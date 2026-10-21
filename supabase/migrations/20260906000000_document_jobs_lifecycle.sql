-- Документные задания из чата — D2-жизненный цикл: НАСТОЯЩЕЕ активное состояние
-- waiting_compute в машине состояний runtime, идемпотентная постановка и CAS-финализация.
--
-- МАШИНА СОСТОЯНИЙ (расширение контракта runtime, пред-ревью D2):
--   • новое состояние waiting_compute — «workflow ждёт своё compute-задание». Оно НЕтерминально
--     (terminal_at обязан быть NULL) и НЕ running (lease-поля обязаны быть NULL);
--   • разрешённые переходы ДОБАВЛЯЮТСЯ ровно три: queued→waiting_compute (только внутри
--     транзакции постановки, type 'action_enqueued'), waiting_compute→completed и
--     waiting_compute→failed (только финализатором, type 'completed'/'failed').
--     waiting_compute→cancelled НЕ вводится, пока не существует настоящей семантики отмены;
--   • ИЗОЛЯЦИЯ ВЛАДЕНИЯ структурная: runtime_claim_workflow выбирает только queued,
--     просроченный running и созревший retry_scheduled — waiting_compute не подходит ни под
--     одно условие, поэтому НИКАКОЙ клеймер (в т.ч. без фильтра типа) не может забрать
--     родителя, при этом состояние честно видно активным;
--   • наблюдаемость: читатели «активных прогонов» расширяются на waiting_compute
--     (tgProcess/morning-brief в этом же изменении), контракты дашборда состояние не
--     перечисляют и передают строку как есть;
--   • ОТКАТ этой миграции запрещён, пока существуют строки в waiting_compute: сначала
--     финализировать/дренировать, никакой принудительной перекраски состояний.
--
-- ЦИКЛ ЗАДАНИЯ: enqueue = одна транзакция (workflow queued → compute-задание →
-- queued→waiting_compute → строка запроса); исход compute ведут воркерные RPC под воркерным
-- lease; финализатор переносит РОВНО этот исход на родителя (completed→completed,
-- failed/dead_letter→failed c terminal_reason_code из error_code задания), идемпотентен,
-- никогда не трогает cancelled и никогда не завершает родителя раньше задания.
--
-- МАНИФЕСТ-ГЕЙТ (условие D2 «невалидный манифест не становится успехом»): job completed
-- превращается в workflow completed ТОЛЬКО если result_manifest структурно привязан к
-- аккаунту/заданию/виду (job_id, MIME по kind, размер 1..64МиБ, sha256, storage_path с
-- префиксом арендатора и вхождением job_id); иначе — failed/DOCUMENT_MANIFEST_INVALID.
-- Проверка детерминирована, поэтому повторная финализация вычисляет тот же исход.
-- ГРАНИЦА ЧЕСТНОСТИ: структурная валидность ≠ зарегистрированный объект хранилища —
-- download-этап обязан дополнительно проверить регистрацию (upload-граница ещё на пред-ревью)
-- и никогда не выдавать файл по одному лишь манифесту.

-- ── состояние и переходы ────────────────────────────────────────────────────────────────────────
alter table runtime.allowed_workflow_transitions drop constraint allowed_transition_from_state_check;
alter table runtime.allowed_workflow_transitions add constraint allowed_transition_from_state_check check (from_state in (
  'received', 'queued', 'running', 'waiting_for_policy', 'waiting_for_approval',
  'waiting_for_action', 'retry_scheduled', 'waiting_compute'
));
alter table runtime.allowed_workflow_transitions drop constraint allowed_transition_to_state_check;
alter table runtime.allowed_workflow_transitions add constraint allowed_transition_to_state_check check (to_state in (
  'queued', 'running', 'waiting_for_policy', 'waiting_for_approval',
  'waiting_for_action', 'retry_scheduled', 'completed', 'failed', 'denied',
  'dead_letter', 'cancelled', 'waiting_compute'
));
alter table runtime.workflow_runs drop constraint workflow_runs_state_check;
alter table runtime.workflow_runs add constraint workflow_runs_state_check check (current_state in (
  'received', 'queued', 'running', 'waiting_for_policy', 'waiting_for_approval',
  'waiting_for_action', 'retry_scheduled', 'completed', 'failed', 'denied',
  'dead_letter', 'cancelled', 'waiting_compute'
));

insert into runtime.allowed_workflow_transitions (from_state, to_state) values
  ('queued', 'waiting_compute'),
  ('waiting_compute', 'completed'),
  ('waiting_compute', 'failed');

-- ── запросы: идемпотентность и арендаторские инварианты ────────────────────────────────────────
create table if not exists public.document_job_requests (
  account_id   uuid not null references public.accounts(id) on delete cascade,
  request_id   uuid not null,
  kind         text not null check (kind in ('docx_document', 'pptx_presentation')),
  input_sha256 text not null check (input_sha256 ~ '^[a-f0-9]{64}$'),
  workflow_id  uuid not null,
  job_id       uuid not null,
  created_at   timestamptz not null default now(),
  primary key (account_id, request_id),
  unique (account_id, workflow_id),
  unique (account_id, job_id),
  foreign key (account_id, workflow_id) references runtime.workflow_runs(account_id, id) on delete restrict,
  foreign key (account_id, job_id) references runtime.compute_jobs(account_id, id) on delete restrict
);

create index if not exists document_job_requests_day_idx
  on public.document_job_requests (account_id, created_at desc);

alter table public.document_job_requests enable row level security;
drop policy if exists document_job_requests_read on public.document_job_requests;
create policy document_job_requests_read on public.document_job_requests for select to authenticated
  using (
    account_id = public.current_account_id()
    and exists (
      select 1 from public.users u
       where u.id = auth.uid() and (u.role = 'owner' or u.is_admin = true)
         and u.account_id = document_job_requests.account_id
    )
  );
revoke insert, update, delete on public.document_job_requests from anon, authenticated;

-- ── постановка ──────────────────────────────────────────────────────────────────────────────────
create or replace function public.document_enqueue_job(
  p_account_id uuid,
  p_request_id uuid,
  p_kind text,
  p_input jsonb,
  p_daily_quota integer default 50
) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_existing public.document_job_requests%rowtype;
  v_blocked boolean;
  v_input_sha text;
  v_workflow_id uuid;
  v_job_id uuid;
  v_used integer;
  v_ingest jsonb;
  v_enqueue jsonb;
  v_seq bigint;
begin
  if p_account_id is null or p_request_id is null then
    return jsonb_build_object('ok', false, 'reason', 'bad_request');
  end if;
  if p_kind is null or p_kind not in ('docx_document', 'pptx_presentation') then
    return jsonb_build_object('ok', false, 'reason', 'bad_kind');
  end if;
  if p_input is null or pg_catalog.jsonb_typeof(p_input) <> 'object'
     or (p_input->>'kind') is distinct from p_kind then
    return jsonb_build_object('ok', false, 'reason', 'bad_input');
  end if;
  -- SQL — авторитет размера, с запасом к жёсткому 65536 нижнего RPC
  if pg_catalog.octet_length(p_input::text) > 60000 then
    return jsonb_build_object('ok', false, 'reason', 'payload_too_large');
  end if;

  select blocked into v_blocked from public.accounts where id = p_account_id for update;
  if not found then return jsonb_build_object('ok', false, 'reason', 'no_account'); end if;
  -- под замком: параллельная блокировка не проскочит между авторизацией и постановкой
  if v_blocked then return jsonb_build_object('ok', false, 'reason', 'blocked'); end if;

  v_input_sha := runtime.sha256_jsonb(p_input);

  -- идемпотентность РАНЬШЕ квоты: повтор на исчерпанной квоте получает СВОЁ задание
  select * into v_existing from public.document_job_requests
   where account_id = p_account_id and request_id = p_request_id;
  if found then
    if v_existing.kind = p_kind and v_existing.input_sha256 = v_input_sha then
      return jsonb_build_object('ok', true, 'job_id', v_existing.job_id,
        'workflow_id', v_existing.workflow_id, 'deduplicated', true);
    end if;
    return jsonb_build_object('ok', false, 'reason', 'idempotency_conflict');
  end if;

  -- местные сутки Ташкента (+05:00, DST нет) детерминированной арифметикой — без tzdata и
  -- без зависимости от TimeZone сессии
  select count(*)::integer into v_used
    from public.document_job_requests
   where account_id = p_account_id
     and (((created_at at time zone 'UTC') + interval '5 hours')::date)
       = (((pg_catalog.now() at time zone 'UTC') + interval '5 hours')::date);
  if v_used >= greatest(1, least(coalesce(p_daily_quota, 50), 500)) then
    return jsonb_build_object('ok', false, 'reason', 'quota_exceeded');
  end if;

  begin
    v_ingest := public.runtime_ingest_event(
      p_account_id      => p_account_id,
      p_provider        => 'document_jobs',
      p_external_event_id => p_request_id::text,
      p_payload         => jsonb_build_object('kind', p_kind, 'input_sha256', v_input_sha),
      p_execution_mode  => 'live',
      p_correlation_id  => p_request_id,
      p_event_type      => 'document.requested',
      p_workflow_type   => 'document_job',
      p_actor_id        => 'document-jobs'
    );
    v_workflow_id := (v_ingest->>'workflow_id')::uuid;
    v_enqueue := public.runtime_enqueue_compute_job(
      p_account_id, v_workflow_id, 'PROFILE_B_DOCS', p_input
    );
    v_job_id := (v_enqueue->>'job_id')::uuid;

    -- НАСТОЯЩЕЕ активное состояние в той же транзакции: claimable 'queued' снаружи не существует
    select coalesce(max(t.transition_seq), 0) + 1 into v_seq
      from runtime.workflow_transitions t
     where t.account_id = p_account_id and t.workflow_id = v_workflow_id;
    insert into runtime.workflow_transitions (
      account_id, workflow_id, transition_seq, from_state, to_state,
      transition_type, actor_type, actor_id, correlation_id,
      workflow_version, lease_epoch, transition_payload, payload_hash
    ) values (
      p_account_id, v_workflow_id, v_seq, 'queued', 'waiting_compute',
      'action_enqueued', 'system', 'document-jobs', p_request_id,
      'v1', 0, jsonb_build_object('job_id', v_job_id),
      runtime.sha256_jsonb(jsonb_build_object('job_id', v_job_id))
    );
    update runtime.workflow_runs
       set current_state = 'waiting_compute', updated_at = pg_catalog.clock_timestamp()
     where account_id = p_account_id and id = v_workflow_id;
    insert into runtime.audit_events (
      account_id, workflow_id, event_type, actor_type, actor_id,
      correlation_id, details, runtime_contract_version, workflow_version
    ) values (
      p_account_id, v_workflow_id, 'runtime.document_workflow_waiting_compute',
      'system', 'document-jobs', p_request_id,
      jsonb_build_object('job_id', v_job_id), 'runtime-v1', 'v1'
    );
  exception
    when sqlstate '55000' then
      return jsonb_build_object('ok', false, 'reason', 'runtime_paused');
    when others then
      return jsonb_build_object('ok', false, 'reason', 'enqueue_failed');
  end;

  insert into public.document_job_requests (account_id, request_id, kind, input_sha256, workflow_id, job_id)
  values (p_account_id, p_request_id, p_kind, v_input_sha, v_workflow_id, v_job_id);

  return jsonb_build_object('ok', true, 'job_id', v_job_id, 'workflow_id', v_workflow_id, 'deduplicated', false);
end;
$$;

-- ── структурная привязка манифеста к аккаунту/заданию/виду ──────────────────────────────────────
-- Чистая детерминированная проверка (никаких таблиц): {} и любой несвязанный манифест — false.
-- NULL-цепочки схлопываются coalesce'ом в false, никогда в «неизвестно».
create or replace function public.document_manifest_valid(
  p_account_id uuid,
  p_job_id uuid,
  p_kind text,
  p_profile text,
  p_manifest jsonb
) returns boolean
language sql immutable set search_path = ''
as $$
  select coalesce(
    p_profile = 'PROFILE_B_DOCS'
    and pg_catalog.jsonb_typeof(p_manifest) = 'object'
    and (p_manifest->>'job_id') = p_job_id::text
    and (p_manifest->>'status') = 'COMPLETED'
    and pg_catalog.jsonb_typeof(p_manifest->'artifacts') = 'array'
    and pg_catalog.jsonb_array_length(p_manifest->'artifacts') = 1
    and (
      select coalesce(
        pg_catalog.jsonb_typeof(s.a) = 'object'
        and (s.a->>'name') ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$'
        -- расширение имени привязано к kind: report.exe для DOCX не проходит
        and (s.a->>'name') like case p_kind
              when 'docx_document' then '%.docx'
              when 'pptx_presentation' then '%.pptx'
            end
        and (s.a->>'mime_type') = case p_kind
              when 'docx_document' then 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
              when 'pptx_presentation' then 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
            end
        and pg_catalog.jsonb_typeof(s.a->'size_bytes') = 'number'
        and (s.a->>'size_bytes')::numeric = pg_catalog.floor((s.a->>'size_bytes')::numeric)
        and (s.a->>'size_bytes')::numeric between 1 and 67108864
        and (s.a->>'sha256') ~ '^[a-f0-9]{64}$'
        and pg_catalog.length(s.a->>'storage_path') between 1 and 500
        -- ОДИН канонический неизменяемый путь, проверяемый ТОЧНО (не префикс/подстрока):
        -- tenants/<account>/artifacts/YYYY/MM/DD/<job_id>-<name>. Upload-граница обязана
        -- порождать РОВНО эту форму (пред-ревью хранилища проверит её же).
        and (s.a->>'storage_path') ~ (
          '^tenants/' || p_account_id::text || '/artifacts/[0-9]{4}/[0-9]{2}/[0-9]{2}/[^/]+$'
        )
        and pg_catalog.regexp_replace((s.a->>'storage_path'), '^.*/', '')
          = p_job_id::text || '-' || (s.a->>'name')
        and pg_catalog.strpos((s.a->>'storage_path'), '..') = 0
      , false)
      from (select p_manifest->'artifacts'->0 as a) s
    )
  , false);
$$;

-- ── статус: ТОЛЬКО документные задания собственного аккаунта ────────────────────────────────────
-- Наружу отдаётся ИСХОД РОДИТЕЛЯ, а не сырой статус задания: пока финализатор не перенёс
-- терминал задания, это «processing». Манифест виден ТОЛЬКО у workflow completed — job
-- completed с {} или несвязанным манифестом финализируется в failed и никогда не выглядит
-- готовым документом. Пригодность к ВЫДАЧЕ дополнительно проверяет download-этап по
-- зарегистрированному объекту хранилища (upload-граница ещё на пред-ревью).
create or replace function public.document_job_status(p_account_id uuid, p_job_id uuid)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_job runtime.compute_jobs%rowtype;
  v_state text;
  v_terminal_reason text;
  v_status text;
begin
  if p_account_id is null or p_job_id is null then
    return jsonb_build_object('ok', false, 'reason', 'not_found');
  end if;
  select j.* into v_job
    from runtime.compute_jobs j
    join public.document_job_requests r
      on r.account_id = j.account_id and r.job_id = j.id
   where j.account_id = p_account_id and j.id = p_job_id;
  if not found then return jsonb_build_object('ok', false, 'reason', 'not_found'); end if;
  select run.current_state, run.terminal_reason_code into v_state, v_terminal_reason
    from runtime.workflow_runs run
   where run.account_id = p_account_id and run.id = v_job.workflow_id;
  v_status := case
    when v_state = 'completed' then 'completed'
    when v_state = 'failed' then 'failed'
    when v_state = 'cancelled' then 'cancelled'
    else 'processing'
  end;
  return jsonb_build_object(
    'ok', true,
    'status', v_status,
    'workflow_state', v_state,
    'compute_status', v_job.status,
    'error_code', case when v_status = 'failed' then coalesce(v_terminal_reason, v_job.error_code) end,
    'attempt_count', v_job.attempt_count,
    'kind', v_job.input_payload->>'kind',
    'manifest', case when v_status = 'completed' then v_job.result_manifest end,
    'created_at', v_job.created_at
  );
end;
$$;

-- ── CAS-финализация: переносит на родителя РОВНО терминальный исход задания ─────────────────────
create or replace function public.document_finalize_workflow(p_account_id uuid, p_workflow_id uuid)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_run runtime.workflow_runs%rowtype;
  v_request public.document_job_requests%rowtype;
  v_job runtime.compute_jobs%rowtype;
  v_target text;
  v_reason text;
  v_seq bigint;
begin
  if p_account_id is null or p_workflow_id is null then
    return jsonb_build_object('ok', false, 'reason', 'bad_request');
  end if;

  -- порядок замков: родитель, затем задание
  select * into v_run from runtime.workflow_runs
   where account_id = p_account_id and id = p_workflow_id
   for update;
  if not found then return jsonb_build_object('ok', false, 'reason', 'not_found'); end if;
  if v_run.workflow_type <> 'document_job' then
    return jsonb_build_object('ok', false, 'reason', 'not_document');
  end if;
  -- отменённого родителя финализатор НЕ трогает никогда
  if v_run.current_state = 'cancelled' then
    return jsonb_build_object('ok', false, 'reason', 'cancelled');
  end if;

  select * into v_request from public.document_job_requests
   where account_id = p_account_id and workflow_id = p_workflow_id;
  if not found then return jsonb_build_object('ok', false, 'reason', 'not_document'); end if;

  select * into v_job from runtime.compute_jobs
   where account_id = p_account_id and id = v_request.job_id
   for share;
  if not found then return jsonb_build_object('ok', false, 'reason', 'finalize_conflict'); end if;
  -- инвариант связи: задание обязано принадлежать именно этому родителю
  if v_job.workflow_id <> p_workflow_id then
    return jsonb_build_object('ok', false, 'reason', 'finalize_conflict');
  end if;

  if v_job.status in ('pending', 'running') then
    return jsonb_build_object('ok', false, 'reason', 'compute_not_terminal');
  end if;
  -- условие D2: НЕвалидный манифест НЕ становится успехом. Проверка детерминирована по
  -- (job, kind, manifest), поэтому повторная финализация вычисляет тот же исход.
  if v_job.status = 'completed' then
    if public.document_manifest_valid(p_account_id, v_job.id, v_request.kind, v_job.profile, v_job.result_manifest) then
      v_target := 'completed';
      v_reason := null;
    else
      v_target := 'failed';
      v_reason := 'DOCUMENT_MANIFEST_INVALID';
    end if;
  else
    v_target := 'failed';
    v_reason := coalesce(v_job.error_code, 'DOCUMENT_JOB_FAILED');
  end if;

  -- идемпотентность: совпадающий терминал — уже сделано; расходящийся — конфликт, не перекраска
  if v_run.current_state in ('completed', 'failed') then
    if v_run.current_state = v_target then
      return jsonb_build_object('ok', true, 'status', v_target, 'already', true);
    end if;
    return jsonb_build_object('ok', false, 'reason', 'finalize_conflict');
  end if;
  if v_run.current_state <> 'waiting_compute' then
    return jsonb_build_object('ok', false, 'reason', 'not_waiting');
  end if;

  select coalesce(max(t.transition_seq), 0) + 1 into v_seq
    from runtime.workflow_transitions t
   where t.account_id = p_account_id and t.workflow_id = p_workflow_id;
  insert into runtime.workflow_transitions (
    account_id, workflow_id, transition_seq, from_state, to_state,
    transition_type, actor_type, actor_id, correlation_id,
    workflow_version, lease_epoch, transition_payload, payload_hash
  ) values (
    p_account_id, p_workflow_id, v_seq, 'waiting_compute', v_target,
    v_target, 'worker', 'document-worker', v_run.correlation_id,
    v_run.workflow_version, 0, jsonb_build_object('job_id', v_job.id, 'job_status', v_job.status),
    runtime.sha256_jsonb(jsonb_build_object('job_id', v_job.id, 'job_status', v_job.status))
  );
  -- терминальные поля по контракту: completed — без причины, failed — с кодом из задания;
  -- lease-поля не трогаются (они NULL по инварианту нетерминального неclaimable состояния)
  update runtime.workflow_runs
     set current_state = v_target,
         terminal_at = pg_catalog.clock_timestamp(),
         terminal_reason_code = v_reason,
         updated_at = pg_catalog.clock_timestamp()
   where account_id = p_account_id and id = p_workflow_id;
  insert into runtime.audit_events (
    account_id, workflow_id, event_type, actor_type, actor_id,
    correlation_id, details, runtime_contract_version, workflow_version
  ) values (
    p_account_id, p_workflow_id, 'runtime.document_workflow_finalized',
    'worker', 'document-worker', v_run.correlation_id,
    jsonb_build_object('status', v_target, 'job_id', v_job.id, 'job_status', v_job.status,
      'reason', v_reason), 'runtime-v1', v_run.workflow_version
  );
  return jsonb_build_object('ok', true, 'status', v_target, 'already', false);
end;
$$;

-- ── детерминированная развёртка незакрытых: только документные, только терминальные задания ─────
create or replace function public.document_list_unfinalized(p_limit integer default 25)
returns table (account_id uuid, workflow_id uuid)
language sql security definer set search_path = ''
as $$
  select run.account_id, run.id
    from runtime.workflow_runs run
    join public.document_job_requests r
      on r.account_id = run.account_id and r.workflow_id = run.id
    join runtime.compute_jobs j
      on j.account_id = r.account_id and j.id = r.job_id
   where run.workflow_type = 'document_job'
     and run.current_state = 'waiting_compute'
     and j.status in ('completed', 'failed', 'dead_letter')
   order by run.created_at, run.id
   limit greatest(1, least(coalesce(p_limit, 25), 25));
$$;

revoke all on function public.document_manifest_valid(uuid, uuid, text, text, jsonb) from public, anon, authenticated;
revoke all on function public.document_enqueue_job(uuid, uuid, text, jsonb, integer) from public, anon, authenticated;
revoke all on function public.document_job_status(uuid, uuid) from public, anon, authenticated;
revoke all on function public.document_finalize_workflow(uuid, uuid) from public, anon, authenticated;
revoke all on function public.document_list_unfinalized(integer) from public, anon, authenticated;
grant execute on function public.document_enqueue_job(uuid, uuid, text, jsonb, integer) to service_role;
grant execute on function public.document_job_status(uuid, uuid) to service_role;
grant execute on function public.document_finalize_workflow(uuid, uuid) to service_role;
grant execute on function public.document_list_unfinalized(integer) to service_role;
