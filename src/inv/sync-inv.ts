/**
 * INVENTORY-ADJUSTMENT sync worker — a SEPARATE module from the po/co/to order sync, but
 * riding the same BC + Deposco auth and shared layer. Bidirectional:
 *
 *   PULL  Deposco → BC : new /inventory/inventoryAdjustments (actionType=Adjustment) become
 *                        BC item-journal Positive/Negative Adjmt. via the bmiInventoryAdjustments
 *                        write API. Cursor = highest Deposco adjustment self.id seen.
 *   PUSH  BC → Deposco : new adjustment item-ledger entries (bmiItemLedgerEntries) become
 *                        Deposco inventory adjustments. Cursor = highest BC ILE entryNo seen.
 *
 * Echo-break (both loops): PUSH tags Deposco with reasonCode=PUSH_REASON; PULL drops that
 * reason. PULL's BC posts get documentNo 'DEP<id>'; PUSH drops ILEs whose documentNo starts 'DEP'.
 * 'Status Change' adjustments (Available↔Blocked) are skipped+logged (no BC qty equivalent yet).
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
 *      INV_PUSH_REASON(BCSYNC), INV_STATE_FILE(.inv-state.json), INV_BACKFILL(false),
 *      INV_LOCATION_MAP("HIVE:WMS" — Deposco facility ⇄ BC location; identity if unset),
 *      INV_DEFAULT_FACILITY(HIVE), BC_* / DEPOSCO_*.
 */
import 'dotenv/config';
import { readFile, writeFile } from 'node:fs/promises';
import { type AxiosError } from 'axios';
import { getBcToken } from '../auth.js';
import { getDeposcoToken, type DeposcoConfig } from '../deposco.js';
import { loadBcConfig, loadDeposcoConfig, type SyncBcConfig } from '../sync/config.js';
import {
  fetchInventoryAdjustments, postInventoryAdjustment, fetchBcAdjustmentEntries,
  maxBcAdjustmentEntryNo, postBcAdjustment, resolveByWebshopCode, resolveWebshopCode, companyIdFor,
} from '../sync/inventory.js';

const INTERVAL_MS = parseInt(process.env.INV_SYNC_INTERVAL_MS ?? '60000', 10);
const PULL_ENABLED = (process.env.INV_PULL_ENABLED ?? 'false').toLowerCase() === 'true';
const PUSH_ENABLED = (process.env.INV_PUSH_ENABLED ?? 'false').toLowerCase() === 'true';
const PUSH_REASON = process.env.INV_PUSH_REASON || 'BCSYNC';
const STATE_FILE = process.env.INV_STATE_FILE || '.inv-state.json';
const BACKFILL = (process.env.INV_BACKFILL ?? 'false').toLowerCase() === 'true';
const DEFAULT_FACILITY = process.env.INV_DEFAULT_FACILITY || 'HIVE';
const DRY_RUN = process.argv.includes('--dry-run');

// Deposco facility ⇄ BC location. "HIVE:WMS,DC2:MAIN" → facility HIVE = location WMS.
// Defaults to HIVE:WMS (the only WMS location) so the pull works without extra env config;
// the Deposco facility number is NOT a valid BC Location Code, so this map is required.
const facToLoc = new Map<string, string>();
const locToFac = new Map<string, string>();
for (const pair of (process.env.INV_LOCATION_MAP ?? 'HIVE:WMS').split(',').map((s) => s.trim()).filter(Boolean)) {
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
async function loadState(): Promise<State | null> {
  try { return JSON.parse(await readFile(STATE_FILE, 'utf8')) as State; }
  catch { return null; }
}
async function saveState(s: State): Promise<void> {
  if (DRY_RUN) return;
  await writeFile(STATE_FILE, JSON.stringify(s, null, 2));
}

// ── PULL: Deposco adjustments → BC item journal ────────────────────────────────
async function pull(cfg: SyncBcConfig, deposcoCfg: DeposcoConfig, companyId: string, state: State, onlyId?: number): Promise<void> {
  const dToken = await getDeposcoToken(deposcoCfg);
  const bToken = await getBcToken(cfg);
  const all = await fetchInventoryAdjustments(deposcoCfg, dToken, { actionType: onlyId ? undefined : 'Adjustment' });

  let candidates = all.filter((a) => a.self?.id != null);
  if (onlyId) candidates = candidates.filter((a) => a.self.id === onlyId);
  else candidates = candidates.filter((a) => a.self.id > state.lastDeposcoAdjId);
  candidates.sort((a, b) => a.self.id - b.self.id); // oldest first

  if (candidates.length === 0) { console.log(`[pull] no new adjustments (cursor id=${state.lastDeposcoAdjId})`); return; }
  console.log(`[pull] ${candidates.length} new adjustment(s) to apply to BC`);

  for (const a of candidates) {
    const id = a.self.id;
    try {
      if (a.actionType !== 'Adjustment') { console.log(`[pull] #${id}: actionType='${a.actionType}' (status change) — skip+log`); state.lastDeposcoAdjId = Math.max(state.lastDeposcoAdjId, id); continue; }
      if ((a.reasonCode ?? '') === PUSH_REASON) { console.log(`[pull] #${id}: reasonCode=${PUSH_REASON} → BC-origin echo, skip`); state.lastDeposcoAdjId = Math.max(state.lastDeposcoAdjId, id); continue; }

      const webshop = a.item?.businessKey?.number ?? '';
      const ref = await resolveByWebshopCode(cfg, bToken, webshop);
      if (!ref) { console.warn(`[pull] #${id}: no BC variant for WebshopVariantCode '${webshop}' — skip`); state.lastDeposcoAdjId = Math.max(state.lastDeposcoAdjId, id); continue; }
      const location = facilityToLocation(a.facility?.businessKey?.number ?? DEFAULT_FACILITY);
      const line = `#${id} ${webshop} → ${ref.itemNo}/${ref.variantCode} @${location} qty=${a.quantity} reason=${a.reasonCode ?? ''}`;

      if (DRY_RUN) { console.log(`[pull] DRY ${line}`); state.lastDeposcoAdjId = Math.max(state.lastDeposcoAdjId, id); continue; }

      const res = await postBcAdjustment(cfg, companyId, bToken, {
        itemNo: ref.itemNo, variantCode: ref.variantCode, locationCode: location,
        quantity: a.quantity, reasonCode: a.reasonCode || undefined, externalAdjustmentId: String(id),
      });
      console.log(`[pull] ✅ ${line} → ILE ${res.itemLedgerEntryNo ?? '?'} doc ${res.documentNo ?? '?'}`);
      state.lastDeposcoAdjId = Math.max(state.lastDeposcoAdjId, id);
      await saveState(state);
    } catch (err) {
      const e = err as AxiosError;
      const body = JSON.stringify(e.response?.data ?? e.message).slice(0, 300);
      // "already been posted" = idempotency hit → advance cursor, it's fine.
      if (/already been posted/i.test(body)) { console.log(`[pull] #${id}: already posted (idempotent) — advancing cursor`); state.lastDeposcoAdjId = Math.max(state.lastDeposcoAdjId, id); await saveState(state); continue; }
      console.error(`[pull] #${id} FAILED HTTP ${e.response?.status}: ${body}`);
      break; // stop so the cursor doesn't skip past an unposted adjustment
    }
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
    return;
  }

  const doPull = !pushOnly;
  const doPush = !pullOnly;
  const once = process.argv.includes('--once');
  console.log(`[inv-sync] starting — interval=${INTERVAL_MS}ms pull=${PULL_ENABLED}&${doPull} push=${PUSH_ENABLED}&${doPush} reason=${PUSH_REASON}${DRY_RUN ? ' DRY-RUN' : ''}${once ? ' (single tick)' : ''}`);

  const opts = { pull: doPull && (PULL_ENABLED || DRY_RUN || once), push: doPush && (PUSH_ENABLED || DRY_RUN || once) };
  if (once) { await tick(cfg, deposcoCfg, companyId, state, opts); return; }
  for (;;) {
    const t0 = Date.now();
    try { await tick(cfg, deposcoCfg, companyId, state, { pull: doPull && PULL_ENABLED, push: doPush && PUSH_ENABLED }); }
    catch (err) { console.error('[tick] FAILED:', err instanceof Error ? err.message : err); }
    await sleep(Math.max(0, INTERVAL_MS - (Date.now() - t0)));
  }
}

main().catch((err) => { console.error('FATAL:', err instanceof Error ? err.message : err); process.exit(1); });
