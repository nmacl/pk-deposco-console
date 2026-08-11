/**
 * Pre-seed Deposco with the item MASTER for SKUs stocked at a BC location.
 * Sources BC Production `StockkeepingUnitList` (Location + Item_Sub_Type filter) — one feed,
 * no join. Smoke-test / bootstrap tool — NOT part of the scheduled console.
 *
 *   node scripts/seed-items.mjs            # DRY RUN — prints payloads, no POST
 *   node scripts/seed-items.mjs --post     # actually POST /items to Deposco
 *
 * Env:
 *   SEED_BC_ENV               (default Production) — BC environment to READ from (independent of
 *                             BC_ENVIRONMENT, so the running console can stay on PILOT)
 *   SEED_LOCATION             (default WESTERLY)   — Location_Code filter
 *   SEED_SUBTYPES             (default "Blank,FG")  — Item_Sub_Type values to include
 *   SEED_LIMIT                (default 10)          — max SKUs to seed
 *   DEPOSCO_INTEGRATION_NAME  (default '' = NO channel) — prod integration/channel name
 *   DEPOSCO_COMPANY           (BU code, default HIVE)
 *   BC_* (tenant/creds)  +  DEPOSCO_* (target env for --post)
 */
import 'dotenv/config';
import axios from 'axios';
import { getBcToken, ipv4Agent } from '../dist/auth.js';
import { getDeposcoToken } from '../dist/deposco.js';
import { loadBcConfig, loadDeposcoConfig } from '../dist/sync/config.js';

const SEED_BC_ENV = process.env.SEED_BC_ENV || 'Production';
const LOCATION = process.env.SEED_LOCATION || 'WESTERLY';
const SUBTYPES = (process.env.SEED_SUBTYPES || 'Blank,FG').split(',').map((s) => s.trim()).filter(Boolean);
const LIMIT = parseInt(process.env.SEED_LIMIT || '10', 10);
const INTEGRATION = process.env.DEPOSCO_INTEGRATION_NAME ?? '';
const BU = process.env.DEPOSCO_COMPANY || 'HIVE';
const POST = process.argv.includes('--post');
const enc = encodeURIComponent;

// StockkeepingUnitList carries no UPC field, so the one-feed design can't populate upcs.
// Join Item_Variants by WebshopVariantCode (same key Deposco uses as item.number) to pick up
// UPC_GTN_No — mirrors src/sync/items.ts buildDeposcoItem. Chunked to keep the $filter short.
async function fetchUpcMap(token, numbers) {
  const map = new Map();
  const CHUNK = 25;
  for (let i = 0; i < numbers.length; i += CHUNK) {
    const clause = numbers.slice(i, i + CHUNK)
      .map((n) => `WebshopVariantCode eq '${n.replace(/'/g, "''")}'`).join(' or ');
    const u = `${BC_BASE}/Item_Variants?$select=${enc('WebshopVariantCode,UPC_GTN_No')}&$filter=${enc(clause)}`;
    const rows = (await axios.get(u, { headers: { Authorization: `Bearer ${token}` }, httpsAgent: ipv4Agent, timeout: 60_000 })).data.value || [];
    for (const v of rows) {
      const upc = (v.UPC_GTN_No ?? '').trim();
      if (upc) map.set((v.WebshopVariantCode ?? '').trim(), upc);
    }
  }
  return map;
}

function buildItem(r, upc = '') {
  const number = (r.WebshopVariantCode ?? '').trim() || `${r.Item_No}-${r.Variant_Code}`;
  const description = r.Description ?? '';
  const shortDescription = [r.Brand, r.Style, r.Color, r.Size].map((p) => (p ?? '').trim()).filter(Boolean).join(' ');
  // Seed as active/sellable regardless of the SKU's location-level IsActive (ignored per PK).
  const active = true;
  return {
    number,
    businessUnit: { businessKey: { code: BU } },
    name: description,
    shortDescription,
    longDescription: description,
    active,
    salesEnabledFlag: active,
    shippable: true,
    hazmat: false,
    inventoryTrackingEnabled: true,
    unitPrice: 0,
    purchaseCost: 0,
    packs: [{
      type: 'Each', quantity: 1, newPackFlag: false,
      weight: { weight: 0, units: 'lb' },
      dimensions: { length: { measurement: 0, units: 'in' }, width: { measurement: 0, units: 'in' }, height: { measurement: 0, units: 'in' } },
    }],
    ...(upc ? { upcs: { data: [{ value: upc }] } } : {}),
    ...(INTEGRATION ? { channels: [{
      integration: { businessKey: { name: INTEGRATION } },
      listingStatus: 'Linked', saleable: active, packQuantity: 1,
      ref1: r.Item_No, ref2: r.Variant_Code, ref3: 'EA', ref4: number,
    }] } : {}),
  };
}

const bcCfg = loadBcConfig();
const dCfg = loadDeposcoConfig();
const BC_BASE = `https://api.businesscentral.dynamics.com/v2.0/${bcCfg.tenantId}/${SEED_BC_ENV}/ODataV4/Company('${bcCfg.company}')`;
console.log(`[seed] READ BC ${SEED_BC_ENV} (${bcCfg.company})  ->  ${POST ? `POST Deposco ${dCfg.apiBase} BU=${BU} integration='${INTEGRATION || '(none)'}'` : 'DRY RUN (no POST)'}`);
console.log(`[seed] filter: Location_Code='${LOCATION}' and Item_Sub_Type in (${SUBTYPES.join(', ')})   limit=${LIMIT}\n`);

const t = await getBcToken(bcCfg);
const subFilter = SUBTYPES.map((s) => `Item_Sub_Type eq '${s.replace(/'/g, "''")}'`).join(' or ');
const url = `${BC_BASE}/StockkeepingUnitList?$filter=${enc(`Location_Code eq '${LOCATION}' and (${subFilter})`)}&$top=${LIMIT}`;
const rows = (await axios.get(url, { headers: { Authorization: `Bearer ${t}` }, httpsAgent: ipv4Agent, timeout: 60_000 })).data.value || [];
console.log(`[seed] ${rows.length} SKU(s) fetched`);

const wanted = rows.map((r) => (r.WebshopVariantCode ?? '').trim()).filter(Boolean);
const upcMap = await fetchUpcMap(t, wanted);
console.log(`[seed] UPCs resolved from Item_Variants: ${upcMap.size}/${wanted.length}\n`);

let ok = 0, fail = 0;
for (const r of rows) {
  const upc = upcMap.get((r.WebshopVariantCode ?? '').trim()) ?? '';
  const item = buildItem(r, upc);
  if (!POST) {
    console.log(`  DRY  ${item.number}  subtype=${r.Item_Sub_Type}  active=${item.active}  inv=${r.Inventory}  upc=${upc || '(none)'}  "${item.name}"  [${item.shortDescription}]`);
    continue;
  }
  try {
    const dt = await getDeposcoToken(dCfg);
    await axios.post(`${dCfg.apiBase}/items`, item, { headers: { Authorization: `Bearer ${dt}`, 'Content-Type': 'application/json' }, httpsAgent: ipv4Agent, timeout: 30_000 });
    console.log(`  ✅ ${item.number}: created`);
    ok++;
  } catch (e) {
    const msg = e.response?.data?.errors?.[0]?.errorMessage ?? e.response?.status ?? e.message;
    console.log(`  ❌ ${item.number}: ${JSON.stringify(msg)}`);
    fail++;
  }
}
console.log(POST ? `\n[seed] done — created ${ok}, failed ${fail}` : `\n[seed] dry run complete — ${rows.length} previewed. Add --post (with prod DEPOSCO_* + DEPOSCO_INTEGRATION_NAME) to create.`);
