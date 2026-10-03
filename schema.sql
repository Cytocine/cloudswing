-- Run once in Supabase: SQL Editor > New query > Run.
create table if not exists drawings (
  symbol     text primary key,
  data       jsonb not null default '[]',
  updated_at timestamptz not null default now()
);

create table if not exists alerts (
  id           text primary key,            -- same id as the drawing on the chart
  symbol       text not null,
  price        numeric not null,
  dir          text not null check (dir in ('above','below')),
  note         text not null default '',
  active       boolean not null default true,
  triggered_at timestamptz,
  created_at   timestamptz not null default now()
);
create index if not exists alerts_active_idx on alerts (active) where active;
create index if not exists alerts_symbol_idx on alerts (symbol);

-- Lock both tables: no anon/authenticated access. Only the Worker (secret key) can read/write.
alter table drawings enable row level security;
alter table alerts   enable row level security;
