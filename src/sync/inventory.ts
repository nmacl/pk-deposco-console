/**
 * Shared inventory-adjustment plumbing for the inv worker — the counterpart to orders.ts,
 * but for the separate inventory module. Covers both directions:
 *
 *   Deposco → BC (pull):  fetchInventoryAdjustments (GET /inventory/inventoryAdjustments,
 *                         paged, ID-descending, createdAfter cursor) → reverse-map the
 *                         WebshopVariantCode to a BC Item+Variant → postBcAdjustment (POST
 *                         the new bmiInventoryAdjustments write API → item journal post).
 *   BC → Deposco (push):  fetchBcAdjustmentEntries (GET bmiItemLedgerEntries, entryNo cursor,
 *                         skip our own 'DEP' docs) → forward-map Item+Variant → WebshopVariantCode
 *                         → postInventoryAdjustment (POST /inventory/inventoryAdjustments).
 *
 * Echo-break: BC-origin Deposco pushes carry reasonCode = INV_PUSH_REASON_CODE (default
 * 'BCSYNC'); the pull drops any adjustment with that reason. Deposco-origin BC posts get
 * documentNo 'DEP<id>'; the push drops any ILE whose documentNo starts 'DEP'.
 */
import type { DeposcoConfig } from '../deposco.js';
import { authReq, bcApiBase, bcGet, bcOdataBase, bmiApiBase, odataStr } from './bc-client.js';
import type { SyncBcConfig } from './config.js';

// ── Deposco reads ────────────────────────────────────────────────────────────
export interface DeposcoInvAdjustment {
  self: { id: number };
  item: { businessKey: { number: string } };
  facility: { businessKey: { number: string } };
  quantity: number; // signed delta
  actionType: string; // 'Adjustment' | 'Status Change'
  inventoryStatus: string; // 'Available' | 'Blocked'
  reasonCode?: string;
  createdDate: string;
}
interface InvAdjPage { data?: DeposcoInvAdjustment[]; links?: Array<{ rel?: string; href?: string }>; complete?: boolean }

/** Paged GET /inventory/inventoryAdjustments. Records come back ID-descending. */
export async function fetchInventoryAdjustments(
  cfg: DeposcoConfig,
  token: string,
  opts: { createdAfter?: string; actionType?: string; itemNumber?: string; pageSize?: number; maxPages?: number } = {},
): Promise<DeposcoInvAdjustment[]> {
  const maxPages = opts.maxPages ?? 50;
  const all: DeposcoInvAdjustment[] = [];
  let url = `${cfg.apiBase}/inventory/inventoryAdjustments`;
  let params: Record<string, unknown> | undefined = {
    businessUnit: cfg.company,
    pageSize: opts.pageSize ?? 100,
    ...(opts.createdAfter ? { createdAfter: opts.createdAfter } : {}),
    ...(opts.actionType ? { actionType: opts.actionType } : {}),
    ...(opts.itemNumber ? { itemNumber: opts.itemNumber } : {}),
  };
  for (let page = 0; page < maxPages; page++) {
    const body = await authReq<InvAdjPage>('get', url, token, { params });
    if (body.data) all.push(...body.data);
    if (body.complete) break;
    const next = body.links?.find((l) => l.rel === 'next')?.href;
    if (!next) break;
    url = next;
    params = undefined; // the next href already carries searchId
  }
  return all;
}

/** POST a BC-origin adjustment into Deposco, mirroring the GET record shape. */
export async function postInventoryAdjustment(
  cfg: DeposcoConfig,
  token: string,
  payload: {
    itemNumber: string; facilityNumber: string; quantity: number;
    reasonCode: string; inventoryStatus?: string;
  },
): Promise<unknown> {
  const body = {
    businessUnit: { businessKey: { code: cfg.company } },
    facility: { businessKey: { number: payload.facilityNumber } },
    item: { businessKey: { number: payload.itemNumber, 'businessUnit.code': cfg.company } },
    quantity: payload.quantity, // signed delta
    actionType: 'Adjustment',
    inventoryStatus: payload.inventoryStatus ?? 'Available',
    reasonCode: payload.reasonCode,
  };
  return authReq('post', `${cfg.apiBase}/inventory/inventoryAdjustments`, token, { data: body });
}

// ── BC ⇄ SKU mapping ──────────────────────────────────────────────────────────
export interface BcVariantRef { itemNo: string; variantCode: string; webshopVariantCode: string }

/** Deposco item number == WebshopVariantCode → BC Item No + Variant Code (the pull direction). */
export async function resolveByWebshopCode(cfg: SyncBcConfig, token: string, webshopCode: string): Promise<BcVariantRef | null> {
  const sel = encodeURIComponent('Item_No,Code,WebshopVariantCode');
  const filter = encodeURIComponent(`WebshopVariantCode eq '${odataStr(webshopCode)}'`);
  const body = await bcGet<{ value: Array<{ Item_No: string; Code: string; WebshopVariantCode?: string }> }>(
    `${bcOdataBase(cfg)}/Item_Variants?$select=${sel}&$filter=${filter}`, token);
  const v = body.value[0];
  if (!v) return null;
  return { itemNo: v.Item_No, variantCode: v.Code, webshopVariantCode: v.WebshopVariantCode ?? webshopCode };
}

/** BC Item No + Variant Code → WebshopVariantCode (the push direction). Cached per process. */
const fwdCache = new Map<string, string | null>();
export async function resolveWebshopCode(cfg: SyncBcConfig, token: string, itemNo: string, variantCode: string): Promise<string | null> {
  const key = `${itemNo}|${variantCode}`;
  if (fwdCache.has(key)) return fwdCache.get(key)!;
  const sel = encodeURIComponent('Item_No,Code,WebshopVariantCode');
  const filter = encodeURIComponent(`Item_No eq '${odataStr(itemNo)}' and Code eq '${odataStr(variantCode)}'`);
  const body = await bcGet<{ value: Array<{ WebshopVariantCode?: string }> }>(
    `${bcOdataBase(cfg)}/Item_Variants?$select=${sel}&$filter=${filter}`, token);
  const code = body.value[0]?.WebshopVariantCode?.trim() || null;
  fwdCache.set(key, code);
  return code;
}

// ── BC write (pull target) ────────────────────────────────────────────────────
export interface BcAdjustmentResult { entryNo?: number; posted?: boolean; itemLedgerEntryNo?: number; documentNo?: string; errorMessage?: string }

/** POST one adjustment to the new bmiInventoryAdjustments write API (posts to the item journal). */
export async function postBcAdjustment(
  cfg: SyncBcConfig,
  companyId: string,
  token: string,
  row: { itemNo: string; variantCode: string; locationCode: string; quantity: number; reasonCode?: string; externalAdjustmentId?: string },
): Promise<BcAdjustmentResult> {
  const url = `${bmiApiBase(cfg)}/companies(${companyId})/bmiInventoryAdjustments`;
  return authReq<BcAdjustmentResult>('post', url, token, {
    data: {
      itemNo: row.itemNo,
      variantCode: row.variantCode,
      locationCode: row.locationCode,
      quantity: row.quantity, // signed; the codeunit picks Positive/Negative Adjmt.
      ...(row.reasonCode ? { reasonCode: row.reasonCode } : {}),
      ...(row.externalAdjustmentId ? { externalAdjustmentId: row.externalAdjustmentId } : {}),
    },
  });
}

// ── BC read (push source) ──────────────────────────────────────────────────────
export interface BmiIleEntry { entryNo: number; itemNo: string; variantCode: string; locationCode: string; quantity: number; entryType: string; postingDate: string; documentNo: string }

/** Adjustment-type item ledger entries with entryNo gt cursor. Used to feed the BC→Deposco push. */
export async function fetchBcAdjustmentEntries(cfg: SyncBcConfig, companyId: string, token: string, afterEntryNo: number, top = 100): Promise<BmiIleEntry[]> {
  const filter = encodeURIComponent(`entryNo gt ${afterEntryNo}`);
  const url = `${bmiApiBase(cfg)}/companies(${companyId})/bmiItemLedgerEntries?$filter=${filter}&$orderby=entryNo asc&$top=${top}`;
  return (await authReq<{ value: BmiIleEntry[] }>('get', url, token)).value ?? [];
}

/** Highest adjustment-type ILE entryNo (for the no-backfill cursor init). */
export async function maxBcAdjustmentEntryNo(cfg: SyncBcConfig, companyId: string, token: string): Promise<number> {
  const url = `${bmiApiBase(cfg)}/companies(${companyId})/bmiItemLedgerEntries?$orderby=entryNo desc&$top=1`;
  return (await authReq<{ value: BmiIleEntry[] }>('get', url, token)).value?.[0]?.entryNo ?? 0;
}

/** Standard company-name → GUID (bcApiBase companies), needed for the bmi surface. */
export async function companyIdFor(cfg: SyncBcConfig, token: string): Promise<string> {
  const body = await bcGet<{ value: Array<{ id: string; name: string }> }>(`${bcApiBase(cfg)}/companies`, token);
  const c = body.value.find((x) => x.name === cfg.company) ?? body.value[0];
  if (!c) throw new Error(`BC company '${cfg.company}' not found`);
  return c.id;
}
