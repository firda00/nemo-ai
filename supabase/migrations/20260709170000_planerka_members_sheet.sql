-- A company connects its OWN Google Sheet as the planerka team roster (name + Telegram chat_id +
-- username + department). The planerka reads it to DM each person their tasks directly.
alter table public.business_profiles add column if not exists planerka_members_sheet_id text;
alter table public.business_profiles add column if not exists planerka_members_tab text;      -- optional tab/sheet name
alter table public.business_profiles add column if not exists planerka_members_map jsonb not null default '{}'::jsonb; -- optional column overrides {name,chatId,username,dept}
