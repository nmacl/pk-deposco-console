/**
 * Permanent-failure alerts — the "tell someone when a sync gives up" layer.
 *
 * Asked for at Tech x Ops 2026-09-22: when an inventory adjustment hits its final retry and will
 * no longer attempt to sync, fire an alert so the team fixes it proactively instead of scanning
 * logs (an un-applied +1 leaves a rep seeing 2 available in Deposco vs 3 in BC).
 *
 * Two things the meeting's mental model got slightly wrong, both handled here:
 *   1. A permanent BC rejection (dimension error, "insufficient quantity", unmappable SKU)
 *      dead-letters on the FIRST attempt — there is no N-attempt loop for those. The signal is
 *      the sync_events row: worker='inv_pull', status='fail', detail.transient=false.
 *   2. The bigger silent risk is the opposite: a "transient" failure (timeout, 5xx, deadlock)
 *      HOLDS THE CURSOR and retries forever, which blocks every later adjustment behind it.
 *      Those rows keep a stable dedupe key (`inv:<id>`) so their `hits` climbs each tick —
 *      once it passes STUCK_HITS the adjustment is treated as stuck and alerted too.
 * Chronic order post-backs (co/to, failed on 2+ distinct days) are folded into the same digest
 * once a day so the alert channel covers "will not resolve on its own" across all workers.
 *
 * Delivery: every alert is written to sync_alerts (idempotent on dedupe_key — only a NEW row is
 * delivered), then sent through whichever channels are configured:
 *   ALERT_WEBHOOK_URL      POST {text, alerts} — Teams/Slack/Power Automate incoming webhook.
 *   ALERT_EMAIL_TO         comma-separated; sent via Microsoft Graph sendMail as ALERT_EMAIL_FROM
 *                          (a licensed mailbox). Uses the BC Entra app's client credentials with a
 *                          Graph scope — that app must be granted the Mail.Send APPLICATION
 *                          permission (admin consent) or Graph returns 403. Override the app with
 *                          ALERT_GRAPH_TENANT_ID / ALERT_GRAPH_CLIENT_ID / ALERT_GRAPH_CLIENT_SECRET.
 * With neither set the alerts still land in sync_alerts and the console's /alerts page.
 *
 * Never throws out of sweepAlerts — an alerting failure must never take the console down.
 */
import axios from 'axios';
import pg from 'pg';
import { ipv4Agent } from '../auth.js';
import { chronicFailures } from './db-log.js';

const { Pool } = pg;

// ── config ──────────────────────────────────────────────────────────────────
export const STUCK_HITS = parseInt(process.env.ALERT_STUCK_HITS ?? '6', 10);          // ticks (~30 min @5min)
const WEBHOOK_URL = process.env.ALERT_WEBHOOK_URL ?? '';
const EMAIL_TO = (process.env.ALERT_EMAIL_TO ?? '').split(',').map((s) => s.trim()).filter(Boolean);
const EMAIL_FROM = process.env.ALERT_EMAIL_FROM ?? '';
const GRAPH_TENANT = process.env.ALERT_GRAPH_TENANT_ID ?? process.env.BC_TENANT_ID ?? '';
const GRAPH_CLIENT = process.env.ALERT_GRAPH_CLIENT_ID ?? process.env.BC_CLIENT_ID ?? '';
const GRAPH_SECRET = process.env.ALERT_GRAPH_CLIENT_SECRET ?? process.env.BC_CLIENT_SECRET ?? '';
const CONSOLE_URL = process.env.ALERT_CONSOLE_URL ?? '';

// ── types ───────────────────────────────────────────────────────────────────
export type AlertKind = 'inv-dead-letter' | 'inv-stuck' | 'chronic-order';
export interface Alert {
  kind: AlertKind;
  worker: string;
  entityId: string;
  message: string;
  detail?: unknown;
  dedupeKey: string;
}

export interface FailRow {
  id: number; ts: string | Date; worker: string; entity_id: string | null; action: string | null;
  message: string | null; detail: unknown; hits: number | null; last_ts: string | Date | null;
}

// ── pure classification (unit-tested) ───────────────────────────────────────
const detailOf = (r: FailRow): Record<string, unknown> => {
  const d = r.detail;
  if (d && typeof d === 'object') return d as Record<string, unknown>;
  if (typeof d === 'string') { try { return JSON.parse(d) as Record<string, unknown>; } catch { return {}; } }
  return {};
};
const isFalse = (v: unknown): boolean => v === false || v === 'false';
const isTrue = (v: unknown): boolean => v === true || v === 'true';

/** Turn inventory-pull failure rows into alerts. Dead letters alert once per adjustment; stuck
 *  transients alert once when they cross STUCK_HITS (and again every further STUCK_HITS ticks). */
export function classifyInventoryFailures(rows: FailRow[], stuckHits = STUCK_HITS): Alert[] {
  const out: Alert[] = [];
  for (const r of rows) {
    if (r.worker !== 'inv_pull') continue;
    const d = detailOf(r);
    const id = r.entity_id ?? String(r.id);
    const item = typeof d.item === 'string' ? d.item : (typeof d.webshop === 'string' ? d.webshop : '?');
    const qty = typeof d.quantity === 'number' ? d.quantity : undefined;
    const who = `${item}${qty !== undefined ? ` ${qty > 0 ? '+' : ''}${qty}` : ''}`;
    if (isFalse(d.transient) || (d.transient === undefined && /dead-letter/i.test(r.message ?? ''))) {
      out.push({
        kind: 'inv-dead-letter', worker: r.worker, entityId: id,
        message: `Inventory adjustment #${id} (${who}) will NOT sync to BC — dead-lettered. ${shortError(d.error ?? r.message)}`,
        detail: { item, quantity: qty, facility: d.facility, error: d.error ?? r.message, eventId: r.id },
        dedupeKey: `inv-dead:${id}`,
      });
    } else if (isTrue(d.transient) && (r.hits ?? 1) >= stuckHits) {
      const bucket = Math.floor((r.hits ?? 1) / stuckHits);
      out.push({
        kind: 'inv-stuck', worker: r.worker, entityId: id,
        message: `Inventory adjustment #${id} (${who}) has failed ${r.hits} ticks in a row and is blocking every later adjustment (cursor held). ${shortError(d.error ?? r.message)}`,
        detail: { item, quantity: qty, facility: d.facility, hits: r.hits, error: d.error ?? r.message, eventId: r.id },
        dedupeKey: `inv-stuck:${id}:${bucket}`,
      });
    }
  }
  return out;
}

/** ONE digest alert per worker per day listing every chronic order — 30 chronic sales orders is a
 *  fact about the backlog, not 30 separate emergencies. Re-keyed on the sorted list so the alert
 *  fires again the same day only if the set changes. */
export function chronicAlerts(worker: string, entities: Iterable<string>, day = new Date().toISOString().slice(0, 10)): Alert[] {
  const list = [...new Set(entities)].sort();
  if (list.length === 0) return [];
  const label = worker === 'co' ? 'sales order shipments' : worker === 'to' ? 'transfer post-backs' : `${worker} post-backs`;
  const shown = list.slice(0, 25).join(', ') + (list.length > 25 ? `, … +${list.length - 25} more` : '');
  return [{
    kind: 'chronic-order', worker, entityId: `${list.length} orders`,
    message: `${list.length} chronic ${label} to BC (failed on 2+ days, will not resolve on their own — fix in BC, see /logs): ${shown}`,
    detail: { orders: list },
    dedupeKey: `chronic:${worker}:${day}:${list.join(',')}`,
  }];
}

export function shortError(e: unknown, max = 220): string {
  let s = typeof e === 'string' ? e : JSON.stringify(e ?? '');
  // The dead-letter writer stores the error as a JSON-encoded string (quotes escaped as \"), so
  // unwrap that layer first, then dig BC's message out of {"error":{"code":..,"message":".."}}.
  if (/^"/.test(s)) { try { s = JSON.parse(s) as string; } catch { /* leave as is */ } }
  const m = /"message"\s*:\s*"((?:[^"\\]|\\.)*)/.exec(s);
  if (m) s = m[1].replace(/\\"/g, '"');
  s = s.replace(/\s*CorrelationId:.*$/i, '').replace(/\\n/g, ' ').trim();
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

export function formatDigest(alerts: Alert[]): { subject: string; text: string } {
  const n = alerts.length;
  const dead = alerts.filter((a) => a.kind === 'inv-dead-letter').length;
  const stuck = alerts.filter((a) => a.kind === 'inv-stuck').length;
  const chronic = alerts.filter((a) => a.kind === 'chronic-order').length;
  const parts = [dead && `${dead} dead-lettered adjustment${dead > 1 ? 's' : ''}`, stuck && `${stuck} stuck adjustment${stuck > 1 ? 's' : ''}`, chronic && `${chronic} chronic order${chronic > 1 ? 's' : ''}`].filter(Boolean);
  const subject = `[PK↔Deposco] ${parts.join(', ') || `${n} alert${n > 1 ? 's' : ''}`}`;
  const lines = alerts.map((a) => `• ${a.message}`);
  if (CONSOLE_URL) lines.push('', `Console: ${CONSOLE_URL.replace(/\/$/, '')}/alerts`);
  return { subject, text: lines.join('\n') };
}

// ── storage ─────────────────────────────────────────────────────────────────
let pool: pg.Pool | null = null;
function db(): pg.Pool | null {
  const url = process.env.DATABASE_URL;
  if (!url) return null;
  if (!pool) { pool = new Pool({ connectionString: url, ssl: { rejectUnauthorized: false }, max: 2, connectionTimeoutMillis: 10_000 }); pool.on('error', () => {}); }
  return pool;
}

let schemaReady = false;
export async function ensureAlertsTable(p: pg.Pool): Promise<void> {
  if (schemaReady) return;
  await p.query(`
    create table if not exists sync_alerts (
      id            bigint generated always as identity primary key,
      ts            timestamptz not null default now(),
      kind          text not null,
      worker        text not null,
      entity_id     text,
      message       text not null,
      detail        jsonb,
      dedupe_key    text unique,
      delivered_via text,
      delivered_at  timestamptz,
      error         text
    )`);
  await p.query('alter table sync_alerts enable row level security').catch(() => {});
  await p.query('revoke all on table sync_alerts from anon, authenticated').catch(() => {});
  schemaReady = true;
}

/** Insert alerts; returns only the ones that were NEW (not already alerted). */
export async function recordAlerts(p: pg.Pool, alerts: Alert[]): Promise<Array<Alert & { id: number }>> {
  const fresh: Array<Alert & { id: number }> = [];
  for (const a of alerts) {
    const r = await p.query(
      `insert into sync_alerts(kind, worker, entity_id, message, detail, dedupe_key)
       values($1,$2,$3,$4,$5,$6) on conflict (dedupe_key) do nothing returning id`,
      [a.kind, a.worker, a.entityId, a.message, a.detail === undefined ? null : JSON.stringify(a.detail), a.dedupeKey]);
    if (r.rows[0]) fresh.push({ ...a, id: r.rows[0].id as number });
  }
  return fresh;
}

// ── delivery ────────────────────────────────────────────────────────────────
let graphToken: { token: string; expiresAt: number } | null = null;
async function getGraphToken(): Promise<string> {
  if (graphToken && graphToken.expiresAt > Date.now() + 60_000) return graphToken.token;
  const body = new URLSearchParams({ grant_type: 'client_credentials', client_id: GRAPH_CLIENT, client_secret: GRAPH_SECRET, scope: 'https://graph.microsoft.com/.default' });
  const r = await axios.post<{ access_token: string; expires_in: number }>(`https://login.microsoftonline.com/${GRAPH_TENANT}/oauth2/v2.0/token`, body.toString(), { httpsAgent: ipv4Agent, timeout: 30_000 });
  graphToken = { token: r.data.access_token, expiresAt: Date.now() + r.data.expires_in * 1000 };
  return graphToken.token;
}

export async function sendGraphMail(to: string[], subject: string, text: string): Promise<void> {
  if (!EMAIL_FROM) throw new Error('ALERT_EMAIL_FROM not set');
  const token = await getGraphToken();
  await axios.post(`https://graph.microsoft.com/v1.0/users/${encodeURIComponent(EMAIL_FROM)}/sendMail`, {
    message: { subject, body: { contentType: 'Text', content: text }, toRecipients: to.map((address) => ({ emailAddress: { address } })) },
    saveToSentItems: false,
  }, { headers: { Authorization: `Bearer ${token}` }, httpsAgent: ipv4Agent, timeout: 30_000 });
}

// Webhook body shape. 'teams' = the Teams Workflows ("Post to a chat/channel when a webhook request
// is received") contract: an Adaptive Card inside a message envelope. Auto-detected from the URL
// (Power Automate / legacy Office connector hosts); ALERT_WEBHOOK_FORMAT=teams|slack|json overrides.
const WEBHOOK_FORMAT = (process.env.ALERT_WEBHOOK_FORMAT ?? (/logic\.azure\.com|powerautomate|powerplatform|webhook\.office\.com|flow\.microsoft/i.test(WEBHOOK_URL) ? 'teams' : 'json')).toLowerCase();

export function webhookBody(subject: string, text: string, alerts: Alert[], format = WEBHOOK_FORMAT): unknown {
  if (format === 'teams') {
    const color = (k: AlertKind): string => k === 'inv-dead-letter' ? 'Attention' : k === 'inv-stuck' ? 'Warning' : 'Accent';
    return {
      type: 'message',
      attachments: [{
        contentType: 'application/vnd.microsoft.card.adaptive',
        contentUrl: null,
        content: {
          $schema: 'http://adaptivecards.io/schemas/adaptive-card.json', type: 'AdaptiveCard', version: '1.4',
          msteams: { width: 'Full' },
          body: [
            { type: 'TextBlock', text: subject, weight: 'Bolder', size: 'Medium', wrap: true },
            ...alerts.map((a) => ({ type: 'TextBlock', text: `**${a.entityId}** · ${a.message}`, wrap: true, color: color(a.kind), spacing: 'Small' })),
            ...(CONSOLE_URL ? [{ type: 'TextBlock', text: `[Open alerts console](${CONSOLE_URL.replace(/\/$/, '')}/alerts)`, wrap: true, spacing: 'Medium' }] : []),
          ],
        },
      }],
    };
  }
  if (format === 'slack') return { text: `*${subject}*\n${text}` };
  return { text: `${subject}\n${text}`, title: subject, alerts };
}

export async function sendWebhook(subject: string, text: string, alerts: Alert[]): Promise<void> {
  await axios.post(WEBHOOK_URL, webhookBody(subject, text, alerts), { httpsAgent: ipv4Agent, timeout: 30_000 });
}

export function channelsConfigured(): string[] {
  const c: string[] = [];
  if (WEBHOOK_URL) c.push(`webhook(${WEBHOOK_FORMAT})`);
  if (EMAIL_TO.length && EMAIL_FROM) c.push('email');
  return c;
}

async function deliver(p: pg.Pool, fresh: Array<Alert & { id: number }>): Promise<void> {
  if (fresh.length === 0) return;
  const { subject, text } = formatDigest(fresh);
  console.log(`[alerts] ${subject}\n${text}`);
  const via: string[] = ['console'];
  const errors: string[] = [];
  if (WEBHOOK_URL) { try { await sendWebhook(subject, text, fresh); via.push('webhook'); } catch (e) { errors.push(`webhook: ${(e as Error).message}`); } }
  if (EMAIL_TO.length && EMAIL_FROM) { try { await sendGraphMail(EMAIL_TO, subject, text); via.push('email'); } catch (e) { errors.push(`email: ${graphError(e)}`); } }
  if (errors.length) console.warn(`[alerts] delivery problems: ${errors.join(' | ')}`);
  await p.query(`update sync_alerts set delivered_via=$2, delivered_at=now(), error=$3 where id = any($1::bigint[])`,
    [fresh.map((a) => a.id), via.join(','), errors.join(' | ') || null]);
}

function graphError(e: unknown): string {
  const ax = e as { response?: { status?: number; data?: unknown }; message?: string };
  const body = ax.response?.data ? JSON.stringify(ax.response.data).slice(0, 300) : '';
  const hint = ax.response?.status === 403 ? ' (grant Mail.Send application permission to the Entra app + admin consent)' : '';
  return `HTTP ${ax.response?.status ?? '?'} ${body || ax.message || ''}${hint}`;
}

// ── the sweep (called by the console server on a schedule) ──────────────────
export interface SweepResult { scanned: number; alerts: number; delivered: number; skipped?: string }

export async function sweepAlerts(opts: { lookbackDays?: number } = {}): Promise<SweepResult> {
  const p = db();
  if (!p) return { scanned: 0, alerts: 0, delivered: 0, skipped: 'no DATABASE_URL' };
  try {
    await ensureAlertsTable(p);
    const lookback = opts.lookbackDays ?? 7;
    const { rows } = await p.query<FailRow>(
      `select id, ts, worker, entity_id, action, message, detail, hits, last_ts
         from sync_events
        where worker = 'inv_pull' and status = 'fail'
          and coalesce(last_ts, ts) > now() - ($1 || ' days')::interval
        order by id`, [String(lookback)]);
    const alerts = classifyInventoryFailures(rows);
    // Chronic order post-backs, once a day.
    for (const [worker, action] of [['co', 'pull'], ['to', 'post']] as const) {
      const chronic = await chronicFailures(worker, action);
      alerts.push(...chronicAlerts(worker, chronic));
    }
    const fresh = await recordAlerts(p, alerts);
    await deliver(p, fresh);
    return { scanned: rows.length, alerts: alerts.length, delivered: fresh.length };
  } catch (e) {
    console.warn(`[alerts] sweep failed: ${(e as Error).message}`);
    return { scanned: 0, alerts: 0, delivered: 0, skipped: (e as Error).message };
  }
}

/** Last N alerts for the console page. */
export async function recentAlerts(limit = 100): Promise<unknown[]> {
  const p = db();
  if (!p) return [];
  await ensureAlertsTable(p);
  return (await p.query('select * from sync_alerts order by id desc limit $1', [limit])).rows;
}

/** Manual test: `node dist/sync/alerts.js --test` sends a synthetic alert through every channel. */
if (process.argv[1]?.endsWith('alerts.js') && process.argv.includes('--test')) {
  (async () => {
    const { subject, text } = formatDigest([{ kind: 'inv-dead-letter', worker: 'inv_pull', entityId: '0', message: 'TEST alert from the PK↔Deposco console — delivery check, nothing is wrong.', dedupeKey: `test:${Date.now()}` }]);
    console.log(`[alerts] channels: ${channelsConfigured().join(', ') || '(none configured)'}`);
    if (WEBHOOK_URL) { await sendWebhook(subject, text, []); console.log('[alerts] webhook OK'); }
    if (EMAIL_TO.length && EMAIL_FROM) { try { await sendGraphMail(EMAIL_TO, subject, text); console.log('[alerts] email OK'); } catch (e) { console.error(`[alerts] email FAILED: ${graphError(e)}`); process.exitCode = 1; } }
  })();
}
