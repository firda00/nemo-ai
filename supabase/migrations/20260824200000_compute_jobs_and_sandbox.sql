-- ADR 002 Stage 0: durable, tenant-safe compute jobs separated from external side effects.

create table runtime.compute_jobs (
  id uuid primary key default gen_random_uuid(),
  workflow_id uuid not null,
  account_id uuid not null,
  profile text not null,
  status text not null default 'pending',
  claim_token uuid,
  lease_holder text,
  lease_until timestamptz,
  lease_epoch bigint not null default 0,
  input_payload jsonb not null,
  result_manifest jsonb,
  error_code text,
  attempt_count integer not null default 0,
  max_attempts integer not null default 3,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  constraint compute_jobs_account_id_id_key unique (account_id, id),
  constraint compute_jobs_workflow_fkey foreign key (account_id, workflow_id)
    references runtime.workflow_runs(account_id, id) on delete restrict,
  constraint compute_jobs_profile_check check (profile in (
    'PROFILE_A_WASI', 'PROFILE_B_DOCS', 'PROFILE_C_BROWSER', 'PROFILE_D_GPU'
  )),
  constraint compute_jobs_status_check check (status in (
    'pending', 'running', 'completed', 'failed', 'dead_letter'
  )),
  constraint compute_jobs_epoch_check check (lease_epoch >= 0),
  constraint compute_jobs_attempts_check check (
    attempt_count >= 0 and max_attempts between 1 and 20 and attempt_count <= max_attempts
  ),
  constraint compute_jobs_input_object_check check (jsonb_typeof(input_payload) = 'object'),
  constraint compute_jobs_input_size_check check (octet_length(input_payload::text) <= 65536),
  constraint compute_jobs_result_object_check check (
    result_manifest is null or jsonb_typeof(result_manifest) = 'object'
  ),
  constraint compute_jobs_result_size_check check (
    result_manifest is null or octet_length(result_manifest::text) <= 262144
  ),
  constraint compute_jobs_error_code_check check (
    error_code is null or error_code ~ '^[A-Z][A-Z0-9_]{0,63}$'
  ),
  constraint compute_jobs_lease_holder_check check (
    lease_holder is null or char_length(lease_holder) between 1 and 160
  ),
  constraint compute_jobs_lease_integrity_check check (
    (status = 'running' and claim_token is not null and lease_holder is not null and lease_until is not null)
    or (status <> 'running' and claim_token is null and lease_holder is null and lease_until is null)
  ),
  constraint compute_jobs_result_integrity_check check (
    (status in ('pending', 'running') and result_manifest is null and error_code is null)
    or (status = 'completed' and result_manifest is not null and error_code is null)
    or (status in ('failed', 'dead_letter') and result_manifest is null and error_code is not null)
  )
);

create index compute_jobs_pending_idx
  on runtime.compute_jobs (profile, created_at, id)
  where status = 'pending';

create index compute_jobs_expired_lease_idx
  on runtime.compute_jobs (profile, lease_until, id)
  where status = 'running';

create index compute_jobs_workflow_idx
  on runtime.compute_jobs (account_id, workflow_id, created_at desc);

create function public.runtime_enqueue_compute_job(
  p_account_id uuid,
  p_workflow_id uuid,
  p_profile text,
  p_input_payload jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_run runtime.workflow_runs%rowtype;
  v_job_id uuid;
begin
  if p_profile not in ('PROFILE_A_WASI', 'PROFILE_B_DOCS', 'PROFILE_C_BROWSER', 'PROFILE_D_GPU') then
    raise exception using errcode = '22023', message = 'invalid compute profile';
  end if;
  if p_input_payload is null or pg_catalog.jsonb_typeof(p_input_payload) <> 'object' then
    raise exception using errcode = '22023', message = 'compute input must be a JSON object';
  end if;
  if pg_catalog.octet_length(p_input_payload::text) > 65536 then
    raise exception using errcode = '22023', message = 'compute input exceeds size limit';
  end if;

  select run.* into strict v_run
  from runtime.workflow_runs as run
  where run.account_id = p_account_id and run.id = p_workflow_id
  for share;

  if v_run.current_state in ('completed', 'failed', 'denied', 'dead_letter', 'cancelled') then
    raise exception using errcode = '55000', message = 'terminal workflow cannot enqueue compute';
  end if;

  insert into runtime.compute_jobs (account_id, workflow_id, profile, input_payload)
  values (p_account_id, p_workflow_id, p_profile, p_input_payload)
  returning id into v_job_id;

  insert into runtime.audit_events (
    account_id, workflow_id, event_type, actor_type, actor_id,
    correlation_id, details, runtime_contract_version, workflow_version
  ) values (
    p_account_id, p_workflow_id, 'runtime.compute_job_enqueued',
    'system', 'runtime_enqueue_compute_job', v_run.correlation_id,
    pg_catalog.jsonb_build_object('job_id', v_job_id, 'profile', p_profile),
    'runtime-v1', v_run.workflow_version
  );

  return pg_catalog.jsonb_build_object(
    'status', 'pending', 'job_id', v_job_id, 'workflow_id', p_workflow_id, 'profile', p_profile
  );
end
$$;

create function public.runtime_claim_compute_jobs(
  p_worker_id text,
  p_lease_duration_seconds integer default 30,
  p_limit integer default 1,
  p_profile text default 'PROFILE_A_WASI'
)
returns table (
  account_id uuid,
  job_id uuid,
  workflow_id uuid,
  profile text,
  claim_token uuid,
  lease_epoch bigint,
  lease_until timestamptz,
  attempt_count integer,
  max_attempts integer,
  input_payload jsonb
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_control runtime.system_controls%rowtype;
  v_job runtime.compute_jobs%rowtype;
  v_run runtime.workflow_runs%rowtype;
  v_token uuid;
  v_until timestamptz;
  v_now timestamptz := clock_timestamp();
begin
  if p_worker_id is null or char_length(p_worker_id) not between 1 and 160 then
    raise exception using errcode = '22023', message = 'invalid compute worker id';
  end if;
  if p_lease_duration_seconds not between 5 and 3600 then
    raise exception using errcode = '22023', message = 'invalid compute lease duration';
  end if;
  if p_limit not between 1 and 100 then
    raise exception using errcode = '22023', message = 'invalid compute claim limit';
  end if;
  if p_profile not in ('PROFILE_A_WASI', 'PROFILE_B_DOCS', 'PROFILE_C_BROWSER', 'PROFILE_D_GPU') then
    raise exception using errcode = '22023', message = 'invalid compute profile filter';
  end if;

  select controls.* into strict v_control
  from runtime.system_controls as controls
  where controls.singleton
  for share;
  if v_control.kill_switch_active or v_control.claims_paused then return; end if;

  -- A crashed worker on its final permitted attempt must become visible, not remain an unclaimable
  -- expired running row forever.
  for v_job in
    update runtime.compute_jobs as job
    set status = 'dead_letter',
        claim_token = null,
        lease_holder = null,
        lease_until = null,
        error_code = 'LEASE_ATTEMPTS_EXHAUSTED',
        updated_at = v_now
    where job.profile = p_profile
      and job.status = 'running'
      and job.lease_until <= v_now
      and job.attempt_count >= job.max_attempts
    returning job.*
  loop
    select run.* into strict v_run
    from runtime.workflow_runs as run
    where run.account_id = v_job.account_id and run.id = v_job.workflow_id;
    insert into runtime.audit_events (
      account_id, workflow_id, event_type, actor_type, actor_id,
      correlation_id, details, runtime_contract_version, workflow_version
    ) values (
      v_job.account_id, v_job.workflow_id, 'runtime.compute_job_dead_lettered',
      'worker', p_worker_id, v_run.correlation_id,
      pg_catalog.jsonb_build_object('job_id', v_job.id, 'error_code', 'LEASE_ATTEMPTS_EXHAUSTED'),
      'runtime-v1', v_run.workflow_version
    );
  end loop;

  for v_job in
    select job.*
    from runtime.compute_jobs as job
    where job.profile = p_profile
      and job.attempt_count < job.max_attempts
      and (
        job.status = 'pending'
        or (job.status = 'running' and job.lease_until <= v_now)
      )
    order by job.created_at, job.id
    for update skip locked
    limit p_limit
  loop
    v_token := gen_random_uuid();
    v_until := v_now + pg_catalog.make_interval(secs => p_lease_duration_seconds);
    update runtime.compute_jobs as job
    set status = 'running',
        claim_token = v_token,
        lease_holder = p_worker_id,
        lease_until = v_until,
        lease_epoch = job.lease_epoch + 1,
        attempt_count = job.attempt_count + 1,
        updated_at = v_now
    where job.account_id = v_job.account_id and job.id = v_job.id
    returning job.* into v_job;

    select run.* into strict v_run
    from runtime.workflow_runs as run
    where run.account_id = v_job.account_id and run.id = v_job.workflow_id;
    insert into runtime.audit_events (
      account_id, workflow_id, event_type, actor_type, actor_id,
      correlation_id, details, runtime_contract_version, workflow_version
    ) values (
      v_job.account_id, v_job.workflow_id, 'runtime.compute_job_claimed',
      'worker', p_worker_id, v_run.correlation_id,
      pg_catalog.jsonb_build_object(
        'job_id', v_job.id, 'profile', v_job.profile,
        'lease_epoch', v_job.lease_epoch, 'lease_until', v_job.lease_until
      ),
      'runtime-v1', v_run.workflow_version
    );

    return query select
      v_job.account_id, v_job.id, v_job.workflow_id, v_job.profile,
      v_job.claim_token, v_job.lease_epoch, v_job.lease_until,
      v_job.attempt_count, v_job.max_attempts, v_job.input_payload;
  end loop;
end
$$;

create function public.runtime_finish_compute_job(
  p_account_id uuid,
  p_job_id uuid,
  p_claim_token uuid,
  p_expected_epoch bigint,
  p_status text,
  p_result_manifest jsonb default null,
  p_error_code text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_job runtime.compute_jobs%rowtype;
  v_run runtime.workflow_runs%rowtype;
begin
  if p_status not in ('completed', 'failed', 'dead_letter') then
    raise exception using errcode = '22023', message = 'invalid terminal compute status';
  end if;
  if p_status = 'completed' then
    if p_result_manifest is null or pg_catalog.jsonb_typeof(p_result_manifest) <> 'object'
      or p_error_code is not null then
      raise exception using errcode = '22023', message = 'completed compute requires a result manifest only';
    end if;
    if pg_catalog.octet_length(p_result_manifest::text) > 262144 then
      raise exception using errcode = '22023', message = 'compute result exceeds size limit';
    end if;
  elsif p_result_manifest is not null
    or p_error_code is null
    or p_error_code !~ '^[A-Z][A-Z0-9_]{0,63}$' then
    raise exception using errcode = '22023', message = 'failed compute requires a sanitized error code only';
  end if;

  select job.* into strict v_job
  from runtime.compute_jobs as job
  where job.account_id = p_account_id and job.id = p_job_id
  for update;
  if v_job.status <> 'running'
    or v_job.claim_token is distinct from p_claim_token
    or v_job.lease_epoch <> p_expected_epoch
    or v_job.lease_until <= clock_timestamp() then
    raise exception using errcode = '55000', message = 'stale or invalid compute lease';
  end if;

  update runtime.compute_jobs as job
  set status = p_status,
      claim_token = null,
      lease_holder = null,
      lease_until = null,
      result_manifest = case when p_status = 'completed' then p_result_manifest else null end,
      error_code = case when p_status = 'completed' then null else p_error_code end,
      updated_at = clock_timestamp()
  where job.account_id = p_account_id and job.id = p_job_id;

  select run.* into strict v_run
  from runtime.workflow_runs as run
  where run.account_id = v_job.account_id and run.id = v_job.workflow_id;
  insert into runtime.audit_events (
    account_id, workflow_id, event_type, actor_type, actor_id,
    correlation_id, details, runtime_contract_version, workflow_version
  ) values (
    v_job.account_id, v_job.workflow_id, 'runtime.compute_job_finished',
    'worker', v_job.lease_holder, v_run.correlation_id,
    pg_catalog.jsonb_build_object(
      'job_id', v_job.id, 'status', p_status,
      'error_code', p_error_code,
      'result_hash', case when p_result_manifest is null then null else runtime.sha256_jsonb(p_result_manifest) end
    ),
    'runtime-v1', v_run.workflow_version
  );

  return pg_catalog.jsonb_build_object(
    'status', p_status, 'job_id', p_job_id, 'workflow_id', v_job.workflow_id
  );
end
$$;

revoke all on table runtime.compute_jobs from public, anon, authenticated;
revoke all on function public.runtime_enqueue_compute_job(uuid, uuid, text, jsonb)
  from public, anon, authenticated;
revoke all on function public.runtime_claim_compute_jobs(text, integer, integer, text)
  from public, anon, authenticated;
revoke all on function public.runtime_finish_compute_job(uuid, uuid, uuid, bigint, text, jsonb, text)
  from public, anon, authenticated;

grant execute on function public.runtime_enqueue_compute_job(uuid, uuid, text, jsonb) to service_role;
grant execute on function public.runtime_claim_compute_jobs(text, integer, integer, text) to service_role;
grant execute on function public.runtime_finish_compute_job(uuid, uuid, uuid, bigint, text, jsonb, text)
  to service_role;

comment on table runtime.compute_jobs
  is 'ADR 002 fenced compute queue; distinct from external transactional outbox side effects.';
