-- Ежемесячные напоминания (Plan B, фундамент): расписания «каждое N-е число», атомарные
-- occurrence→task, и СВОЙ outbox по проверенному протоколу брифинга (lease-CAS, снимок
-- получателя до отправки, неоднозначная отправка = терминальный unknown).
--
-- Принципиальные решения (условия двух раундов ревью):
--   • НИ ОДНОЙ строки в briefing_runs и ни одного нового kind в briefing_* RPC: у брифинга
--     dispatch читает morning/evening-флаги и держит дневную уникальность — месячный поток
--     живёт в СВОИХ таблицах и функциях;
--   • получатель ПЕРЕИСПОЛЬЗУЕТСЯ: та же верификация briefing_settings (deep-link /start),
--     но включённость и ревизия месячного расписания НЕЗАВИСИМЫ: выключенные morning/evening
--     не выключают напоминания, а пересохранение получателя (сброс верификации) закрывает
--     И месячную отправку до повторной верификации — dispatch проверяет только
--     recipient_verified_at/канал/чат, НИКОГДА не morning/evening;
--   • СОГЛАСИЕ — ПО ВРЕМЕНИ, не по дате: планировщик создаёт occurrence только при
--     due_at >= GREATEST(enabled_at текущей ревизии, recipient_verified_at). Каждое
--     сохранение включённого расписания сдвигает enabled_at на «сейчас», поэтому ни правка,
--     ни повторная верификация не открывают догон в прошлое до текущего согласия;
--   • occurrence НИКОГДА не удаляется, идентичность (расписание, аккаунт, месяц) заморожена
--     триггером. Правка расписания ПЕРЕНОСИТ ещё не отправлявшиеся occurrence на новую
--     дату/время (задача пользователя сохраняется: обновляется только её deadline — заголовок
--     и исполнителя после создания правит только человек). Выключение переводит planned в
--     терминальный skipped:schedule_disabled, задачи остаются. Поэтому месяц, в котором
--     occurrence уже СУЩЕСТВУЕТ (отправленная, неизвестная, отменённая), второй отправки не
--     получит — документированное поведение, не недосмотр;
--   • порядок блокировок ЕДИНЫЙ: сначала reminder_schedules, потом reminder_occurrences —
--     и в save, и в планировщике (FOR UPDATE OF s), и в mark_dispatch. Взаимная блокировка
--     save↔dispatch исключается порядком, а не удачей. PGlite-тесты одноподключённые, поэтому
--     сам порядок — инвариант кода и настоящих деплоев, не «доказан гонкой»;
--   • день клампится: LEAST(день, последний день месяца); UI обязан показывать это правило;
--   • Ташкент — фиксированный UTC+5 (без перевода часов), поэтому due_at считается смещением,
--     а не именованной таймзоной: SQL-тесты идут в PGlite без базы tzdata.
--
-- Cron здесь НЕ ставится: воркер-обвязка приходит следующим шагом после ревью фундамента.

create table if not exists public.reminder_schedules (
  id                uuid primary key default gen_random_uuid(),
  account_id        uuid not null references public.accounts(id) on delete cascade,
  title             text not null check (char_length(title) between 1 and 200),
  day_of_month      integer not null check (day_of_month between 1 and 31),
  -- минуты от местной полуночи; 540 = 09:00 Ташкента
  send_minute       integer not null default 540 check (send_minute between 0 and 1439),
  enabled           boolean not null default false,
  -- момент, с которого действует согласие ТЕКУЩЕЙ ревизии; каждый enabled-save сдвигает его
  enabled_at        timestamptz,
  schedule_revision integer not null default 1,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  -- составная цель для FK арендаторского инварианта occurrence
  unique (id, account_id)
);

create table if not exists public.reminder_occurrences (
  id                         uuid primary key default gen_random_uuid(),
  schedule_id                uuid not null,
  account_id                 uuid not null references public.accounts(id) on delete cascade,
  -- НЕИЗМЕНЯЕМАЯ месячная идентичность: единственная отправка расписания в календарный месяц
  month_key                  text not null check (month_key ~ '^\d{4}-\d{2}$'),
  due_date                   date not null,
  due_at                     timestamptz not null,
  schedule_revision          integer not null,
  status                     text not null default 'planned'
    check (status in ('planned', 'sending', 'sent', 'failed', 'skipped', 'unknown')),
  error                      text,
  attempt_count              integer not null default 0,
  lease_token                uuid,
  lease_until                timestamptz,
  dispatched_at              timestamptz,
  dispatch_channel_id        uuid,
  dispatch_chat_id           text,
  dispatch_settings_revision integer,
  telegram_message_id        bigint,
  created_at                 timestamptz not null default now(),
  updated_at                 timestamptz not null default now(),
  unique (schedule_id, month_key),
  -- арендаторский инвариант: occurrence не может ссылаться на чужое расписание
  foreign key (schedule_id, account_id)
    references public.reminder_schedules(id, account_id) on delete cascade
);

-- атомарная связь occurrence→task: у задачи не бывает двух источников-напоминаний
alter table public.tasks add column if not exists reminder_occurrence_id uuid
  unique references public.reminder_occurrences(id) on delete set null;

create index if not exists reminder_schedules_acc_idx on public.reminder_schedules (account_id, created_at desc);
create index if not exists reminder_occurrences_due_idx on public.reminder_occurrences (status, due_at);
create index if not exists reminder_occurrences_acc_idx on public.reminder_occurrences (account_id, due_date desc);

-- месячная идентичность заморожена: «переехавшая» occurrence обошла бы месячную уникальность.
-- due_date/due_at сознательно НЕ заморожены — перенос внутри месяца и есть безопасная правка.
create or replace function public.reminder_occurrence_identity_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.month_key is distinct from old.month_key
     or new.schedule_id is distinct from old.schedule_id
     or new.account_id is distinct from old.account_id then
    raise exception using errcode = '22023', message = 'REMINDER_IDENTITY_IMMUTABLE';
  end if;
  return new;
end;
$$;
drop trigger if exists reminder_occurrence_identity on public.reminder_occurrences;
create trigger reminder_occurrence_identity
  before update on public.reminder_occurrences
  for each row execute function public.reminder_occurrence_identity_guard();

-- ── RLS: читают владелец/админ своего аккаунта; пишут только RPC под service_role ───────────────
alter table public.reminder_schedules enable row level security;
alter table public.reminder_occurrences enable row level security;

drop policy if exists reminder_schedules_read on public.reminder_schedules;
create policy reminder_schedules_read on public.reminder_schedules for select to authenticated
  using (
    account_id = public.current_account_id()
    and exists (
      select 1 from public.users u
       where u.id = auth.uid() and (u.role = 'owner' or u.is_admin = true)
         -- защита в глубину: подделанная строка users с чужим account_id не открывает чужие строки
         and u.account_id = reminder_schedules.account_id
    )
  );

drop policy if exists reminder_occurrences_read on public.reminder_occurrences;
create policy reminder_occurrences_read on public.reminder_occurrences for select to authenticated
  using (
    account_id = public.current_account_id()
    and exists (
      select 1 from public.users u
       where u.id = auth.uid() and (u.role = 'owner' or u.is_admin = true)
         and u.account_id = reminder_occurrences.account_id
    )
  );

revoke insert, update, delete on public.reminder_schedules from anon, authenticated;
revoke insert, update, delete on public.reminder_occurrences from anon, authenticated;

-- ── создание/правка расписания. Любая правка поднимает ревизию. Блокировки: расписание,
--    затем occurrence. planned-строки ПЕРЕНОСЯТСЯ (не удаляются); выключение делает их
--    терминальными; задачи пользователя не стираются никогда ────────────────────────────────────
create or replace function public.reminder_save_schedule(
  p_account_id uuid, p_schedule_id uuid, p_title text,
  p_day_of_month integer, p_send_minute integer, p_enabled boolean, p_now timestamptz
) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_row public.reminder_schedules%rowtype;
  v_verified timestamptz;
begin
  if p_title is null or char_length(pg_catalog.btrim(p_title)) not between 1 and 200 then
    return jsonb_build_object('ok', false, 'reason', 'bad_title');
  end if;
  if p_day_of_month is null or p_day_of_month not between 1 and 31 then
    return jsonb_build_object('ok', false, 'reason', 'bad_day');
  end if;
  if p_send_minute is null or p_send_minute not between 0 and 1439 then
    return jsonb_build_object('ok', false, 'reason', 'bad_minute');
  end if;
  -- включение требует ПРОВЕРЕННОГО получателя (та же верификация, что у брифинга).
  -- Ровно проверка согласия — флаги morning/evening НЕ читаются нигде в этом файле.
  if p_enabled then
    select recipient_verified_at into v_verified
      from public.briefing_settings where account_id = p_account_id;
    if v_verified is null then
      return jsonb_build_object('ok', false, 'reason', 'recipient_not_verified');
    end if;
  end if;

  if p_schedule_id is null then
    -- лимит расписаний — АТОМАРНО, под замком строки аккаунта: два одновременных создания на
    -- границе сериализуются здесь, а не в проверке приложения. Замок аккаунта берётся только в
    -- этой ветке (никаких замков расписаний следом), поэтому инверсии с порядком
    -- «расписание → occurrence» остальных функций нет. Правка существующих НЕ ограничена —
    -- на лимите всё остаётся управляемым и выключаемым.
    perform 1 from public.accounts where id = p_account_id for update;
    if (select count(*) from public.reminder_schedules where account_id = p_account_id) >= 30 then
      return jsonb_build_object('ok', false, 'reason', 'schedule_limit');
    end if;
    insert into public.reminder_schedules (account_id, title, day_of_month, send_minute, enabled, enabled_at)
    values (p_account_id, pg_catalog.btrim(p_title), p_day_of_month, p_send_minute, p_enabled,
            case when p_enabled then p_now end)
    returning * into v_row;
    return jsonb_build_object('ok', true, 'schedule', to_jsonb(v_row));
  end if;

  -- порядок блокировок: РАСПИСАНИЕ первым, occurrence после (как в mark_dispatch и планировщике)
  select * into v_row from public.reminder_schedules
   where id = p_schedule_id and account_id = p_account_id
   for update;
  if not found then return jsonb_build_object('ok', false, 'reason', 'not_found'); end if;

  update public.reminder_schedules
     set title = pg_catalog.btrim(p_title),
         day_of_month = p_day_of_month,
         send_minute = p_send_minute,
         enabled = p_enabled,
         -- согласие ТЕКУЩЕЙ ревизии: каждый enabled-save начинается «с этого момента»
         enabled_at = case when p_enabled then p_now end,
         schedule_revision = v_row.schedule_revision + 1,
         updated_at = pg_catalog.now()
   where id = v_row.id
  returning * into v_row;

  if p_enabled then
    -- сначала deadline задач — и ТОЛЬКО у демонстрационно нетронутых: строка ещё 'todo' и её
    -- deadline всё ещё равен сгенерированной дате. Правленный пользователем срок, взятая в
    -- работу или закрытая задача — собственность человека, расписание их не переписывает.
    update public.tasks t
       set deadline = (pg_catalog.date_trunc('month', o.due_date::timestamp)
                       + pg_catalog.make_interval(days => least(
                           p_day_of_month,
                           extract(day from (pg_catalog.date_trunc('month', o.due_date::timestamp)
                             + interval '1 month - 1 day'))::integer) - 1))::date
      from public.reminder_occurrences o
     where o.schedule_id = v_row.id and o.status = 'planned'
       and t.reminder_occurrence_id = o.id
       and t.status = 'todo'
       and t.deadline = o.due_date;
    -- безопасный перенос: та же occurrence (месяц неизменен), новые день/время/ревизия.
    -- Перенос может дать due_at в прошлом относительно enabled_at этой правки — такая
    -- occurrence НЕ уйдёт: mark_dispatch держит пол согласия по времени (см. ниже).
    update public.reminder_occurrences o
       set due_date = (pg_catalog.date_trunc('month', o.due_date::timestamp)
                       + pg_catalog.make_interval(days => least(
                           p_day_of_month,
                           extract(day from (pg_catalog.date_trunc('month', o.due_date::timestamp)
                             + interval '1 month - 1 day'))::integer) - 1))::date,
           due_at = ((pg_catalog.date_trunc('month', o.due_date::timestamp)
                       + pg_catalog.make_interval(days => least(
                           p_day_of_month,
                           extract(day from (pg_catalog.date_trunc('month', o.due_date::timestamp)
                             + interval '1 month - 1 day'))::integer) - 1)
                       + pg_catalog.make_interval(mins => p_send_minute)
                       - interval '5 hours') at time zone 'UTC'),
           schedule_revision = v_row.schedule_revision,
           updated_at = pg_catalog.now()
     where o.schedule_id = v_row.id and o.status = 'planned';
  else
    -- выключение: planned становится терминальной, месяц остаётся занятым, задачи не трогаем
    update public.reminder_occurrences
       set status = 'skipped', error = 'schedule_disabled',
           lease_token = null, lease_until = null, updated_at = pg_catalog.now()
     where schedule_id = v_row.id and status = 'planned';
  end if;
  return jsonb_build_object('ok', true, 'schedule', to_jsonb(v_row));
end;
$$;

-- ── планировщик: сегодняшние и догоняемые (≤3 дней) даты → occurrence + задача, АТОМАРНО.
--    Расписания блокируются (FOR UPDATE OF s) — правка/выключение не гонится со вставкой.
--    Согласие по ВРЕМЕНИ: due_at не раньше GREATEST(enabled_at, recipient_verified_at) ──────────
create or replace function public.reminder_plan_occurrences(p_today date, p_catchup_days integer default 3)
returns integer
language plpgsql security definer set search_path = ''
as $$
declare v_count integer;
begin
  with days as (
    select g.d::date as due_date
      from pg_catalog.generate_series(
             (p_today - least(greatest(coalesce(p_catchup_days, 0), 0), 3))::timestamp,
             p_today::timestamp, interval '1 day') g(d)
  ),
  locked as (
    -- расписание первым, до любых вставок — единый порядок блокировок с save/mark_dispatch
    select s.id, s.account_id, s.title, s.schedule_revision, s.send_minute, s.day_of_month, s.enabled_at
      from public.reminder_schedules s
      join public.accounts a on a.id = s.account_id and a.blocked = false
      join public.briefing_settings bs on bs.account_id = s.account_id
           and bs.recipient_verified_at is not null
     where s.enabled
       for update of s
  ),
  cand as (
    select l.id as schedule_id, l.account_id, l.schedule_revision, d.due_date,
           pg_catalog.to_char(d.due_date, 'YYYY-MM') as month_key,
           -- Ташкент = фиксированный UTC+5: местные минуты минус 5 часов дают момент в UTC
           ((d.due_date::timestamp + pg_catalog.make_interval(mins => l.send_minute)
             - interval '5 hours') at time zone 'UTC') as due_at
      from locked l
      join days d on true
      join public.briefing_settings bs on bs.account_id = l.account_id
     where extract(day from d.due_date)::integer = least(
             l.day_of_month,
             extract(day from (pg_catalog.date_trunc('month', d.due_date::timestamp)
               + interval '1 month - 1 day'))::integer)
       -- согласие по времени: ни правка, ни повторная верификация не открывают догон
       -- в прошлое до ТЕКУЩЕГО согласия
       and ((d.due_date::timestamp + pg_catalog.make_interval(mins => l.send_minute)
             - interval '5 hours') at time zone 'UTC')
           >= greatest(coalesce(l.enabled_at, bs.recipient_verified_at), bs.recipient_verified_at)
  ),
  ins as (
    insert into public.reminder_occurrences
        (schedule_id, account_id, month_key, due_date, due_at, schedule_revision)
    select schedule_id, account_id, month_key, due_date, due_at, schedule_revision from cand
    on conflict (schedule_id, month_key) do nothing
    returning id, schedule_id, account_id, due_date
  ),
  linked as (
    insert into public.tasks (account_id, title, deadline, status, source, reminder_occurrence_id)
    select i.account_id, l.title, i.due_date, 'todo', 'reminder', i.id
      from ins i
      join locked l on l.id = i.schedule_id
    returning 1
  )
  select count(*)::integer into v_count from ins;
  return v_count;
end;
$$;

-- ── lease-CAS выборка к отправке: due-гейт в SQL (drain не отправляет раньше срока) И нижняя
--    граница p_min_due_date — просроченные строки структурно невыбираемы даже если recovery
--    перед этим не отработал ─────────────────────────────────────────────────────────────────────
create or replace function public.reminder_claim_due(
  p_now timestamptz, p_min_due_date date, p_limit integer, p_lease_seconds integer
) returns table (
  id uuid, account_id uuid, schedule_id uuid, due_date date, due_at timestamptz,
  lease_token uuid, attempt_count integer, title text
)
language plpgsql security definer set search_path = ''
as $$
begin
  return query
  update public.reminder_occurrences o
     set status = 'sending',
         lease_token = pg_catalog.gen_random_uuid(),
         lease_until = pg_catalog.now() + pg_catalog.make_interval(secs => greatest(30, least(p_lease_seconds, 300))),
         attempt_count = o.attempt_count + 1,
         updated_at = pg_catalog.now()
    from public.reminder_schedules s
   where s.id = o.schedule_id
     and o.id in (
       select b.id from public.reminder_occurrences b
        where b.due_at <= p_now
          and b.due_date >= p_min_due_date
          and (b.status = 'planned'
               or (b.status = 'sending' and b.lease_until < pg_catalog.now()
                   and b.dispatched_at is null and b.attempt_count < 2))
        order by b.due_at
        limit greatest(1, least(p_limit, 25))
        for update skip locked
     )
  returning o.id, o.account_id, o.schedule_id, o.due_date, o.due_at, o.lease_token, o.attempt_count, s.title;
end;
$$;

-- ── восстановление: всё, что уже нельзя отправить честно, становится терминальным ───────────────
create or replace function public.reminder_recover(p_now timestamptz, p_expire_before date)
returns integer
language plpgsql security definer set search_path = ''
as $$
declare v_total integer := 0; v_count integer;
begin
  -- просроченный lease ПОСЛЕ диспетчеризации: исход неизвестен, повторной отправки не будет
  update public.reminder_occurrences
     set status = 'unknown', error = 'dispatch_lease_expired', lease_token = null,
         updated_at = pg_catalog.now()
   where status = 'sending' and lease_until < p_now and dispatched_at is not null;
  get diagnostics v_count = row_count; v_total := v_total + v_count;
  -- попытки исчерпаны ДО диспетчеризации: определённый отказ, не вечное 'sending'
  update public.reminder_occurrences
     set status = 'failed', error = 'attempts_exhausted', lease_token = null,
         updated_at = pg_catalog.now()
   where status = 'sending' and lease_until < p_now
     and dispatched_at is null and attempt_count >= 2;
  get diagnostics v_count = row_count; v_total := v_total + v_count;
  -- напоминание старше окна догона опоздало навсегда — закрывается честно, не отправляется
  update public.reminder_occurrences
     set status = 'skipped', error = 'expired_unsent', lease_token = null,
         updated_at = pg_catalog.now()
   where due_date < p_expire_before
     and (status = 'planned'
          or (status = 'sending' and lease_until < p_now and dispatched_at is null));
  get diagnostics v_count = row_count; v_total := v_total + v_count;
  return v_total;
end;
$$;

-- ── CAS-маркер диспетчеризации: заново проверяет ТЕКУЩЕЕ согласие и ревизию расписания,
--    снимает получателя. Порядок блокировок: расписание → occurrence → briefing_settings.
--    Отправка возможна ТОЛЬКО в возвращённый снимок ───────────────────────────────────────────
create or replace function public.reminder_mark_dispatch(p_occurrence_id uuid, p_lease_token uuid)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_schedule_id uuid;
  v_occ public.reminder_occurrences%rowtype;
  v_schedule public.reminder_schedules%rowtype;
  v_settings public.briefing_settings%rowtype;
  v_blocked boolean;
begin
  -- id расписания читается БЕЗ блокировки, чтобы взять замки в едином порядке (расписание
  -- первым); все проверки состояния выполняются ПОСЛЕ захвата обоих замков
  select schedule_id into v_schedule_id from public.reminder_occurrences where id = p_occurrence_id;
  if v_schedule_id is null then return jsonb_build_object('ok', false, 'reason', 'lease_lost'); end if;

  select * into v_schedule from public.reminder_schedules
   where id = v_schedule_id for update;
  if not found then return jsonb_build_object('ok', false, 'reason', 'schedule_disabled'); end if;

  select * into v_occ from public.reminder_occurrences
   where id = p_occurrence_id and lease_token = p_lease_token
     and status = 'sending' and dispatched_at is null and lease_until > pg_catalog.now()
   for update;
  if not found then return jsonb_build_object('ok', false, 'reason', 'lease_lost'); end if;

  if not v_schedule.enabled then
    return jsonb_build_object('ok', false, 'reason', 'schedule_disabled');
  end if;
  -- правка после планирования: устаревшая occurrence не отправляется
  if v_schedule.schedule_revision <> v_occ.schedule_revision then
    return jsonb_build_object('ok', false, 'reason', 'superseded');
  end if;

  -- согласие получателя = верификация брифинга. Пересохранение получателя сбрасывает
  -- verified_at — с этого момента и месячная отправка закрыта до повторной верификации.
  -- Флаги morning/evening сознательно НЕ участвуют: это независимые подписки.
  select * into v_settings from public.briefing_settings
   where account_id = v_occ.account_id for update;
  if not found or v_settings.recipient_verified_at is null
     or v_settings.notify_channel_id is null or v_settings.notify_chat_id is null then
    return jsonb_build_object('ok', false, 'reason', 'recipient_not_verified');
  end if;

  -- пол согласия ПО ВРЕМЕНИ и на диспетчеризации, не только в планировщике: перенос дня назад
  -- (due_at раньше enabled_at этой ревизии) или повторная верификация ПОСЛЕ срока (due_at
  -- раньше recipient_verified_at) не имеют права отправиться
  if v_occ.due_at < greatest(coalesce(v_schedule.enabled_at, v_settings.recipient_verified_at),
                             v_settings.recipient_verified_at) then
    return jsonb_build_object('ok', false, 'reason', 'pre_consent');
  end if;

  select blocked into v_blocked from public.accounts where id = v_occ.account_id;
  if v_blocked is distinct from false then
    return jsonb_build_object('ok', false, 'reason', 'blocked');
  end if;

  update public.reminder_occurrences
     set dispatched_at = pg_catalog.now(),
         dispatch_channel_id = v_settings.notify_channel_id,
         dispatch_chat_id = v_settings.notify_chat_id,
         dispatch_settings_revision = v_settings.settings_revision,
         updated_at = pg_catalog.now()
   where id = p_occurrence_id;
  return jsonb_build_object('ok', true,
    'channel_id', v_settings.notify_channel_id, 'chat_id', v_settings.notify_chat_id);
end;
$$;

-- ── терминальный переход, огороженный тем же lease ──────────────────────────────────────────────
create or replace function public.reminder_finish(
  p_occurrence_id uuid, p_lease_token uuid, p_status text, p_message_id bigint, p_error text
) returns boolean
language plpgsql security definer set search_path = ''
as $$
declare v_count integer;
begin
  if p_status not in ('sent', 'failed', 'skipped', 'unknown') then
    raise exception using errcode = '22023', message = 'REMINDER_BAD_FINISH_STATUS';
  end if;
  update public.reminder_occurrences
     set status = p_status,
         telegram_message_id = p_message_id,
         error = p_error,
         lease_token = null,
         lease_until = null,
         updated_at = pg_catalog.now()
   where id = p_occurrence_id and lease_token = p_lease_token and status = 'sending';
  get diagnostics v_count = row_count;
  return v_count = 1;
end;
$$;

revoke all on function public.reminder_save_schedule(uuid, uuid, text, integer, integer, boolean, timestamptz) from public, anon, authenticated;
revoke all on function public.reminder_plan_occurrences(date, integer) from public, anon, authenticated;
revoke all on function public.reminder_claim_due(timestamptz, date, integer, integer) from public, anon, authenticated;
revoke all on function public.reminder_recover(timestamptz, date) from public, anon, authenticated;
revoke all on function public.reminder_mark_dispatch(uuid, uuid) from public, anon, authenticated;
revoke all on function public.reminder_finish(uuid, uuid, text, bigint, text) from public, anon, authenticated;
grant execute on function public.reminder_save_schedule(uuid, uuid, text, integer, integer, boolean, timestamptz) to service_role;
grant execute on function public.reminder_plan_occurrences(date, integer) to service_role;
grant execute on function public.reminder_claim_due(timestamptz, date, integer, integer) to service_role;
grant execute on function public.reminder_recover(timestamptz, date) to service_role;
grant execute on function public.reminder_mark_dispatch(uuid, uuid) to service_role;
grant execute on function public.reminder_finish(uuid, uuid, text, bigint, text) to service_role;
