// One-time sweep: clear the middleware's RCPT-… placeholder out of "Vendor Invoice No." on
// open purchase orders. The old pull flow parked that ref there to satisfy
// Microsoft.NAV.receiveAndInvoice's validation; the new receive-only path (bmiPurchaseReceipts,
// extension v2.13) stores it in "PK Deposco Receipt Ref" instead, and Vendor Invoice No. must
// go back to holding the vendor's REAL invoice number for AP.
//
//   node scripts/clear-rcpt-vendor-inv.mjs           # dry run: list what would be cleared
//   node scripts/clear-rcpt-vendor-inv.mjs --apply   # actually clear (only values ^RCPT-)
import 'dotenv/config';
import { getBcToken } from '../dist/auth.js';
import { loadBcConfig } from '../dist/sync/config.js';
import { bcOdataBase, bcGetAll, authReq } from '../dist/sync/bc-client.js';

const APPLY = process.argv.includes('--apply');
const cfg = loadBcConfig();
const token = await getBcToken(cfg);
const odata = bcOdataBase(cfg);

// Only OPEN documents: posted/archived history is immutable anyway, and the field on a posted
// purchase invoice can't (and shouldn't) be rewritten after the fact.
const url = `${odata}/Purchase_Order?$filter=${encodeURIComponent("startswith(Vendor_Invoice_No,'RCPT-')")}&$select=No,Vendor_Invoice_No,Status`;
const rows = await bcGetAll(url, token);
console.log(`[sweep] env=${cfg.environment}: ${rows.length} open PO(s) carry an RCPT- placeholder in Vendor Invoice No.`);
for (const r of rows) console.log(`  ${r.No} (${r.Status}): ${r.Vendor_Invoice_No}`);

if (!APPLY) {
  console.log('[sweep] dry run — re-run with --apply to clear these.');
  process.exit(0);
}

let cleared = 0;
for (const r of rows) {
  if (!/^RCPT-/.test(r.Vendor_Invoice_No)) continue; // belt & suspenders: never touch real numbers
  await authReq('patch',
    `${odata}/Purchase_Order(Document_Type='Order',No='${String(r.No).replace(/'/g, "''")}')`, token,
    { data: { Vendor_Invoice_No: '' }, headers: { 'If-Match': '*' } });
  cleared++;
  console.log(`  cleared ${r.No}`);
}
console.log(`[sweep] ✓ cleared ${cleared}/${rows.length}`);
