/**
 * INVENTORY-ADJUSTMENT sync worker — a SEPARATE module from the po/co/to order sync, but
 * riding the same BC + Deposco auth and shared layer. Bidirectional:
 *
 *   PULL  Deposco → BC : new /inventory/inventoryAdjustments NETTED per item (Deposco is the
 *                        1:1 source of truth) → one BC item-journal Positive/Negative Adjmt. per
 *                        item via the bmiInventoryAdjustments write API. Netting makes it
 *                        order-independent and avoids intermediate negative-inventory underflow.
 *                        Cursor = highest Deposco adjustment self.id seen; failures dead-lettered.
 *   PUSH  BC → Deposco : new adjustment item-ledger entries (bmiItemLedgerEntries) become
 *                        Deposco inventory adjustments. Cursor = highest BC ILE entryNo seen.
 *
 * Echo-break (both loops): PUSH tags Deposco with reasonCode=PUSH_REASON; PULL drops that
 * reason. PULL's BC posts get documentNo 'DEP<id>'; PUSH drops ILEs whose documentNo starts 'DEP'.
 * 'Status Change' adjustments (Available↔Blocked) are skipped+logged (no BC qty equivalent yet).
 *
 * DIRECTION POLICY: inventory flows Deposco -> BC ONLY. Deposco is the system of record for
 * on-hand at a WMS location, so BC-side counts are not exported back. The BC -> Deposco push is
 * retained but OFF unless INV_PUSH_ENABLED=true is set explicitly — no CLI mode implies it.
 * Note its cursor (inv/bc_entry) is stale by ~33k entries against BC Production, so re-derive it
 * (delete the sync_cursors row so initCursors reseeds) before ever switching the push on.
 *
 * SAFETY: on first run (no state file) the cursors initialize to the CURRENT max on each side
 * and nothing is posted — no accidental backfill of all history. Set INV_BACKFILL=true to
 * process everything from cursor 0 on a fresh state.
 *
 * Modes:
 *   node dist/inv/sync-inv.js                 continuous loop
 *   node dist/inv/sync-inv.js --once          one tick
 *   node dist/inv/sync-inv.js --pull-only | --push-only
 *   node dist/inv/sync-inv.js --dry-run       log what it WOULD post, mutate nothing
 *   node dist/inv/sync-inv.js --adj 111       pull one Deposco adjustment by id (forces pull)
 *
 * Env: INV_SYNC_INTERVAL_MS(60000), INV_PULL_ENABLED(false), INV_PUSH_ENABLED(false),
 *      INV_PUSH_ENABLED is the ONLY way to enable BC->Deposco; --once does not imply it.
 *      INV_PUSH_REASON(BCSYNC), INV_STATE_FILE(.inv-state.json), INV_BACKFILL(false),
 *      INV_LOCATION_MAP("HIVE:WESTERLY" — Deposco facility ⇄ BC location; identity if unset),
 *      INV_DEFAULT_FACILITY(HIVE), BC_* / DEPOSCO_*.
 */
import 'dotenv/config';
import { readFile, writeFile, appendFile } from 'node:fs/promises';
import { type AxiosError } from 'axios';
import { getBcToken } from '../auth.js';
import { getDeposcoToken, type DeposcoConfig } from '../deposco.js';
import { loadBcConfig, loadDeposcoConfig, type SyncBcConfig } from '../sync/config.js';
import {
  fetchInventoryAdjustments, postInventoryAdjustment, fetchBcAdjustmentEntries,
  maxBcAdjustmentEntryNo, postBcAdjustment, resolveByWebshopCode, resolveWebshopCode, companyIdFor,
} from '../sync/inventory.js';
import { startRun, finishRun, logEvent, closeDb, readCursor, writeCursor, hasDb, type SyncEvent } from '../sync/db-log.js';

const INTERVAL_MS = parseInt(process.env.INV_SYNC_INTERVAL_MS ?? '60000', 10);
const PULL_ENABLED = (process.env.INV_PULL_ENABLED ?? 'false').toLowerCase() === 'true';
const PUSH_ENABLED = (process.env.INV_PUSH_ENABLED ?? 'false').toLowerCase() === 'true';
const PUSH_REASON = process.env.INV_PUSH_REASON || 'BCSYNC';
const STATE_FILE = process.env.INV_STATE_FILE || '.inv-state.json';
const BACKFILL = (process.env.INV_BACKFILL ?? 'false').toLowerCase() === 'true';
const DEFAULT_FACILITY = process.env.INV_DEFAULT_FACILITY || 'HIVE';
const DRY_RUN = process.argv.includes('--dry-run');

// Deposco facility ⇄ BC location. "HIVE:WESTERLY,DC2:MAIN" → facility HIVE = location WESTERLY.
// Defaults to HIVE:WESTERLY so the pull works without extra env config; the Deposco facility
// number is NOT a valid BC Location Code, so this map is required. Override via INV_LOCATION_MAP
// to retarget without a code change.
const facToLoc = new Map<string, string>();
const locToFac = new Map<string, string>();
for (const pair of (process.env.INV_LOCATION_MAP ?? 'HIVE:WESTERLY').split(',').map((s) => s.trim()).filter(Boolean)) {
  const [fac, loc] = pair.split(':').map((s) => s.trim());
  if (fac && loc) { facToLoc.set(fac.toUpperCase(), loc); locToFac.set(loc.toUpperCase(), fac); }
}
const facilityToLocation = (f: string): string => facToLoc.get(f.toUpperCase()) ?? f;
const locationToFacility = (l: string): string => locToFac.get(l.toUpperCase()) ?? (l || DEFAULT_FACILITY);

// Deposco only manages the WMS location(s), so BC→Deposco push is restricted to those.
// Defaults to the BC locations named in INV_LOCATION_MAP; override with INV_PUSH_LOCATIONS.
const PUSH_LOCATIONS = new Set(
  (process.env.INV_PUSH_LOCATIONS ?? [...locToFac.keys()].join(','))
    .split(',').map((s) => s.trim().toUpperCase()).filter(Boolean),
);
const isPushLocation = (l: string): boolean => PUSH_LOCATIONS.size === 0 || PUSH_LOCATIONS.has(l.toUpperCase());

interface State { lastDeposcoAdjId: number; lastBcEntryNo: number }
const CURSOR_WORKER = 'inv';
// Cursor lives in the DB (sync_cursors) when DATABASE_URL is set — survives Railway restarts,
// so the scheduler can't lose its place. Falls back to the local file otherwise.
async function loadState(): Promise<State | null> {
  if (hasDb()) {
    const adj = await readCursor(CURSOR_WORKER, 'deposco_adj');
    if (adj == null) return null; // no DB cursor yet → caller seeds (no backfill)
    const bc = await readCursor(CURSOR_WORKER, 'bc_entry');
    return { lastDeposcoAdjId: Number(adj), lastBcEntryNo: Number(bc ?? 0) };
  }
  try { return JSON.parse(await readFile(STATE_FILE, 'utf8')) as State; }
  catch { return null; }
}
async function saveState(s: State): Promise<void> {
  if (DRY_RUN) return;
  if (hasDb()) {
    await writeCursor(CURSOR_WORKER, 'deposco_adj', String(s.lastDeposcoAdjId));
    await writeCursor(CURSOR_WORKER, 'bc_entry', String(s.lastBcEntryNo));
    return;
  }
  await writeFile(STATE_FILE, JSON.stringify(s, null, 2));
}

// Adjustments that can't post (unmappable item, or a net that BC still rejects) are appended
// here rather than blocking the batch — surfaced for manual resolution / re-drive.
const DEADLETTER_FILE = process.env.INV_DEADLETTER_FILE || '.inv-failed.jsonl';
async function deadLetter(entry: Record<string, unknown>): Promise<void> {
  if (DRY_RUN) return;
  const at = new Date().toISOString();
  try { await appendFile(DEADLETTER_FILE, JSON.stringify({ at, ...entry }) + '\n'); }
  catch { /* best-effort; the console log already shows it */ }
}

// ── PULL: Deposco adjustments → BC item journal ────────────────────────────────
// 1:1 model — Deposco is the source of truth. Each adjustment is applied EXACTLY ONCE, in id
// order (idempotent via externalAdjustmentId = the Deposco id). BC never goes below zero: the
// AL codeunit floors decrements at BC's actual on-hand. When BC can't fully match a Deposco
// decrement (it was already lower), that's a real DESYNC — logged per item + summarized at the
// end. A hard failure (unmappable item, unexpected BC error) is dead-lettered and the batch
// continues — one bad adjustment never blocks the rest.
interface Desync { id: number; webshop: string; item: string; location: string; requested: number; posted: number; note: string }
async function pull(cfg: SyncBcConfig, deposcoCfg: DeposcoConfig, companyId: string, state: State, onlyId?: number): Promise<void> {
  const dToken = await getDeposcoToken(deposcoCfg);
  const bToken = await getBcToken(cfg);
  const all = await fetchInventoryAdjustments(deposcoCfg, dToken, {}); // all types — cursor must clear the whole range

  let inRange = all.filter((a) => a.self?.id != null);
  if (onlyId) inRange = inRange.filter((a) => a.self.id === onlyId);
  else inRange = inRange.filter((a) => a.self.id > state.lastDeposcoAdjId);
  inRange.sort((a, b) => a.self.id - b.self.id); // chronological — apply in the order Deposco recorded them
  if (inRange.length === 0) { console.log(`[pull] no new adjustments (cursor id=${state.lastDeposcoAdjId})`); return; }
  console.log(`[pull] ${inRange.length} adjustment(s) #${inRange[0].self.id}-#${inRange[inRange.length - 1].self.id} → BC (exactly-once, floor-at-zero)`);

  // Structured logging (no-ops without DATABASE_URL; skipped entirely on dry-run).
  const runId = DRY_RUN ? null : await startRun('inv_pull', process.env.SYNC_TRIGGER || 'manual');
  const ev = (id: number, status: SyncEvent['status'], extra: Partial<SyncEvent> = {}): Promise<void> | undefined =>
    DRY_RUN ? undefined : logEvent({ runId, worker: 'inv_pull', direction: 'deposco->bc', entityType: 'inventory_adj', entityId: String(id), dedupeKey: `inv:${id}`, action: 'pull', status, ...extra });

  const desyncs: Desync[] = [];
  let posted = 0, floored = 0, skipped = 0, failed = 0;
  const advance = (id: number) => { if (!onlyId) state.lastDeposcoAdjId = Math.max(state.lastDeposcoAdjId, id); };

  for (const a of inRange) {
    const id = a.self.id;
    try {
      if (a.actionType !== 'Adjustment') { console.log(`[pull] #${id}: '${a.actionType}' (status change) — skip`); skipped++; await ev(id, 'skip', { message: `status change (actionType=${a.actionType})` }); advance(id); await saveState(state); continue; }
      if ((a.reasonCode ?? '') === PUSH_REASON) { console.log(`[pull] #${id}: ${PUSH_REASON} echo — skip`); skipped++; await ev(id, 'skip', { message: `${PUSH_REASON} echo` }); advance(id); await saveState(state); continue; }

      const webshop = a.item?.businessKey?.number ?? '';
      const ref = await resolveByWebshopCode(cfg, bToken, webshop);
      if (!ref) { console.warn(`[pull] #${id}: no BC variant for '${webshop}' — DEAD-LETTER`); await deadLetter({ id, webshop, reason: 'no BC variant' }); failed++; await ev(id, 'fail', { side: 'bc', message: `no BC variant for '${webshop}'`, detail: { webshop } }); advance(id); await saveState(state); continue; }
      const location = facilityToLocation(a.facility?.businessKey?.number ?? DEFAULT_FACILITY);
      const desc = `#${id} ${webshop} → ${ref.itemNo}/${ref.variantCode} @${location} ${a.quantity > 0 ? '+' : ''}${a.quantity}`;

      if (DRY_RUN) { console.log(`[pull] DRY ${desc}`); advance(id); continue; }

      const res = await postBcAdjustment(cfg, companyId, bToken, {
        itemNo: ref.itemNo, variantCode: ref.variantCode, locationCode: location, quantity: a.quantity, externalAdjustmentId: String(id),
      });
      const evDetail = { item: `${ref.itemNo}/${ref.variantCode}`, location, requested: a.quantity, posted: res.postedQuantity ?? a.quantity, ile: res.itemLedgerEntryNo };
      if (res.errorMessage) {
        // floored/clamped by the AL codeunit — BC could not fully match Deposco = a real desync
        console.warn(`[pull] ⚠ ${desc} — ${res.errorMessage}`);
        desyncs.push({ id, webshop, item: `${ref.itemNo}/${ref.variantCode}`, location, requested: a.quantity, posted: res.postedQuantity ?? 0, note: res.errorMessage });
        floored++;
        await ev(id, 'desync', { action: 'floor', side: 'bc', message: res.errorMessage, detail: evDetail });
      } else {
        console.log(`[pull] ✅ ${desc} → posted ${res.postedQuantity ?? a.quantity}, ILE ${res.itemLedgerEntryNo ?? '?'}`);
        posted++;
        await ev(id, 'ok', { action: 'post', message: desc, detail: evDetail });
      }
      advance(id); await saveState(state);
    } catch (err) {
      const e = err as AxiosError;
      const body = JSON.stringify(e.response?.data ?? e.message).slice(0, 300);
      if (/already been posted/i.test(body)) { console.log(`[pull] #${id}: already posted (idempotent)`); await ev(id, 'skip', { message: 'already posted (idempotent)' }); advance(id); await saveState(state); continue; }
      // TRANSIENT vs PERMANENT. Dead-lettering exists so one unusable record can't block the
      // queue, but it advances the cursor — which for a TRANSIENT fault silently discards a real
      // stock movement. Adjustment #57 (25543-BCW-LG +1) was lost exactly that way: BC deadlocked
      // against a warehouse user mid-post, the record was dead-lettered, and the cursor moved to
      // #93, so it was never retried and BC is short by 1.
      //
      // A deadlock/429/5xx/network fault says nothing about the record — only about the moment.
      // authReq already retries these in-request; if it has exhausted that, hold the cursor and
      // stop the batch so the SAME id is reprocessed next tick, and keep doing so until it lands.
      // The batch stops rather than continues because these are applied in Deposco's order and
      // the cursor is a single high-water mark — skipping ahead would strand this one again.
      // authReq wraps failures in a plain Error carrying httpStatus — e.response only exists if
      // the axios error somehow escaped raw. Without httpStatus, `!e.response` classified EVERY
      // failure as transient, so a permanent 400 (#227, insufficient BC inventory) held the
      // cursor from Aug 14 and 298 adjustments queued behind it unimported.
      const status = e.response?.status ?? (err as { httpStatus?: number }).httpStatus;
      const transient = /deadlock/i.test(body) || status === 429 || (status !== undefined && status >= 500) || (status === undefined && !e.response);

      // Say WHAT was lost, not just that something failed. authReq throws a plain Error (the
      // status is already baked into its message), so `e.response?.status` is undefined here and
      // the old event logged the literal string "HTTP undefined" with the real cause buried in
      // `detail` — unreadable in /logs and impossible to act on. Name the item, place and
      // quantity, and say plainly that BC does NOT have this stock movement.
      const who = `${a.item?.businessKey?.number ?? '?'} @${a.facility?.businessKey?.number ?? '?'} ${a.quantity > 0 ? '+' : ''}${a.quantity}`;
      const cause = /deadlock/i.test(body) ? 'BC deadlocked against another user posting to the Item Ledger'
        : status ? `BC HTTP ${status}` : (e as Error).message.slice(0, 160);

      if (transient) {
        const m = `#${id} ${who} NOT applied to BC — ${cause}. Cursor held; retrying every tick until it posts.`;
        console.error(`[pull] ⚠ ${m}`);
        failed++;
        await ev(id, 'fail', { side: 'bc', message: m, detail: { item: a.item?.businessKey?.number, facility: a.facility?.businessKey?.number, quantity: a.quantity, transient: true, error: body } });
        await saveState(state);
        break;
      }
      const m = `#${id} ${who} NOT applied to BC — ${cause}. Dead-lettered: this stock movement must be entered in BC by hand, or Deposco and BC stay out of step for this item.`;
      console.error(`[pull] ❌ ${m}`);
      await deadLetter({ id, item: a.item?.businessKey?.number, facility: a.facility?.businessKey?.number, quantity: a.quantity, error: body });
      failed++;
      await ev(id, 'fail', { side: 'bc', message: m, detail: { item: a.item?.businessKey?.number, facility: a.facility?.businessKey?.number, quantity: a.quantity, transient: false, error: body } });
      advance(id); await saveState(state);
    }
  }

  await finishRun(runId, failed > 0 ? 'partial' : 'ok', { posted, floored, skipped, failed });
  console.log(`[pull] done: ${posted} posted, ${floored} floored, ${skipped} skipped, ${failed} dead-lettered → cursor id=${state.lastDeposcoAdjId}`);
  if (desyncs.length) {
    console.log(`[pull] ⚠ ${desyncs.length} BC↔Deposco DESYNC(s) — BC on-hand was lower than Deposco's decrement:`);
    for (const d of desyncs) console.log(`   • ${d.webshop} (${d.item}) @${d.location}: Deposco ${d.requested > 0 ? '+' : ''}${d.requested}, BC posted ${d.posted} — ${d.note}`);
  } else if (!DRY_RUN && (posted > 0 || floored === 0)) {
    console.log('[pull] ✓ no desyncs — BC is in sync with Deposco for this batch');
  }
}

// ── PUSH: BC adjustment entries → Deposco ──────────────────────────────────────
async function push(cfg: SyncBcConfig, deposcoCfg: DeposcoConfig, companyId: string, state: State): Promise<void> {
  const bToken = await getBcToken(cfg);
  const dToken = await getDeposcoToken(deposcoCfg);
  const entries = await fetchBcAdjustmentEntries(cfg, companyId, bToken, state.lastBcEntryNo);
  // drop our own pull-posts ('DEP' docs) AND anything outside the WMS location(s) Deposco manages
  const fresh = entries.filter((e) => !String(e.documentNo ?? '').startsWith('DEP') && isPushLocation(e.locationCode));

  if (fresh.length === 0) { console.log(`[push] no new pushable BC adjustment entries (cursor entryNo=${state.lastBcEntryNo}, ${entries.length} seen)`); if (entries.length) state.lastBcEntryNo = Math.max(state.lastBcEntryNo, ...entries.map((e) => e.entryNo)); return; }
  console.log(`[push] ${fresh.length} new BC adjustment entry(ies) to send to Deposco`);

  for (const e of entries.sort((a, b) => a.entryNo - b.entryNo)) {
    try {
      if (String(e.documentNo ?? '').startsWith('DEP') || !isPushLocation(e.locationCode)) { state.lastBcEntryNo = Math.max(state.lastBcEntryNo, e.entryNo); continue; }
      const webshop = await resolveWebshopCode(cfg, bToken, e.itemNo, e.variantCode);
      if (!webshop) { console.warn(`[push] ILE ${e.entryNo}: no WebshopVariantCode for ${e.itemNo}/${e.variantCode} — skip`); state.lastBcEntryNo = Math.max(state.lastBcEntryNo, e.entryNo); continue; }
      const facility = locationToFacility(e.locationCode);
      const line = `ILE ${e.entryNo} ${e.itemNo}/${e.variantCode} → ${webshop} @${facility} qty=${e.quantity} (${e.entryType})`;

      if (DRY_RUN) { console.log(`[push] DRY ${line}`); state.lastBcEntryNo = Math.max(state.lastBcEntryNo, e.entryNo); continue; }

      await postInventoryAdjustment(deposcoCfg, dToken, {
        itemNumber: webshop, facilityNumber: facility, quantity: e.quantity, reasonCode: PUSH_REASON,
      });
      console.log(`[push] ✅ ${line} → Deposco (reason ${PUSH_REASON})`);
      state.lastBcEntryNo = Math.max(state.lastBcEntryNo, e.entryNo);
      await saveState(state);
    } catch (err) {
      const ex = err as AxiosError;
      console.error(`[push] ILE ${e.entryNo} FAILED HTTP ${ex.response?.status}: ${JSON.stringify(ex.response?.data ?? ex.message).slice(0, 300)}`);
      break;
    }
  }
}

// ── First-run cursor init (no accidental backfill) ─────────────────────────────
async function initCursors(cfg: SyncBcConfig, deposcoCfg: DeposcoConfig, companyId: string): Promise<State> {
  const dToken = await getDeposcoToken(deposcoCfg);
  const bToken = await getBcToken(cfg);
  const adj = await fetchInventoryAdjustments(deposcoCfg, dToken, { pageSize: 1, maxPages: 1 }); // ID-descending → [0] is the max
  const state: State = {
    lastDeposcoAdjId: BACKFILL ? 0 : (adj[0]?.self?.id ?? 0),
    lastBcEntryNo: BACKFILL ? 0 : await maxBcAdjustmentEntryNo(cfg, companyId, bToken),
  };
  console.log(`[init] no state — cursors set to Deposco id=${state.lastDeposcoAdjId}, BC entryNo=${state.lastBcEntryNo}${BACKFILL ? ' (BACKFILL: processing from 0)' : ' (no backfill)'}`);
  // A fresh cursor (no stored value) that lands on a non-zero max means we're SKIPPING every
  // adjustment ≤ that id — the real "missed adjustments" risk (first run, or DB cursor lost).
  // Flag it as a desync so ops can verify nothing was dropped. Deduped by the seeded value so a
  // repeat init to the same id logs once, not every tick.
  if (!BACKFILL && !DRY_RUN && state.lastDeposcoAdjId > 0) {
    await logEvent({
      worker: 'inv_pull', direction: 'deposco->bc', entityType: 'inventory_adj', action: 'cursor-init',
      status: 'desync', side: 'deposco',
      message: `cursor freshly initialized to ${state.lastDeposcoAdjId} (no stored cursor) — adjustments ≤ ${state.lastDeposcoAdjId} were NOT applied by this run; if this wasn't a deliberate reset, some may have been missed`,
      dedupeKey: `inv-cursor-init:${state.lastDeposcoAdjId}`,
    });
  }
  return state;
}

async function tick(cfg: SyncBcConfig, deposcoCfg: DeposcoConfig, companyId: string, state: State, opts: { pull: boolean; push: boolean }): Promise<void> {
  if (opts.pull) await pull(cfg, deposcoCfg, companyId, state);
  if (opts.push) await push(cfg, deposcoCfg, companyId, state);
  await saveState(state);
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  const cfg = loadBcConfig();
  const deposcoCfg = loadDeposcoConfig();
  const bToken = await getBcToken(cfg);
  const companyId = await companyIdFor(cfg, bToken);

  const adjIdx = process.argv.indexOf('--adj');
  const adjArg = adjIdx >= 0 ? parseInt(process.argv[adjIdx + 1], 10) : null;
  const pullOnly = process.argv.includes('--pull-only') || adjArg != null;
  const pushOnly = process.argv.includes('--push-only');

  let state = (await loadState()) ?? (await initCursors(cfg, deposcoCfg, companyId));

  // Single-adjustment pull (web-UI button / manual replay).
  if (adjArg != null) {
    console.log(`[inv] single pull of Deposco adjustment #${adjArg}${DRY_RUN ? ' (dry-run)' : ''}`);
    await pull(cfg, deposcoCfg, companyId, state, adjArg);
    await closeDb();
    return;
  }

  const doPull = !pushOnly;
  const doPush = !pullOnly;
  const once = process.argv.includes('--once');
  console.log(`[inv-sync] starting — interval=${INTERVAL_MS}ms pull=${PULL_ENABLED}&${doPull} push=${PUSH_ENABLED}&${doPush} reason=${PUSH_REASON}${DRY_RUN ? ' DRY-RUN' : ''}${once ? ' (single tick)' : ''}`);

  // Inventory is ONE-WAY by policy: Deposco -> BC only. The pull is the supported direction, so
  // --once/--dry-run may run it without INV_PULL_ENABLED (that's how the scheduled job works).
  // The PUSH must NEVER be implied by the mode — it previously inherited `|| once`, so a bare
  // `--once` would try to export BC ledger adjustments to Deposco despite INV_PUSH_ENABLED=false.
  // It now requires the flag explicitly, in --once and loop mode alike.
  const opts = {
    pull: doPull && (PULL_ENABLED || DRY_RUN || once),
    push: doPush && PUSH_ENABLED,
  };
  if (doPush && !PUSH_ENABLED && (once || DRY_RUN)) {
    console.log('[inv] push skipped — BC->Deposco is off by policy (set INV_PUSH_ENABLED=true to override)');
  }
  if (once) { await tick(cfg, deposcoCfg, companyId, state, opts); await closeDb(); return; }
  for (;;) {
    const t0 = Date.now();
    try { await tick(cfg, deposcoCfg, companyId, state, { pull: doPull && PULL_ENABLED, push: doPush && PUSH_ENABLED }); }
    catch (err) { console.error('[tick] FAILED:', err instanceof Error ? err.message : err); }
    await sleep(Math.max(0, INTERVAL_MS - (Date.now() - t0)));
  }
}

main().catch((err) => { console.error('FATAL:', err instanceof Error ? err.message : err); process.exit(1); });
