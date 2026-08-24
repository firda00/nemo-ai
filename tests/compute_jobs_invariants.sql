begin;

insert into public.accounts (id, name)
values ('41000000-0000-4000-8000-000000000001', 'compute-jobs-test');

do $$
declare
  v_ingest jsonb;
  v_job jsonb;
  v_claim record;
  v_second jsonb;
  v_second_claim record;
  v_rejected boolean := false;
begin
  v_ingest := public.runtime_ingest_event(
    '41000000-0000-4000-8000-000000000001',
    'sandbox-test', 'compute-event-1', '{}'::jsonb,
    'shadow', '41100000-0000-4000-8000-000000000001',
    p_event_type => 'sandbox.compute', p_workflow_type => 'sandbox_compute_test'
  );

  begin
    perform public.runtime_enqueue_compute_job(
      '41000000-0000-4000-8000-000000000001',
      (v_ingest->>'workflow_id')::uuid,
      'PROFILE_INVALID', '{}'
    );
  exception when sqlstate '22023' then
    v_rejected := true;
  end;
  if not v_rejected then raise exception 'invalid compute profile was accepted'; end if;

  v_job := public.runtime_enqueue_compute_job(
    '41000000-0000-4000-8000-000000000001',
    (v_ingest->>'workflow_id')::uuid,
    'PROFILE_A_WASI',
    '{"source":"console.log(6 * 7)"}'::jsonb
  );
  select * into strict v_claim
  from public.runtime_claim_compute_jobs('wasi-test-worker', 30, 1, 'PROFILE_A_WASI');

  v_rejected := false;
  begin
    perform public.runtime_finish_compute_job(
      v_claim.account_id, v_claim.job_id, gen_random_uuid(), v_claim.lease_epoch,
      'completed', '{"status":"COMPLETED"}'::jsonb, null
    );
  exception when sqlstate '55000' then
    v_rejected := true;
  end;
  if not v_rejected then raise exception 'stale compute token was accepted'; end if;

  perform public.runtime_finish_compute_job(
    v_claim.account_id, v_claim.job_id, v_claim.claim_token, v_claim.lease_epoch,
    'completed',
    pg_catalog.jsonb_build_object(
      'job_id', v_claim.job_id,
      'status', 'COMPLETED',
      'exit_code', 0,
      'execution_time_ms', 1,
      'stdout_sanitized', '42',
      'stderr_sanitized', '',
      'artifacts', '[]'::jsonb,
      'provenance', pg_catalog.jsonb_build_object('engine_version', 'deno-test')
    ),
    null
  );

  if not exists (
    select 1 from runtime.compute_jobs
    where id = v_claim.job_id and account_id = v_claim.account_id
      and status = 'completed' and claim_token is null and result_manifest is not null
  ) then
    raise exception 'compute completion was not persisted atomically';
  end if;

  v_second := public.runtime_enqueue_compute_job(
    '41000000-0000-4000-8000-000000000001',
    (v_ingest->>'workflow_id')::uuid,
    'PROFILE_A_WASI',
    '{"source":"while(true){}"}'::jsonb
  );
  update runtime.compute_jobs set max_attempts = 1 where id = (v_second->>'job_id')::uuid;
  select * into strict v_second_claim
  from public.runtime_claim_compute_jobs('wasi-crash-worker', 30, 1, 'PROFILE_A_WASI');
  update runtime.compute_jobs
  set lease_until = clock_timestamp() - interval '1 second'
  where id = v_second_claim.job_id;
  perform * from public.runtime_claim_compute_jobs('wasi-recovery-worker', 30, 1, 'PROFILE_A_WASI');

  if not exists (
    select 1 from runtime.compute_jobs
    where id = v_second_claim.job_id
      and status = 'dead_letter' and error_code = 'LEASE_ATTEMPTS_EXHAUSTED'
  ) then
    raise exception 'expired final compute lease was stranded';
  end if;
end
$$;

do $$
begin
  if pg_catalog.has_schema_privilege('authenticated', 'runtime', 'USAGE')
    or pg_catalog.has_function_privilege(
      'authenticated', 'public.runtime_enqueue_compute_job(uuid,uuid,text,jsonb)', 'EXECUTE'
    )
    or pg_catalog.has_function_privilege(
      'anon', 'public.runtime_claim_compute_jobs(text,integer,integer,text)', 'EXECUTE'
    ) then
    raise exception 'application roles can access compute runtime';
  end if;
  if not pg_catalog.has_function_privilege(
    'service_role',
    'public.runtime_finish_compute_job(uuid,uuid,uuid,bigint,text,jsonb,text)',
    'EXECUTE'
  ) then
    raise exception 'service_role cannot finish compute jobs';
  end if;
end
$$;

rollback;
