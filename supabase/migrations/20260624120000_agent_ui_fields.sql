-- UI fields the frontend agent editor needs that aren't in the base §7 schema.
alter table public.agents add column if not exists avatar_color text not null default 'violet';
alter table public.agents add column if not exists lead_form jsonb not null default '{}'::jsonb;
