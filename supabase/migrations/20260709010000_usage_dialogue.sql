-- Token-economy: attribute AI usage to a dialogue so cost-per-conversation / per-lead is
-- computable (the < $0.05/lead unit-economics target). cost is now written per reply too.
alter table public.usage add column if not exists dialogue_id uuid;
create index if not exists usage_dialogue_idx on public.usage(dialogue_id) where dialogue_id is not null;
