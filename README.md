# PK ↔ Deposco Sync Console

A self-contained web UI for **one-off manual syncs** between Business Central and Deposco.
Type a BC order number, hit a button, watch the verbose log stream live.

- `TRFO…` → transfer (ship / receive)
- `WSP…` → purchase order
- `PKSO / WSOD / HDSO / DISO…` → sales → customer order

Each order gets two buttons:
1. **Push → Deposco** — sends the order to Deposco (`--push-only`).
2. **Ship / Receive → BC** — posts the Deposco ship/receive back into BC (`--post-only`).

## Run locally

```bash
cp .env.example .env      # fill in the BC_* and DEPOSCO_* secrets
npm install
npm run dev               # build + serve on http://localhost:8787
```

## Deploy to Railway

1. Push this folder to a GitHub repo.
2. In Railway: **New Project → Deploy from GitHub repo** → pick it.
3. Railway auto-detects Node, runs `npm run build`, then `npm start` (see `railway.json`).
4. Add the environment variables from `.env.example` in the Railway **Variables** tab
   (do **not** commit `.env` — it's gitignored).
5. Set **`WEB_USER`** and **`WEB_PASS`** to password-protect the console — it mutates
   production Deposco/BC, so don't leave the public URL open.

`PORT` is injected by Railway automatically; no need to set it.

## How it works

`server.mjs` is a zero-framework Node HTTP + SSE server. On a button click it spawns the
compiled single-order worker (`dist/{to,po,co}/sync-*.js --order <n> --push-only|--post-only`)
and streams its stdout/stderr to the browser. All the sync logic lives in `src/` (a copy of
the middleware's worker + shared modules), compiled to `dist/` by `tsc`.

## Alerts (added 2026-09-22)

`/alerts` lists permanent sync failures; the server sweeps `sync_events` every `ALERT_SCHEDULE_MS`
(default 5 min) and delivers each NEW alert once:

- **inv-dead-letter** — an inventory adjustment BC rejected for good (dimension / insufficient qty /
  unmappable SKU). Fix in BC by hand; Deposco and BC are out of step for that item until you do.
- **inv-stuck** — a "transient" failure (timeout / 5xx) that has now failed `ALERT_STUCK_HITS` ticks
  in a row and is holding the inventory cursor (nothing after it applies either).
- **chronic-order** — one digest per worker per day of orders whose BC post-back has failed on 2+ days.

Delivery channels (either/both; nothing set = console + `/alerts` only):

- **Teams chat or channel** — in Teams open the chat → `…` → **Workflows** → template
  *"Post to a chat when a webhook request is received"* (or the channel variant) → it gives you an
  HTTP POST URL → set `ALERT_WEBHOOK_URL` to it. The URL is auto-detected as Teams and gets an
  Adaptive Card. (Slack incoming webhooks work too; set `ALERT_WEBHOOK_FORMAT=slack`.)
- **Email** via Microsoft Graph — set `ALERT_EMAIL_FROM` (a licensed mailbox) + `ALERT_EMAIL_TO`, and
  grant the Entra app **Mail.Send** (application permission, admin consent). Test with
  `node dist/sync/alerts.js --test`.

## Tech x Ops 2026-09-22 switches

| Env | Default | What |
|---|---|---|
| `PO_CONSIGNEE_PARTNER_ENABLED` | `true` | BC vendor name → Deposco PO `consigneePartner` (trading partner find-or-create by name) |
| `PO_RECEIPT_POSTING_DATE` | `received` | Purchase receipts post on the Deposco received date; `header` = old behaviour. Closed-period → falls back to header date + logs a desync |
| `RO_RECEIPT_POSTING_DATE` | `header` | Same for return receipts (flip to `received` once accounting confirms) |
| `INV_POSTING_DATE` | `workdate` | `deposco` posts inventory adjustments on Deposco's adjustment date |
| `SO_SALES_REP_ENABLED` | `true` | Salesperson name → CO `customAttribute5` + `salesRepContact` |
| `TO_TRACKING_ENABLED` | `true` | Deposco tracking → posted transfer shipment (`node dist/to/sync-to.js --backfill-tracking 30` for history) |
