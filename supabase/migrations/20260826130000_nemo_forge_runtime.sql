-- ADR 004 / Nemo Forge Stage 1: durable project and execution state.
--
-- This migration intentionally keeps the runtime schema closed. Browser clients
-- must use scoped SECURITY DEFINER RPCs added in the next stage; they must never
-- subscribe to or mutate these tables directly.

create table runtime.skill_definitions (
  skill_id text primary key,
  display_name text not null,
  description text not null,
  allowed_step_types text[] not null,
  allowed_compute_profiles text[] not null,
  risk_class text not null default 'low',
  version integer not null default 1,
  active boolean not null default true,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  constraint skill_definitions_id_check check (
    char_length(skill_id) between 1 and 120
    and skill_id ~ '^[a-z0-9][a-z0-9_-]*$'
  ),
  constraint skill_definitions_name_check check (char_length(display_name) between 1 and 160),
  constraint skill_definitions_description_check check (char_length(description) between 1 and 2048),
  constraint skill_definitions_step_types_check check (
    cardinality(allowed_step_types) between 1 and 6
    and allowed_step_types <@ array[
      'research', 'documents', 'media', 'quality_check', 'approval', 'publish'
    ]::text[]
  ),
  constraint skill_definitions_profiles_check check (
    cardinality(allowed_compute_profiles) between 1 and 4
    and allowed_compute_profiles <@ array[
      'PROFILE_A_WASI', 'PROFILE_B_DOCS', 'PROFILE_C_BROWSER', 'PROFILE_D_GPU'
    ]::text[]
  ),
  constraint skill_definitions_risk_check check (risk_class in ('low', 'medium', 'high')),
  constraint skill_definitions_version_check check (version between 1 and 1000000)
);

create function runtime.text_array_is_unique(p_values text[])
returns boolean
language sql
immutable
strict
set search_path = ''
as $$
  select pg_catalog.cardinality(p_values) = (
    select pg_catalog.count(distinct value)
    from pg_catalog.unnest(p_values) as valueset(value)
  )
$$;

alter table runtime.skill_definitions
  add constraint skill_definitions_step_types_unique_check check (
    array_position(allowed_step_types, null) is null
    and runtime.text_array_is_unique(allowed_step_types)
  ),
  add constraint skill_definitions_profiles_unique_check check (
    array_position(allowed_compute_profiles, null) is null
    and runtime.text_array_is_unique(allowed_compute_profiles)
  );

insert into runtime.skill_definitions (
  skill_id, display_name, description, allowed_step_types,
  allowed_compute_profiles, risk_class
) values
  ('evidence-research', 'Evidence research',
    'Collects bounded evidence and returns references rather than unsupported claims.',
    array['research'], array['PROFILE_A_WASI'], 'low'),
  ('document-authoring', 'Document authoring',
    'Compiles structured, self-contained documents in the document sandbox.',
    array['documents'], array['PROFILE_B_DOCS'], 'medium'),
  ('media-generation', 'Media generation',
    'Creates bounded media artifacts through verified media connectors and workers.',
    array['media'], array['PROFILE_C_BROWSER', 'PROFILE_D_GPU'], 'high'),
  ('grounding-quality-gate', 'Grounding quality gate',
    'Checks evidence, factual consistency, and policy constraints before approval.',
    array['quality_check'], array['PROFILE_A_WASI'], 'low'),
  ('human-approval', 'Human approval',
    'Pauses a plan until an authorized tenant operator records a decision.',
    array['approval'], array['PROFILE_A_WASI'], 'high'),
  ('approved-delivery', 'Approved delivery',
    'Queues an approved result for delivery without bypassing the runtime outbox.',
    array['publish'], array['PROFILE_A_WASI'], 'high');

create table runtime.projects (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.accounts(id) on delete restrict,
  title text not null,
  raw_prompt text not null,
  budget_cap_usd numeric(14, 4) not null,
  status text not null default 'draft',
  plan_version text not null default '1.0',
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  constraint forge_projects_account_id_id_key unique (account_id, id),
  constraint forge_projects_title_check check (char_length(title) between 1 and 160),
  constraint forge_projects_prompt_check check (
    char_length(raw_prompt) between 3 and 16384
    and octet_length(raw_prompt) <= 65536
  ),
  constraint forge_projects_budget_check check (budget_cap_usd between 0 and 1000000),
  constraint forge_projects_status_check check (status in (
    'draft', 'compiling', 'ready', 'running', 'paused', 'completed', 'failed', 'cancelled'
  )),
  constraint forge_projects_plan_version_check check (
    char_length(plan_version) between 1 and 32
    and plan_version ~ '^[0-9]+(\.[0-9]+){0,2}$'
  )
);

create table runtime.project_executions (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null,
  project_id uuid not null,
  workflow_id uuid,
  idempotency_key text not null,
  plan_snapshot jsonb not null,
  plan_hash text generated always as (runtime.sha256_jsonb(plan_snapshot)) stored,
  current_stage_index integer not null default 0,
  status text not null default 'queued',
  fencing_epoch bigint not null default 0,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  constraint forge_executions_account_id_id_key unique (account_id, id),
  constraint forge_executions_account_execution_id_key unique (account_id, project_id, id),
  constraint forge_executions_idempotency_key unique (account_id, project_id, idempotency_key),
  constraint forge_executions_project_fkey foreign key (account_id, project_id)
    references runtime.projects(account_id, id) on delete restrict,
  constraint forge_executions_workflow_fkey foreign key (account_id, workflow_id)
    references runtime.workflow_runs(account_id, id) on delete restrict,
  constraint forge_executions_idempotency_check check (
    char_length(idempotency_key) between 1 and 160
    and idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]*$'
  ),
  constraint forge_executions_plan_object_check check (jsonb_typeof(plan_snapshot) = 'object'),
  constraint forge_executions_plan_size_check check (octet_length(plan_snapshot::text) <= 262144),
  constraint forge_executions_plan_shape_check check (
    plan_snapshot->>'schemaVersion' = '1.0'
    and plan_snapshot->>'projectId' = project_id::text
    and jsonb_typeof(plan_snapshot->'steps') = 'array'
    and jsonb_array_length(plan_snapshot->'steps') between 1 and 32
    and (plan_snapshot->>'totalBudgetCapUsd')::numeric between 0 and 1000000
    and (plan_snapshot->>'estimatedCostUsd')::numeric between 0
      and (plan_snapshot->>'totalBudgetCapUsd')::numeric
  ),
  constraint forge_executions_stage_check check (
    current_stage_index >= 0
    and current_stage_index < jsonb_array_length(plan_snapshot->'steps')
  ),
  constraint forge_executions_status_check check (status in (
    'queued', 'running', 'waiting_approval', 'completed', 'failed', 'cancelled'
  )),
  constraint forge_executions_fencing_check check (fencing_epoch >= 0)
);

create table runtime.execution_steps (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null,
  execution_id uuid not null,
  step_index integer not null,
  title text not null,
  step_type text not null,
  status text not null default 'pending',
  assigned_skill_id text not null references runtime.skill_definitions(skill_id) on delete restrict,
  compute_profile text not null,
  evidence_refs jsonb not null default '[]'::jsonb,
  artifact_refs jsonb not null default '[]'::jsonb,
  cost_tokens bigint not null default 0,
  estimated_cost_usd numeric(14, 6) not null default 0,
  requires_approval boolean not null default false,
  claim_token uuid,
  lease_holder text,
  lease_until timestamptz,
  fencing_epoch bigint not null default 0,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  constraint forge_steps_account_id_id_key unique (account_id, id),
  constraint forge_steps_account_execution_id_key unique (account_id, execution_id, id),
  constraint forge_steps_order_key unique (account_id, execution_id, step_index),
  constraint forge_steps_execution_fkey foreign key (account_id, execution_id)
    references runtime.project_executions(account_id, id) on delete restrict,
  constraint forge_steps_index_check check (step_index between 0 and 31),
  constraint forge_steps_title_check check (char_length(title) between 1 and 160),
  constraint forge_steps_type_check check (step_type in (
    'research', 'documents', 'media', 'quality_check', 'approval', 'publish'
  )),
  constraint forge_steps_status_check check (status in (
    'pending', 'running', 'completed', 'waiting_approval', 'failed', 'cancelled', 'skipped'
  )),
  constraint forge_steps_profile_check check (compute_profile in (
    'PROFILE_A_WASI', 'PROFILE_B_DOCS', 'PROFILE_C_BROWSER', 'PROFILE_D_GPU'
  )),
  constraint forge_steps_evidence_array_check check (
    jsonb_typeof(evidence_refs) = 'array'
    and jsonb_array_length(evidence_refs) <= 64
    and octet_length(evidence_refs::text) <= 65536
  ),
  constraint forge_steps_artifact_array_check check (
    jsonb_typeof(artifact_refs) = 'array'
    and jsonb_array_length(artifact_refs) <= 64
    and octet_length(artifact_refs::text) <= 65536
  ),
  constraint forge_steps_cost_check check (
    cost_tokens >= 0 and estimated_cost_usd between 0 and 1000000
  ),
  constraint forge_steps_approval_check check (
    (step_type = 'approval' and requires_approval)
    or (step_type = 'publish' and requires_approval)
    or step_type not in ('approval', 'publish')
  ),
  constraint forge_steps_fencing_check check (fencing_epoch >= 0),
  constraint forge_steps_lease_holder_check check (
    lease_holder is null or char_length(lease_holder) between 1 and 160
  ),
  constraint forge_steps_lease_integrity_check check (
    (status = 'running' and claim_token is not null and lease_holder is not null and lease_until is not null)
    or (status <> 'running' and claim_token is null and lease_holder is null and lease_until is null)
  )
);

create table runtime.execution_step_dependencies (
  account_id uuid not null,
  execution_id uuid not null,
  step_id uuid not null,
  depends_on_step_id uuid not null,
  created_at timestamptz not null default clock_timestamp(),
  primary key (account_id, step_id, depends_on_step_id),
  constraint forge_step_dependencies_step_fkey
    foreign key (account_id, execution_id, step_id)
    references runtime.execution_steps(account_id, execution_id, id) on delete cascade,
  constraint forge_step_dependencies_parent_fkey
    foreign key (account_id, execution_id, depends_on_step_id)
    references runtime.execution_steps(account_id, execution_id, id) on delete restrict,
  constraint forge_step_dependencies_not_self_check check (step_id <> depends_on_step_id)
);

create table runtime.connector_capabilities (
  account_id uuid not null references public.accounts(id) on delete restrict,
  provider text not null,
  operations text[] not null,
  connection_type text not null,
  verified boolean not null default false,
  verified_at timestamptz,
  verification_ref text,
  models text[] not null default '{}'::text[],
  max_duration_seconds integer,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  primary key (account_id, provider),
  constraint forge_connector_provider_check check (
    char_length(provider) between 1 and 80
    and provider ~ '^[a-z0-9][a-z0-9_-]*$'
  ),
  constraint forge_connector_operations_check check (
    cardinality(operations) between 1 and 6
    and array_position(operations, null) is null
    and runtime.text_array_is_unique(operations)
    and operations <@ array['image', 'video', 'voice', 'avatar', 'document', 'research']::text[]
  ),
  constraint forge_connector_connection_check check (
    connection_type in ('api_key', 'oauth', 'mcp', 'local')
  ),
  constraint forge_connector_verification_check check (
    (verified and verified_at is not null and verification_ref is not null)
    or (not verified and verified_at is null and verification_ref is null)
  ),
  constraint forge_connector_verification_ref_check check (
    verification_ref is null or char_length(verification_ref) between 1 and 512
  ),
  constraint forge_connector_models_check check (
    cardinality(models) <= 100
    and array_position(models, null) is null
    and runtime.text_array_is_unique(models)
  ),
  constraint forge_connector_duration_check check (
    (max_duration_seconds is null)
    or ('video' = any(operations) and max_duration_seconds between 1 and 3600)
  )
);

create function runtime.touch_forge_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := clock_timestamp();
  return new;
end;
$$;

create function runtime.validate_forge_step()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_skill runtime.skill_definitions%rowtype;
begin
  select skill.* into strict v_skill
  from runtime.skill_definitions as skill
  where skill.skill_id = new.assigned_skill_id;

  if not v_skill.active then
    raise exception using errcode = '23514', message = 'assigned Forge skill is inactive';
  end if;
  if not (new.step_type = any(v_skill.allowed_step_types)) then
    raise exception using errcode = '23514', message = 'Forge skill does not allow this step type';
  end if;
  if not (new.compute_profile = any(v_skill.allowed_compute_profiles)) then
    raise exception using errcode = '23514', message = 'Forge skill does not allow this compute profile';
  end if;
  return new;
end;
$$;

create function runtime.protect_forge_execution_identity()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.account_id is distinct from old.account_id
     or new.project_id is distinct from old.project_id
     or new.workflow_id is distinct from old.workflow_id
     or new.idempotency_key is distinct from old.idempotency_key
     or new.plan_snapshot is distinct from old.plan_snapshot then
    raise exception using errcode = '55000', message = 'Forge execution identity and plan snapshot are immutable';
  end if;
  return new;
end;
$$;

create trigger forge_skill_definitions_touch
before update on runtime.skill_definitions
for each row execute function runtime.touch_forge_updated_at();

create trigger forge_projects_touch
before update on runtime.projects
for each row execute function runtime.touch_forge_updated_at();

create trigger forge_project_executions_touch
before update on runtime.project_executions
for each row execute function runtime.touch_forge_updated_at();

create trigger forge_project_executions_identity_immutable
before update on runtime.project_executions
for each row execute function runtime.protect_forge_execution_identity();

create trigger forge_execution_steps_touch
before update on runtime.execution_steps
for each row execute function runtime.touch_forge_updated_at();

create trigger forge_execution_steps_validate
before insert or update of assigned_skill_id, step_type, compute_profile
on runtime.execution_steps
for each row execute function runtime.validate_forge_step();

create trigger forge_connector_capabilities_touch
before update on runtime.connector_capabilities
for each row execute function runtime.touch_forge_updated_at();

create index forge_projects_account_status_idx
  on runtime.projects (account_id, status, updated_at desc, id);
create index forge_executions_project_status_idx
  on runtime.project_executions (account_id, project_id, status, updated_at desc, id);
create index forge_executions_workflow_idx
  on runtime.project_executions (account_id, workflow_id)
  where workflow_id is not null;
create index forge_steps_ready_idx
  on runtime.execution_steps (account_id, execution_id, step_index, id)
  where status = 'pending';
create index forge_steps_expired_lease_idx
  on runtime.execution_steps (lease_until, account_id, id)
  where status = 'running';
create index forge_step_dependencies_execution_idx
  on runtime.execution_step_dependencies (account_id, execution_id, step_id);
create index forge_connector_verified_idx
  on runtime.connector_capabilities (account_id, provider)
  where verified;

alter table runtime.skill_definitions enable row level security;
alter table runtime.projects enable row level security;
alter table runtime.project_executions enable row level security;
alter table runtime.execution_steps enable row level security;
alter table runtime.execution_step_dependencies enable row level security;
alter table runtime.connector_capabilities enable row level security;

revoke all on table runtime.skill_definitions from public, anon, authenticated;
revoke all on table runtime.projects from public, anon, authenticated;
revoke all on table runtime.project_executions from public, anon, authenticated;
revoke all on table runtime.execution_steps from public, anon, authenticated;
revoke all on table runtime.execution_step_dependencies from public, anon, authenticated;
revoke all on table runtime.connector_capabilities from public, anon, authenticated;
revoke all on function runtime.text_array_is_unique(text[]) from public, anon, authenticated;
revoke all on function runtime.touch_forge_updated_at() from public, anon, authenticated;
revoke all on function runtime.validate_forge_step() from public, anon, authenticated;
revoke all on function runtime.protect_forge_execution_identity() from public, anon, authenticated;

comment on table runtime.projects is
  'Closed Nemo Forge project metadata. Access is only through scoped public RPCs.';
comment on table runtime.project_executions is
  'Immutable-plan execution instances with tenant idempotency and fencing generation.';
comment on table runtime.execution_steps is
  'Fenced atomic DAG steps. Sensitive reasoning and plaintext provider secrets are prohibited.';
comment on table runtime.connector_capabilities is
  'Verified connector metadata only. Provider credentials must remain in the secret store.';
