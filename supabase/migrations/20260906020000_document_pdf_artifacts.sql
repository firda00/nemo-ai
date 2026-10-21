-- Forward-only extension of the reviewed document lifecycle to typed Typst PDF.
-- No existing rows are rewritten. Account/parent/job locks, idempotency, immutable
-- registration and lease fencing are preserved verbatim in the replaced functions.
-- Local validation only; applying this migration to production is not authorized.

alter table public.document_job_requests drop constraint document_job_requests_kind_check;
alter table public.document_job_requests add constraint document_job_requests_kind_check
  check (kind in ('docx_document', 'pptx_presentation', 'typst_document'));
alter table public.document_artifacts drop constraint document_artifacts_kind_check;
alter table public.document_artifacts add constraint document_artifacts_kind_check
  check (kind in ('docx_document', 'pptx_presentation', 'typst_document'));
alter table public.document_artifacts drop constraint document_artifacts_extension_check;
alter table public.document_artifacts add constraint document_artifacts_extension_check check (
  (kind = 'docx_document' and name like '%.docx')
  or (kind = 'pptx_presentation' and name like '%.pptx')
  or (kind = 'typst_document' and name like '%.pdf')
);
alter table public.document_artifacts drop constraint document_artifacts_mime_check;
alter table public.document_artifacts add constraint document_artifacts_mime_check check (
  (kind = 'docx_document' and mime_type = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document')
  or (kind = 'pptx_presentation' and mime_type = 'application/vnd.openxmlformats-officedocument.presentationml.presentation')
  or (kind = 'typst_document' and mime_type = 'application/pdf')
);

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
  if p_kind is null or p_kind not in ('docx_document', 'pptx_presentation', 'typst_document') then
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
              when 'typst_document' then '%.pdf'
            end
        and (s.a->>'mime_type') = case p_kind
              when 'docx_document' then 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
              when 'pptx_presentation' then 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
              when 'typst_document' then 'application/pdf'
            end
        and pg_catalog.jsonb_typeof(s.a->'size_bytes') = 'number'
        and (s.a->>'size_bytes')::numeric = pg_catalog.floor((s.a->>'size_bytes')::numeric)
        and (s.a->>'size_bytes')::numeric between 1 and 67108864
        and (s.a->>'sha256') ~ '^[a-f0-9]{64}$'
        and pg_catalog.length(s.a->>'storage_path') between 1 and 500
        -- ТОЧНАЯ каноническая форма tenants/<acc>/artifacts/<job>/<epoch>/<sha>-<name>:
        -- содержимое (sha) и имя обязаны совпадать с полями артефакта, epoch — число
        and (s.a->>'storage_path') ~ (
          '^tenants/' || p_account_id::text || '/artifacts/' || p_job_id::text || '/[0-9]{1,19}/[^/]+$'
        )
        and pg_catalog.regexp_replace((s.a->>'storage_path'), '^.*/', '')
          = (s.a->>'sha256') || '-' || (s.a->>'name')
        and pg_catalog.strpos((s.a->>'storage_path'), '..') = 0
      , false)
      from (select p_manifest->'artifacts'->0 as a) s
    )
  , false);
$$;

create or replace function public.document_register_artifact(
  p_account_id uuid,
  p_job_id uuid,
  p_claim_token uuid,
  p_expected_epoch bigint,
  p_name text,
  p_mime_type text,
  p_size_bytes bigint,
  p_sha256 text
) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_blocked boolean;
  v_run runtime.workflow_runs%rowtype;
  v_request public.document_job_requests%rowtype;
  v_job runtime.compute_jobs%rowtype;
  v_existing public.document_artifacts%rowtype;
  v_path text;
begin
  if p_account_id is null or p_job_id is null or p_claim_token is null or p_expected_epoch is null
     or p_name is null or p_mime_type is null or p_size_bytes is null or p_sha256 is null then
    return jsonb_build_object('ok', false, 'reason', 'bad_request');
  end if;
  if p_name !~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$' or pg_catalog.strpos(p_name, '..') > 0
     or p_size_bytes not between 1 and 67108864
     or p_sha256 !~ '^[a-f0-9]{64}$' then
    return jsonb_build_object('ok', false, 'reason', 'bad_request');
  end if;

  -- порядок замков ГЛОБАЛЬНО согласован с постановкой: аккаунт → родитель → задание.
  -- FOR SHARE достаточно для стабильного blocked и не сталкивается с другими регистрациями
  select blocked into v_blocked from public.accounts where id = p_account_id for share;
  if not found then return jsonb_build_object('ok', false, 'reason', 'not_found'); end if;
  if v_blocked then return jsonb_build_object('ok', false, 'reason', 'blocked'); end if;

  select * into v_request from public.document_job_requests
   where account_id = p_account_id and job_id = p_job_id;
  if not found then return jsonb_build_object('ok', false, 'reason', 'not_document'); end if;

  -- привязка имени/MIME к виду ДО замков
  if (v_request.kind = 'docx_document'
        and (p_name not like '%.docx'
          or p_mime_type <> 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'))
     or (v_request.kind = 'pptx_presentation'
        and (p_name not like '%.pptx'
          or p_mime_type <> 'application/vnd.openxmlformats-officedocument.presentationml.presentation'))
     or (v_request.kind = 'typst_document'
        and (p_name not like '%.pdf' or p_mime_type <> 'application/pdf')) then
    return jsonb_build_object('ok', false, 'reason', 'bad_request');
  end if;

  -- порядок замков как у финализатора: родитель FOR UPDATE, затем задание FOR SHARE.
  -- Этот замок и делает регистрацию невозможной ПОСЛЕ терминала родителя: финализатор
  -- держит родителя, пока пишет терминал; мы держим родителя, пока публикуем.
  select * into v_run from runtime.workflow_runs
   where account_id = p_account_id and id = v_request.workflow_id
   for update;
  if not found then return jsonb_build_object('ok', false, 'reason', 'not_found'); end if;
  if v_run.workflow_type <> 'document_job' then
    return jsonb_build_object('ok', false, 'reason', 'not_document');
  end if;
  if v_run.current_state in ('completed', 'failed', 'denied', 'dead_letter', 'cancelled') then
    return jsonb_build_object('ok', false, 'reason', 'workflow_terminal');
  end if;
  if v_run.current_state <> 'waiting_compute' then
    return jsonb_build_object('ok', false, 'reason', 'not_waiting');
  end if;

  select * into v_job from runtime.compute_jobs
   where account_id = p_account_id and id = p_job_id
   for share;
  if not found then return jsonb_build_object('ok', false, 'reason', 'not_found'); end if;
  -- инварианты связи и профиля: документная регистрация не принимает чужой профиль
  -- (перекоммутированное media-задание) и задание, ведущее к другому родителю
  if v_job.profile <> 'PROFILE_B_DOCS' or v_job.workflow_id <> v_request.workflow_id then
    return jsonb_build_object('ok', false, 'reason', 'mapping_conflict');
  end if;
  -- ЗАБОР: живой running-lease с точным token+epoch; устаревшая попытка не публикует
  if v_job.status <> 'running'
     or v_job.claim_token is distinct from p_claim_token
     or v_job.lease_epoch <> p_expected_epoch
     or v_job.lease_until <= pg_catalog.clock_timestamp() then
    return jsonb_build_object('ok', false, 'reason', 'stale_lease');
  end if;

  -- идемпотентность: одна строка на job; ВСЕ метаданные содержимого обязаны совпасть —
  -- тогда отдаётся ЗАРЕГИСТРИРОВАННЫЙ путь (истина публикации), иначе конфликт
  select * into v_existing from public.document_artifacts
   where account_id = p_account_id and job_id = p_job_id;
  if found then
    if v_existing.name = p_name and v_existing.mime_type = p_mime_type
       and v_existing.size_bytes = p_size_bytes and v_existing.sha256 = p_sha256 then
      return jsonb_build_object('ok', true, 'storage_path', v_existing.storage_path, 'already', true);
    end if;
    return jsonb_build_object('ok', false, 'reason', 'registration_conflict');
  end if;

  v_path := 'tenants/' || p_account_id::text || '/artifacts/' || p_job_id::text
    || '/' || p_expected_epoch::text || '/' || p_sha256 || '-' || p_name;
  insert into public.document_artifacts (
    account_id, job_id, workflow_id, kind, name, mime_type, size_bytes, sha256, lease_epoch, storage_path
  ) values (
    p_account_id, p_job_id, v_request.workflow_id, v_request.kind,
    p_name, p_mime_type, p_size_bytes, p_sha256, p_expected_epoch, v_path
  );
  insert into runtime.audit_events (
    account_id, workflow_id, event_type, actor_type, actor_id,
    correlation_id, details, runtime_contract_version, workflow_version
  ) values (
    p_account_id, v_request.workflow_id, 'runtime.document_artifact_registered',
    'worker', 'document-worker', v_run.correlation_id,
    jsonb_build_object('job_id', p_job_id, 'sha256', p_sha256, 'size_bytes', p_size_bytes,
      'lease_epoch', p_expected_epoch), 'runtime-v1', v_run.workflow_version
  );
  return jsonb_build_object('ok', true, 'storage_path', v_path, 'already', false);
end;
$$;
