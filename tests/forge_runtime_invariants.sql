\set ON_ERROR_STOP on

begin;

insert into public.accounts (id, name) values
  ('10000000-0000-4000-8000-000000000001', 'Forge tenant A'),
  ('10000000-0000-4000-8000-000000000002', 'Forge tenant B');

insert into runtime.projects (id, account_id, title, raw_prompt, budget_cap_usd) values
  ('20000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', 'Project A', 'Create a grounded campaign', 10),
  ('20000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000002', 'Project B', 'Create a verified report', 10);

insert into runtime.project_executions (
  id, account_id, project_id, idempotency_key, plan_snapshot
) values (
  '30000000-0000-4000-8000-000000000001',
  '10000000-0000-4000-8000-000000000001',
  '20000000-0000-4000-8000-000000000001',
  'forge-test-1',
  '{"schemaVersion":"1.0","projectId":"20000000-0000-4000-8000-000000000001","totalBudgetCapUsd":10,"estimatedCostUsd":1,"steps":[{"stepId":"40000000-0000-4000-8000-000000000001"}]}'::jsonb
);

insert into runtime.execution_steps (
  id, account_id, execution_id, step_index, title, step_type,
  assigned_skill_id, compute_profile
) values (
  '40000000-0000-4000-8000-000000000001',
  '10000000-0000-4000-8000-000000000001',
  '30000000-0000-4000-8000-000000000001',
  0, 'Research', 'research', 'evidence-research', 'PROFILE_A_WASI'
);

do $$
begin
  begin
    insert into runtime.project_executions (
      account_id, project_id, idempotency_key, plan_snapshot
    ) values (
      '10000000-0000-4000-8000-000000000002',
      '20000000-0000-4000-8000-000000000001',
      'cross-tenant',
      '{"schemaVersion":"1.0","projectId":"20000000-0000-4000-8000-000000000001","totalBudgetCapUsd":10,"estimatedCostUsd":1,"steps":[{}]}'::jsonb
    );
    raise exception 'cross-tenant project FK was accepted';
  exception when foreign_key_violation then null;
  end;

  begin
    insert into runtime.execution_steps (
      account_id, execution_id, step_index, title, step_type,
      assigned_skill_id, compute_profile
    ) values (
      '10000000-0000-4000-8000-000000000001',
      '30000000-0000-4000-8000-000000000001',
      1, 'Unsafe profile', 'media', 'media-generation', 'Profile_C'
    );
    raise exception 'legacy compute profile was accepted';
  exception when check_violation then null;
  end;

  begin
    insert into runtime.execution_steps (
      account_id, execution_id, step_index, title, step_type,
      assigned_skill_id, compute_profile, requires_approval
    ) values (
      '10000000-0000-4000-8000-000000000001',
      '30000000-0000-4000-8000-000000000001',
      1, 'Publish without gate', 'publish', 'approved-delivery', 'PROFILE_A_WASI', false
    );
    raise exception 'publish without approval requirement was accepted';
  exception when check_violation then null;
  end;

  begin
    insert into runtime.execution_steps (
      account_id, execution_id, step_index, title, step_type,
      assigned_skill_id, compute_profile
    ) values (
      '10000000-0000-4000-8000-000000000001',
      '30000000-0000-4000-8000-000000000001',
      1, 'Unknown skill', 'research', 'missing-skill', 'PROFILE_A_WASI'
    );
    raise exception 'unknown skill was accepted';
  exception when foreign_key_violation then null;
  end;

  begin
    insert into runtime.execution_steps (
      account_id, execution_id, step_index, title, step_type,
      assigned_skill_id, compute_profile
    ) values (
      '10000000-0000-4000-8000-000000000001',
      '30000000-0000-4000-8000-000000000001',
      1, 'Mismatched skill', 'media', 'evidence-research', 'PROFILE_A_WASI'
    );
    raise exception 'skill/type mismatch was accepted';
  exception when check_violation then null;
  end;

  begin
    insert into runtime.connector_capabilities (
      account_id, provider, operations, connection_type, max_duration_seconds
    ) values (
      '10000000-0000-4000-8000-000000000001', 'invalid-duration',
      array['image'], 'api_key', 30
    );
    raise exception 'non-video connector duration was accepted';
  exception when check_violation then null;
  end;

  begin
    insert into runtime.connector_capabilities (
      account_id, provider, operations, connection_type, verified
    ) values (
      '10000000-0000-4000-8000-000000000001', 'false-verification',
      array['video'], 'mcp', true
    );
    raise exception 'verified connector without evidence was accepted';
  exception when check_violation then null;
  end;

  if has_table_privilege('anon', 'runtime.projects', 'select')
     or has_table_privilege('authenticated', 'runtime.projects', 'select')
     or has_table_privilege('anon', 'runtime.execution_steps', 'insert')
     or has_table_privilege('authenticated', 'runtime.connector_capabilities', 'update') then
    raise exception 'Forge runtime tables leaked privileges to application roles';
  end if;
end;
$$;

insert into runtime.project_executions (
  id, account_id, project_id, idempotency_key, plan_snapshot
) values (
  '30000000-0000-4000-8000-000000000002',
  '10000000-0000-4000-8000-000000000001',
  '20000000-0000-4000-8000-000000000001',
  'forge-test-2',
  '{"schemaVersion":"1.0","projectId":"20000000-0000-4000-8000-000000000001","totalBudgetCapUsd":10,"estimatedCostUsd":1,"steps":[{"stepId":"40000000-0000-4000-8000-000000000002"}]}'::jsonb
);

insert into runtime.execution_steps (
  id, account_id, execution_id, step_index, title, step_type,
  assigned_skill_id, compute_profile
) values (
  '40000000-0000-4000-8000-000000000002',
  '10000000-0000-4000-8000-000000000001',
  '30000000-0000-4000-8000-000000000002',
  0, 'Other execution', 'research', 'evidence-research', 'PROFILE_A_WASI'
);

do $$
begin
  begin
    insert into runtime.execution_step_dependencies (
      account_id, execution_id, step_id, depends_on_step_id
    ) values (
      '10000000-0000-4000-8000-000000000001',
      '30000000-0000-4000-8000-000000000001',
      '40000000-0000-4000-8000-000000000001',
      '40000000-0000-4000-8000-000000000002'
    );
    raise exception 'cross-execution dependency was accepted';
  exception when foreign_key_violation then null;
  end;

  begin
    insert into runtime.project_executions (
      account_id, project_id, idempotency_key, plan_snapshot
    ) values (
      '10000000-0000-4000-8000-000000000001',
      '20000000-0000-4000-8000-000000000001',
      'forge-test-1',
      '{"schemaVersion":"1.0","projectId":"20000000-0000-4000-8000-000000000001","totalBudgetCapUsd":10,"estimatedCostUsd":1,"steps":[{}]}'::jsonb
    );
    raise exception 'duplicate tenant idempotency key was accepted';
  exception when unique_violation then null;
  end;
end;
$$;

select 'Nemo Forge Stage 1 invariants passed' as result;

rollback;
