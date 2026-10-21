-- Документные артефакты: хранилище + РЕГИСТРАЦИЯ как единственная правда о выдаче.
-- Условное GO Codex (локально, БЕЗ деплоя): публикационный забор — ПОВТОРНАЯ проверка
-- lease в транзакции регистрации (первичная проверка на endpoint только совещательная:
-- она не может обещать отсутствие поздних записей байтов устаревшим воркером);
-- канонический путь квалифицирован попыткой и содержимым, чтобы сирота после
-- upload-успеха/registration-сбоя НИКОГДА не блокировал повтор; финализатор принимает
-- completed ТОЛЬКО при неизменяемой регистрации, совпадающей с манифестом.
--
-- КАНОНИЧЕСКИЙ ПУТЬ (единственная форма, порождается ТОЛЬКО сервером, клиентского пути
-- не существует): tenants/<account_id>/artifacts/<job_id>/<lease_epoch>/<sha256>-<name>
--   • epoch-сегмент: повтор с новым lease пишет в НОВЫЙ путь — сирота прежней попытки
--     не мешает; коллизия возможна только в ТОЙ ЖЕ попытке с ТЕМ ЖЕ содержимым, и
--     endpoint обязан сверить фактические размер/хэш сохранённого объекта перед
--     переиспользованием (никогда не регистрировать коллизию вслепую);
--   • sha-сегмент: содержимое входит в путь — перезапись другим содержимым по тому же
--     пути невозможна структурно; CHECK таблицы пересобирает путь из колонок.
--
-- ПОРЯДОК ОБЯЗАТЕЛЕН: upload → register → finish → finalize. Регистрация требует
-- живой running-lease (token+epoch+срок) под замком родителя — после терминального
-- исхода родителя регистрация невозможна (тот же замок, что у финализатора).
--
-- ИДЕМПОТЕНТНОСТЬ РЕГИСТРАЦИИ: одна строка на job (PK); повтор со ВСЕМИ совпадающими
-- метаданными содержимого (kind/name/mime/size/sha) → already:true и ЗАРЕГИСТРИРОВАННЫЙ
-- путь (истина публикации); любое расхождение → registration_conflict, без перезаписи.
-- Расхождение только в epoch/пути при полном совпадении содержимого НЕ конфликт: это
-- повтор после сбоя finish — воркер обязан использовать зарегистрированный путь.
--
-- УБОРКИ НЕТ СОЗНАТЕЛЬНО (как margin-files): несвязанные объекты копятся, настоящая
-- уборка — отдельный worker через Storage API после собственного ревью.

-- ── бакет: приватный, без браузерных политик, только service role ───────────────────────────────
insert into storage.buckets (id, name, public, file_size_limit)
values ('document-artifacts', 'document-artifacts', false, 64 * 1024 * 1024)
on conflict (id) do update
  set public = false,
      file_size_limit = excluded.file_size_limit;

-- ── составная связь workflow↔job для FK регистрации ────────────────────────────────────────────
alter table public.document_job_requests
  add constraint document_job_requests_job_workflow_key unique (account_id, job_id, workflow_id);

-- ── регистрация: append-only, одна строка на job ────────────────────────────────────────────────
create table public.document_artifacts (
  account_id   uuid not null references public.accounts(id) on delete restrict,
  job_id       uuid not null,
  workflow_id  uuid not null,
  kind         text not null check (kind in ('docx_document', 'pptx_presentation')),
  name         text not null,
  mime_type    text not null,
  size_bytes   bigint not null check (size_bytes between 1 and 67108864),
  sha256       text not null check (sha256 ~ '^[a-f0-9]{64}$'),
  lease_epoch  bigint not null check (lease_epoch >= 0),
  storage_path text not null,
  uploaded_at  timestamptz not null default clock_timestamp(),
  primary key (account_id, job_id),
  unique (storage_path),
  foreign key (account_id, job_id, workflow_id)
    references public.document_job_requests(account_id, job_id, workflow_id) on delete restrict,
  constraint document_artifacts_name_check check (name ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$'),
  constraint document_artifacts_extension_check check (
    (kind = 'docx_document' and name like '%.docx')
    or (kind = 'pptx_presentation' and name like '%.pptx')
  ),
  constraint document_artifacts_mime_check check (
    (kind = 'docx_document'
      and mime_type = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document')
    or (kind = 'pptx_presentation'
      and mime_type = 'application/vnd.openxmlformats-officedocument.presentationml.presentation')
  ),
  -- путь ПЕРЕСОБИРАЕТСЯ из колонок: никакая строка с иным путём не существует
  constraint document_artifacts_canonical_path_check check (
    storage_path = 'tenants/' || account_id::text || '/artifacts/' || job_id::text
      || '/' || lease_epoch::text || '/' || sha256 || '-' || name
  )
);

create trigger document_artifacts_immutable
before update or delete on public.document_artifacts
for each row execute function runtime.prevent_mutation();

alter table public.document_artifacts enable row level security;
drop policy if exists document_artifacts_read on public.document_artifacts;
create policy document_artifacts_read on public.document_artifacts for select to authenticated
  using (
    account_id = public.current_account_id()
    and exists (
      select 1 from public.users u
       where u.id = auth.uid() and (u.role = 'owner' or u.is_admin = true)
         and u.account_id = document_artifacts.account_id
    )
    and not exists (
      select 1 from public.accounts a where a.id = document_artifacts.account_id and a.blocked
    )
  );
revoke insert, update, delete on public.document_artifacts from anon, authenticated;

-- ── валидатор манифеста: путь той же канонической формы, что и регистрация ─────────────────────
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

-- ── совещательная предпроверка загрузки (НЕ забор — забор в регистрации) ───────────────────────
-- Экономит стриминг 64 МиБ для явно устаревшего воркера и отдаёт kind для проверок
-- расширения/MIME на endpoint. Между этой проверкой и регистрацией lease может истечь —
-- публикацию решает ТОЛЬКО document_register_artifact.
create or replace function public.document_verify_upload(
  p_account_id uuid,
  p_job_id uuid,
  p_claim_token uuid,
  p_expected_epoch bigint
) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_blocked boolean;
  v_job runtime.compute_jobs%rowtype;
  v_request public.document_job_requests%rowtype;
  v_state text;
begin
  if p_account_id is null or p_job_id is null or p_claim_token is null or p_expected_epoch is null then
    return jsonb_build_object('ok', false, 'reason', 'bad_request');
  end if;
  select blocked into v_blocked from public.accounts where id = p_account_id;
  if not found then return jsonb_build_object('ok', false, 'reason', 'not_found'); end if;
  if v_blocked then return jsonb_build_object('ok', false, 'reason', 'blocked'); end if;
  select * into v_job from runtime.compute_jobs
   where account_id = p_account_id and id = p_job_id;
  if not found then return jsonb_build_object('ok', false, 'reason', 'not_found'); end if;
  select * into v_request from public.document_job_requests
   where account_id = p_account_id and job_id = p_job_id;
  if not found then return jsonb_build_object('ok', false, 'reason', 'not_document'); end if;
  -- та же строгость, что и у забора: профиль, связь job↔request, родитель в waiting_compute
  if v_job.profile <> 'PROFILE_B_DOCS' or v_job.workflow_id <> v_request.workflow_id then
    return jsonb_build_object('ok', false, 'reason', 'mapping_conflict');
  end if;
  select run.current_state into v_state from runtime.workflow_runs run
   where run.account_id = p_account_id and run.id = v_request.workflow_id;
  if v_state is distinct from 'waiting_compute' then
    return jsonb_build_object('ok', false, 'reason', 'not_waiting');
  end if;
  if v_job.status <> 'running'
     or v_job.claim_token is distinct from p_claim_token
     or v_job.lease_epoch <> p_expected_epoch
     or v_job.lease_until <= pg_catalog.clock_timestamp() then
    return jsonb_build_object('ok', false, 'reason', 'stale_lease');
  end if;
  return jsonb_build_object('ok', true, 'kind', v_request.kind, 'workflow_id', v_request.workflow_id);
end;
$$;

-- ── регистрация: публикационный забор ──────────────────────────────────────────────────────────
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
          or p_mime_type <> 'application/vnd.openxmlformats-officedocument.presentationml.presentation')) then
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

-- ── финализатор: completed ТОЛЬКО при валидном манифесте И совпадающей регистрации ─────────────
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

  -- порядок замков: родитель, затем задание (тот же, что у регистрации — взаимное
  -- исключение: регистрация не может закоммититься после того, как здесь записан терминал)
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
  -- условие D2: НЕвалидный манифест НЕ становится успехом; условие границы хранилища:
  -- УСПЕХ требует неизменяемой регистрации, совпадающей с манифестом по job/имени/MIME/
  -- размеру/хэшу/пути — локальный или незарегистрированный файл никогда не «готов».
  -- Обе проверки детерминированы (регистрация append-only, после терминала невозможна),
  -- поэтому повторная финализация вычисляет тот же исход.
  if v_job.status = 'completed' then
    if not public.document_manifest_valid(p_account_id, v_job.id, v_request.kind, v_job.profile, v_job.result_manifest) then
      v_target := 'failed';
      v_reason := 'DOCUMENT_MANIFEST_INVALID';
    elsif not exists (
      select 1
        from public.document_artifacts a
       where a.account_id = p_account_id and a.job_id = v_job.id
         and a.name = (v_job.result_manifest->'artifacts'->0->>'name')
         and a.mime_type = (v_job.result_manifest->'artifacts'->0->>'mime_type')
         and a.size_bytes::numeric = (v_job.result_manifest->'artifacts'->0->>'size_bytes')::numeric
         and a.sha256 = (v_job.result_manifest->'artifacts'->0->>'sha256')
         and a.storage_path = (v_job.result_manifest->'artifacts'->0->>'storage_path')
    ) then
      v_target := 'failed';
      v_reason := 'DOCUMENT_ARTIFACT_UNREGISTERED';
    else
      v_target := 'completed';
      v_reason := null;
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
  -- терминальные поля по контракту: completed — без причины, failed — с кодом;
  -- lease-поля не трогаются (NULL по инварианту нетерминального неclaimable состояния)
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

revoke all on function public.document_verify_upload(uuid, uuid, uuid, bigint) from public, anon, authenticated;
revoke all on function public.document_register_artifact(uuid, uuid, uuid, bigint, text, text, bigint, text) from public, anon, authenticated;
grant execute on function public.document_verify_upload(uuid, uuid, uuid, bigint) to service_role;
grant execute on function public.document_register_artifact(uuid, uuid, uuid, bigint, text, text, bigint, text) to service_role;
