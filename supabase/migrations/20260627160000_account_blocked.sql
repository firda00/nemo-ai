-- Admin moderation: an account can be blocked (soft — can log in but can't use
-- the platform; its agents are paused). Hard ban (cannot log in) is done via the
-- GoTrue admin API (auth.users ban_duration) from the admin-api function.
alter table public.accounts add column if not exists blocked boolean not null default false;
