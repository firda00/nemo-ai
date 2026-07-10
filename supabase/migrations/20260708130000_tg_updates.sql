-- Idempotency for the Telegram webhook. Telegram RE-DELIVERS an update if it doesn't receive a
-- fast 200 (slow LLM/tool work makes this common), which caused duplicate tasks and double LLM
-- spend. We record each processed update per bot and skip re-deliveries. Service-role only.
create table if not exists public.tg_updates (
  channel_id uuid        not null,
  update_id  bigint      not null,
  created_at timestamptz not null default now(),
  primary key (channel_id, update_id)
);

-- lock it down: only the service role (edge function) touches this; RLS with no policy denies
-- anon/authenticated entirely.
alter table public.tg_updates enable row level security;

create index if not exists tg_updates_created_idx on public.tg_updates (created_at);
