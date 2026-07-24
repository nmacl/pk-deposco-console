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
import 'dotenv/config'; // load .env locally (Railway injects env vars directly)
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import pg from 'pg';

// Lazy read-only pool for rendering the sync logs (sync_runs / sync_events). Null if
// DATABASE_URL isn't set — the /logs view then shows "logging not configured".
let pgPool = null;
function db() {
  if (!process.env.DATABASE_URL) return null;
  if (!pgPool) pgPool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false }, max: 3, connectionTimeoutMillis: 10_000 });
  return pgPool;
}

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
<header><h1>PK ↔ Deposco Sync Console &nbsp;<a href="/logs" style="font-size:12px;font-weight:500;color:#8957e5;">→ Sync Logs</a></h1>
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

// Read-only ops view of the sync logs (sync_runs / sync_events). Polls /logs/data.
const LOGS_PAGE = /* html */ `<!doctype html><html><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Sync Logs — PK ↔ Deposco</title>
<style>
  :root { color-scheme: dark; } * { box-sizing: border-box; }
  body { margin:0; font:13px/1.5 -apple-system,Segoe UI,Roboto,sans-serif; background:#0d1117; color:#c9d1d9; }
  header { padding:14px 20px; border-bottom:1px solid #21262d; display:flex; align-items:center; gap:14px; flex-wrap:wrap; }
  h1 { margin:0; font-size:15px; font-weight:600; } a { color:#58a6ff; text-decoration:none; }
  .sub { color:#8b949e; font-size:12px; }
  .bar { display:flex; gap:8px; align-items:center; padding:12px 20px; flex-wrap:wrap; }
  button { padding:6px 12px; border-radius:6px; border:1px solid #30363d; background:#161b22; color:#c9d1d9; cursor:pointer; font-size:12px; font-weight:600; }
  button.on { background:#1f6feb; border-color:#1f6feb; color:#fff; }
  .runs { display:flex; gap:8px; padding:0 20px 10px; flex-wrap:wrap; }
  .run { border:1px solid #21262d; border-radius:6px; padding:6px 10px; font-size:11px; background:#0f141a; }
  .run b { color:#e6edf3; }
  table { width:calc(100% - 40px); margin:0 20px 24px; border-collapse:collapse; font-size:12.5px; }
  th { text-align:left; color:#8b949e; font-weight:600; border-bottom:1px solid #21262d; padding:6px 8px; position:sticky; top:0; background:#0d1117; }
  td { padding:6px 8px; border-bottom:1px solid #161b22; vertical-align:top; }
  tr.ev { cursor:pointer; } tr.ev:hover { background:#0f141a; }
  .badge { padding:1px 7px; border-radius:10px; font-size:11px; font-weight:700; }
  .s-fail { background:#3d1418; color:#ff7b72; } .s-desync,.s-floor { background:#3a2d10; color:#e3b341; }
  .s-ok { background:#12261a; color:#3fb950; } .s-skip { background:#1a1f26; color:#8b949e; }
  .side { font-size:10px; color:#8b949e; text-transform:uppercase; }
  .detail { display:none; white-space:pre-wrap; font:11px ui-monospace,Menlo,monospace; color:#8b949e; background:#010409; border:1px solid #21262d; border-radius:6px; padding:8px; margin-top:4px; }
  .mono { font:12px ui-monospace,Menlo,monospace; } .dim { color:#6e7681; }
</style></head><body>
<header><h1>Sync Logs</h1><a href="/">← Console</a>
  <span class="sub" id="status">loading…</span>
  <label class="sub" style="margin-left:auto;"><input type="checkbox" id="auto" checked/> auto-refresh 10s</label></header>
<div class="bar">
  <button data-f="issues" class="on">Issues (fail / desync)</button>
  <button data-f="fail">Failures only</button>
  <button data-f="all">All events</button>
  <button id="refresh" style="margin-left:auto;">Refresh now</button></div>
<div class="runs" id="runs"></div>
<table><thead><tr><th>Time</th><th>Worker</th><th>Entity</th><th>Status</th><th>Message</th></tr></thead><tbody id="rows"></tbody></table>
<script>
var filter='issues', timer=null;
function esc(s){ return String(s==null?'':s).replace(/[&<>]/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;'}[c];}); }
function fmt(ts){ return ts? new Date(ts).toLocaleString():''; }
function badge(s){ return '<span class="badge s-'+esc(s)+'">'+esc(s)+'</span>'; }
function load(){
  fetch('/logs/data?filter='+filter).then(function(r){return r.json();}).then(function(d){
    var st=document.getElementById('status');
    if(!d.configured){ st.textContent='⚠ logging not configured (no DATABASE_URL on this deploy)'; return; }
    if(d.error){ st.textContent='DB error: '+d.error; return; }
    st.textContent='updated '+new Date().toLocaleTimeString()+' · '+d.events.length+' event(s) shown';
    document.getElementById('runs').innerHTML=d.runs.map(function(r){ var c=r.counts||{}; return '<div class="run"><b>'+esc(r.worker)+'</b> '+esc(r.trigger)+' · '+esc(r.status||'…')+' <span class="dim">'+fmt(r.finished_at||r.started_at)+'</span><br>'+(c.posted||0)+' posted · '+(c.failed||0)+' fail · '+(c.floored||0)+' floor · '+(c.skipped||0)+' skip</div>'; }).join('');
    document.getElementById('rows').innerHTML=d.events.map(function(e){
      var detail=e.detail? JSON.stringify(e.detail,null,1):'';
      return '<tr class="ev"><td class="dim mono">'+fmt(e.ts)+'</td><td>'+esc(e.worker)+'</td><td class="mono">'+esc(e.entity_id||'')+(e.side?' <span class="side">'+esc(e.side)+'</span>':'')+'</td><td>'+badge(e.status)+'</td><td>'+esc(e.message||'')+'</td></tr>'
        +'<tr><td colspan="5" style="padding:0 8px 6px;"><div class="detail">'+esc(detail)+'</div></td></tr>';
    }).join('')||'<tr><td colspan="5" class="dim">no events</td></tr>';
  }).catch(function(e){ document.getElementById('status').textContent='fetch error: '+e.message; });
}
document.getElementById('rows').addEventListener('click',function(e){ var tr=e.target.closest('tr.ev'); if(!tr)return; var det=tr.nextElementSibling.querySelector('.detail'); if(det) det.style.display=det.style.display==='block'?'none':'block'; });
Array.prototype.forEach.call(document.querySelectorAll('button[data-f]'),function(b){ b.onclick=function(){ filter=b.getAttribute('data-f'); Array.prototype.forEach.call(document.querySelectorAll('button[data-f]'),function(x){x.className=x===b?'on':'';}); load(); }; });
document.getElementById('refresh').onclick=load;
function schedule(){ if(timer)clearInterval(timer); if(document.getElementById('auto').checked) timer=setInterval(load,10000); }
document.getElementById('auto').onchange=schedule;
load(); schedule();
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
  if (url.pathname === '/logs') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(LOGS_PAGE);
    return;
  }
  if (url.pathname === '/logs/data') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    const p = db();
    if (!p) { res.end(JSON.stringify({ configured: false })); return; }
    const filter = url.searchParams.get('filter') || 'issues';
    const limit = Math.min(parseInt(url.searchParams.get('limit') || '150', 10) || 150, 500);
    // fixed allowlist → no injection from the filter param
    const where = filter === 'fail' ? "where status = 'fail'"
      : filter === 'issues' ? "where status in ('fail','desync','floor')" : '';
    p.query(`select id,ts,worker,direction,entity_type,entity_id,action,status,side,message,detail from sync_events ${where} order by id desc limit $1`, [limit])
      .then((ev) => p.query('select id,worker,trigger,started_at,finished_at,status,counts from sync_runs order by id desc limit 15')
        .then((runs) => res.end(JSON.stringify({ configured: true, events: ev.rows, runs: runs.rows }))))
      .catch((e) => res.end(JSON.stringify({ configured: true, error: e.message })));
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
