create table public.telegram_voice_intents (
  id uuid primary key,
  account_id uuid not null references public.accounts(id) on delete cascade,
  channel_id uuid not null references public.channels(id) on delete cascade,
  chat_id text not null,
  message_id bigint not null,
  intent jsonb not null,
  forge_payload jsonb not null,
  status text not null default 'pending',
  execution_id uuid,
  expires_at timestamptz not null default (clock_timestamp() + interval '15 minutes'),
  created_at timestamptz not null default clock_timestamp(),
  decided_at timestamptz,
  constraint telegram_voice_intents_account_id_id_key unique (account_id, id),
  constraint telegram_voice_intents_message_key unique (account_id, channel_id, chat_id, message_id),
  constraint telegram_voice_intents_status_check check (status in ('pending', 'processing', 'approved', 'rejected', 'expired')),
  constraint telegram_voice_intents_payload_check check (
    jsonb_typeof(intent) = 'object' and jsonb_typeof(forge_payload) = 'object'
    and octet_length(intent::text) <= 32768 and octet_length(forge_payload::text) <= 65536
  )
);

create index telegram_voice_intents_pending_idx
  on public.telegram_voice_intents (account_id, channel_id, chat_id, expires_at)
  where status = 'pending';

alter table public.telegram_voice_intents enable row level security;
revoke all on table public.telegram_voice_intents from public, anon, authenticated;
grant select, insert, update on table public.telegram_voice_intents to service_role;

comment on table public.telegram_voice_intents is
  'Short-lived tenant-scoped approval state for transcribed owner voice commands. Raw audio and secrets are never stored.';
