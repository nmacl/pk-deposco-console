/**
 * Shared BC HTTP plumbing for the sync workers (po/co/to). Previously each monolith
 * carried its own copy of bcGet / pick / numOf / getCompanyId / URL builders.
 *
 * Three BC surfaces are addressed from here:
 *   - api/v2.0        (GUID-keyed standard API — purchaseOrders etc.)
 *   - ODataV4         (name-keyed OData pages — TransferOrderLines, Item_Card_Excel)
 *   - api/bmi/pk/v1.0 (our sibling extension's flattened read pages — bmiPurchaseOrderLines,
 *                      bmiSalesOrderLines, bmiTransferOrderLines. See al/.)
 */
import axios, { type AxiosError } from 'axios';
import { mkdirSync, readFileSync, rmdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getBcToken, ipv4Agent } from '../auth.js';
import type { SyncBcConfig } from './config.js';

export function bcApiBase(cfg: SyncBcConfig): string {
  return `https://api.businesscentral.dynamics.com/v2.0/${cfg.tenantId}/${cfg.environment}/api/v2.0`;
}

export function bcOdataBase(cfg: SyncBcConfig): string {
  return `https://api.businesscentral.dynamics.com/v2.0/${cfg.tenantId}/${cfg.environment}/ODataV4/Company('${encodeURIComponent(cfg.company)}')`;
}

export function bmiApiBase(cfg: SyncBcConfig): string {
  return `https://api.businesscentral.dynamics.com/v2.0/${cfg.tenantId}/${cfg.environment}/api/bmi/pk/v1.0`;
}

export const odataStr = (s: string): string => s.replace(/'/g, "''");

export type BcRow = Record<string, unknown>;

export const pick = (o: BcRow, ...names: string[]): string => {
  for (const n of names) { const v = o[n]; if (v != null && v !== '') return String(v); }
  return '';
};

export const numOf = (o: BcRow, ...names: string[]): number => Number(pick(o, ...names) || 0);

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * One-shot authed JSON request with the ipv4 agent + default timeout baked in, returning
 * the response body. Collapses the `{ headers: { Authorization }, httpsAgent, timeout }`
 * boilerplate repeated across the workers. Works for BC and Deposco (both bearer + ipv4).
 * Content-Type is set automatically when a body is present; pass If-Match etc. via headers.
 */
// ── Deposco rate limiter (Deposco allows ~4 req/sec) ────────────────────────────
// Space Deposco calls ≥ DEPOSCO_MIN_INTERVAL_MS apart (default 350ms ≈ 2.8/s, comfortable margin
// under 4/s).
//
// The limit is ACCOUNT-WIDE while the workers are separate processes, and the 45s scheduler
// stagger only separates their STARTS: measured 2026-08-20, po ticks run ~200-245s, to ~160-200s,
// ro ~120-137s (all every 5 min) and co ticks run ~36 MINUTES, so 3-4 workers fire concurrently
// most of the time — a per-process 350ms spacing multiplied out to ~11 req/s and daily 429 storms
// that exhausted even the 8-attempt budget. So the schedule is shared through the filesystem
// (every worker is spawned by server.mjs in the same container): a lock directory (mkdir is
// atomic) guards a "next free slot" timestamp file; each caller claims slot = max(now, last +
// interval), advances the file, and sleeps until its slot. The in-process promise chain stays as
// a cheap first stage so one process's concurrent callers queue without spinning on the lock.
const DEPOSCO_MIN_INTERVAL_MS = parseInt(process.env.DEPOSCO_MIN_INTERVAL_MS ?? '350', 10);
const THROTTLE_DIR = process.env.DEPOSCO_THROTTLE_DIR ?? join(tmpdir(), 'pk-deposco-throttle');
const THROTTLE_LOCK = join(THROTTLE_DIR, 'lock');
const THROTTLE_SLOT = join(THROTTLE_DIR, 'next-slot');
// A crashed holder must not wedge every worker: a lock this old is stale and gets stolen.
const LOCK_STALE_MS = 5_000;

const jitter = (base: number): number => base + Math.floor(Math.random() * base);

/** Claim the next global send slot (epoch ms). Falls back to "now" if the fs is unusable —
 *  a broken throttle file must degrade to the old per-process behaviour, never block syncs. */
async function claimDeposcoSlot(): Promise<number> {
  try {
    mkdirSync(THROTTLE_DIR, { recursive: true });
    const giveUpAt = Date.now() + 30_000;
    for (;;) {
      try { mkdirSync(THROTTLE_LOCK); break; } catch {
        try { if (Date.now() - statSync(THROTTLE_LOCK).mtimeMs > LOCK_STALE_MS) rmdirSync(THROTTLE_LOCK); } catch { /* raced another waiter */ }
        if (Date.now() > giveUpAt) return Date.now();
        await new Promise((r) => setTimeout(r, jitter(15)));
      }
    }
    try {
      let last = 0;
      try { last = Number(readFileSync(THROTTLE_SLOT, 'utf8')) || 0; } catch { /* first call */ }
      const slot = Math.max(Date.now(), last + DEPOSCO_MIN_INTERVAL_MS);
      writeFileSync(THROTTLE_SLOT, String(slot));
      return slot;
    } finally {
      try { rmdirSync(THROTTLE_LOCK); } catch { /* stolen as stale */ }
    }
  } catch {
    const slot = Math.max(Date.now(), lastDeposcoAt + DEPOSCO_MIN_INTERVAL_MS);
    lastDeposcoAt = slot;
    return slot;
  }
}

let deposcoChain: Promise<void> = Promise.resolve();
let lastDeposcoAt = 0;
export function deposcoThrottle(): Promise<void> {
  const p = deposcoChain.then(async () => {
    const slot = await claimDeposcoSlot();
    const wait = slot - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  });
  deposcoChain = p.catch(() => {});
  return p;
}
const isDeposco = (url: string): boolean => url.includes('deposco.com');

export async function authReq<T>(
  method: 'get' | 'post' | 'patch',
  url: string,
  token: string,
  opts: { data?: unknown; params?: Record<string, unknown>; headers?: Record<string, string>; timeout?: number } = {},
): Promise<T> {
  // Rate limits get a bigger budget than other faults. A 429 means the request was REJECTED, not
  // processed, so re-sending is always safe — and on 2026-08-11 three attempts over ~10s ran out
  // during a burst and DROPPED two POs and a transfer outright (status=fail, order never pushed).
  // Deposco's limit is ~4/s while the throttle is per-process across four workers, so bursts are
  // expected; patience is cheaper than a lost order.
  const MAX_ATTEMPTS = 4;
  const MAX_ATTEMPTS_RATE_LIMIT = parseInt(process.env.DEPOSCO_RATE_LIMIT_ATTEMPTS ?? '8', 10);
  // A deadlock can persist as long as the other transaction runs — a warehouse user posting a
  // large journal is seconds, not milliseconds — so give it a real window rather than 4 attempts
  // inside 4 seconds. Worst case ~35s, all of it safe: the victim is rolled back every time.
  const MAX_ATTEMPTS_DEADLOCK = parseInt(process.env.BC_DEADLOCK_ATTEMPTS ?? '8', 10);
  let ax: AxiosError | undefined;
  for (let attempt = 1; attempt <= Math.max(MAX_ATTEMPTS, MAX_ATTEMPTS_RATE_LIMIT, MAX_ATTEMPTS_DEADLOCK); attempt++) {
    try {
      if (isDeposco(url)) await deposcoThrottle();
      const resp = await axios.request<T>({
        method,
        url,
        data: opts.data,
        params: opts.params,
        headers: {
          Authorization: `Bearer ${token}`,
          ...(opts.data !== undefined ? { 'Content-Type': 'application/json' } : {}),
          ...opts.headers,
        },
        httpsAgent: ipv4Agent,
        timeout: opts.timeout ?? 30_000,
      });
      return resp.data;
    } catch (err) {
      ax = err as AxiosError;
      const status = ax.response?.status;
      // Retry: 429 (rate limit) for ANY method — a 429 means it was rejected, never processed,
      // so re-sending is safe. 5xx / network errors only for GET (POST/PATCH could double-apply).
      const isRateLimit = status === 429;
      const isTransient = status !== undefined && status >= 500;
      const isNetwork = !ax.response;
      // SQL deadlock, for ANY method. BC surfaces it as 409 Internal_ServerError "The activity was
      // deadlocked with another user who was modifying the Item Ledger…" — seen posting
      // bmiInventoryAdjustments while a warehouse user touched the same item. A deadlock VICTIM is
      // rolled back by SQL Server, so nothing was applied and re-posting cannot double-apply; that
      // is what makes this safe to retry where a plain 5xx on a POST is not.
      const errText = typeof ax.response?.data === 'string' ? ax.response.data : JSON.stringify(ax.response?.data ?? '');
      // Same shape on both sides of the integration: the write lost a race and was REJECTED, so
      // re-sending is safe. BC says "deadlocked with another user"; Deposco says 409 "The resource
      // was updated by a concurrent request. Please retry when the resource is not in use."
      const isDeadlock = /deadlock/i.test(errText)
        || (status === 409 && /concurrent request|not in use/i.test(errText));
      const retryable = isRateLimit || isDeadlock || ((isTransient || isNetwork) && method === 'get');
      const budget = isRateLimit ? MAX_ATTEMPTS_RATE_LIMIT : isDeadlock ? MAX_ATTEMPTS_DEADLOCK : MAX_ATTEMPTS;
      if (retryable && attempt < budget) {
        const retryAfter = Number(ax.response?.headers?.['retry-after']);
        // Deadlocks want a SHORT, heavily randomised wait: the lock clears the moment the other
        // transaction finishes, and a fixed backoff would just march both contenders back into
        // each other. Rate limits and 5xx keep the longer exponential climb.
        const waitMs = Number.isFinite(retryAfter) && retryAfter > 0
          ? retryAfter * 1000
          : isDeadlock
            ? 250 * 2 ** (attempt - 1) + Math.floor(Math.random() * 750)
            : Math.min(1500 * 2 ** (attempt - 1), 20_000) + Math.floor(Math.random() * 500);
        console.log(`[http] ${method.toUpperCase()} ${(url.split('.com')[1] ?? url).slice(0, 60)} → HTTP ${status ?? ax.code} — retry ${attempt}/${budget - 1} in ${waitMs}ms`);
        await new Promise((r) => setTimeout(r, waitMs));
        continue;
      }
      break;
    }
  }
  // Verbose-always: surface method + path + status + response body, so a failure never
  // collapses to a bare "Request failed with status code 400".
  const status = ax?.response?.status ?? ax?.code ?? '?';
  const body = ax?.response?.data;
  const q = opts.params ? '?' + Object.entries(opts.params).map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`).join('&') : '';
  const path = (url.split('.com')[1] ?? url) + q;
  const detail = (typeof body === 'string' ? body : JSON.stringify(body ?? ax?.message)).slice(0, 600);
  // 429 bodies are empty, which made failures read as a generic error with no cause. Say it.
  const note = status === 429 ? ` (Deposco rate limit — exhausted ${MAX_ATTEMPTS_RATE_LIMIT} attempts; raise DEPOSCO_MIN_INTERVAL_MS)` : '';
  // CAUSE FIRST, path last. Callers truncate this into a log column (sync_events.message is
  // sliced to ~180-300 chars); with the path leading, a long BC resource URL — tenant GUID,
  // company GUID, systemId GUID — ate the entire budget and every failure logged as a bare
  // "POST /v2.0/…/bmiSalesOrders(…)/Microsoft.NAV" with the actual error cut off the end. Weeks
  // of postShipment timeouts were invisible in /logs for exactly this reason.
  const err = new Error(`HTTP ${status}${note}: ${detail} — ${method.toUpperCase()} ${path}`) as Error & { httpStatus?: number };
  // The real HTTP status as DATA, not just prose: callers that classify transient-vs-permanent
  // (inv pull's dead-letter decision) were reading e.response?.status, got undefined on this
  // wrapped Error, and mislabelled every failure — a permanent 400 held the cursor for 3 days.
  err.httpStatus = ax?.response?.status;
  throw err;
}

/** GET with a 4-attempt backoff. Used for all read-side BC calls. */
export async function bcGet<T>(url: string, token: string, extraHeaders?: Record<string, string>): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const resp = await axios.get<T>(url, {
        headers: { Authorization: `Bearer ${token}`, ...extraHeaders },
        httpsAgent: ipv4Agent,
        timeout: 120_000,
      });
      return resp.data;
    } catch (e) {
      lastErr = e;
      const code = (e as AxiosError).code ?? (e as AxiosError).response?.status ?? (e as Error).message;
      console.log(`[bc] GET failed (${code}); retry ${attempt}/4 in ${2 * attempt}s`);
      await sleep(2000 * attempt);
    }
  }
  throw lastErr;
}

/**
 * GET every page of a BC OData collection, following `@odata.nextLink`.
 *
 * BC pages large results whether you ask it to or not, and a caller that reads `value` once gets a
 * silent partial set — the same failure mode as Deposco's nested collections. Verified against
 * Sales_Order_Line: 1,617 WESTERLY lines come back as 4 pages at maxpagesize=500 and the walked
 * total matches the unpaged total exactly.
 *
 * The page size is requested explicitly so behaviour doesn't drift with BC's default.
 */
export async function bcGetAll<T>(url: string, token: string, pageSize = 5000, maxPages = 200): Promise<T[]> {
  const out: T[] = [];
  interface ODataPage { value?: T[]; '@odata.nextLink'?: string }
  let next: string | undefined = url;
  for (let page = 0; page < maxPages && next; page++) {
    const body: ODataPage = await bcGet<ODataPage>(next, token, { Prefer: `odata.maxpagesize=${pageSize}` });
    out.push(...(body.value ?? []));
    next = body['@odata.nextLink'];
  }
  if (next) console.warn(`[bc] ${url.split('/').pop()?.slice(0, 60)}: stopped after ${maxPages} pages — result may be incomplete`);
  return out;
}

/** Company SystemId is the same across the api/v2.0, automation, and bmi surfaces; cache it per process. */
let cachedCompanyId: string | null = null;
export async function getCompanyId(cfg: SyncBcConfig, token?: string): Promise<string> {
  if (cachedCompanyId) return cachedCompanyId;
  const t = token ?? (await getBcToken(cfg));
  const body = await bcGet<{ value: Array<{ id: string; name: string }> }>(`${bcApiBase(cfg)}/companies`, t);
  const c = body.value.find((x) => x.name === cfg.company);
  if (!c) throw new Error(`BC company '${cfg.company}' not found`);
  cachedCompanyId = c.id;
  return c.id;
}

/** Run async work over items with a bounded concurrency (replaces the per-file copy). */
export async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}
