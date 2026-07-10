-- Idempotency for WhatsApp/Instagram (Meta redelivers a webhook if it doesn't get a fast 200).
-- Telegram already dedups via tg_updates; this covers the other channels. Service-role only.
create table if not exists public.webhook_dedup (
  channel_id uuid not null,
  msg_id     text not null,
  created_at timestamptz not null default now(),
  primary key (channel_id, msg_id)
);
alter table public.webhook_dedup enable row level security;
