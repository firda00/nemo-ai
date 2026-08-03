-- The Telegram worker lease is infrastructure state, not browser-readable data.
-- RLS with no browser policies keeps the service-role worker functional while
-- preventing direct lease reads or writes from anon/authenticated clients.
alter table public.worker_lease enable row level security;
revoke all on table public.worker_lease from anon, authenticated;
