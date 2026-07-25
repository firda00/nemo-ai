-- Persist the exact capability methods assigned to every specialist.
-- RLS on sub_agents already scopes these rows to current_account_id().
alter table public.sub_agents
  add column if not exists skills jsonb not null default '[]'::jsonb;

alter table public.sub_agents
  drop constraint if exists sub_agents_skills_array;

alter table public.sub_agents
  add constraint sub_agents_skills_array
  check (jsonb_typeof(skills) = 'array');
