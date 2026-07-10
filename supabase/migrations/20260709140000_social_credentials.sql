-- Autoposting connectors beyond Meta (Twitter/X, Reddit) need to store several credentials each,
-- not the fixed access_token/page_id columns. Add a flexible jsonb for platform-specific keys.
alter table public.social_accounts add column if not exists credentials jsonb;
