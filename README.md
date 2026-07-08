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
