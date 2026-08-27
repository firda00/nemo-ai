-- Local-only Forge Event Bridge fixture. Contains no plaintext webhook secret:
-- secret_ref resolves FORGE_WEBHOOK_SECRET from the Edge Function environment.
\set ON_ERROR_STOP on

do $$
declare
  v_account_id constant uuid := '8cb776a2-97f8-4c64-83ea-64994088583c';
  v_project_id constant uuid := '2b1431b5-34fd-4e32-8529-e347fa3c5569';
  v_trigger_id constant uuid := 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11';
  v_matrix_version integer;
  v_bucket_id uuid;
begin
  select matrix.version into v_matrix_version
  from billing.pricing_matrices as matrix
  where matrix.is_active
  limit 1;

  if v_matrix_version is null then
    v_matrix_version := 9001;
    insert into billing.pricing_matrices (
      version, name, conversion_rules, is_active
    ) values (
      v_matrix_version,
      'Local Forge webhook E2E',
      '{"legacy_credit_to_unit": 1}'::jsonb,
      true
    );
  end if;

  insert into public.accounts (id, name, plan, token_balance)
  values (v_account_id, 'Local Forge E2E', 'pro', 1000000)
  on conflict (id) do nothing;

  if not (select cutover.v2_active from billing.cutover_state as cutover where cutover.singleton) then
    perform runtime.enter_billing_maintenance('local-forge-e2e', 'LOCAL_FORGE_E2E');
    perform billing.activate_global_cutover('local-forge-e2e', 'LOCAL_FORGE_E2E');
  end if;

  insert into billing.account_usage_policies (
    account_id, pricing_matrix_version, budget_units, policy
  ) values (
    v_account_id, v_matrix_version, 1000000, '{"fixture": true}'::jsonb
  )
  on conflict (account_id) do update
    set pricing_matrix_version = excluded.pricing_matrix_version,
        budget_units = excluded.budget_units,
        policy = excluded.policy,
        updated_at = clock_timestamp();

  if not exists (
    select 1 from billing.usage_buckets as bucket
    where bucket.account_id = v_account_id
      and bucket.remaining_units >= 25000
      and bucket.expires_at > clock_timestamp()
  ) then
    v_bucket_id := gen_random_uuid();
    insert into billing.usage_buckets (
      id, account_id, source, pricing_matrix_version,
      total_units, remaining_units, expires_at
    ) values (
      v_bucket_id, v_account_id, 'grant', v_matrix_version,
      1000000, 1000000, clock_timestamp() + interval '30 days'
    );
    insert into billing.usage_ledger (
      account_id, event_type, units, bucket_id, idempotency_key, details
    ) values (
      v_account_id, 'grant', 1000000, v_bucket_id,
      'local-forge-e2e-grant', '{"fixture": true}'::jsonb
    );
  end if;

  insert into runtime.projects (
    id, account_id, title, raw_prompt, budget_cap_usd, status
  ) values (
    v_project_id, v_account_id, 'Local marketplace event flow',
    'Validate a marketplace event, ground the result, request approval, then publish.',
    5.00, 'ready'
  )
  on conflict (id) do nothing;

  insert into runtime.event_triggers (
    id, account_id, project_id, provider, event_type, signature_mode,
    secret_ref, task_template, estimated_units, max_events_per_minute,
    execution_mode, active
  ) values (
    v_trigger_id, v_account_id, v_project_id, 'uzum',
    'marketplace.order.status_changed', 'hmac_sha256',
    'env:FORGE_WEBHOOK_SECRET',
    'Validate the order status, collect evidence, request approval, then prepare delivery.',
    25000, 30, 'shadow', true
  )
  on conflict (id) do update
    set account_id = excluded.account_id,
        project_id = excluded.project_id,
        provider = excluded.provider,
        event_type = excluded.event_type,
        signature_mode = excluded.signature_mode,
        secret_ref = excluded.secret_ref,
        task_template = excluded.task_template,
        estimated_units = excluded.estimated_units,
        max_events_per_minute = excluded.max_events_per_minute,
        execution_mode = excluded.execution_mode,
        active = excluded.active;
end
$$;

select id as trigger_id, account_id, project_id, provider, event_type, secret_ref, active
from runtime.event_triggers
where id = 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11';
