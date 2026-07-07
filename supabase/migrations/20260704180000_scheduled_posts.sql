-- Autoposting: scheduled content sent to a Telegram target by a connected bot.
-- A cron-driven function (autopost run_due) sends due posts and stamps status.
create table if not exists public.scheduled_posts (
  id           uuid primary key default gen_random_uuid(),
  account_id   uuid not null default public.current_account_id() references public.accounts(id) on delete cascade,
  channel_id   uuid references public.channels(id) on delete set null,  -- which connected bot sends it
  target_chat  text not null,                                           -- @channel or numeric chat id
  content      text not null,
  scheduled_at timestamptz not null,
  status       text not null default 'scheduled',                       -- scheduled | posted | failed | canceled
  posted_at    timestamptz,
  error        text,
  created_at   timestamptz not null default now()
);

create index if not exists scheduled_posts_due_idx on public.scheduled_posts (scheduled_at) where status = 'scheduled';

alter table public.scheduled_posts enable row level security;
