/**
 * Deposco trading partners — find-or-create by code.
 *
 * Why this exists: the purchaseOrder's `consigneePartner` (the "Consignee Partner" column ops
 * asked to carry the BC vendor name, 2026-09-22) is NOT free text — it is an EntityRef to a
 * tradingPartner record (`{ businessKey: { code, 'businessUnit.code' } }`, confirmed live on
 * SO5992 → tradingPartners/9 "Third Party Billing"). So a vendor has to exist as a trading partner
 * before a PO can point at it. Codes may contain spaces ("Standard Billing" exists), so the
 * vendor NAME is used as both code and name — vendor number was explicitly not wanted since
 * nothing ties Deposco back to BC on this side.
 *
 * Cached per process (the PO worker is a short-lived --once child, so this is per tick).
 * POST /tradingPartners is allowed (OPTIONS → GET,HEAD,POST). Never throws on the lookup path
 * for a partner that exists; a create failure surfaces to the caller, who decides whether to push
 * the order without the partner.
 */
import type { DeposcoConfig } from '../deposco.js';
import { authReq } from './bc-client.js';

// Deposco trading-partner code length is not documented; 50 is safely inside what the UI
// accepts for existing codes and long enough for every vendor name in BC (Text[100] there, but
// the longest live one is ~40).
export const PARTNER_CODE_MAX = 50;

export function partnerCodeFor(vendorName: string): string {
  return vendorName.replace(/\s+/g, ' ').trim().slice(0, PARTNER_CODE_MAX).trim();
}

interface TpRow { self?: { id?: number }; code?: string; name?: string }
interface TpPage { data?: TpRow[] }

const known = new Map<string, number>();   // code (upper) → id

async function findPartner(cfg: DeposcoConfig, token: string, code: string): Promise<number | null> {
  const cached = known.get(code.toUpperCase());
  if (cached !== undefined) return cached;
  const body = await authReq<TpPage>('get', `${cfg.apiBase}/tradingPartners`, token, { params: { code, pageSize: 25 } });
  // The `code` filter may be a prefix/contains match on Deposco's side — compare exactly.
  const hit = (body.data ?? []).find((r) => (r.code ?? '').trim().toUpperCase() === code.toUpperCase());
  if (hit?.self?.id !== undefined) { known.set(code.toUpperCase(), hit.self.id); return hit.self.id; }
  return null;
}

/**
 * Returns the trading-partner code to reference for this vendor, creating the partner in
 * Deposco if it does not exist yet. Returns null for a blank name.
 */
export async function ensureTradingPartner(cfg: DeposcoConfig, token: string, vendorName: string): Promise<string | null> {
  const code = partnerCodeFor(vendorName);
  if (!code) return null;
  if (await findPartner(cfg, token, code) !== null) return code;

  console.log(`[partner] creating Deposco trading partner "${code}"`);
  const created = await authReq<TpRow>('post', `${cfg.apiBase}/tradingPartners`, token, {
    data: { businessUnit: { businessKey: { code: cfg.company } }, code, name: code },
    timeout: 30_000,
  }).catch(async (err) => {
    // Lost a race with another worker process, or Deposco's `code` filter missed it: re-read
    // before giving up, since "already exists" is success for our purposes.
    if (await findPartner(cfg, token, code) !== null) return null;
    throw err;
  });
  if (created?.self?.id !== undefined) known.set(code.toUpperCase(), created.self.id);
  else if (!known.has(code.toUpperCase())) await findPartner(cfg, token, code);
  return code;
}

/** EntityRef shape Deposco expects on purchaseOrder.consigneePartner / customerOrder.tradingPartner. */
export function partnerRef(code: string, bu: string): { businessKey: { code: string; 'businessUnit.code': string } } {
  return { businessKey: { code, 'businessUnit.code': bu } };
}
