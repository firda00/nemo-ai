\set ON_ERROR_STOP on

-- Real schema chain: routing receipt -> canonical inbox -> workflow -> Forge execution -> steps.
select
  inbound.id as inbound_event_id,
  inbound.external_event_id,
  inbound.provider,
  inbound.event_type,
  inbound.status as routing_status,
  inbound.account_id,
  inbox.payload as normalized_payload,
  inbox.payload #>> '{untrusted_event_data,account_id}' as spoofed_account_id,
  execution.id as execution_id,
  execution.status as execution_status,
  execution.plan_hash,
  workflow.id as workflow_id,
  workflow.current_state as workflow_state,
  step.step_index,
  step.title as step_title,
  step.step_type,
  step.status as step_status,
  step.evidence_refs,
  step.artifact_refs
from runtime.inbound_events as inbound
join runtime.inbox_events as inbox
  on inbox.account_id = inbound.account_id and inbox.id = inbound.inbox_event_id
join runtime.workflow_runs as workflow
  on workflow.account_id = inbound.account_id and workflow.id = inbound.workflow_id
join runtime.project_executions as execution
  on execution.account_id = inbound.account_id and execution.id = inbound.execution_id
left join runtime.execution_steps as step
  on step.account_id = execution.account_id and step.execution_id = execution.id
where inbound.trigger_id = 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11'
order by inbound.received_at desc, step.step_index asc
limit 20;

-- Security assertions: tenant comes from the trigger, allowlisted payload excludes probe/junk fields.
select
  inbound.id,
  (inbound.account_id = trigger.account_id) as tenant_binding_ok,
  not (inbox.payload->'untrusted_event_data' ? 'account_id') as account_spoof_removed,
  not (inbox.payload->'untrusted_event_data' ? 'untrusted_extra_field') as junk_removed,
  inbox.payload->'untrusted_event_data' as accepted_fields
from runtime.inbound_events as inbound
join runtime.event_triggers as trigger
  on trigger.account_id = inbound.account_id and trigger.id = inbound.trigger_id
join runtime.inbox_events as inbox
  on inbox.account_id = inbound.account_id and inbox.id = inbound.inbox_event_id
where inbound.trigger_id = 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11'
order by inbound.received_at desc
limit 1;
