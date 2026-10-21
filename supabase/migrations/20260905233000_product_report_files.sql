-- Ежемесячный ФАЙЛ отчёта (Plan B, стадия документа): реестр загрузок с ЯВНО объявленным
-- отчётным периодом, вид расписания product_report и заморозка ПОЛНОГО снимка источника на
-- occurrence. Условия ревью:
--   • период — только явное объявление (никакой эвристики по датам в этой итерации), месяц
--     проверяется как КАЛЕНДАРНЫЙ (01–12), не только формой строки;
--   • occurrence замораживает ВСЁ: sha, имя файла, период, момент загрузки, валюту (ревизия
--     уже заморожена) — повторное объявление периода в реестре НЕ переименовывает уже
--     подготовленную occurrence, подпись документа собирается из снимка occurrence;
--   • повторная загрузка того же файла сохраняет ПЕРВОНАЧАЛЬНЫЕ uploaded_at и период —
--     метка времени «данные по состоянию на» не омолаживается пере-загрузкой (обработчик
--     обновляет только имя файла);
--   • отправляемый документ строится PER-OCCURRENCE в памяти и НЕ переиспользует общий
--     артефакт margin-reports/<sha>/... — период/as-of/sha вшиваются в сам workbook;
--   • смена сигнатур reminder_save_schedule / reminder_claim_due — через ЯВНЫЙ drop без
--     cascade и повторные revoke/grant: у RETURNS TABLE нельзя добавить колонки через
--     create or replace, а параметры по умолчанию создали бы ПЕРЕГРУЗКУ со старыми правами.
--     Старые 7-аргументные вызовы продолжают работать через значения по умолчанию.

-- ── реестр загрузок с отчётным периодом ─────────────────────────────────────────────────────────
create table if not exists public.margin_upload_registry (
  account_id    uuid not null references public.accounts(id) on delete cascade,
  file_sha256   text not null check (file_sha256 ~ '^[0-9a-f]{64}$'),
  file_name     text not null check (char_length(file_name) between 1 and 200),
  uploaded_at   timestamptz not null default now(),
  -- календарный месяц: 2026-13 не проходит, не только «четыре цифры-дефис-две цифры»
  period_month  text check (period_month ~ '^\d{4}-(0[1-9]|1[0-2])$'),
  period_set_at timestamptz,
  primary key (account_id, file_sha256)
);

alter table public.margin_upload_registry enable row level security;
drop policy if exists margin_upload_registry_read on public.margin_upload_registry;
create policy margin_upload_registry_read on public.margin_upload_registry for select to authenticated
  using (
    account_id = public.current_account_id()
    and exists (
      select 1 from public.users u
       where u.id = auth.uid() and (u.role = 'owner' or u.is_admin = true)
         and u.account_id = margin_upload_registry.account_id
    )
  );
revoke insert, update, delete on public.margin_upload_registry from anon, authenticated;

-- ── вид расписания и снимок источника на occurrence ─────────────────────────────────────────────
alter table public.reminder_schedules add column if not exists kind text not null default 'reminder'
  check (kind in ('reminder', 'product_report'));
alter table public.reminder_schedules add column if not exists report_currency text
  check (report_currency is null or report_currency in ('UZS', 'USD', 'RUB', 'EUR'));

alter table public.reminder_occurrences add column if not exists source_file_sha256 text
  check (source_file_sha256 is null or source_file_sha256 ~ '^[0-9a-f]{64}$');
alter table public.reminder_occurrences add column if not exists source_file_name text;
alter table public.reminder_occurrences add column if not exists source_period_month text
  check (source_period_month is null or source_period_month ~ '^\d{4}-(0[1-9]|1[0-2])$');
alter table public.reminder_occurrences add column if not exists source_uploaded_at timestamptz;
alter table public.reminder_occurrences add column if not exists source_currency text;

-- ── save: добавлены p_kind/p_report_currency. Перегрузка недопустима — старую сигнатуру
--    сносим явно и переназначаем права; прежние 7-аргументные вызовы работают через default ─────
drop function public.reminder_save_schedule(uuid, uuid, text, integer, integer, boolean, timestamptz);
create function public.reminder_save_schedule(
  p_account_id uuid, p_schedule_id uuid, p_title text,
  p_day_of_month integer, p_send_minute integer, p_enabled boolean, p_now timestamptz,
  p_kind text default 'reminder', p_report_currency text default null
) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_row public.reminder_schedules%rowtype;
  v_verified timestamptz;
  v_currency text;
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
  if p_kind is null or p_kind not in ('reminder', 'product_report') then
    return jsonb_build_object('ok', false, 'reason', 'bad_kind');
  end if;
  -- отчёт без валюты не имеет смысла; валюта простого напоминания всегда NULL
  if p_kind = 'product_report'
     and (p_report_currency is null or p_report_currency not in ('UZS', 'USD', 'RUB', 'EUR')) then
    return jsonb_build_object('ok', false, 'reason', 'bad_currency');
  end if;
  v_currency := case when p_kind = 'product_report' then p_report_currency end;
  if p_enabled then
    select recipient_verified_at into v_verified
      from public.briefing_settings where account_id = p_account_id;
    if v_verified is null then
      return jsonb_build_object('ok', false, 'reason', 'recipient_not_verified');
    end if;
  end if;

  if p_schedule_id is null then
    perform 1 from public.accounts where id = p_account_id for update;
    if (select count(*) from public.reminder_schedules where account_id = p_account_id) >= 30 then
      return jsonb_build_object('ok', false, 'reason', 'schedule_limit');
    end if;
    insert into public.reminder_schedules
        (account_id, title, day_of_month, send_minute, enabled, enabled_at, kind, report_currency)
    values (p_account_id, pg_catalog.btrim(p_title), p_day_of_month, p_send_minute, p_enabled,
            case when p_enabled then p_now end, p_kind, v_currency)
    returning * into v_row;
    return jsonb_build_object('ok', true, 'schedule', to_jsonb(v_row));
  end if;

  select * into v_row from public.reminder_schedules
   where id = p_schedule_id and account_id = p_account_id
   for update;
  if not found then return jsonb_build_object('ok', false, 'reason', 'not_found'); end if;
  -- вид заморожен при создании: превращение напоминания в отчёт (и обратно) меняло бы смысл
  -- уже существующих occurrence этого месяца
  if v_row.kind <> p_kind then
    return jsonb_build_object('ok', false, 'reason', 'kind_immutable');
  end if;

  update public.reminder_schedules
     set title = pg_catalog.btrim(p_title),
         day_of_month = p_day_of_month,
         send_minute = p_send_minute,
         enabled = p_enabled,
         enabled_at = case when p_enabled then p_now end,
         report_currency = v_currency,
         schedule_revision = v_row.schedule_revision + 1,
         updated_at = pg_catalog.now()
   where id = v_row.id
  returning * into v_row;

  if p_enabled then
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
    update public.reminder_occurrences
       set status = 'skipped', error = 'schedule_disabled',
           lease_token = null, lease_until = null, updated_at = pg_catalog.now()
     where schedule_id = v_row.id and status = 'planned';
  end if;
  return jsonb_build_object('ok', true, 'schedule', to_jsonb(v_row));
end;
$$;

-- ── claim: RETURNS TABLE расширяется видом/валютой/снимком/lease_until — только через drop ──────
drop function public.reminder_claim_due(timestamptz, date, integer, integer);
create function public.reminder_claim_due(
  p_now timestamptz, p_min_due_date date, p_limit integer, p_lease_seconds integer
) returns table (
  id uuid, account_id uuid, schedule_id uuid, due_date date, due_at timestamptz,
  lease_token uuid, lease_until timestamptz, attempt_count integer, title text,
  kind text, report_currency text,
  source_file_sha256 text, source_file_name text, source_period_month text,
  source_uploaded_at timestamptz, source_currency text
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
  returning o.id, o.account_id, o.schedule_id, o.due_date, o.due_at,
            o.lease_token, o.lease_until, o.attempt_count, s.title,
            s.kind, s.report_currency,
            o.source_file_sha256, o.source_file_name, o.source_period_month,
            o.source_uploaded_at, o.source_currency;
end;
$$;

-- ── заморозка источника: АТОМАРНО выбирает свежайший файл РОВНО этого месяца и снимает ВСЁ.
--    Повторный вызов возвращает уже замороженный снимок — свежая загрузка или переобъявление
--    периода в реестре НЕ меняют однажды подготовленную occurrence ─────────────────────────────
create function public.reminder_freeze_source(p_occurrence_id uuid, p_lease_token uuid)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_schedule_id uuid;
  v_occ public.reminder_occurrences%rowtype;
  v_schedule public.reminder_schedules%rowtype;
  v_src record;
begin
  select schedule_id into v_schedule_id from public.reminder_occurrences where id = p_occurrence_id;
  if v_schedule_id is null then return jsonb_build_object('ok', false, 'reason', 'lease_lost'); end if;

  -- порядок блокировок единый: расписание → occurrence
  select * into v_schedule from public.reminder_schedules where id = v_schedule_id for update;
  if not found or not v_schedule.enabled then
    return jsonb_build_object('ok', false, 'reason', 'schedule_disabled');
  end if;
  select * into v_occ from public.reminder_occurrences
   where id = p_occurrence_id and lease_token = p_lease_token
     and status = 'sending' and dispatched_at is null and lease_until > pg_catalog.now()
   for update;
  if not found then return jsonb_build_object('ok', false, 'reason', 'lease_lost'); end if;
  if v_schedule.schedule_revision <> v_occ.schedule_revision then
    return jsonb_build_object('ok', false, 'reason', 'superseded');
  end if;
  if v_schedule.kind <> 'product_report' then
    return jsonb_build_object('ok', false, 'reason', 'not_report');
  end if;
  if v_schedule.report_currency is null then
    return jsonb_build_object('ok', false, 'reason', 'currency_missing');
  end if;

  if v_occ.source_file_sha256 is not null then
    -- уже заморожено: отвечаем СНИМКОМ occurrence, не реестром
    return jsonb_build_object('ok', true,
      'file_sha256', v_occ.source_file_sha256, 'file_name', v_occ.source_file_name,
      'period_month', v_occ.source_period_month, 'uploaded_at', v_occ.source_uploaded_at,
      'currency', v_occ.source_currency);
  end if;

  select r.file_sha256, r.file_name, r.uploaded_at into v_src
    from public.margin_upload_registry r
   where r.account_id = v_occ.account_id and r.period_month = v_occ.month_key
   -- стабильная развязка при равных метках времени — заморозка детерминирована
   order by r.uploaded_at desc, r.file_sha256 asc
   limit 1;
  if not found then return jsonb_build_object('ok', false, 'reason', 'source_missing_period'); end if;

  update public.reminder_occurrences
     set source_file_sha256 = v_src.file_sha256,
         source_file_name = v_src.file_name,
         source_period_month = v_occ.month_key,
         source_uploaded_at = v_src.uploaded_at,
         source_currency = v_schedule.report_currency,
         updated_at = pg_catalog.now()
   where id = p_occurrence_id;
  return jsonb_build_object('ok', true,
    'file_sha256', v_src.file_sha256, 'file_name', v_src.file_name,
    'period_month', v_occ.month_key, 'uploaded_at', v_src.uploaded_at,
    'currency', v_schedule.report_currency);
end;
$$;

-- ── явное объявление отчётного периода файла (единственный способ его изменить) ─────────────────
create function public.margin_registry_set_period(
  p_account_id uuid, p_file_sha256 text, p_period_month text
) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare v_row public.margin_upload_registry%rowtype;
begin
  if p_file_sha256 is null or p_file_sha256 !~ '^[0-9a-f]{64}$' then
    return jsonb_build_object('ok', false, 'reason', 'bad_sha');
  end if;
  if p_period_month is null or p_period_month !~ '^\d{4}-(0[1-9]|1[0-2])$' then
    return jsonb_build_object('ok', false, 'reason', 'bad_period');
  end if;
  update public.margin_upload_registry
     set period_month = p_period_month, period_set_at = pg_catalog.now()
   where account_id = p_account_id and file_sha256 = p_file_sha256
  returning * into v_row;
  if not found then return jsonb_build_object('ok', false, 'reason', 'not_found'); end if;
  return jsonb_build_object('ok', true, 'source', to_jsonb(v_row));
end;
$$;

-- права переназначаются ЗАНОВО для пересозданных функций и выдаются новым
revoke all on function public.reminder_save_schedule(uuid, uuid, text, integer, integer, boolean, timestamptz, text, text) from public, anon, authenticated;
revoke all on function public.reminder_claim_due(timestamptz, date, integer, integer) from public, anon, authenticated;
revoke all on function public.reminder_freeze_source(uuid, uuid) from public, anon, authenticated;
revoke all on function public.margin_registry_set_period(uuid, text, text) from public, anon, authenticated;
grant execute on function public.reminder_save_schedule(uuid, uuid, text, integer, integer, boolean, timestamptz, text, text) to service_role;
grant execute on function public.reminder_claim_due(timestamptz, date, integer, integer) to service_role;
grant execute on function public.reminder_freeze_source(uuid, uuid) to service_role;
grant execute on function public.margin_registry_set_period(uuid, text, text) to service_role;
