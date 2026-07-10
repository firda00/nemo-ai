-- tool_runs: audit trail of every agent tool execution (written by _shared/tools.ts, read by the
-- observability view). This table was referenced everywhere but never had a migration — so the
-- inserts were silently failing and the whole observability layer was empty. Service-role only.
create table if not exists public.tool_runs (
  id         uuid primary key default gen_random_uuid(),
  account_id uuid references public.accounts(id) on delete cascade,
  tool       text,
  args       jsonb,
  result     text,
  ok         boolean not null default true,
  created_at timestamptz not null default now()
);
create index if not exists tool_runs_account_idx on public.tool_runs(account_id, created_at desc);
create index if not exists tool_runs_tool_idx on public.tool_runs(tool, created_at desc);
alter table public.tool_runs enable row level security;
