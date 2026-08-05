alter table public.commerce_recommendations
  add column if not exists alerted_at timestamptz,
  add column if not exists digest_sent_at date;

create index if not exists commerce_recommendations_critical_unsent_idx
  on public.commerce_recommendations(created_at)
  where severity = 'critical' and alerted_at is null and status = 'open';
