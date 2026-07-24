/**
 * PK ↔ Deposco sync console — self-contained web UI for one-off manual syncs.
 *
 * Self-contained & Railway-ready: this folder is its own deployable repo. `npm run build`
 * compiles src/ → dist/, `npm start` runs this server. It spawns the compiled single-order
 * sync workers and streams their verbose stdout/stderr to the browser (SSE):
 *   TRFO...                      → dist/to/sync-to.js   (transfer)
 *   WSP...                       → dist/po/sync-po.js   (purchase order)
 *   PKSO/WSOD/HDSO/DISO/TEST...  → dist/co/sync-co.js   (sales -> customer order)
 * Two buttons per order: "Push → Deposco" (--push-only) and "Ship/Receive → BC" (--post-only).
 *
 * Env:
 *   PORT           listen port (Railway injects this; falls back to WEB_PORT then 8787)
 *   WEB_USER, WEB_PASS  if BOTH set, gate the whole app behind HTTP Basic Auth
 *   plus the BC_ and DEPOSCO_ vars the workers need (see .env.example)
 */
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const ROOT = dirname(fileURLToPath(import.meta.url));
const PORT = parseInt(process.env.PORT ?? process.env.WEB_PORT ?? '8787', 10);

// Optional HTTP Basic Auth gate. Enabled only when BOTH WEB_USER and WEB_PASS are set
// (so local dev stays open). This console mutates PRODUCTION Deposco/BC — set these on Railway.
const AUTH_USER = process.env.WEB_USER ?? '';
const AUTH_PASS = process.env.WEB_PASS ?? '';
const AUTH_ON = AUTH_USER !== '' && AUTH_PASS !== '';
function authOk(req) {
  if (!AUTH_ON) return true;
  const h = req.headers.authorization ?? '';
  if (!h.startsWith('Basic ')) return false;
  const [u, p] = Buffer.from(h.slice(6), 'base64').toString('utf8').split(':');
  return u === AUTH_USER && p === AUTH_PASS;
}

// prefix → compiled worker
function workerFor(order) {
  const u = order.toUpperCase();
  if (u.startsWith('TRFO')) return { script: 'dist/to/sync-to.js', kind: 'transfer' };
  if (u.startsWith('WSP')) return { script: 'dist/po/sync-po.js', kind: 'purchase order' };
  if (/^(PKSO|WSOD|HDSO|DISO|TEST)/.test(u)) return { script: 'dist/co/sync-co.js', kind: 'sales order' };
  return null;
}

const PAGE = /* html */ `<!doctype html><html><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>PK ↔ Deposco Sync Console</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin:0; font:14px/1.5 -apple-system,Segoe UI,Roboto,sans-serif; background:#0d1117; color:#c9d1d9; }
  header { padding:16px 20px; border-bottom:1px solid #21262d; }
  h1 { margin:0; font-size:16px; font-weight:600; }
  .sub { color:#8b949e; font-size:12px; margin-top:2px; }
  .bar { display:flex; gap:8px; align-items:center; padding:16px 20px; flex-wrap:wrap; }
  input { flex:0 0 220px; padding:9px 12px; border-radius:6px; border:1px solid #30363d; background:#010409; color:#e6edf3; font:14px monospace; text-transform:uppercase; }
  input:focus { outline:none; border-color:#1f6feb; }
  .chip { font-size:12px; padding:3px 9px; border-radius:20px; background:#161b22; border:1px solid #30363d; color:#8b949e; }
  .chip.ok { color:#3fb950; border-color:#238636; } .chip.bad { color:#f85149; border-color:#8b2b25; }
  button { padding:9px 14px; border-radius:6px; border:1px solid #30363d; cursor:pointer; font-size:13px; font-weight:600; color:#e6edf3; }
  button:disabled { opacity:.45; cursor:not-allowed; }
  .push { background:#1f6feb; border-color:#1f6feb; }
  .post { background:#238636; border-color:#238636; }
  .inv { background:#8957e5; border-color:#8957e5; }
  .sep { width:1px; align-self:stretch; background:#30363d; margin:0 4px; }
  .clear { background:#161b22; margin-left:auto; }
  #log { margin:0 20px 20px; padding:12px 14px; background:#010409; border:1px solid #21262d; border-radius:8px;
         height:calc(100vh - 190px); overflow:auto; font:12.5px/1.55 ui-monospace,SFMono-Regular,Menlo,monospace; white-space:pre-wrap; }
  .ln { display:block; }
  .run { color:#58a6ff; font-weight:700; margin-top:10px; border-top:1px dashed #21262d; padding-top:8px; }
  .err { color:#f85149; } .warn { color:#d29922; } .ok { color:#3fb950; } .dim { color:#6e7681; }
</style></head><body>
<header><h1>PK ↔ Deposco Sync Console</h1>
<div class="sub">Type one or more BC order #s — space/comma separated (TRFO / WSP / PKSO / WSOD / HDSO / DISO / TEST). ① pushes to Deposco. ② posts the Deposco ship/receive back to BC. Runs sequentially.</div></header>
<div class="bar">
  <input id="order" placeholder="WSOD139248, WSOD139249 TEST0001" autocomplete="off" spellcheck="false"/>
  <span id="type" class="chip">enter an order</span>
  <button class="push" id="btnPush" disabled>① Push → Deposco</button>
  <button class="post" id="btnPost" disabled>② Ship / Receive → BC</button>
  <span class="sep"></span>
  <button class="inv" id="btnInvPull">Inventory Pull (Deposco → BC)</button>
  <button class="clear" id="btnClear">Clear log</button>
</div>
<div id="log"></div>
<script>
const $=(id)=>document.getElementById(id);
const order=$('order'), type=$('type'), log=$('log');
const kinds=[['TRFO','transfer'],['WSP','purchase order'],['PKSO','sales order'],['WSOD','sales order'],['HDSO','sales order'],['DISO','sales order'],['TEST','sales order']];
function parseOrders(v){ return [...new Set(v.split(/[\\s,]+/).map(s=>s.trim().toUpperCase()).filter(Boolean))]; }
function detectOne(o){ const m=kinds.find(([p])=>o.startsWith(p)); return m?m[1]:null; }
function refresh(){
  const list=parseOrders(order.value);
  const valid=list.filter(detectOne), bad=list.filter(o=>!detectOne(o));
  if(list.length===0){ type.textContent='enter order(s)'; type.className='chip'; }
  else if(valid.length===0){ type.textContent='unknown prefix'; type.className='chip bad'; }
  else { type.textContent=valid.length+' order'+(valid.length>1?'s':'')+(bad.length?' (+'+bad.length+' unknown)':''); type.className='chip ok'; }
  const ok = valid.length>0;
  $('btnPush').disabled=!ok; $('btnPost').disabled=!ok;
}
order.addEventListener('input',refresh);
function line(text,cls){ const el=document.createElement('span'); el.className='ln '+(cls||''); el.textContent=text; log.appendChild(el); log.scrollTop=log.scrollHeight; }
function classify(t){ if(/error|fatal|❌|failed/i.test(t))return'err'; if(/warn|⚠|skip/i.test(t))return'warn'; if(/✅|posted|ok\\b|accepted|completed|HTTP 20/i.test(t))return'ok'; return ''; }
function run(mode){
  const list=parseOrders(order.value); if(!list.length)return;
  const label=mode==='push'?'PUSH → Deposco':'SHIP/RECEIVE → BC';
  line('\\n════════ '+list.length+' order(s)  '+label+'  '+new Date().toLocaleTimeString()+' ════════','run');
  $('btnPush').disabled=true; $('btnPost').disabled=true;
  const es=new EventSource('/sync?orders='+encodeURIComponent(list.join(','))+'&mode='+mode);
  es.onmessage=(e)=>line(e.data, classify(e.data));
  es.addEventListener('done',(e)=>{ line('▸ batch done (exit '+e.data+')','dim'); es.close(); refresh(); });
  es.onerror=()=>{ line('▸ stream closed','dim'); es.close(); refresh(); };
}
$('btnPush').onclick=()=>run('push');
$('btnPost').onclick=()=>run('post');
function runInvPull(){
  line('\\n──────── INVENTORY PULL (Deposco → BC)  '+new Date().toLocaleTimeString()+' ────────','run');
  $('btnInvPull').disabled=true;
  const es=new EventSource('/inv?dir=pull');
  es.onmessage=(e)=>line(e.data, classify(e.data));
  const stop=()=>{ $('btnInvPull').disabled=false; es.close(); };
  es.addEventListener('done',(e)=>{ line('▸ exit '+e.data,'dim'); stop(); });
  es.onerror=()=>{ line('▸ stream closed','dim'); stop(); };
}
$('btnInvPull').onclick=runInvPull;
$('btnClear').onclick=()=>log.innerHTML='';
order.addEventListener('keydown',(e)=>{ if(e.key==='Enter'&&!$('btnPush').disabled) run('push'); });
refresh(); order.focus();
</script></body></html>`;

const server = createServer((req, res) => {
  if (!authOk(req)) {
    res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="PK Deposco Console"' });
    res.end('auth required');
    return;
  }
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.pathname === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(PAGE);
    return;
  }
  if (url.pathname === '/sync') {
    // Accepts one or many orders (?orders=A,B,C — or legacy ?order=A). Mixed types are fine;
    // each routes to its own worker and runs SEQUENTIALLY (readable logs, no concurrent posts).
    const raw = url.searchParams.get('orders') || url.searchParams.get('order') || '';
    const mode = url.searchParams.get('mode') === 'post' ? 'post' : 'push';
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    const send = (data) => res.write(`data: ${String(data).replace(/\n/g, '\ndata: ')}\n\n`);
    const done = (code) => { res.write(`event: done\ndata: ${code}\n\n`); res.end(); };

    const orders = [...new Set(raw.split(/[\s,]+/).map((s) => s.trim().toUpperCase()).filter(Boolean))].slice(0, 50);
    if (orders.length === 0) { send('no order numbers provided'); return done(1); }

    const flag = mode === 'push' ? '--push-only' : '--post-only';
    let currentChild = null;
    let aborted = false;
    req.on('close', () => { aborted = true; if (currentChild) currentChild.kill(); });

    const runOne = (order) => new Promise((resolveRun) => {
      if (!/^[A-Za-z0-9._-]+$/.test(order)) { send(`⚠ ${order}: invalid order number — skipped`); return resolveRun(); }
      const w = workerFor(order);
      if (!w) { send(`⚠ ${order}: unknown order prefix — skipped`); return resolveRun(); }
      send(`\n──────── ${order}  (${w.kind})  ${flag} ────────`);
      const child = spawn('node', [resolve(ROOT, w.script), '--order', order, flag], { cwd: ROOT, env: process.env });
      currentChild = child;
      let buf = '';
      const onData = (chunk) => {
        buf += chunk.toString();
        const parts = buf.split('\n');
        buf = parts.pop() ?? '';
        for (const l of parts) send(l);
      };
      child.stdout.on('data', onData);
      child.stderr.on('data', onData);
      child.on('close', (code) => { if (buf) send(buf); send(`▸ ${order} exit ${code ?? 0}`); currentChild = null; resolveRun(); });
      child.on('error', (err) => { send(`▸ ${order} spawn error: ${err.message}`); currentChild = null; resolveRun(); });
    });

    (async () => {
      send(`▸ ${orders.length} order(s) [${mode}]: ${orders.join(', ')}`);
      for (const order of orders) {
        if (aborted) break;
        await runOne(order);
      }
      if (!aborted) done(0);
    })();
    return;
  }
  // Inventory-adjustment sync — one batch PULL tick (Deposco → BC). Not order-scoped.
  // Push (BC → Deposco) is intentionally not exposed: Deposco's inventoryAdjustments endpoint
  // is read-only and the write path needs the DISCRETE_INVENTORY_API subscription (off on HIVE).
  if (url.pathname === '/inv') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    const send = (data) => res.write(`data: ${String(data).replace(/\n/g, '\ndata: ')}\n\n`);

    const args = [resolve(ROOT, 'dist/inv/sync-inv.js'), '--once', '--pull-only'];
    send('▸ inventory pull: node dist/inv/sync-inv.js --once --pull-only');
    const child = spawn('node', args, { cwd: ROOT, env: process.env });

    let buf = '';
    const onData = (chunk) => {
      buf += chunk.toString();
      const parts = buf.split('\n');
      buf = parts.pop() ?? '';
      for (const l of parts) send(l);
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('close', (code) => { if (buf) send(buf); res.write(`event: done\ndata: ${code ?? 0}\n\n`); res.end(); });
    child.on('error', (err) => { send(`spawn error: ${err.message}`); res.write('event: done\ndata: 1\n\n'); res.end(); });
    req.on('close', () => { child.kill(); });
    return;
  }
  res.writeHead(404); res.end('not found');
});

server.listen(PORT, () => {
  console.log(`[web] PK ↔ Deposco sync console → http://localhost:${PORT}`);
  console.log(`[web] basic auth: ${AUTH_ON ? 'ON' : 'OFF (set WEB_USER + WEB_PASS to enable)'}`);
});
