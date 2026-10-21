-- Personal daily briefing — Step 2a: explicit per-account opt-in settings. ADDITIVE ONLY.
-- No cron jobs, no delivery machinery, no changes to morning-brief/daily-digest.
--
-- Consent model: a row exists only after the OWNER (or same-account admin) saves it through the
-- daily-briefing function — no backfill, no defaults-on, so auto-enable is structurally impossible.
--
-- Recipient model: the row binds the EXACT bot channel + chat id (never "first bot of the
-- account" — the ambiguity 20260805130000_commerce_notify_channel.sql exists to kill).
-- recipient_verified_at stays NULL in Step 2a: the legacy telegram-webhook binding does not
-- validate a private chat, so a configured pair is NOT proof of a verified recipient. Only the
-- future delivery-phase atomic recipient-link claim may set it; every settings write resets it.

create table if not exists public.briefing_settings (
  account_id uuid primary key references public.accounts(id) on delete cascade,
  morning_enabled boolean not null default false,
  evening_enabled boolean not null default false,
  weather_lat numeric(8,5),
  weather_lon numeric(8,5),
  notify_channel_id uuid,
  notify_chat_id text,
  recipient_verified_at timestamptz,
  updated_by uuid references public.users(id) on delete set null,
  updated_at timestamptz not null default now(),
  constraint briefing_settings_lat_range check (weather_lat is null or (weather_lat >= -90 and weather_lat <= 90)),
  constraint briefing_settings_lon_range check (weather_lon is null or (weather_lon >= -180 and weather_lon <= 180)),
  constraint briefing_settings_coords_pair check ((weather_lat is null) = (weather_lon is null)),
  constraint briefing_settings_chat_id_shape check (notify_chat_id is null or notify_chat_id ~ '^-?[0-9]{1,20}$'),
  -- The current channels table is agent-scoped and does not duplicate account_id. The trigger
  -- below enforces the same-account invariant through channels.agent_id -> agents.account_id.
  constraint briefing_settings_channel_exists
    foreign key (notify_channel_id) references public.channels (id) on delete cascade,
  -- consent without a destination cannot exist: enabling either briefing requires the BOT
  -- binding. The chat id is deliberately NOT required here — the verification /start discovers
  -- the real chat, and delivery refuses unverified recipients anyway.
  constraint briefing_settings_enabled_needs_recipient
    check ((not morning_enabled and not evening_enabled) or (notify_channel_id is not null))
);

alter table public.briefing_settings enable row level security;

-- reads: owner/is_admin of the account only — the row carries the owner's private chat id and
-- home coordinates, which an operator has no business seeing. public.current_account_id()
-- already joins accounts and excludes blocked ones (20260723121000_blocked_accounts_fail_closed).
create policy briefing_settings_read on public.briefing_settings for select
  using (
    account_id = public.current_account_id()
    and exists (
      select 1 from public.users u
      where u.id = auth.uid()
        -- defense in depth: the privileged user must belong to THIS row's account, even if the
        -- session's account context were ever forged apart from the uid
        and u.account_id = briefing_settings.account_id
        and (u.role = 'owner' or u.is_admin = true)
    )
  );

-- writes: the browser has NO write path at all. The daily-briefing function (service role,
-- which bypasses RLS) is the sole writer and must itself enforce owner/is_admin membership
-- AND the blocked-account denial before every write.
revoke all on table public.briefing_settings from public, anon;
revoke insert, update, delete on table public.briefing_settings from authenticated;
grant select on table public.briefing_settings to authenticated;

create or replace function public.briefing_settings_channel_account_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.notify_channel_id is not null and not exists (
    select 1
    from public.channels c
    join public.agents a on a.id = c.agent_id
    where c.id = new.notify_channel_id
      and a.account_id = new.account_id
  ) then
    raise exception using errcode = '23514', message = 'briefing channel belongs to another account';
  end if;
  return new;
end;
$$;

revoke all on function public.briefing_settings_channel_account_guard() from public, anon, authenticated;

drop trigger if exists briefing_settings_channel_account_guard on public.briefing_settings;
create trigger briefing_settings_channel_account_guard
  before insert or update of account_id, notify_channel_id on public.briefing_settings
  for each row execute function public.briefing_settings_channel_account_guard();
