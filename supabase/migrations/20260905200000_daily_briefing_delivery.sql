-- Daily briefing — Step 2b delivery: verified recipient claim, durable runs, outcomes.
-- Incorporates both Codex review rounds:
--   1) claim consumption AND settings verification happen in ONE function (single transaction),
--      serialized with issuance and saves by locking the account's settings row FIRST everywhere;
--      supersession uses a monotonic current_claim_id pointer, never timestamp comparison;
--   2) delivery runs are fenced by a lease token; the dispatch marker atomically re-validates the
--      CURRENT consent and snapshots channel/chat/revision into the run BEFORE any send; an
--      expired lease after dispatch is terminal 'unknown' and is never resent; expired
--      undispatched rows out of attempts terminal-fail instead of hanging in 'sending';
--      stale-dated rows are closed by recovery, never sent hours or days late;
--   3) outcomes are captured ONLY from a reply matching the run's own dispatch snapshot
--      (channel+chat+message id — message ids are chat-local) or an explicit /day_result command;
--      idempotency is per-channel update id (update ids are bot-local, not global);
--   4) blocked accounts are refused inside the RPCs themselves, not only at the endpoints;
--   5) LEAST/GREATEST are used as plain SQL expressions (they are grammar, not schema-qualified
--      functions) with lower AND upper bounds.

-- ── settings: revision + monotonic claim pointer; every consent write resets both bindings ──────
alter table public.briefing_settings
  add column if not exists settings_revision integer not null default 0;
alter table public.briefing_settings
  add column if not exists current_claim_id uuid;

-- ── recipient claims — service-role only, no browser surface at all ─────────────────────────────
create table if not exists public.briefing_recipient_claims (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.accounts(id) on delete cascade,
  channel_id uuid not null,
  settings_revision integer not null,
  token_hash text not null unique,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  consumed_at timestamptz,
  consumed_chat_id text,
  foreign key (channel_id) references public.channels (id) on delete cascade
);
create index if not exists briefing_recipient_claims_account_idx
  on public.briefing_recipient_claims (account_id, created_at desc);
alter table public.briefing_recipient_claims enable row level security;
revoke all on table public.briefing_recipient_claims from public, anon, authenticated;

create or replace function public.briefing_recipient_channel_account_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not exists (
    select 1
    from public.channels c
    join public.agents a on a.id = c.agent_id
    where c.id = new.channel_id
      and a.account_id = new.account_id
  ) then
    raise exception using errcode = '23514', message = 'briefing channel belongs to another account';
  end if;
  return new;
end;
$$;

revoke all on function public.briefing_recipient_channel_account_guard() from public, anon, authenticated;
drop trigger if exists briefing_recipient_channel_account_guard on public.briefing_recipient_claims;
create trigger briefing_recipient_channel_account_guard
  before insert or update of account_id, channel_id on public.briefing_recipient_claims
  for each row execute function public.briefing_recipient_channel_account_guard();

-- ── durable delivery runs, with the dispatch-time recipient snapshot ────────────────────────────
create table if not exists public.briefing_runs (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.accounts(id) on delete cascade,
  kind text not null check (kind in ('morning', 'evening')),
  run_date date not null,
  status text not null default 'prepared'
    check (status in ('prepared', 'sending', 'sent', 'unknown', 'failed', 'skipped')),
  attempt_count integer not null default 0,
  lease_token uuid,
  lease_until timestamptz,
  dispatched_at timestamptz,
  -- snapshot of WHERE this run was dispatched: message ids are chat-local, so a later rebind
  -- must never let a reply in another chat attach to this run
  dispatch_channel_id uuid,
  dispatch_chat_id text,
  dispatch_settings_revision integer,
  telegram_message_id bigint,
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (account_id, kind, run_date)
);
create index if not exists briefing_runs_claim_idx
  on public.briefing_runs (kind, run_date, status, lease_until);
create index if not exists briefing_runs_reply_idx
  on public.briefing_runs (dispatch_channel_id, dispatch_chat_id, telegram_message_id);
alter table public.briefing_runs enable row level security;
create policy briefing_runs_read on public.briefing_runs for select
  using (
    account_id = public.current_account_id()
    and exists (
      select 1 from public.users u
      where u.id = auth.uid()
        and u.account_id = briefing_runs.account_id
        and (u.role = 'owner' or u.is_admin = true)
    )
  );
revoke all on table public.briefing_runs from public, anon;
revoke insert, update, delete on table public.briefing_runs from authenticated;
grant select on table public.briefing_runs to authenticated;

-- ── evening outcomes — one per account per day; idempotent per (channel, update id) ─────────────
create table if not exists public.briefing_outcomes (
  account_id uuid not null references public.accounts(id) on delete cascade,
  run_date date not null,
  channel_id uuid not null,
  chat_id text not null,
  text text not null check (length(text) between 1 and 2000),
  telegram_update_id bigint not null,
  via text not null check (via in ('reply', 'command')),
  collected_at timestamptz not null default now(),
  primary key (account_id, run_date),
  -- update ids are BOT-local: two bots can legitimately deliver the same update id
  unique (channel_id, telegram_update_id)
);
alter table public.briefing_outcomes enable row level security;
create policy briefing_outcomes_read on public.briefing_outcomes for select
  using (
    account_id = public.current_account_id()
    and exists (
      select 1 from public.users u
      where u.id = auth.uid()
        and u.account_id = briefing_outcomes.account_id
        and (u.role = 'owner' or u.is_admin = true)
    )
  );
revoke all on table public.briefing_outcomes from public, anon;
revoke insert, update, delete on table public.briefing_outcomes from authenticated;
grant select on table public.briefing_outcomes to authenticated;

-- ── claim issuance: settings row locked FIRST; the new claim becomes the only valid one ─────────
create or replace function public.briefing_issue_claim(
  p_account uuid, p_token_hash text
) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_settings public.briefing_settings%rowtype;
  v_blocked boolean;
  v_claim_id uuid;
begin
  select * into v_settings from public.briefing_settings
   where account_id = p_account for update;
  if not found then return jsonb_build_object('ok', false, 'reason', 'no_settings'); end if;
  if v_settings.notify_channel_id is null then
    return jsonb_build_object('ok', false, 'reason', 'no_channel');
  end if;
  select blocked into v_blocked from public.accounts where id = p_account;
  if v_blocked is distinct from false then
    return jsonb_build_object('ok', false, 'reason', 'blocked');
  end if;
  delete from public.briefing_recipient_claims
   where account_id = p_account and consumed_at is null;
  insert into public.briefing_recipient_claims (account_id, channel_id, settings_revision, token_hash, expires_at)
  values (p_account, v_settings.notify_channel_id, v_settings.settings_revision, p_token_hash,
          pg_catalog.now() + interval '15 minutes')
  returning id into v_claim_id;
  update public.briefing_settings
     set current_claim_id = v_claim_id, updated_at = pg_catalog.now()
   where account_id = p_account;
  return jsonb_build_object('ok', true, 'claim_id', v_claim_id, 'channel_id', v_settings.notify_channel_id);
end;
$$;

-- ── claim consumption + verification: ONE transaction; settings locked first (same order as
--    issuance, so concurrent issue/consume serialize instead of deadlocking) ────────────────────
create or replace function public.briefing_consume_claim(
  p_token_hash text, p_chat_id text, p_channel_id uuid
) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_account uuid;
  v_settings public.briefing_settings%rowtype;
  v_claim public.briefing_recipient_claims%rowtype;
  v_blocked boolean;
begin
  select account_id into v_account from public.briefing_recipient_claims
   where token_hash = p_token_hash and consumed_at is null and expires_at > pg_catalog.now();
  if not found then return jsonb_build_object('ok', false, 'reason', 'invalid'); end if;
  select * into v_settings from public.briefing_settings
   where account_id = v_account for update;
  if not found then return jsonb_build_object('ok', false, 'reason', 'stale'); end if;
  -- re-read the claim UNDER the settings lock: issuance deletes unconsumed claims under the
  -- same lock, so a claim that survives this re-read is the current one
  select * into v_claim from public.briefing_recipient_claims
   where token_hash = p_token_hash and consumed_at is null and expires_at > pg_catalog.now()
   for update;
  if not found then return jsonb_build_object('ok', false, 'reason', 'invalid'); end if;
  -- monotonic pointer, not timestamps: only the claim the settings row points at may verify
  if v_settings.current_claim_id is distinct from v_claim.id then
    return jsonb_build_object('ok', false, 'reason', 'superseded');
  end if;
  if v_claim.channel_id <> p_channel_id then
    return jsonb_build_object('ok', false, 'reason', 'wrong_channel');
  end if;
  if v_settings.settings_revision <> v_claim.settings_revision
     or v_settings.notify_channel_id is distinct from v_claim.channel_id then
    return jsonb_build_object('ok', false, 'reason', 'stale');
  end if;
  select blocked into v_blocked from public.accounts where id = v_account;
  if v_blocked is distinct from false then
    return jsonb_build_object('ok', false, 'reason', 'blocked');
  end if;
  update public.briefing_recipient_claims
     set consumed_at = pg_catalog.now(), consumed_chat_id = p_chat_id
   where id = v_claim.id;
  -- the verified chat id comes from the /start message itself, never from typed input
  update public.briefing_settings
     set recipient_verified_at = pg_catalog.now(), notify_chat_id = p_chat_id,
         current_claim_id = null, updated_at = pg_catalog.now()
   where account_id = v_account;
  return jsonb_build_object('ok', true, 'account_id', v_account);
end;
$$;

-- ── set-based preparation: EVERY eligible account gets its row before anyone is sent to ─────────
create or replace function public.briefing_prepare_runs(p_kind text, p_run_date date)
returns integer
language plpgsql security definer set search_path = ''
as $$
declare v_count integer;
begin
  insert into public.briefing_runs (account_id, kind, run_date)
  select s.account_id, p_kind, p_run_date
    from public.briefing_settings s
    join public.accounts a on a.id = s.account_id and a.blocked = false
   where s.recipient_verified_at is not null
     and case p_kind when 'morning' then s.morning_enabled
                     when 'evening' then s.evening_enabled
                     else false end
  on conflict (account_id, kind, run_date) do nothing;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

-- ── lease-fenced batch claim (SKIP LOCKED): re-claimable ONLY while nothing was dispatched ──────
create or replace function public.briefing_claim_runs(
  p_kind text, p_run_date date, p_limit integer, p_lease_seconds integer
) returns setof public.briefing_runs
language plpgsql security definer set search_path = ''
as $$
begin
  return query
  update public.briefing_runs r
     set status = 'sending',
         lease_token = gen_random_uuid(),
         lease_until = pg_catalog.now() + pg_catalog.make_interval(secs => greatest(30, least(p_lease_seconds, 300))),
         attempt_count = r.attempt_count + 1,
         updated_at = pg_catalog.now()
   where r.id in (
     select b.id from public.briefing_runs b
      where b.kind = p_kind and b.run_date = p_run_date
        and (b.status = 'prepared'
             or (b.status = 'sending' and b.lease_until < pg_catalog.now()
                 and b.dispatched_at is null and b.attempt_count < 2))
      order by b.account_id
      limit greatest(1, least(p_limit, 25))
      for update skip locked
   )
  returning r.*;
end;
$$;

-- ── recovery: terminal transitions for everything that can no longer be sent honestly ───────────
create or replace function public.briefing_recover_runs(p_kind text, p_today date)
returns integer
language plpgsql security definer set search_path = ''
as $$
declare v_total integer := 0; v_count integer;
begin
  -- an expired lease AFTER dispatch: outcome unknown, never resent
  update public.briefing_runs
     set status = 'unknown', error = 'dispatch_lease_expired', lease_token = null,
         updated_at = pg_catalog.now()
   where kind = p_kind and run_date <= p_today
     and status = 'sending' and lease_until < pg_catalog.now() and dispatched_at is not null;
  get diagnostics v_count = row_count; v_total := v_total + v_count;
  -- attempts exhausted BEFORE any dispatch: definite failure, not eternal 'sending'
  update public.briefing_runs
     set status = 'failed', error = 'attempts_exhausted', lease_token = null,
         updated_at = pg_catalog.now()
   where kind = p_kind and run_date <= p_today
     and status = 'sending' and lease_until < pg_catalog.now()
     and dispatched_at is null and attempt_count >= 2;
  get diagnostics v_count = row_count; v_total := v_total + v_count;
  -- a briefing for a PAST day must never be sent late — close stranded rows honestly
  update public.briefing_runs
     set status = 'skipped', error = 'expired_unsent', lease_token = null,
         updated_at = pg_catalog.now()
   where kind = p_kind and run_date < p_today
     and (status = 'prepared'
          or (status = 'sending' and lease_until < pg_catalog.now() and dispatched_at is null));
  get diagnostics v_count = row_count; v_total := v_total + v_count;
  return v_total;
end;
$$;

-- ── CAS dispatch marker: atomically re-validates CURRENT consent and snapshots the recipient.
--    The send may happen ONLY when this returned ok, and only to the returned snapshot ──────────
create or replace function public.briefing_mark_dispatch(p_run_id uuid, p_lease_token uuid)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_run public.briefing_runs%rowtype;
  v_settings public.briefing_settings%rowtype;
  v_blocked boolean;
  v_enabled boolean;
begin
  select * into v_run from public.briefing_runs
   where id = p_run_id and lease_token = p_lease_token
     and status = 'sending' and dispatched_at is null and lease_until > pg_catalog.now()
   for update;
  if not found then return jsonb_build_object('ok', false, 'reason', 'lease_lost'); end if;
  select * into v_settings from public.briefing_settings
   where account_id = v_run.account_id for update;
  if not found then return jsonb_build_object('ok', false, 'reason', 'no_settings'); end if;
  v_enabled := case v_run.kind when 'morning' then v_settings.morning_enabled else v_settings.evening_enabled end;
  if not v_enabled or v_settings.recipient_verified_at is null
     or v_settings.notify_channel_id is null or v_settings.notify_chat_id is null then
    return jsonb_build_object('ok', false, 'reason', 'recipient_not_verified');
  end if;
  select blocked into v_blocked from public.accounts where id = v_run.account_id;
  if v_blocked is distinct from false then
    return jsonb_build_object('ok', false, 'reason', 'blocked');
  end if;
  update public.briefing_runs
     set dispatched_at = pg_catalog.now(),
         dispatch_channel_id = v_settings.notify_channel_id,
         dispatch_chat_id = v_settings.notify_chat_id,
         dispatch_settings_revision = v_settings.settings_revision,
         updated_at = pg_catalog.now()
   where id = p_run_id;
  return jsonb_build_object('ok', true,
    'channel_id', v_settings.notify_channel_id, 'chat_id', v_settings.notify_chat_id);
end;
$$;

-- ── terminal transition, fenced by the same lease token ─────────────────────────────────────────
create or replace function public.briefing_finish_run(
  p_run_id uuid, p_lease_token uuid, p_status text, p_message_id bigint, p_error text
) returns boolean
language plpgsql security definer set search_path = ''
as $$
declare v_count integer;
begin
  if p_status not in ('sent', 'failed', 'skipped', 'unknown') then
    raise exception using errcode = '22023', message = 'BRIEFING_BAD_FINISH_STATUS';
  end if;
  update public.briefing_runs
     set status = p_status,
         telegram_message_id = p_message_id,
         error = p_error,
         lease_token = null,
         lease_until = null,
         updated_at = pg_catalog.now()
   where id = p_run_id and lease_token = p_lease_token and status = 'sending';
  get diagnostics v_count = row_count;
  return v_count = 1;
end;
$$;

-- ── outcome capture: reply must match the run's own dispatch snapshot; command is explicit ──────
create or replace function public.briefing_capture_outcome(
  p_channel_id uuid, p_chat_id text, p_reply_message_id bigint,
  p_update_id bigint, p_text text, p_via text
) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_settings public.briefing_settings%rowtype;
  v_run public.briefing_runs%rowtype;
  v_blocked boolean;
  v_date date;
  v_today date := ((pg_catalog.now() + interval '5 hours') at time zone 'UTC')::date;
begin
  if p_text is null or length(p_text) < 1 or length(p_text) > 2000 then
    return jsonb_build_object('ok', false, 'reason', 'bad_text');
  end if;
  if p_via not in ('reply', 'command') then
    return jsonb_build_object('ok', false, 'reason', 'bad_via');
  end if;
  -- only the VERIFIED recipient chat on the bound channel may record outcomes
  select * into v_settings from public.briefing_settings
   where notify_channel_id = p_channel_id and notify_chat_id = p_chat_id
     and recipient_verified_at is not null
   limit 1;
  if not found then return jsonb_build_object('ok', false, 'reason', 'not_verified'); end if;
  select blocked into v_blocked from public.accounts where id = v_settings.account_id;
  if v_blocked is distinct from false then
    return jsonb_build_object('ok', false, 'reason', 'blocked');
  end if;
  if p_via = 'reply' then
    -- the reply must point at THIS channel+chat's own sent evening run: message ids are
    -- chat-local, so the run's dispatch snapshot is the only honest join key
    select * into v_run from public.briefing_runs
     where account_id = v_settings.account_id and kind = 'evening' and status = 'sent'
       and telegram_message_id = p_reply_message_id
       and dispatch_channel_id = p_channel_id and dispatch_chat_id = p_chat_id
       and run_date >= v_today - 1
     limit 1;
    if not found then return jsonb_build_object('ok', false, 'reason', 'no_match'); end if;
    v_date := v_run.run_date;
  else
    v_date := v_today;
  end if;
  begin
    insert into public.briefing_outcomes (account_id, run_date, channel_id, chat_id, text, telegram_update_id, via)
    values (v_settings.account_id, v_date, p_channel_id, p_chat_id, p_text, p_update_id, p_via);
  exception
    when unique_violation then
      -- a Telegram retry of the same update, or a second answer for an already-recorded day:
      -- both are idempotent no-ops, never overwrites of the first answer
      return jsonb_build_object('ok', true, 'duplicate', true, 'run_date', v_date);
  end;
  return jsonb_build_object('ok', true, 'run_date', v_date);
end;
$$;

-- ── consent save: revision bump + claim/verification invalidation are ONE atomic statement ──────
-- The Step 2a upsert could not express `settings_revision + 1`; this RPC is the only save path.
create or replace function public.briefing_save_settings(
  p_account uuid, p_morning boolean, p_evening boolean,
  p_lat numeric, p_lon numeric, p_channel uuid, p_chat text, p_updated_by uuid
) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare v_row public.briefing_settings%rowtype;
begin
  insert into public.briefing_settings as s
    (account_id, morning_enabled, evening_enabled, weather_lat, weather_lon,
     notify_channel_id, notify_chat_id, recipient_verified_at, settings_revision,
     current_claim_id, updated_by, updated_at)
  values (p_account, p_morning, p_evening, p_lat, p_lon, p_channel, p_chat, null, 1, null,
          p_updated_by, pg_catalog.now())
  on conflict (account_id) do update
     set morning_enabled = excluded.morning_enabled,
         evening_enabled = excluded.evening_enabled,
         weather_lat = excluded.weather_lat,
         weather_lon = excluded.weather_lon,
         notify_channel_id = excluded.notify_channel_id,
         notify_chat_id = excluded.notify_chat_id,
         -- every save invalidates verification AND any outstanding claim, monotonically
         recipient_verified_at = null,
         settings_revision = s.settings_revision + 1,
         current_claim_id = null,
         updated_by = excluded.updated_by,
         updated_at = pg_catalog.now()
  returning * into v_row;
  return to_jsonb(v_row);
end;
$$;

-- lock everything down: service role only
revoke all on function public.briefing_save_settings(uuid, boolean, boolean, numeric, numeric, uuid, text, uuid) from public, anon, authenticated;
grant execute on function public.briefing_save_settings(uuid, boolean, boolean, numeric, numeric, uuid, text, uuid) to service_role;
revoke all on function public.briefing_issue_claim(uuid, text) from public, anon, authenticated;
revoke all on function public.briefing_consume_claim(text, text, uuid) from public, anon, authenticated;
revoke all on function public.briefing_prepare_runs(text, date) from public, anon, authenticated;
revoke all on function public.briefing_claim_runs(text, date, integer, integer) from public, anon, authenticated;
revoke all on function public.briefing_recover_runs(text, date) from public, anon, authenticated;
revoke all on function public.briefing_mark_dispatch(uuid, uuid) from public, anon, authenticated;
revoke all on function public.briefing_finish_run(uuid, uuid, text, bigint, text) from public, anon, authenticated;
revoke all on function public.briefing_capture_outcome(uuid, text, bigint, bigint, text, text) from public, anon, authenticated;
grant execute on function public.briefing_issue_claim(uuid, text) to service_role;
grant execute on function public.briefing_consume_claim(text, text, uuid) to service_role;
grant execute on function public.briefing_prepare_runs(text, date) to service_role;
grant execute on function public.briefing_claim_runs(text, date, integer, integer) to service_role;
grant execute on function public.briefing_recover_runs(text, date) to service_role;
grant execute on function public.briefing_mark_dispatch(uuid, uuid) to service_role;
grant execute on function public.briefing_finish_run(uuid, uuid, text, bigint, text) to service_role;
grant execute on function public.briefing_capture_outcome(uuid, text, bigint, bigint, text, text) to service_role;

-- ── cron: two send ticks + a bounded drain/recovery tick (all through the vault dispatcher) ─────
create or replace function runtime.invoke_daily_briefing_cron(p_kind text)
returns bigint
language plpgsql security definer set search_path = ''
as $$
declare
  v_functions_url text;
  v_cron_secret text;
  v_request_id bigint;
begin
  select decrypted_secret into v_functions_url from vault.decrypted_secrets
   where name = 'nemo_functions_url' order by created_at desc limit 1;
  select decrypted_secret into v_cron_secret from vault.decrypted_secrets
   where name = 'nemo_cron_secret' order by created_at desc limit 1;
  if nullif(btrim(v_functions_url), '') is null or nullif(btrim(v_cron_secret), '') is null then
    raise exception using errcode = '22023', message = 'DAILY_BRIEFING_CRON_NOT_CONFIGURED';
  end if;
  select net.http_post(
    url := rtrim(v_functions_url, '/') || '/daily-briefing-worker',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron-secret', v_cron_secret),
    body := jsonb_build_object('kind', p_kind, 'source', 'pg_cron', 'scheduled_for', clock_timestamp()),
    timeout_milliseconds := 30000
  ) into v_request_id;
  return v_request_id;
end;
$$;
revoke all on function runtime.invoke_daily_briefing_cron(text) from public, anon, authenticated;
grant execute on function runtime.invoke_daily_briefing_cron(text) to service_role;

do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.unschedule(jobid) from cron.job where jobname in
      ('nemo-briefing-morning', 'nemo-briefing-evening', 'nemo-briefing-drain');
    -- 08:30 and 20:00 Asia/Tashkent (UTC+5, no DST)
    perform cron.schedule('nemo-briefing-morning', '30 3 * * *',
      'select runtime.invoke_daily_briefing_cron(''morning'');');
    perform cron.schedule('nemo-briefing-evening', '0 15 * * *',
      'select runtime.invoke_daily_briefing_cron(''evening'');');
    -- drain/recovery: closes expired leases and finishes prepared batches; preparation itself is
    -- gated on the Tashkent due time inside the worker, so a drain can never send early
    perform cron.schedule('nemo-briefing-drain', '*/10 * * * *',
      'select runtime.invoke_daily_briefing_cron(''drain'');');
  end if;
end;
$$;
