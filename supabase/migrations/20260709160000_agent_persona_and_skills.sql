-- Personal-assistant mode (an agent that answers in Telegram AS one specific person, not the
-- organization) + user-selectable agent skills (capability bundles like data analysis).
alter table public.agents add column if not exists persona_mode text not null default 'business';
alter table public.agents add column if not exists owner_name text;
alter table public.agents add column if not exists skills text[] not null default '{}';
