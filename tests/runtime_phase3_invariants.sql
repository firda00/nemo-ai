begin;

do $$
begin
  begin
    perform * from public.runtime_claim_workflow('test-worker', 30, 1, 'shadow', 'Invalid-Type');
    raise exception 'invalid workflow type was accepted';
  exception when sqlstate '22023' then null;
  end;

  if pg_catalog.to_regprocedure('public.runtime_claim_workflow(text,integer,integer,text)') is not null then
    raise exception 'legacy claim overload still exists';
  end if;

  if pg_catalog.has_function_privilege(
      'authenticated',
      'public.runtime_claim_workflow(text,integer,integer,text,text)',
      'EXECUTE'
    ) then
    raise exception 'authenticated can execute runtime claim';
  end if;
  if pg_catalog.has_function_privilege(
      'authenticated',
      'public.runtime_checkpoint_and_transition(uuid,uuid,bigint,uuid,jsonb,text)',
      'EXECUTE'
    ) or pg_catalog.has_function_privilege(
      'anon',
      'public.runtime_acquire_connector_permit(uuid,text,text,integer)',
      'EXECUTE'
    ) then
    raise exception 'application roles can execute privileged phase 3 RPCs';
  end if;
  if not pg_catalog.has_function_privilege(
      'service_role',
      'public.runtime_record_connector_failure(uuid,text,text,uuid,text)',
      'EXECUTE'
    ) then
    raise exception 'service_role cannot execute connector breaker RPCs';
  end if;
end
$$;

do $$
declare
  v_account uuid;
  v_ingest jsonb;
  v_claim record;
begin
  select id into v_account from public.accounts order by created_at limit 1;
  if v_account is null then
    insert into public.accounts (name) values ('Runtime Phase 3 Test') returning id into v_account;
  end if;

  v_ingest := public.runtime_ingest_event(
    v_account, 'phase3-test', 'checkpoint-event', '{}'::jsonb, 'shadow', gen_random_uuid(),
    'test.event', clock_timestamp(), 'runtime-test-v1', 'v1', 'phase3_checkpoint_test', 'v1', 'test'
  );
  select * into strict v_claim
  from public.runtime_claim_workflow('phase3-test-worker', 60, 1, 'shadow', 'phase3_checkpoint_test');

  begin
    perform public.runtime_checkpoint_and_transition(
      v_claim.account_id, v_claim.workflow_id, v_claim.lease_epoch, v_claim.claim_token,
      '[]'::jsonb, 'phase3-test-worker'
    );
    raise exception 'array context patch was accepted';
  exception when sqlstate '22023' then null;
  end;

  begin
    perform public.runtime_checkpoint_and_transition(
      v_claim.account_id, v_claim.workflow_id, v_claim.lease_epoch, v_claim.claim_token,
      pg_catalog.jsonb_build_object('oversized', pg_catalog.repeat('x', 66000)), 'phase3-test-worker'
    );
    raise exception 'oversized context patch was accepted';
  exception when sqlstate '22023' then null;
  end;

  perform public.runtime_checkpoint_and_transition(
    v_claim.account_id, v_claim.workflow_id, v_claim.lease_epoch, v_claim.claim_token,
    '{"enrichment":{"status":"complete"}}'::jsonb, 'phase3-test-worker'
  );

  if not exists (
    select 1 from runtime.workflow_runs
    where account_id = v_claim.account_id and id = v_claim.workflow_id
      and current_state = 'waiting_for_policy'
      and context @> '{"enrichment":{"status":"complete"}}'::jsonb
  ) then
    raise exception 'checkpoint did not atomically persist state and context';
  end if;
end
$$;

do $$
declare
  v_account uuid;
  v_permit jsonb;
  v_denied jsonb;
  v_probe jsonb;
begin
  select id into v_account from public.accounts order by created_at limit 1;
  v_permit := public.runtime_acquire_connector_permit(v_account, 'amocrm-test', 'read_lead', 30);
  if not coalesce((v_permit->>'allowed')::boolean, false) or v_permit->>'permit_token' is null then
    raise exception 'closed breaker did not issue a permit';
  end if;

  update runtime.connector_health
  set failure_threshold = 1
  where account_id = v_account and connector_id = 'amocrm-test' and operation = 'read_lead';
  perform public.runtime_record_connector_failure(
    v_account, 'amocrm-test', 'read_lead', (v_permit->>'permit_token')::uuid, 'UPSTREAM_TIMEOUT'
  );
  v_denied := public.runtime_acquire_connector_permit(v_account, 'amocrm-test', 'read_lead', 30);
  if coalesce((v_denied->>'allowed')::boolean, true) then
    raise exception 'open breaker issued a permit during cooldown';
  end if;

  update runtime.connector_health set opened_until = clock_timestamp() - interval '1 second'
  where account_id = v_account and connector_id = 'amocrm-test' and operation = 'read_lead';
  v_probe := public.runtime_acquire_connector_permit(v_account, 'amocrm-test', 'read_lead', 30);
  if not coalesce((v_probe->>'allowed')::boolean, false)
    or v_probe->>'probe_token' is distinct from v_probe->>'permit_token' then
    raise exception 'half-open breaker did not issue a fenced probe';
  end if;
  v_denied := public.runtime_acquire_connector_permit(v_account, 'amocrm-test', 'read_lead', 30);
  if coalesce((v_denied->>'allowed')::boolean, true) then
    raise exception 'half-open breaker admitted more than one probe';
  end if;
end
$$;

rollback;
