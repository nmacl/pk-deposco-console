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
export async function authReq<T>(
  method: 'get' | 'post' | 'patch',
  url: string,
  token: string,
  opts: { data?: unknown; params?: Record<string, unknown>; headers?: Record<string, string>; timeout?: number } = {},
): Promise<T> {
  try {
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
    // Verbose-always: surface method + path + status + response body on EVERY failure,
    // so a 400 never collapses to a bare "Request failed with status code 400".
    const ax = err as AxiosError;
    const status = ax.response?.status ?? ax.code ?? '?';
    const body = ax.response?.data;
    const q = opts.params ? '?' + Object.entries(opts.params).map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`).join('&') : '';
    const path = (url.split('.com')[1] ?? url) + q;
    const detail = (typeof body === 'string' ? body : JSON.stringify(body ?? ax.message)).slice(0, 600);
    throw new Error(`${method.toUpperCase()} ${path} → HTTP ${status}: ${detail}`);
  }
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
