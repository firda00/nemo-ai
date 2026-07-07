-- Per-sub-agent Telegram bots + group "task-bot".
-- Each sub-agent can own its OWN Telegram bot (channels.sub_agent_id), answering
-- in its own persona. A bot can also run in a GROUP as a task-bot (scope='group'):
-- someone @mentions it and assigns a task to a person -> it creates a task row with
-- the assignee's Telegram identity and can remind them. Account-scoped via RLS.

-- ---------- channels: bind a bot to a specific sub-agent + declare its scope ----------
alter table public.channels add column if not exists sub_agent_id uuid
  references public.sub_agents(id) on delete cascade;
alter table public.channels add column if not exists scope text not null default 'dm';
  -- dm | group   (group = task-bot / team coordination chat)
alter table public.channels add column if not exists label text; -- display name in the UI

create index if not exists channels_sub_agent_idx on public.channels (sub_agent_id);

-- ---------- tasks: carry the Telegram assignee + source chat so the bot can remind ----------
alter table public.tasks add column if not exists channel_id uuid
  references public.channels(id) on delete set null;
alter table public.tasks add column if not exists telegram_chat_id text;  -- group the task came from
alter table public.tasks add column if not exists assignee_tg text;       -- @username or numeric user id
alter table public.tasks add column if not exists assignee_name text;     -- display name
alter table public.tasks add column if not exists created_by text;        -- who assigned it (tg name)
alter table public.tasks add column if not exists due_at timestamptz;     -- precise reminder time
alter table public.tasks add column if not exists last_reminded_at timestamptz;

create index if not exists tasks_due_idx on public.tasks (due_at) where status <> 'done';

-- ---------- telegram_members: the "special list of user ids" the task-bot keeps ----------
-- One row per person the bot has seen in a group, so it can resolve @mentions to a
-- real Telegram user and remind them personally.
create table if not exists public.telegram_members (
  id            uuid primary key default gen_random_uuid(),
  account_id    uuid not null default public.current_account_id() references public.accounts(id) on delete cascade,
  channel_id    uuid references public.channels(id) on delete cascade,
  chat_id       text not null,
  tg_user_id    text not null,
  username      text,
  display_name  text,
  created_at    timestamptz not null default now(),
  unique(channel_id, chat_id, tg_user_id)
);

alter table public.telegram_members enable row level security;
drop policy if exists telegram_members_acc on public.telegram_members;
create policy telegram_members_acc on public.telegram_members for all
  using (account_id = public.current_account_id())
  with check (account_id = public.current_account_id());

create index if not exists tg_members_chat_idx on public.telegram_members (channel_id, chat_id);
