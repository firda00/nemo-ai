-- ADR 001 / Durable Operations Runtime v1 / Phase 1
-- Closed schema, tables, constraints, indexes, retention metadata and kill switch.
-- No consumer grants and no production traffic are enabled by this migration.

create schema runtime;

revoke all on schema runtime from public, anon, authenticated;
alter default privileges in schema runtime revoke all on tables from public, anon, authenticated;
alter default privileges in schema runtime revoke all on sequences from public, anon, authenticated;
alter default privileges in schema runtime revoke all on functions from public, anon, authenticated;

create function runtime.prevent_mutation()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception using
    errcode = '55000',
    message = format('%I.%I is append-only', tg_table_schema, tg_table_name);
end;
$$;

-- The state pair is a database invariant, not only an RPC convention.
create table runtime.allowed_workflow_transitions (
  from_state text not null,
  to_state text not null,
  primary key (from_state, to_state),
  constraint allowed_transition_from_state_check check (from_state in (
    'received', 'queued', 'running', 'waiting_for_policy', 'waiting_for_approval',
    'waiting_for_action', 'retry_scheduled'
  )),
  constraint allowed_transition_to_state_check check (to_state in (
    'queued', 'running', 'waiting_for_policy', 'waiting_for_approval',
    'waiting_for_action', 'retry_scheduled', 'completed', 'failed', 'denied',
    'dead_letter', 'cancelled'
  )),
  constraint allowed_transition_not_identity_check check (from_state <> to_state)
);

insert into runtime.allowed_workflow_transitions (from_state, to_state) values
  ('received', 'queued'),
  ('received', 'waiting_for_policy'),
  ('received', 'retry_scheduled'),
  ('received', 'failed'),
  ('received', 'cancelled'),
  ('queued', 'running'),
  ('queued', 'cancelled'),
  ('queued', 'dead_letter'),
  ('running', 'queued'),
  ('running', 'waiting_for_policy'),
  ('running', 'retry_scheduled'),
  ('running', 'completed'),
  ('running', 'failed'),
  ('running', 'dead_letter'),
  ('running', 'cancelled'),
  ('waiting_for_policy', 'waiting_for_action'),
  ('waiting_for_policy', 'waiting_for_approval'),
  ('waiting_for_policy', 'denied'),
  ('waiting_for_policy', 'retry_scheduled'),
  ('waiting_for_policy', 'failed'),
  ('waiting_for_policy', 'cancelled'),
  ('waiting_for_approval', 'waiting_for_action'),
  ('waiting_for_approval', 'denied'),
  ('waiting_for_approval', 'waiting_for_policy'),
  ('waiting_for_approval', 'cancelled'),
  ('waiting_for_action', 'queued'),
  ('waiting_for_action', 'completed'),
  ('waiting_for_action', 'retry_scheduled'),
  ('waiting_for_action', 'failed'),
  ('waiting_for_action', 'dead_letter'),
  ('waiting_for_action', 'cancelled'),
  ('retry_scheduled', 'queued'),
  ('retry_scheduled', 'dead_letter'),
  ('retry_scheduled', 'cancelled');

create trigger allowed_workflow_transitions_immutable
before update or delete on runtime.allowed_workflow_transitions
for each row execute function runtime.prevent_mutation();

-- Accepted, normalized input is immutable. Processing state belongs to workflow_runs.
create table runtime.inbox_events (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.accounts(id) on delete restrict,
  provider text not null,
  event_type text not null,
  external_event_id text not null,
  external_event_id_hash text not null,
  identity_version text not null,
  correlation_id uuid not null,
  causation_id uuid,
  occurred_at timestamptz not null,
  received_at timestamptz not null default clock_timestamp(),
  contract_version text not null,
  normalization_result text not null,
  payload jsonb not null,
  payload_hash text not null,
  hash_algorithm text not null default 'sha256',
  evidence_ref text,
  constraint inbox_events_account_id_id_key unique (account_id, id),
  constraint inbox_events_identity_key unique (
    account_id, provider, identity_version, external_event_id_hash
  ),
  constraint inbox_events_provider_check check (
    char_length(provider) between 1 and 64 and provider ~ '^[a-z0-9][a-z0-9_-]*$'
  ),
  constraint inbox_events_event_type_check check (char_length(event_type) between 1 and 96),
  constraint inbox_events_external_id_check check (char_length(external_event_id) between 1 and 2048),
  constraint inbox_events_identity_version_check check (char_length(identity_version) between 1 and 32),
  constraint inbox_events_external_hash_check check (external_event_id_hash ~ '^[0-9a-f]{64}$'),
  constraint inbox_events_contract_version_check check (char_length(contract_version) between 1 and 64),
  constraint inbox_events_normalization_result_check check (
    normalization_result in ('accepted', 'accepted_with_redaction')
  ),
  constraint inbox_events_payload_object_check check (jsonb_typeof(payload) = 'object'),
  constraint inbox_events_payload_size_check check (octet_length(payload::text) <= 65536),
  constraint inbox_events_payload_hash_check check (payload_hash ~ '^[0-9a-f]{64}$'),
  constraint inbox_events_hash_algorithm_check check (hash_algorithm = 'sha256'),
  constraint inbox_events_evidence_ref_check check (
    evidence_ref is null or char_length(evidence_ref) between 1 and 1024
  )
);

create trigger inbox_events_immutable
before update or delete on runtime.inbox_events
for each row execute function runtime.prevent_mutation();

create table runtime.workflow_runs (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.accounts(id) on delete restrict,
  inbox_event_id uuid not null,
  workflow_type text not null,
  workflow_version text not null,
  execution_mode text not null,
  current_state text not null default 'received',
  correlation_id uuid not null,
  causation_id uuid,
  lease_holder text,
  lease_until timestamptz,
  claim_token uuid,
  lease_epoch bigint not null default 0,
  attempt_count integer not null default 0,
  max_attempts integer not null default 5,
  next_attempt_at timestamptz,
  last_error_code text,
  sanitized_error_message text,
  error_evidence_ref text,
  terminal_reason_code text,
  terminal_at timestamptz,
  context jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  constraint workflow_runs_account_id_id_key unique (account_id, id),
  constraint workflow_runs_event_identity_key unique (
    account_id, inbox_event_id, workflow_type, workflow_version, execution_mode
  ),
  constraint workflow_runs_inbox_fkey foreign key (account_id, inbox_event_id)
    references runtime.inbox_events(account_id, id) on delete restrict,
  constraint workflow_runs_causation_fkey foreign key (account_id, causation_id)
    references runtime.workflow_runs(account_id, id) on delete restrict,
  constraint workflow_runs_type_check check (char_length(workflow_type) between 1 and 128),
  constraint workflow_runs_version_check check (char_length(workflow_version) between 1 and 64),
  constraint workflow_runs_execution_mode_check check (execution_mode in ('shadow', 'live')),
  constraint workflow_runs_state_check check (current_state in (
    'received', 'queued', 'running', 'waiting_for_policy', 'waiting_for_approval',
    'waiting_for_action', 'retry_scheduled', 'completed', 'failed', 'denied',
    'dead_letter', 'cancelled'
  )),
  constraint workflow_runs_lease_epoch_check check (lease_epoch >= 0),
  constraint workflow_runs_attempts_check check (
    attempt_count >= 0 and max_attempts between 1 and 100 and attempt_count <= max_attempts
  ),
  constraint workflow_runs_retry_time_check check (
    (current_state = 'retry_scheduled' and next_attempt_at is not null)
    or (current_state <> 'retry_scheduled' and next_attempt_at is null)
  ),
  constraint workflow_runs_lease_integrity_check check (
    (current_state = 'running'
      and lease_holder is not null and lease_until is not null and claim_token is not null)
    or (current_state <> 'running'
      and lease_holder is null and lease_until is null and claim_token is null)
  ),
  constraint workflow_runs_lease_holder_check check (
    lease_holder is null or char_length(lease_holder) between 1 and 160
  ),
  constraint workflow_runs_error_code_check check (
    last_error_code is null or last_error_code ~ '^[A-Z][A-Z0-9_]{0,63}$'
  ),
  constraint workflow_runs_error_message_check check (
    sanitized_error_message is null or char_length(sanitized_error_message) <= 512
  ),
  constraint workflow_runs_error_evidence_ref_check check (
    error_evidence_ref is null or char_length(error_evidence_ref) between 1 and 1024
  ),
  constraint workflow_runs_terminal_integrity_check check (
    (current_state in ('completed', 'failed', 'denied', 'dead_letter', 'cancelled')
      and terminal_at is not null
      and (current_state = 'completed' or terminal_reason_code is not null))
    or (current_state not in ('completed', 'failed', 'denied', 'dead_letter', 'cancelled')
      and terminal_at is null and terminal_reason_code is null)
  ),
  constraint workflow_runs_terminal_reason_check check (
    terminal_reason_code is null or terminal_reason_code ~ '^[A-Z][A-Z0-9_]{0,63}$'
  ),
  constraint workflow_runs_context_object_check check (jsonb_typeof(context) = 'object'),
  constraint workflow_runs_context_size_check check (octet_length(context::text) <= 65536)
);

create table runtime.workflow_transitions (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null,
  workflow_id uuid not null,
  transition_seq bigint not null,
  from_state text not null,
  to_state text not null,
  transition_type text not null,
  actor_type text not null,
  actor_id text not null,
  correlation_id uuid not null,
  causation_id uuid,
  workflow_version text not null,
  policy_version text,
  claim_token uuid,
  lease_epoch bigint not null,
  transition_payload jsonb,
  payload_hash text,
  evidence_ref text,
  evidence_hash text,
  created_at timestamptz not null default clock_timestamp(),
  constraint workflow_transitions_account_id_id_key unique (account_id, id),
  constraint workflow_transitions_workflow_id_id_key unique (account_id, workflow_id, id),
  constraint workflow_transitions_seq_key unique (account_id, workflow_id, transition_seq),
  constraint workflow_transitions_workflow_fkey foreign key (account_id, workflow_id)
    references runtime.workflow_runs(account_id, id) on delete restrict,
  constraint workflow_transitions_pair_fkey foreign key (from_state, to_state)
    references runtime.allowed_workflow_transitions(from_state, to_state) on delete restrict,
  constraint workflow_transitions_seq_check check (transition_seq > 0),
  constraint workflow_transitions_type_check check (transition_type in (
    'ingested', 'classified', 'planned', 'policy_requested', 'policy_decided',
    'approval_requested', 'approval_resolved', 'action_enqueued', 'action_completed',
    'checkpoint_saved', 'retry_scheduled', 'completed', 'failed', 'denied',
    'cancelled', 'dead_letter', 'recovered'
  )),
  constraint workflow_transitions_actor_type_check check (
    actor_type in ('system', 'worker', 'user', 'admin', 'maintenance')
  ),
  constraint workflow_transitions_actor_id_check check (char_length(actor_id) between 1 and 160),
  constraint workflow_transitions_lease_epoch_check check (lease_epoch >= 0),
  constraint workflow_transitions_payload_object_check check (
    transition_payload is null or jsonb_typeof(transition_payload) = 'object'
  ),
  constraint workflow_transitions_payload_size_check check (
    transition_payload is null or octet_length(transition_payload::text) <= 16384
  ),
  constraint workflow_transitions_payload_hash_check check (
    payload_hash is null or payload_hash ~ '^[0-9a-f]{64}$'
  ),
  constraint workflow_transitions_evidence_ref_check check (
    evidence_ref is null or char_length(evidence_ref) between 1 and 1024
  ),
  constraint workflow_transitions_evidence_hash_check check (
    evidence_hash is null or evidence_hash ~ '^[0-9a-f]{64}$'
  )
);

create trigger workflow_transitions_immutable
before update or delete on runtime.workflow_transitions
for each row execute function runtime.prevent_mutation();

create table runtime.policy_decisions (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null,
  workflow_id uuid not null,
  transition_id uuid not null,
  ruleset_id text not null,
  policy_version text not null,
  decision text not null,
  reasons jsonb not null default '[]'::jsonb,
  input_hash text not null,
  action_payload_hash text not null,
  canonicalization_version text not null,
  evidence_ref text,
  created_at timestamptz not null default clock_timestamp(),
  constraint policy_decisions_account_id_id_key unique (account_id, id),
  constraint policy_decisions_workflow_id_id_key unique (account_id, workflow_id, id),
  constraint policy_decisions_action_identity_key unique (
    account_id, workflow_id, id, policy_version, canonicalization_version, action_payload_hash
  ),
  constraint policy_decisions_workflow_fkey foreign key (account_id, workflow_id)
    references runtime.workflow_runs(account_id, id) on delete restrict,
  constraint policy_decisions_transition_fkey foreign key (account_id, workflow_id, transition_id)
    references runtime.workflow_transitions(account_id, workflow_id, id) on delete restrict,
  constraint policy_decisions_ruleset_check check (char_length(ruleset_id) between 1 and 128),
  constraint policy_decisions_version_check check (char_length(policy_version) between 1 and 64),
  constraint policy_decisions_decision_check check (
    decision in ('allow', 'deny', 'require_approval')
  ),
  constraint policy_decisions_reasons_array_check check (jsonb_typeof(reasons) = 'array'),
  constraint policy_decisions_reasons_size_check check (octet_length(reasons::text) <= 8192),
  constraint policy_decisions_input_hash_check check (input_hash ~ '^[0-9a-f]{64}$'),
  constraint policy_decisions_action_hash_check check (action_payload_hash ~ '^[0-9a-f]{64}$'),
  constraint policy_decisions_canonicalization_check check (
    char_length(canonicalization_version) between 1 and 32
  ),
  constraint policy_decisions_evidence_ref_check check (
    evidence_ref is null or char_length(evidence_ref) between 1 and 1024
  )
);

create trigger policy_decisions_immutable
before update or delete on runtime.policy_decisions
for each row execute function runtime.prevent_mutation();

create table runtime.outbox_actions (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null,
  workflow_id uuid not null,
  transition_id uuid not null,
  policy_decision_id uuid not null,
  approval_request_id uuid,
  policy_version text not null,
  connector_id text not null,
  action_type text not null,
  execution_mode text not null,
  payload jsonb not null,
  action_payload_hash text not null,
  canonicalization_version text not null,
  idempotency_key text not null,
  idempotency_key_hash text not null,
  status text not null,
  attempt_count integer not null default 0,
  max_attempts integer not null default 5,
  next_attempt_at timestamptz,
  claimed_at timestamptz,
  lease_until timestamptz,
  claim_token uuid,
  lease_epoch bigint not null default 0,
  completed_at timestamptz,
  provider_result_ref text,
  reconciliation_state text not null default 'not_required',
  last_error_code text,
  sanitized_error_message text,
  error_evidence_ref text,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  constraint outbox_actions_account_id_id_key unique (account_id, id),
  constraint outbox_actions_workflow_id_id_key unique (account_id, workflow_id, id),
  constraint outbox_actions_idempotency_key unique (
    account_id, connector_id, idempotency_key_hash
  ),
  constraint outbox_actions_workflow_fkey foreign key (account_id, workflow_id)
    references runtime.workflow_runs(account_id, id) on delete restrict,
  constraint outbox_actions_transition_fkey foreign key (account_id, workflow_id, transition_id)
    references runtime.workflow_transitions(account_id, workflow_id, id) on delete restrict,
  constraint outbox_actions_policy_fkey foreign key (
    account_id, workflow_id, policy_decision_id, policy_version,
    canonicalization_version, action_payload_hash
  ) references runtime.policy_decisions(
    account_id, workflow_id, id, policy_version, canonicalization_version, action_payload_hash
  ) on delete restrict,
  constraint outbox_actions_connector_check check (char_length(connector_id) between 1 and 160),
  constraint outbox_actions_action_type_check check (char_length(action_type) between 1 and 128),
  constraint outbox_actions_policy_version_check check (char_length(policy_version) between 1 and 64),
  constraint outbox_actions_mode_check check (execution_mode in ('shadow', 'live')),
  constraint outbox_actions_status_check check (status in (
    'pending', 'processing', 'retry_scheduled', 'completed', 'failed',
    'dead_letter', 'cancelled', 'simulated'
  )),
  constraint outbox_actions_shadow_invariants_check check (
    (execution_mode = 'shadow' and status = 'simulated')
    or (execution_mode = 'live' and status in (
      'pending', 'processing', 'retry_scheduled', 'completed', 'failed',
      'dead_letter', 'cancelled'
    ))
  ),
  constraint outbox_actions_payload_object_check check (jsonb_typeof(payload) = 'object'),
  constraint outbox_actions_payload_size_check check (octet_length(payload::text) <= 16384),
  constraint outbox_actions_action_hash_check check (action_payload_hash ~ '^[0-9a-f]{64}$'),
  constraint outbox_actions_canonicalization_check check (
    char_length(canonicalization_version) between 1 and 64
  ),
  constraint outbox_actions_idempotency_value_check check (
    char_length(idempotency_key) between 1 and 2048
  ),
  constraint outbox_actions_idempotency_hash_check check (
    idempotency_key_hash ~ '^[0-9a-f]{64}$'
  ),
  constraint outbox_actions_attempts_check check (
    attempt_count >= 0 and max_attempts between 1 and 100 and attempt_count <= max_attempts
  ),
  constraint outbox_actions_retry_time_check check (
    (status = 'retry_scheduled' and next_attempt_at is not null)
    or (status <> 'retry_scheduled' and next_attempt_at is null)
  ),
  constraint outbox_actions_lease_integrity_check check (
    (status = 'processing' and claimed_at is not null
      and lease_until is not null and claim_token is not null)
    or (status <> 'processing' and lease_until is null and claim_token is null)
  ),
  constraint outbox_actions_lease_epoch_check check (lease_epoch >= 0),
  constraint outbox_actions_completion_check check (
    (status in ('completed', 'failed', 'dead_letter', 'cancelled', 'simulated')
      and completed_at is not null)
    or (status not in ('completed', 'failed', 'dead_letter', 'cancelled', 'simulated')
      and completed_at is null)
  ),
  constraint outbox_actions_reconciliation_check check (
    reconciliation_state in (
      'not_required', 'ambiguous', 'confirmed_effect', 'confirmed_no_effect'
    )
  ),
  constraint outbox_actions_ambiguous_check check (
    reconciliation_state <> 'ambiguous' or status = 'dead_letter'
  ),
  constraint outbox_actions_shadow_reconciliation_check check (
    execution_mode <> 'shadow' or reconciliation_state = 'not_required'
  ),
  constraint outbox_actions_result_ref_check check (
    provider_result_ref is null or char_length(provider_result_ref) between 1 and 1024
  ),
  constraint outbox_actions_error_code_check check (
    last_error_code is null or last_error_code ~ '^[A-Z][A-Z0-9_]{0,63}$'
  ),
  constraint outbox_actions_error_message_check check (
    sanitized_error_message is null or char_length(sanitized_error_message) <= 512
  ),
  constraint outbox_actions_error_evidence_ref_check check (
    error_evidence_ref is null or char_length(error_evidence_ref) between 1 and 1024
  )
);

-- Existing approvals remain valid. Runtime linkage is nullable for backwards compatibility.
alter table public.approval_requests
  add column if not exists workflow_id uuid,
  add column if not exists transition_id uuid,
  add column if not exists policy_decision_id uuid,
  add column if not exists outbox_action_id uuid,
  add column if not exists policy_version text,
  add column if not exists action_canonicalization_version text,
  add column if not exists action_payload_hash text;

alter table public.approval_requests
  add constraint approval_requests_account_id_id_key unique (account_id, id),
  add constraint approval_requests_runtime_workflow_id_id_key unique (account_id, workflow_id, id),
  add constraint approval_requests_runtime_workflow_fkey
    foreign key (account_id, workflow_id)
    references runtime.workflow_runs(account_id, id) on delete restrict,
  add constraint approval_requests_runtime_transition_fkey
    foreign key (account_id, workflow_id, transition_id)
    references runtime.workflow_transitions(account_id, workflow_id, id) on delete restrict,
  add constraint approval_requests_runtime_policy_fkey
    foreign key (
      account_id, workflow_id, policy_decision_id, policy_version,
      action_canonicalization_version, action_payload_hash
    ) references runtime.policy_decisions(
      account_id, workflow_id, id, policy_version, canonicalization_version, action_payload_hash
    ) on delete restrict,
  add constraint approval_requests_runtime_outbox_fkey
    foreign key (account_id, workflow_id, outbox_action_id)
    references runtime.outbox_actions(account_id, workflow_id, id) on delete restrict,
  add constraint approval_requests_runtime_shape_check check (
    (workflow_id is null and transition_id is null and policy_decision_id is null
      and outbox_action_id is null and policy_version is null
      and action_canonicalization_version is null and action_payload_hash is null)
    or (workflow_id is not null and transition_id is not null and policy_decision_id is not null
      and policy_version is not null and action_canonicalization_version is not null
      and action_payload_hash is not null and source = 'workflow')
  ),
  add constraint approval_requests_runtime_outbox_lifecycle_check check (
    workflow_id is null
    or (status = 'approved' and outbox_action_id is not null)
    or (status <> 'approved' and outbox_action_id is null)
  ),
  add constraint approval_requests_runtime_action_hash_check check (
    action_payload_hash is null or action_payload_hash ~ '^[0-9a-f]{64}$'
  ),
  add constraint approval_requests_runtime_canonicalization_check check (
    action_canonicalization_version is null
    or char_length(action_canonicalization_version) between 1 and 64
  );

alter table runtime.outbox_actions
  add constraint outbox_actions_approval_fkey
  foreign key (account_id, workflow_id, approval_request_id)
  references public.approval_requests(account_id, workflow_id, id) on delete restrict;

create table runtime.audit_events (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.accounts(id) on delete restrict,
  workflow_id uuid,
  transition_id uuid,
  policy_decision_id uuid,
  approval_request_id uuid,
  outbox_action_id uuid,
  parent_audit_event_id uuid,
  event_type text not null,
  actor_type text not null,
  actor_id text not null,
  correlation_id uuid not null,
  details jsonb not null default '{}'::jsonb,
  payload_hash text,
  hash_algorithm text not null default 'sha256',
  runtime_contract_version text not null,
  workflow_version text,
  policy_version text,
  created_at timestamptz not null default clock_timestamp(),
  constraint audit_events_account_id_id_key unique (account_id, id),
  constraint audit_events_workflow_fkey foreign key (account_id, workflow_id)
    references runtime.workflow_runs(account_id, id) on delete restrict,
  constraint audit_events_transition_fkey foreign key (account_id, workflow_id, transition_id)
    references runtime.workflow_transitions(account_id, workflow_id, id) on delete restrict,
  constraint audit_events_policy_fkey foreign key (account_id, workflow_id, policy_decision_id)
    references runtime.policy_decisions(account_id, workflow_id, id) on delete restrict,
  constraint audit_events_approval_fkey foreign key (account_id, approval_request_id)
    references public.approval_requests(account_id, id) on delete restrict,
  constraint audit_events_outbox_fkey foreign key (account_id, workflow_id, outbox_action_id)
    references runtime.outbox_actions(account_id, workflow_id, id) on delete restrict,
  constraint audit_events_parent_fkey foreign key (account_id, parent_audit_event_id)
    references runtime.audit_events(account_id, id) on delete restrict,
  constraint audit_events_event_type_check check (char_length(event_type) between 1 and 128),
  constraint audit_events_actor_type_check check (
    actor_type in ('system', 'worker', 'user', 'admin', 'maintenance')
  ),
  constraint audit_events_actor_id_check check (char_length(actor_id) between 1 and 160),
  constraint audit_events_details_object_check check (jsonb_typeof(details) = 'object'),
  constraint audit_events_details_size_check check (octet_length(details::text) <= 16384),
  constraint audit_events_payload_hash_check check (
    payload_hash is null or payload_hash ~ '^[0-9a-f]{64}$'
  ),
  constraint audit_events_hash_algorithm_check check (hash_algorithm = 'sha256'),
  constraint audit_events_contract_version_check check (
    char_length(runtime_contract_version) between 1 and 64
  ),
  constraint audit_events_runtime_reference_shape_check check (
    (transition_id is null or workflow_id is not null)
    and (policy_decision_id is null or workflow_id is not null)
    and (outbox_action_id is null or workflow_id is not null)
  )
);

create trigger audit_events_immutable
before update or delete on runtime.audit_events
for each row execute function runtime.prevent_mutation();

create table runtime.dead_letters (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.accounts(id) on delete restrict,
  source_kind text not null,
  workflow_id uuid,
  outbox_action_id uuid,
  inbox_event_id uuid,
  error_code text not null,
  sanitized_error_message text,
  error_evidence_ref text,
  payload_snapshot jsonb not null default '{}'::jsonb,
  attempt_history jsonb not null default '[]'::jsonb,
  resolved boolean not null default false,
  resolution_reason_code text,
  resolution_action text,
  resolved_by uuid references public.users(id) on delete restrict,
  resolved_at timestamptz,
  created_at timestamptz not null default clock_timestamp(),
  constraint dead_letters_account_id_id_key unique (account_id, id),
  constraint dead_letters_workflow_fkey foreign key (account_id, workflow_id)
    references runtime.workflow_runs(account_id, id) on delete restrict,
  constraint dead_letters_outbox_fkey foreign key (account_id, outbox_action_id)
    references runtime.outbox_actions(account_id, id) on delete restrict,
  constraint dead_letters_inbox_fkey foreign key (account_id, inbox_event_id)
    references runtime.inbox_events(account_id, id) on delete restrict,
  constraint dead_letters_source_kind_check check (
    source_kind in ('workflow', 'outbox_action', 'inbox_event')
  ),
  constraint dead_letters_source_shape_check check (
    (source_kind = 'workflow' and workflow_id is not null
      and outbox_action_id is null and inbox_event_id is null)
    or (source_kind = 'outbox_action' and workflow_id is null
      and outbox_action_id is not null and inbox_event_id is null)
    or (source_kind = 'inbox_event' and workflow_id is null
      and outbox_action_id is null and inbox_event_id is not null)
  ),
  constraint dead_letters_error_code_check check (error_code ~ '^[A-Z][A-Z0-9_]{0,63}$'),
  constraint dead_letters_error_message_check check (
    sanitized_error_message is null or char_length(sanitized_error_message) <= 512
  ),
  constraint dead_letters_error_evidence_ref_check check (
    error_evidence_ref is null or char_length(error_evidence_ref) between 1 and 1024
  ),
  constraint dead_letters_payload_object_check check (jsonb_typeof(payload_snapshot) = 'object'),
  constraint dead_letters_payload_size_check check (octet_length(payload_snapshot::text) <= 32768),
  constraint dead_letters_attempt_history_check check (jsonb_typeof(attempt_history) = 'array'),
  constraint dead_letters_attempt_history_size_check check (octet_length(attempt_history::text) <= 32768),
  constraint dead_letters_resolution_integrity_check check (
    (not resolved and resolution_reason_code is null and resolution_action is null
      and resolved_by is null and resolved_at is null)
    or (resolved and resolution_reason_code is not null and resolution_action is not null
      and resolved_by is not null and resolved_at is not null)
  ),
  constraint dead_letters_resolution_reason_check check (
    resolution_reason_code is null or resolution_reason_code ~ '^[A-Z][A-Z0-9_]{0,63}$'
  ),
  constraint dead_letters_resolution_action_check check (
    resolution_action is null or char_length(resolution_action) between 1 and 512
  )
);

create table runtime.connector_health (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.accounts(id) on delete restrict,
  connector_id text not null,
  operation text not null,
  state text not null default 'closed',
  consecutive_failures integer not null default 0,
  failure_threshold integer not null default 5,
  cooldown_seconds integer not null default 60,
  failure_window_started_at timestamptz,
  opened_until timestamptz,
  half_open_probe_token uuid,
  last_success_at timestamptz,
  last_failure_at timestamptz,
  tripped_at timestamptz,
  updated_at timestamptz not null default clock_timestamp(),
  constraint connector_health_account_id_id_key unique (account_id, id),
  constraint connector_health_operation_key unique (account_id, connector_id, operation),
  constraint connector_health_connector_check check (char_length(connector_id) between 1 and 160),
  constraint connector_health_operation_check check (char_length(operation) between 1 and 128),
  constraint connector_health_state_check check (state in ('closed', 'open', 'half_open')),
  constraint connector_health_failures_check check (consecutive_failures >= 0),
  constraint connector_health_threshold_check check (failure_threshold between 1 and 1000),
  constraint connector_health_cooldown_check check (cooldown_seconds between 1 and 86400),
  constraint connector_health_state_integrity_check check (
    (state = 'closed' and opened_until is null and half_open_probe_token is null)
    or (state = 'open' and opened_until is not null and half_open_probe_token is null)
    or (state = 'half_open' and half_open_probe_token is not null)
  )
);

create table runtime.feedback_events (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.accounts(id) on delete restrict,
  workflow_id uuid not null,
  transition_id uuid not null,
  feedback_type text not null,
  reason_code text not null,
  original_action_snapshot jsonb not null,
  corrected_action_snapshot jsonb not null,
  created_by uuid not null references public.users(id) on delete restrict,
  eval_consent boolean not null default false,
  pii_redacted boolean not null,
  created_at timestamptz not null default clock_timestamp(),
  constraint feedback_events_account_id_id_key unique (account_id, id),
  constraint feedback_events_workflow_fkey foreign key (account_id, workflow_id)
    references runtime.workflow_runs(account_id, id) on delete restrict,
  constraint feedback_events_transition_fkey foreign key (account_id, workflow_id, transition_id)
    references runtime.workflow_transitions(account_id, workflow_id, id) on delete restrict,
  constraint feedback_events_type_check check (char_length(feedback_type) between 1 and 96),
  constraint feedback_events_reason_code_check check (reason_code ~ '^[A-Z][A-Z0-9_]{0,63}$'),
  constraint feedback_events_original_object_check check (
    jsonb_typeof(original_action_snapshot) = 'object'
  ),
  constraint feedback_events_corrected_object_check check (
    jsonb_typeof(corrected_action_snapshot) = 'object'
  ),
  constraint feedback_events_snapshot_size_check check (
    octet_length(original_action_snapshot::text) <= 16384
    and octet_length(corrected_action_snapshot::text) <= 16384
  )
);

create trigger feedback_events_immutable
before update or delete on runtime.feedback_events
for each row execute function runtime.prevent_mutation();

-- Absence of a row means pending review. A review is itself immutable evidence.
create table runtime.feedback_reviews (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.accounts(id) on delete restrict,
  feedback_event_id uuid not null,
  review_status text not null,
  review_reason_code text not null,
  reviewed_by uuid not null references public.users(id) on delete restrict,
  reviewed_at timestamptz not null default clock_timestamp(),
  constraint feedback_reviews_account_id_id_key unique (account_id, id),
  constraint feedback_reviews_event_key unique (account_id, feedback_event_id),
  constraint feedback_reviews_event_fkey foreign key (account_id, feedback_event_id)
    references runtime.feedback_events(account_id, id) on delete restrict,
  constraint feedback_reviews_status_check check (review_status in ('accepted', 'rejected')),
  constraint feedback_reviews_reason_code_check check (
    review_reason_code ~ '^[A-Z][A-Z0-9_]{0,63}$'
  )
);

create trigger feedback_reviews_immutable
before update or delete on runtime.feedback_reviews
for each row execute function runtime.prevent_mutation();

-- Singleton control row. Phase 2 claim RPCs must lock/read it before selecting work.
create table runtime.system_controls (
  singleton boolean primary key default true,
  kill_switch_active boolean not null default false,
  claims_paused boolean not null default false,
  ingestion_paused boolean not null default false,
  reason_code text,
  activated_by text,
  activated_at timestamptz,
  control_epoch bigint not null default 0,
  updated_at timestamptz not null default clock_timestamp(),
  constraint system_controls_singleton_check check (singleton),
  constraint system_controls_epoch_check check (control_epoch >= 0),
  constraint system_controls_kill_switch_check check (
    not kill_switch_active or claims_paused
  ),
  constraint system_controls_activation_check check (
    (not kill_switch_active and not claims_paused and not ingestion_paused
      and reason_code is null and activated_by is null and activated_at is null)
    or ((kill_switch_active or claims_paused or ingestion_paused) and reason_code is not null
      and activated_by is not null and activated_at is not null)
  ),
  constraint system_controls_reason_check check (
    reason_code is null or reason_code ~ '^[A-Z][A-Z0-9_]{0,63}$'
  ),
  constraint system_controls_actor_check check (
    activated_by is null or char_length(activated_by) between 1 and 160
  )
);

insert into runtime.system_controls (singleton) values (true);

-- Retention is archive-first. Phase 1 never deletes workflow/audit history.
create table runtime.retention_policies (
  data_class text primary key,
  hot_retention interval,
  cold_archive_required boolean not null,
  deletion_allowed boolean not null,
  partition_strategy text not null,
  partition_review_threshold_rows bigint,
  updated_at timestamptz not null default clock_timestamp(),
  constraint retention_policies_data_class_check check (data_class in (
    'inbox_events', 'workflow_runs', 'workflow_transitions', 'audit_events', 'dead_letters'
  )),
  constraint retention_policies_hot_retention_check check (
    hot_retention is null or hot_retention >= interval '30 days'
  ),
  constraint retention_policies_partition_strategy_check check (
    partition_strategy in ('none', 'review_monthly_range_at_threshold')
  ),
  constraint retention_policies_partition_threshold_check check (
    (partition_strategy = 'none' and partition_review_threshold_rows is null)
    or (partition_strategy = 'review_monthly_range_at_threshold'
      and partition_review_threshold_rows >= 1000000)
  ),
  constraint retention_policies_archive_before_delete_check check (
    not deletion_allowed or cold_archive_required
  )
);

insert into runtime.retention_policies (
  data_class, hot_retention, cold_archive_required, deletion_allowed,
  partition_strategy, partition_review_threshold_rows
) values
  ('inbox_events', interval '30 days', true, false, 'review_monthly_range_at_threshold', 1000000),
  ('workflow_runs', interval '30 days', true, false, 'none', null),
  ('workflow_transitions', interval '30 days', true, false, 'review_monthly_range_at_threshold', 1000000),
  ('audit_events', null, true, false, 'review_monthly_range_at_threshold', 1000000),
  ('dead_letters', null, true, false, 'none', null);

create table runtime.archive_manifests (
  id uuid primary key default gen_random_uuid(),
  cutoff_at timestamptz not null,
  status text not null default 'prepared',
  requested_by text not null,
  cold_object_ref text,
  cold_object_hash text,
  exported_at timestamptz,
  verified_at timestamptz,
  created_at timestamptz not null default clock_timestamp(),
  constraint archive_manifests_status_check check (
    status in ('prepared', 'exported', 'verified', 'cancelled')
  ),
  constraint archive_manifests_requested_by_check check (
    char_length(requested_by) between 1 and 160
  ),
  constraint archive_manifests_object_ref_check check (
    cold_object_ref is null or char_length(cold_object_ref) between 1 and 1024
  ),
  constraint archive_manifests_object_hash_check check (
    cold_object_hash is null or cold_object_hash ~ '^[0-9a-f]{64}$'
  ),
  constraint archive_manifests_export_integrity_check check (
    (status = 'prepared' and cold_object_ref is null and cold_object_hash is null
      and exported_at is null and verified_at is null)
    or (status = 'cancelled' and verified_at is null)
    or (status = 'exported' and cold_object_ref is not null and cold_object_hash is not null
      and exported_at is not null and verified_at is null)
    or (status = 'verified' and cold_object_ref is not null and cold_object_hash is not null
      and exported_at is not null and verified_at is not null)
  )
);

create table runtime.archive_manifest_items (
  manifest_id uuid not null references runtime.archive_manifests(id) on delete restrict,
  account_id uuid not null,
  workflow_id uuid not null,
  created_at timestamptz not null default clock_timestamp(),
  primary key (manifest_id, account_id, workflow_id),
  constraint archive_manifest_items_workflow_fkey foreign key (account_id, workflow_id)
    references runtime.workflow_runs(account_id, id) on delete restrict
);

create trigger archive_manifest_items_immutable
before update or delete on runtime.archive_manifest_items
for each row execute function runtime.prevent_mutation();

-- Produces an auditable archive candidate set. It intentionally performs no DELETE.
create function runtime.prepare_archive_manifest(
  p_older_than interval,
  p_requested_by text,
  p_limit integer default 10000
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_manifest_id uuid := gen_random_uuid();
begin
  if p_older_than < interval '30 days' or p_older_than > interval '10 years' then
    raise exception using errcode = '22023', message = 'invalid retention window';
  end if;
  if p_limit < 1 or p_limit > 100000 then
    raise exception using errcode = '22023', message = 'invalid archive batch size';
  end if;
  if p_requested_by is null or char_length(p_requested_by) not between 1 and 160 then
    raise exception using errcode = '22023', message = 'invalid archive actor';
  end if;

  insert into runtime.archive_manifests (id, cutoff_at, requested_by)
  values (v_manifest_id, clock_timestamp() - p_older_than, p_requested_by);

  insert into runtime.archive_manifest_items (manifest_id, account_id, workflow_id)
  select v_manifest_id, candidate.account_id, candidate.id
  from runtime.workflow_runs as candidate
  where candidate.current_state in ('completed', 'cancelled')
    and candidate.terminal_at < clock_timestamp() - p_older_than
    and not exists (
      select 1
      from runtime.archive_manifest_items as existing
      join runtime.archive_manifests as manifest on manifest.id = existing.manifest_id
      where existing.account_id = candidate.account_id
        and existing.workflow_id = candidate.id
        and manifest.status <> 'cancelled'
    )
  order by candidate.terminal_at, candidate.id
  limit p_limit;

  return v_manifest_id;
end;
$$;

create index workflow_runs_ready_idx
  on runtime.workflow_runs (execution_mode, created_at, id)
  where current_state = 'queued';

create index workflow_runs_retry_idx
  on runtime.workflow_runs (execution_mode, next_attempt_at, id)
  where current_state = 'retry_scheduled';

create index workflow_runs_running_lease_idx
  on runtime.workflow_runs (lease_until, id)
  where current_state = 'running';

create index workflow_runs_correlation_idx
  on runtime.workflow_runs (account_id, correlation_id, created_at desc);

create index outbox_actions_pending_idx
  on runtime.outbox_actions (connector_id, created_at, id)
  where execution_mode = 'live' and status = 'pending';

create index outbox_actions_retry_idx
  on runtime.outbox_actions (connector_id, next_attempt_at, id)
  where execution_mode = 'live' and status = 'retry_scheduled';

create index outbox_actions_processing_lease_idx
  on runtime.outbox_actions (lease_until, id)
  where execution_mode = 'live' and status = 'processing';

create index audit_events_workflow_time_idx
  on runtime.audit_events (account_id, workflow_id, created_at, id);

create index dead_letters_open_idx
  on runtime.dead_letters (account_id, created_at, id)
  where not resolved;

revoke all on all tables in schema runtime from public, anon, authenticated;
revoke all on all sequences in schema runtime from public, anon, authenticated;
revoke all on all functions in schema runtime from public, anon, authenticated;

comment on schema runtime is
  'Private Durable Operations Runtime. Access is only through allowlisted Phase 2 RPC wrappers.';
comment on function runtime.prepare_archive_manifest(interval, text, integer) is
  'Prepares an archive manifest only. Physical deletion requires verified cold storage and a separate audited maintenance ADR.';
