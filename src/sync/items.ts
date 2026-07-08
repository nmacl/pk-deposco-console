/**
 * Shared lazy item-create for the sync workers. Previously triplicated verbatim in
 * po/co/to (each said "duplicated from po/sync.ts — factor out later"). This is later.
 *
 * When Deposco 404s an order push with "Item with business key number = [X]", the caller
 * looks X up in BC (Item_Variants by WebshopVariantCode → Item_Card_Excel), builds the
 * Deposco item payload, and POSTs /items so the retry succeeds.
 */
import axios, { type AxiosError } from 'axios';
import { getBcToken, ipv4Agent } from '../auth.js';
import { getDeposcoToken, type DeposcoConfig } from '../deposco.js';
import { bcGet, bcOdataBase, odataStr } from './bc-client.js';
import type { SyncBcConfig } from './config.js';

const DEFAULT_BU = process.env.DEPOSCO_COMPANY || 'HIVE';

export interface BcVariantFull { Item_No: string; Code: string; Description_2?: string; Size?: string; Block?: boolean; WebshopVariantCode?: string; UPC_GTN_No?: string; }
export interface BcCardFull { No: string; Description?: string; Brand?: string; Style?: string; Unit_Price?: number; Unit_Cost?: number; Blocked?: boolean; Sales_Blocked?: boolean; }

/**
 * Mirror of item/transform.ts (can't import it — the item bulk path isn't deployed here).
 * newPackFlag:false, Hive Pilot channel, WebshopVariantCode as the item number.
 */
export function buildDeposcoItem(card: BcCardFull, v: BcVariantFull, bu: string = DEFAULT_BU): Record<string, unknown> {
  const number = (v.WebshopVariantCode ?? '').trim() || `${v.Item_No}-${v.Code}`;
  const description = card.Description ?? '';
  const shortDescription = [card.Brand, card.Style, v.Description_2, v.Size].map((p) => (p ?? '').trim()).filter((p) => p.length > 0).join(' ');
  const active = card.Blocked !== true && v.Block !== true;
  const salesEnabled = card.Sales_Blocked !== true;
  const upc = (v.UPC_GTN_No ?? '').trim();
  return {
    number,
    businessUnit: { businessKey: { code: bu } },
    name: description,
    shortDescription,
    longDescription: description,
    active,
    salesEnabledFlag: salesEnabled,
    shippable: true,
    hazmat: false,
    inventoryTrackingEnabled: true,
    unitPrice: card.Unit_Price ?? 0,
    purchaseCost: card.Unit_Cost ?? 0,
    packs: [{
      type: 'Each', quantity: 1, newPackFlag: false,
      weight: { weight: 0, units: 'lb' },
      dimensions: { length: { measurement: 0, units: 'in' }, width: { measurement: 0, units: 'in' }, height: { measurement: 0, units: 'in' } },
    }],
    ...(upc ? { upcs: { data: [{ value: upc }] } } : {}),
    channels: [{
      integration: { businessKey: { name: 'Hive Pilot' } },
      listingStatus: 'Linked', saleable: salesEnabled, packQuantity: 1,
      ref1: v.Item_No, ref2: v.Code, ref3: 'EA', ref4: number,
    }],
  };
}

/** Pull the missing item number(s) out of Deposco's 404 error array. */
export function parseMissingItemNumbers(errors: Array<{ errorMessage?: string }> | undefined): string[] {
  const out: string[] = [];
  for (const e of errors ?? []) {
    const m = (e.errorMessage ?? '').match(/Item with business key number = \[([^\]]+)\]/i);
    if (m) out.push(m[1]);
  }
  return out;
}

/**
 * Look up an item in BC by WebshopVariantCode + its card, build the Deposco payload,
 * POST /items. Returns true on create, false if it can't (logged, never throws).
 */
export async function createMissingItem(bcCfg: SyncBcConfig, deposcoCfg: DeposcoConfig, number: string, bu: string = DEFAULT_BU): Promise<boolean> {
  const odata = bcOdataBase(bcCfg);
  try {
    const bcToken = await getBcToken(bcCfg);
    const vSel = ['Item_No', 'Code', 'Description_2', 'Size', 'Block', 'WebshopVariantCode', 'UPC_GTN_No'].join(',');
    const vBody = await bcGet<{ value: BcVariantFull[] }>(
      `${odata}/Item_Variants?$select=${encodeURIComponent(vSel)}&$filter=${encodeURIComponent(`WebshopVariantCode eq '${odataStr(number)}'`)}`,
      bcToken,
    );
    const v = vBody.value[0];
    if (!v) { console.warn(`[lazy] ${number}: no BC variant by WebshopVariantCode — cannot create`); return false; }
    const cSel = ['No', 'Description', 'Brand', 'Style', 'Unit_Price', 'Unit_Cost', 'Blocked', 'Sales_Blocked'].join(',');
    const cBody = await bcGet<{ value: BcCardFull[] }>(
      `${odata}/Item_Card_Excel?$select=${encodeURIComponent(cSel)}&$filter=${encodeURIComponent(`No eq '${odataStr(v.Item_No)}'`)}`,
      bcToken,
    );
    const card = cBody.value[0];
    if (!card) { console.warn(`[lazy] ${number}: no BC item card for Item_No ${v.Item_No} — cannot create`); return false; }
    const item = buildDeposcoItem(card, v, bu);
    const dToken = await getDeposcoToken(deposcoCfg);
    await axios.post(`${deposcoCfg.apiBase}/items`, item, {
      headers: { Authorization: `Bearer ${dToken}`, 'Content-Type': 'application/json' },
      httpsAgent: ipv4Agent, timeout: 30_000,
    });
    console.log(`[lazy] created item ${number} (BC ${v.Item_No}/${v.Code})`);
    return true;
  } catch (err) {
    const axErr = err as AxiosError<{ errors?: Array<{ errorMessage?: string }> }>;
    const msg = axErr.response?.data?.errors?.[0]?.errorMessage ?? (err instanceof Error ? err.message : String(err));
    console.error(`[lazy] ${number}: create failed — ${msg}`);
    return false;
  }
}
