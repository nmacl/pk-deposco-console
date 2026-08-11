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
// under 4/s even if two worker processes briefly overlap).
// A chained promise serializes acquisition so even concurrent callers stay spaced. Per-process
// (each scheduled worker is its own process) — combined with staggered scheduler starts + the
// 429 backoff below, this keeps us under Deposco's limit.
const DEPOSCO_MIN_INTERVAL_MS = parseInt(process.env.DEPOSCO_MIN_INTERVAL_MS ?? '350', 10);

// Rate-limit pressure counter. The throttle is PER-PROCESS and four workers run staggered 45s
// apart, so a run that overtakes its slot (the CO tick can push ~100 orders) overlaps the next
// worker and the combined rate exceeds Deposco's ~4/s. Retries absorb it silently, which means
// sustained pressure was previously invisible — workers now report this in their run counts so
// DEPOSCO_MIN_INTERVAL_MS can be tuned from data instead of guesswork.
let deposco429 = 0;
let httpRetries = 0;
export const rateLimitHits = (): number => deposco429;
export const retryCount = (): number => httpRetries;
let deposcoChain: Promise<void> = Promise.resolve();
let lastDeposcoAt = 0;
export function deposcoThrottle(): Promise<void> {
  const p = deposcoChain.then(async () => {
    const wait = lastDeposcoAt + DEPOSCO_MIN_INTERVAL_MS - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastDeposcoAt = Date.now();
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
  const MAX_ATTEMPTS = 4;
  let ax: AxiosError | undefined;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
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
      const retryable = isRateLimit || ((isTransient || isNetwork) && method === 'get');
      if (retryable && attempt < MAX_ATTEMPTS) {
        httpRetries++;
        if (isRateLimit && isDeposco(url)) deposco429++;
        const retryAfter = Number(ax.response?.headers?.['retry-after']);
        const waitMs = Number.isFinite(retryAfter) && retryAfter > 0
          ? retryAfter * 1000
          : Math.min(1500 * 2 ** (attempt - 1), 20_000) + Math.floor(Math.random() * 500);
        console.log(`[http] ${method.toUpperCase()} ${(url.split('.com')[1] ?? url).slice(0, 60)} → HTTP ${status ?? ax.code} — retry ${attempt}/${MAX_ATTEMPTS - 1} in ${waitMs}ms`);
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
  throw new Error(`${method.toUpperCase()} ${path} → HTTP ${status}: ${detail}`);
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
