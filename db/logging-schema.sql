-- PK ↔ Deposco middleware — sync logging + cursors (Supabase/Postgres).
-- Structured events (not raw log strings) so failures are a query, not a regex, and
-- re-runs don't create duplicate rows.

-- One row per worker tick/run.
create table if not exists sync_runs (
  id          bigint generated always as identity primary key,
  worker      text not null,                       -- inv_pull | po | co | to
  trigger     text not null default 'manual',      -- manual | schedule
  started_at  timestamptz not null default now(),
  finished_at timestamptz,
  status      text,                                -- ok | partial | error
  counts      jsonb,                               -- {posted,failed,floored,skipped}
  note        text
);

-- One row per item handled. status/side make "what failed, on whose end" a filter.
create table if not exists sync_events (
  id          bigint generated always as identity primary key,
  run_id      bigint references sync_runs(id) on delete set null,
  ts          timestamptz not null default now(),
  worker      text not null,
  direction   text,                                -- deposco->bc | bc->deposco
  entity_type text,                                -- order | inventory_adj
  entity_id   text,                                -- WSOD139248 | Deposco adj id
  action      text,                                -- pull | push | post | floor
  status      text not null,                       -- ok | skip | floor | desync | fail
  side        text,                                -- bc | deposco | null
  message     text,
  detail      jsonb,
  dedupe_key  text unique                          -- idempotent event key (NULLs allowed → always insert)
);
create index if not exists sync_events_status_ts on sync_events (status, ts desc);
create index if not exists sync_events_run on sync_events (run_id);
create index if not exists sync_events_entity on sync_events (entity_type, entity_id);

-- Per-worker (and per-order-prefix) high-water mark — replaces the ephemeral .inv-state.json
-- so cursors survive Railway restarts and the weekend prod reload.
create table if not exists sync_cursors (
  worker      text not null,
  key         text not null default '',            -- order prefix, or '' for inventory
  last_synced text,                                -- last id / order number synced past
  updated_at  timestamptz not null default now(),
  primary key (worker, key)
);
