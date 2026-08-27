-- Nemo Forge Event Bridge: authenticated trigger registry and atomic handoff into
-- the existing Durable Runtime inbox + ADR 003 usage reservations.

create table runtime.event_triggers (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.accounts(id) on delete restrict,
  project_id uuid not null,
  provider text not null,
  event_type text not null,
  signature_mode text not null,
  secret_ref text not null,
  task_template text not null,
  estimated_units bigint not null,
  max_events_per_minute integer not null default 60,
  execution_mode text not null default 'shadow',
  active boolean not null default true,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  constraint forge_event_triggers_account_id_id_key unique (account_id, id),
  constraint forge_event_triggers_project_fkey foreign key (account_id, project_id)
    references runtime.projects(account_id, id) on delete restrict,
  constraint forge_event_triggers_provider_check check (provider in ('amocrm', 'telegram', 'uzum')),
  constraint forge_event_triggers_type_check check (event_type in (
    'crm.lead.created', 'crm.lead.updated', 'telegram.command.received',
    'marketplace.order.status_changed', 'marketplace.stock.low'
  )),
  constraint forge_event_triggers_provider_type_check check (
    (provider = 'amocrm' and event_type in ('crm.lead.created', 'crm.lead.updated'))
    or (provider = 'telegram' and event_type = 'telegram.command.received')
    or (provider = 'uzum' and event_type in (
      'marketplace.order.status_changed', 'marketplace.stock.low'
    ))
  ),
  constraint forge_event_triggers_signature_check check (
    signature_mode in ('hmac_sha256', 'telegram_secret_token')
  ),
  constraint forge_event_triggers_secret_ref_check check (
    char_length(secret_ref) between 1 and 256
    and secret_ref ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]*$'
  ),
  constraint forge_event_triggers_template_check check (
    char_length(task_template) between 3 and 4096 and octet_length(task_template) <= 16384
  ),
  constraint forge_event_triggers_units_check check (estimated_units between 1 and 1000000000),
  constraint forge_event_triggers_rate_check check (max_events_per_minute between 1 and 10000),
  constraint forge_event_triggers_mode_check check (execution_mode in ('shadow', 'live'))
);

-- This is a routing receipt, not a second payload inbox. The canonical immutable
-- payload remains in runtime.inbox_events and is referenced tenant-safely below.
create table runtime.inbound_events (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null,
  trigger_id uuid not null,
  inbox_event_id uuid not null,
  workflow_id uuid not null,
  project_id uuid not null,
  execution_id uuid not null,
  reservation_id uuid not null,
  provider text not null,
  event_type text not null,
  external_event_id text not null,
  occurred_at timestamptz not null,
  received_at timestamptz not null default clock_timestamp(),
  payload_hash text not null,
  status text not null default 'routed',
  constraint forge_inbound_events_account_id_id_key unique (account_id, id),
  constraint forge_inbound_events_identity_key unique (account_id, provider, external_event_id),
  constraint forge_inbound_events_trigger_fkey foreign key (account_id, trigger_id)
    references runtime.event_triggers(account_id, id) on delete restrict,
  constraint forge_inbound_events_inbox_fkey foreign key (account_id, inbox_event_id)
    references runtime.inbox_events(account_id, id) on delete restrict,
  constraint forge_inbound_events_workflow_fkey foreign key (account_id, workflow_id)
    references runtime.workflow_runs(account_id, id) on delete restrict,
  constraint forge_inbound_events_project_fkey foreign key (account_id, project_id)
    references runtime.projects(account_id, id) on delete restrict,
  constraint forge_inbound_events_execution_fkey foreign key (account_id, execution_id)
    references runtime.project_executions(account_id, id) on delete restrict,
  constraint forge_inbound_events_reservation_fkey foreign key (account_id, reservation_id)
    references billing.usage_reservations(account_id, id) on delete restrict,
  constraint forge_inbound_events_external_id_check check (
    char_length(external_event_id) between 1 and 256
    and external_event_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]*$'
  ),
  constraint forge_inbound_events_payload_hash_check check (payload_hash ~ '^[a-f0-9]{64}$'),
  constraint forge_inbound_events_status_check check (status in ('routed', 'completed', 'failed'))
);

create trigger forge_event_triggers_touch
before update on runtime.event_triggers
for each row execute function runtime.touch_forge_updated_at();

create trigger forge_inbound_events_immutable
before update or delete on runtime.inbound_events
for each row execute function runtime.prevent_mutation();

create index forge_event_triggers_lookup_idx
  on runtime.event_triggers (id, provider) where active;
create index forge_inbound_events_account_received_idx
  on runtime.inbound_events (account_id, received_at desc, id);

alter table runtime.event_triggers enable row level security;
alter table runtime.inbound_events enable row level security;

revoke all on table runtime.event_triggers from public, anon, authenticated;
revoke all on table runtime.inbound_events from public, anon, authenticated;

create function public.runtime_resolve_forge_event_trigger(
  p_trigger_id uuid,
  p_provider text
)
returns table (
  id uuid,
  account_id uuid,
  project_id uuid,
  provider text,
  event_type text,
  signature_mode text,
  secret_ref text,
  task_template text,
  estimated_units bigint,
  max_events_per_minute integer,
  execution_mode text,
  active boolean
)
language sql
stable
security definer
set search_path = ''
as $$
  select trigger.id, trigger.account_id, trigger.project_id, trigger.provider,
    trigger.event_type, trigger.signature_mode, trigger.secret_ref,
    trigger.task_template, trigger.estimated_units, trigger.max_events_per_minute,
    trigger.execution_mode, trigger.active
  from runtime.event_triggers as trigger
  where trigger.id = p_trigger_id and trigger.provider = p_provider and trigger.active
$$;

create function public.runtime_enqueue_forge_event(
  p_account_id uuid,
  p_trigger_id uuid,
  p_external_event_id text,
  p_event_type text,
  p_occurred_at timestamptz,
  p_payload jsonb,
  p_payload_hash text,
  p_plan jsonb,
  p_estimated_units bigint
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_trigger runtime.event_triggers%rowtype;
  v_existing runtime.inbound_events%rowtype;
  v_reservation jsonb;
  v_ingest jsonb;
  v_reservation_id uuid;
  v_inbox_id uuid;
  v_workflow_id uuid;
  v_execution_id uuid;
  v_receipt_id uuid;
  v_execution_created boolean := false;
  v_idempotency_key text;
begin
  if p_account_id is null or p_trigger_id is null then
    raise exception using errcode = '22023', message = 'invalid event identity';
  end if;
  if p_payload is null or jsonb_typeof(p_payload) <> 'object'
     or octet_length(p_payload::text) > 65536 then
    raise exception using errcode = '22023', message = 'invalid event payload';
  end if;
  if p_payload_hash is null or p_payload_hash !~ '^[a-f0-9]{64}$' then
    raise exception using errcode = '22023', message = 'payload integrity mismatch';
  end if;
  if p_occurred_at is null
     or p_occurred_at < clock_timestamp() - interval '5 minutes'
     or p_occurred_at > clock_timestamp() + interval '5 minutes' then
    raise exception using errcode = '22023', message = 'event timestamp outside replay window';
  end if;

  select trigger.* into v_trigger
  from runtime.event_triggers as trigger
  where trigger.account_id = p_account_id and trigger.id = p_trigger_id
  for update;
  if not found or not v_trigger.active then
    raise exception using errcode = '28000', message = 'event rejected';
  end if;
  if p_event_type <> v_trigger.event_type or p_estimated_units <> v_trigger.estimated_units then
    raise exception using errcode = '22023', message = 'event trigger contract mismatch';
  end if;
  select inbound.* into v_existing
  from runtime.inbound_events as inbound
  where inbound.account_id = p_account_id
    and inbound.provider = v_trigger.provider
    and inbound.external_event_id = p_external_event_id;
  if found then
    if v_existing.event_type <> p_event_type or v_existing.payload_hash <> p_payload_hash then
      raise exception using errcode = '23000', message = 'event identity collision';
    end if;
    return jsonb_build_object(
      'status', 'duplicate',
      'inbound_event_id', v_existing.id,
      'workflow_id', v_existing.workflow_id,
      'execution_id', v_existing.execution_id,
      'reservation_id', v_existing.reservation_id
    );
  end if;
  if (
    select count(*)
    from runtime.inbound_events as inbound
    where inbound.account_id = p_account_id
      and inbound.trigger_id = p_trigger_id
      and inbound.received_at >= clock_timestamp() - interval '1 minute'
  ) >= v_trigger.max_events_per_minute then
    return jsonb_build_object('status', 'rate_limited');
  end if;
  if p_plan is null or jsonb_typeof(p_plan) <> 'object'
     or p_plan->>'schemaVersion' <> '1.0'
     or p_plan->>'projectId' <> v_trigger.project_id::text
     or jsonb_typeof(p_plan->'steps') <> 'array'
     or jsonb_array_length(p_plan->'steps') not between 1 and 32 then
    raise exception using errcode = '22023', message = 'invalid Forge plan';
  end if;
  if exists (
    select 1 from jsonb_array_elements(p_plan->'steps') with ordinality as step(value, position)
    where step.value->>'type' = 'publish'
      and not exists (
        select 1 from jsonb_array_elements(p_plan->'steps') with ordinality as approval(value, position)
        where approval.position < step.position
          and approval.value->>'type' = 'approval'
          and (step.value->'dependsOn') ? (approval.value->>'stepId')
      )
  ) then
    raise exception using errcode = '23514', message = 'publish requires a preceding approval dependency';
  end if;

  v_idempotency_key := 'forge-event:' || runtime.sha256_text(
    p_account_id::text || ':' || v_trigger.provider || ':' || p_external_event_id
  );
  v_reservation := billing.reserve_usage(
    p_account_id, v_idempotency_key, p_estimated_units, 'forge-event-bridge', 300
  );
  if coalesce(v_reservation->>'status', '') not in ('reserved', 'finalized')
     or v_reservation->>'reservation_id' is null then
    return jsonb_build_object('status', 'budget_denied');
  end if;
  v_reservation_id := (v_reservation->>'reservation_id')::uuid;

  v_ingest := public.runtime_ingest_event(
    p_account_id, v_trigger.provider, p_external_event_id, p_payload,
    v_trigger.execution_mode, gen_random_uuid(), p_event_type, p_occurred_at,
    'forge-event-bridge-v1', 'v1', 'forge_event_trigger', 'v1', 'forge-event-bridge'
  );
  v_inbox_id := (v_ingest->>'inbox_event_id')::uuid;
  v_workflow_id := (v_ingest->>'workflow_id')::uuid;

  insert into runtime.project_executions (
    account_id, project_id, workflow_id, idempotency_key, plan_snapshot, status
  ) values (
    p_account_id, v_trigger.project_id, v_workflow_id, v_idempotency_key, p_plan, 'queued'
  )
  on conflict (account_id, project_id, idempotency_key) do nothing
  returning id into v_execution_id;

  if v_execution_id is null then
    select execution.id into strict v_execution_id
    from runtime.project_executions as execution
    where execution.account_id = p_account_id
      and execution.project_id = v_trigger.project_id
      and execution.idempotency_key = v_idempotency_key;
  else
    v_execution_created := true;
  end if;

  if v_execution_created then
    insert into runtime.execution_steps (
      account_id, execution_id, step_index, title, step_type, status,
      assigned_skill_id, compute_profile, evidence_refs, artifact_refs,
      cost_tokens, estimated_cost_usd, requires_approval
    )
    select
      p_account_id, v_execution_id, step.position - 1,
      step.value->>'title', step.value->>'type', step.value->>'status',
      step.value->>'assignedSkillId', step.value->>'computeProfile',
      coalesce(step.value->'evidenceRefs', '[]'::jsonb),
      coalesce(step.value->'artifactRefs', '[]'::jsonb),
      coalesce((step.value->>'costTokens')::bigint, 0),
      coalesce((step.value->>'estimatedCostUsd')::numeric, 0),
      coalesce((step.value->>'requiresApproval')::boolean, false)
    from jsonb_array_elements(p_plan->'steps') with ordinality as step(value, position);

    insert into runtime.execution_step_dependencies (
      account_id, execution_id, step_id, depends_on_step_id
    )
    select p_account_id, v_execution_id, target.id, dependency.id
    from jsonb_array_elements(p_plan->'steps') with ordinality as plan_step(value, position)
    join runtime.execution_steps as target
      on target.account_id = p_account_id and target.execution_id = v_execution_id
      and target.step_index = plan_step.position - 1
    cross join lateral jsonb_array_elements_text(plan_step.value->'dependsOn') as dependency_ref(step_id)
    join jsonb_array_elements(p_plan->'steps') with ordinality as dependency_plan(value, position)
      on dependency_plan.value->>'stepId' = dependency_ref.step_id
    join runtime.execution_steps as dependency
      on dependency.account_id = p_account_id and dependency.execution_id = v_execution_id
      and dependency.step_index = dependency_plan.position - 1;
  end if;

  insert into runtime.inbound_events (
    account_id, trigger_id, inbox_event_id, workflow_id, project_id,
    execution_id, reservation_id, provider, event_type, external_event_id,
    occurred_at, payload_hash
  ) values (
    p_account_id, p_trigger_id, v_inbox_id, v_workflow_id, v_trigger.project_id,
    v_execution_id, v_reservation_id, v_trigger.provider, p_event_type,
    p_external_event_id, p_occurred_at, p_payload_hash
  )
  on conflict (account_id, provider, external_event_id) do nothing
  returning id into v_receipt_id;

  if v_receipt_id is null then
    select inbound.id into strict v_receipt_id
    from runtime.inbound_events as inbound
    where inbound.account_id = p_account_id
      and inbound.provider = v_trigger.provider
      and inbound.external_event_id = p_external_event_id;
  end if;

  return jsonb_build_object(
    'status', case when v_execution_created then 'created' else 'duplicate' end,
    'inbound_event_id', v_receipt_id,
    'workflow_id', v_workflow_id,
    'execution_id', v_execution_id,
    'reservation_id', v_reservation_id
  );
end
$$;

revoke all on function public.runtime_enqueue_forge_event(
  uuid, uuid, text, text, timestamptz, jsonb, text, jsonb, bigint
) from public, anon, authenticated;
revoke all on function public.runtime_resolve_forge_event_trigger(uuid, text)
  from public, anon, authenticated;
grant execute on function public.runtime_resolve_forge_event_trigger(uuid, text)
  to service_role;
grant execute on function public.runtime_enqueue_forge_event(
  uuid, uuid, text, text, timestamptz, jsonb, text, jsonb, bigint
) to service_role;

comment on table runtime.event_triggers is
  'Tenant-scoped Forge trigger metadata. secret_ref points to an external secret manager; plaintext secrets are forbidden.';
comment on table runtime.inbound_events is
  'Immutable Event Bridge routing receipts referencing the canonical runtime.inbox_events payload.';
comment on function public.runtime_resolve_forge_event_trigger(uuid, text) is
  'Service-only trigger resolution. secret_ref is an opaque secret-manager locator, never plaintext secret material.';
comment on function public.runtime_enqueue_forge_event(
  uuid, uuid, text, text, timestamptz, jsonb, text, jsonb, bigint
) is 'Service-only atomic ADR 003 reservation, Durable Inbox ingestion, and Forge DAG creation.';
