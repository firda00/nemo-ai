-- Auto follow-up / nurture sequences ("автоворонка дожима").
-- The AI keeps nudging a lead over several days (Telegram or email) until they
-- convert or opt out. Each row is one running sequence; the follow-up edge function
-- advances it on a schedule, generating each message from the conversation + the
-- business profile. Account-scoped via RLS like the rest of the schema.

create table if not exists public.follow_ups (
  id           uuid primary key default gen_random_uuid(),
  account_id   uuid not null default public.current_account_id() references public.accounts(id) on delete cascade,
  agent_id     uuid references public.agents(id)   on delete set null,
  dialogue_id  uuid references public.dialogues(id) on delete set null,
  lead_id      uuid references public.leads(id)     on delete set null,
  channel      text not null default 'telegram',        -- telegram | email
  target       text not null,                           -- telegram chat id or email address
  goal         text not null default '',                -- what the sequence nudges toward
  status       text not null default 'active',          -- active | done | stopped | converted
  step         int  not null default 0,                 -- how many messages already sent
  max_steps    int  not null default 3,
  cadence_hours int[] not null default '{24,72,168}',   -- delay before step 1, 2, 3 ...
  next_run_at  timestamptz not null default now(),
  last_sent_at timestamptz,
  last_message text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

alter table public.follow_ups enable row level security;

-- Owner can read + stop their own sequences from the UI. The follow-up edge function
-- writes/advances rows with the service_role key (bypasses RLS), like the other bots.
drop policy if exists follow_ups_acc on public.follow_ups;
create policy follow_ups_acc on public.follow_ups for all
  using (account_id = public.current_account_id())
  with check (account_id = public.current_account_id());

-- the cron scan orders by (status, next_run_at); the account list orders by recency
create index if not exists follow_ups_due_idx on public.follow_ups (status, next_run_at);
create index if not exists follow_ups_acc_idx on public.follow_ups (account_id, created_at desc);
