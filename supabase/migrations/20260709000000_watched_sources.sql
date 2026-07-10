-- Channel watch → auto-localize. A user pastes a YouTube channel link once; a cron
-- polls its free RSS feed and, on each new video, localizes the title+description into
-- the chosen languages as content_drafts (Telegram can auto-publish; others are drafts).
-- All access goes through the watch-sources edge function (service role); RLS is enabled
-- with no permissive policies so the tables are not directly reachable by anon/authenticated.

create table if not exists public.watched_sources (
  id            uuid primary key default gen_random_uuid(),
  account_id    uuid not null references public.accounts(id) on delete cascade,
  url           text not null,
  kind          text not null default 'youtube',
  external_id   text,                       -- youtube channel id (UC...)
  title         text,
  languages     text[] not null default '{}',
  platforms     text[] not null default '{}',
  auto_publish  boolean not null default false,
  tg_channel_id uuid,                        -- channels.id of the sender bot (telegram auto-publish)
  tg_target     text,                        -- @channel the bot posts into
  last_video_id text,
  active        boolean not null default true,
  last_checked_at timestamptz,
  created_at    timestamptz not null default now()
);
create index if not exists watched_sources_account_idx on public.watched_sources(account_id);
create index if not exists watched_sources_active_idx on public.watched_sources(active) where active;
alter table public.watched_sources enable row level security;

create table if not exists public.content_drafts (
  id           uuid primary key default gen_random_uuid(),
  account_id   uuid not null references public.accounts(id) on delete cascade,
  source_id    uuid references public.watched_sources(id) on delete set null,
  video_id     text,
  video_title  text,
  video_url    text,
  lang         text,
  content      text,
  status       text not null default 'draft',   -- draft | published
  published_to text,                             -- 'telegram' when auto-posted
  created_at   timestamptz not null default now()
);
create index if not exists content_drafts_account_idx on public.content_drafts(account_id, created_at desc);
alter table public.content_drafts enable row level security;
