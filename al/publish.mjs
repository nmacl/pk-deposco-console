/**
 * Publish the compiled sibling extension to BC via the Automation API (headless).
 *   node al/publish.mjs [path-to-.app]     (default al/PK_Deposco_ReadAPI.app)
 *
 * Flow (Automation API v2.0 extensionUpload):
 *   1. GET  companies                              → companyId
 *   2. POST companies(id)/extensionUpload          {schedule, schemaSyncMode} → systemId + etag
 *   3. PATCH companies(id)/extensionUpload(sysId)   binary .app, If-Match: etag
 *   4. POST  .../Microsoft.NAV.upload               (trigger deploy; tolerated if not needed)
 *   5. poll  companies(id)/extensionDeploymentStatus
 * schemaSyncMode=Add (we only ADD a page + permissionset — no destructive table sync).
 */
import 'dotenv/config';
import axios from 'axios';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { getBcToken, ipv4Agent } from '../dist/auth.js';

const appPath = resolve(process.cwd(), process.argv[2] || 'al/PK_Deposco_ReadAPI.app');
const t = process.env.BC_TENANT_ID, e = process.env.BC_ENVIRONMENT;
const auto = `https://api.businesscentral.dynamics.com/v2.0/${t}/${e}/api/microsoft/automation/v2.0`;
const token = await getBcToken({ tenantId: t, clientId: process.env.BC_CLIENT_ID, clientSecret: process.env.BC_CLIENT_SECRET });
const H = { Authorization: `Bearer ${token}` };
const req = async (method, url, opts = {}) => {
  try {
    return await axios({ method, url, httpsAgent: ipv4Agent, timeout: 120_000, ...opts, headers: { ...H, ...opts.headers } });
  } catch (err) {
    const body = typeof err.response?.data === 'string' ? err.response.data : JSON.stringify(err.response?.data ?? err.message);
    throw new Error(`${method.toUpperCase()} ${url.split('/api/')[1] ?? url} → HTTP ${err.response?.status}: ${body.slice(0, 500)}`);
  }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const appBytes = await readFile(appPath);
console.log(`[pub] uploading ${appPath} (${(appBytes.byteLength / 1024).toFixed(1)}KB)`);

// 1. company
const company = (await req('get', `${auto}/companies`)).data.value[0];
console.log(`[pub] company ${company.name} id=${company.id}`);
const coBase = `${auto}/companies(${company.id})`;

// 2. reuse the singleton staging record if present, else create it
let entry = (await req('get', `${coBase}/extensionUpload`)).data.value?.[0];
if (entry) {
  console.log(`[pub] reusing existing extensionUpload systemId=${entry.systemId}`);
} else {
  entry = (await req('post', `${coBase}/extensionUpload`, {
    headers: { 'Content-Type': 'application/json' },
    data: { schedule: 'Current version', schemaSyncMode: 'Add' },
  })).data;
  console.log(`[pub] extensionUpload created systemId=${entry.systemId} schedule=${entry.schedule}`);
}
const sysId = entry.systemId;

// 3. PATCH the .app binary to the extensionContent navigation stream (NOT the entity itself)
await req('patch', `${coBase}/extensionUpload(${sysId})/extensionContent`, {
  headers: { 'Content-Type': 'application/octet-stream', 'If-Match': '*' },
  data: appBytes,
});
console.log('[pub] .app content uploaded → extensionContent (PATCH ok)');

// 4. trigger install (required bound action). NOTE: on our IPv4 keep-alive socket this
// POST frequently returns a bogus "Parse Error: Expected HTTP/" even though the server
// receives it and starts deploying — so tolerate that and fall through to polling.
try {
  await req('post', `${coBase}/extensionUpload(${sysId})/Microsoft.NAV.upload`, {
    headers: { 'Content-Type': 'application/json' },
  });
  console.log('[pub] Microsoft.NAV.upload triggered');
} catch (err) {
  console.log(`[pub] upload action returned a socket error (${String(err.message).slice(0, 60)}…) — server likely started anyway; polling`);
}

// 5. poll deployment status
console.log('[pub] polling extensionDeploymentStatus ...');
for (let i = 0; i < 40; i++) {
  await sleep(5000);
  let rows;
  try { rows = (await req('get', `${coBase}/extensionDeploymentStatus`)).data.value ?? []; }
  catch (err) { console.log(`[pub]   poll error HTTP ${err.response?.status}`); continue; }
  const mine = rows.find((r) => (r.name || '').includes('PK Deposco Read API')) ?? rows[0];
  if (!mine) { console.log('[pub]   (no deployment rows yet)'); continue; }
  console.log(`[pub]   ${mine.name}: ${mine.status} ${mine.operationType ?? ''}`);
  if (/Completed/i.test(mine.status)) { console.log('[pub] ✅ deployment completed'); process.exit(0); }
  if (/Failed|Error/i.test(mine.status)) {
    console.error(`[pub] ❌ deployment failed: ${JSON.stringify(mine).slice(0, 500)}`);
    process.exit(1);
  }
}
console.log('[pub] gave up polling (still in progress). Check extensionDeploymentStatus later.');
