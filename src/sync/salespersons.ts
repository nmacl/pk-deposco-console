/**
 * BC salesperson code → name, via our AL read page bmiSalespersons (page 60219, AL >= 2.18).
 *
 * BC's api/v2.0 has no salesperson entity and the ODataV4 Salespersons_Purchasers web service is
 * not published, so before 2.18 a sales order's Salesperson_Code (e.g. "SP-070") could not be
 * turned into a rep's name from the middleware. The CO push needs the NAME for Deposco's
 * customAttribute5 (Parker @ Deposco, 2026-09-22). Whole table is cached per process — it is a
 * few dozen rows and the worker is a short-lived --once child.
 */
import { authReq, bmiApiBase } from './bc-client.js';
import type { SyncBcConfig } from './config.js';

interface SpRow { code?: string; name?: string; email?: string; blocked?: boolean }

let table: Map<string, SpRow> | null = null;

async function load(cfg: SyncBcConfig, companyId: string, token: string): Promise<Map<string, SpRow>> {
  if (table) return table;
  const body = await authReq<{ value?: SpRow[] }>('get', `${bmiApiBase(cfg)}/companies(${companyId})/bmiSalespersons`, token, { params: { $top: 1000 } });
  table = new Map((body.value ?? []).map((r) => [String(r.code ?? '').trim().toUpperCase(), r]));
  return table;
}

/** Rep's display name for a Salesperson Code, or null when the code is blank/unknown. */
export async function salespersonName(cfg: SyncBcConfig, companyId: string, token: string, code: string): Promise<string | null> {
  const key = code.trim().toUpperCase();
  if (!key) return null;
  const row = (await load(cfg, companyId, token)).get(key);
  const name = row?.name?.trim();
  return name || null;
}

/** Test seam — lets callers (and tests) preload the cache without a BC round trip. */
export function primeSalespersons(rows: SpRow[]): void {
  table = new Map(rows.map((r) => [String(r.code ?? '').trim().toUpperCase(), r]));
}
