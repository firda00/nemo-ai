-- Agents may either observe only or prepare an owner-approved draft.
-- An approved executor is intentionally not a valid value until an audited executor exists.
alter table public.agents add column if not exists action_policy text not null default 'approval_required';
alter table public.agents drop constraint if exists agents_action_policy_check;
alter table public.agents add constraint agents_action_policy_check check (action_policy in ('read_only', 'approval_required'));
