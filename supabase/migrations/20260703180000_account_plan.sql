-- Per-account plan tier for cost control at scale. Expensive models (gpt-4o for the
-- orchestrator manager/synth) are reserved for paid tiers + admins; free accounts use
-- the cheap model. Metered by token_balance as before.
alter table public.accounts add column if not exists plan text not null default 'free';
  -- free | pro | business
