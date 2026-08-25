-- ADR 001/002 operational dashboard: service-only, tenant-scoped telemetry and HITL decisions.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'runtime-artifacts',
  'runtime-artifacts',
  false,
  1073741824,
  array['application/pdf', 'text/html', 'image/jpeg', 'video/mp4', 'video/webm']
)
on conflict (id) do update set
  public = false,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

create function public.runtime_dashboard_metrics(p_account_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_inbox_total bigint;
  v_outbox_delivered bigint;
  v_dead_letter_count bigint;
  v_orphaned_inbox bigint;
  v_eval runtime.vision_eval_summaries%rowtype;
  v_f1 numeric := 0;
  v_gate_status text := 'no_data';
  v_uptime_seconds bigint;
begin
  if p_account_id is null or not exists (
    select 1 from public.accounts as account where account.id = p_account_id
  ) then
    raise exception using errcode = '22023', message = 'invalid dashboard account';
  end if;

  select count(*) into v_inbox_total
  from runtime.inbox_events as inbox where inbox.account_id = p_account_id;

  select count(*) into v_outbox_delivered
  from runtime.outbox_actions as action
  where action.account_id = p_account_id
    and action.execution_mode = 'live'
    and action.status = 'completed';

  select
    (select count(*) from runtime.workflow_runs as run
      where run.account_id = p_account_id and run.current_state = 'dead_letter')
    + (select count(*) from runtime.outbox_actions as action
      where action.account_id = p_account_id and action.status = 'dead_letter')
    + (select count(*) from runtime.compute_jobs as job
      where job.account_id = p_account_id and job.status = 'dead_letter')
  into v_dead_letter_count;

  select count(*) into v_orphaned_inbox
  from runtime.inbox_events as inbox
  where inbox.account_id = p_account_id
    and not exists (
      select 1 from runtime.workflow_runs as run
      where run.account_id = inbox.account_id and run.inbox_event_id = inbox.id
    );

  select summary.* into v_eval
  from runtime.vision_eval_summaries as summary
  where summary.account_id = p_account_id
  order by summary.created_at desc, summary.id desc
  limit 1;

  if v_eval.id is not null then
    if v_eval.precision_score + v_eval.recall_score > 0 then
      v_f1 := 2 * v_eval.precision_score * v_eval.recall_score
        / (v_eval.precision_score + v_eval.recall_score);
    end if;
    v_gate_status := case
      when v_eval.created_at < clock_timestamp() - interval '30 days' then 'stale'
      when v_eval.passed then 'eligible'
      else 'blocked'
    end;
  end if;

  v_uptime_seconds := greatest(
    0,
    floor(extract(epoch from clock_timestamp() - pg_catalog.pg_postmaster_start_time()))::bigint
  );

  return pg_catalog.jsonb_build_object(
    'inbox_total', v_inbox_total,
    'outbox_delivered', v_outbox_delivered,
    'dead_letter_count', v_dead_letter_count,
    'live_gate_status', v_gate_status,
    'avg_grounding_score', coalesce(v_eval.average_grounding_score, 0),
    'f1_score', round(v_f1, 7),
    'false_action_rate', coalesce(v_eval.false_action_rate, 0),
    'uptime_seconds', v_uptime_seconds,
    'zero_data_loss', v_orphaned_inbox = 0,
    'orphaned_inbox_count', v_orphaned_inbox,
    'eval_created_at', v_eval.created_at
  );
end
$$;

create function public.runtime_dashboard_list_approvals(
  p_account_id uuid,
  p_limit integer default 50
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_result jsonb;
begin
  if p_limit not between 1 and 100 then
    raise exception using errcode = '22023', message = 'invalid dashboard approval limit';
  end if;

  select coalesce(pg_catalog.jsonb_agg(item.payload order by item.created_at desc), '[]'::jsonb)
  into v_result
  from (
    select request.created_at, pg_catalog.jsonb_build_object(
      'id', request.id,
      'workflow_id', request.workflow_id,
      'action_type', request.action_type,
      'summary', request.summary,
      'status', request.status,
      'expires_at', request.expires_at,
      'created_at', request.created_at,
      'workflow_type', run.workflow_type,
      'execution_mode', run.execution_mode,
      'sensor_metadata', coalesce(
        run.context -> 'untrusted_sensor_output',
        run.context -> 'sensor_metadata',
        '{}'::jsonb
      ),
      'artifact_manifests', coalesce((
        select pg_catalog.jsonb_agg(
          pg_catalog.jsonb_build_object(
            'job_id', job.id,
            'profile', job.profile,
            'result_manifest', job.result_manifest - 'stdout_sanitized' - 'stderr_sanitized'
          ) order by job.created_at, job.id
        )
        from (
          select candidate.*
          from runtime.compute_jobs as candidate
          where candidate.account_id = request.account_id
            and candidate.workflow_id = request.workflow_id
            and candidate.status = 'completed'
            and candidate.result_manifest is not null
          order by candidate.created_at, candidate.id
          limit 64
        ) as job
      ), '[]'::jsonb)
    ) as payload
    from public.approval_requests as request
    join runtime.workflow_runs as run
      on run.account_id = request.account_id and run.id = request.workflow_id
    where request.account_id = p_account_id
      and request.status = 'pending'
      and request.expires_at > clock_timestamp()
      and run.current_state = 'waiting_for_approval'
      and run.execution_mode = 'live'
    order by request.created_at desc
    limit p_limit
  ) as item;

  return v_result;
end
$$;

create function public.runtime_dashboard_decide_approval(
  p_account_id uuid,
  p_approval_request_id uuid,
  p_user_id uuid,
  p_decision text,
  p_reason text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_request public.approval_requests%rowtype;
  v_run runtime.workflow_runs%rowtype;
  v_policy runtime.policy_decisions%rowtype;
  v_seq bigint;
  v_transition_id uuid;
  v_payload jsonb;
  v_connector_id text;
  v_action_type text;
  v_result jsonb;
begin
  if p_decision not in ('approve', 'reject') then
    raise exception using errcode = '22023', message = 'invalid dashboard approval decision';
  end if;
  if p_reason is not null and char_length(p_reason) > 500 then
    raise exception using errcode = '22023', message = 'approval reason exceeds limit';
  end if;
  if not exists (
    select 1 from public.users as app_user
    where app_user.id = p_user_id
      and app_user.account_id = p_account_id
      and (app_user.role in ('owner', 'operator') or app_user.is_admin)
  ) then
    raise exception using errcode = '42501', message = 'invalid dashboard operator context';
  end if;

  select request.* into strict v_request
  from public.approval_requests as request
  where request.account_id = p_account_id and request.id = p_approval_request_id
  for update;

  select run.* into strict v_run
  from runtime.workflow_runs as run
  where run.account_id = p_account_id and run.id = v_request.workflow_id
  for update;

  if v_request.status <> 'pending'
    or v_request.expires_at <= clock_timestamp()
    or v_run.current_state <> 'waiting_for_approval'
    or v_run.execution_mode <> 'live' then
    raise exception using errcode = '55000', message = 'approval request is not pending';
  end if;

  if p_decision = 'approve' then
    v_payload := v_run.context -> 'proposed_action';
    v_connector_id := coalesce(
      nullif(v_run.context ->> 'proposed_connector_id', ''),
      nullif(v_payload ->> 'connector_id', ''),
      nullif(v_payload ->> 'channel', '')
    );
    v_action_type := coalesce(
      nullif(v_run.context ->> 'proposed_action_type', ''),
      nullif(v_payload ->> 'action_type', ''),
      nullif(v_payload ->> 'action', '')
    );
    if v_payload is null or pg_catalog.jsonb_typeof(v_payload) <> 'object'
      or v_connector_id is null or char_length(v_connector_id) > 160
      or v_action_type is null or char_length(v_action_type) > 128 then
      raise exception using errcode = '22023', message = 'approval action metadata is invalid';
    end if;

    v_result := public.runtime_resolve_approval_and_enqueue_action(
      p_account_id => p_account_id,
      p_workflow_id => v_run.id,
      p_approval_request_id => v_request.id,
      p_user_id => p_user_id,
      p_decision => 'approved',
      p_connector_id => v_connector_id,
      p_action_type => v_action_type,
      p_payload => v_payload,
      p_idempotency_key => 'dashboard-approval:' || v_request.id::text,
      p_max_attempts => 5
    );
    return v_result || pg_catalog.jsonb_build_object(
      'decision', 'approve', 'state', 'waiting_for_action'
    );
  end if;

  select decision.* into strict v_policy
  from runtime.policy_decisions as decision
  where decision.account_id = p_account_id
    and decision.workflow_id = v_run.id
    and decision.id = v_request.policy_decision_id;

  select coalesce(max(transition.transition_seq), 0) + 1 into v_seq
  from runtime.workflow_transitions as transition
  where transition.account_id = p_account_id and transition.workflow_id = v_run.id;

  insert into runtime.workflow_transitions (
    account_id, workflow_id, transition_seq, from_state, to_state,
    transition_type, actor_type, actor_id, correlation_id,
    workflow_version, policy_version, lease_epoch, transition_payload
  ) values (
    p_account_id, v_run.id, v_seq, 'waiting_for_approval', 'cancelled',
    'cancelled', 'user', p_user_id::text, v_run.correlation_id,
    v_run.workflow_version, v_policy.policy_version, v_run.lease_epoch,
    pg_catalog.jsonb_build_object(
      'approval_request_id', v_request.id,
      'reason', nullif(left(coalesce(p_reason, ''), 500), '')
    )
  ) returning id into v_transition_id;

  update public.approval_requests
  set status = 'rejected', decided_by = p_user_id, decided_at = clock_timestamp()
  where account_id = p_account_id and id = v_request.id;

  update runtime.outbox_actions
  set status = 'cancelled', completed_at = clock_timestamp(),
      next_attempt_at = null, claimed_at = null, lease_until = null, claim_token = null,
      last_error_code = 'APPROVAL_REJECTED', updated_at = clock_timestamp()
  where account_id = p_account_id
    and workflow_id = v_run.id
    and approval_request_id = v_request.id
    and status in ('pending', 'retry_scheduled');

  update runtime.workflow_runs
  set current_state = 'cancelled', terminal_reason_code = 'APPROVAL_REJECTED',
      terminal_at = clock_timestamp(), updated_at = clock_timestamp()
  where account_id = p_account_id and id = v_run.id;

  insert into runtime.audit_events (
    account_id, workflow_id, transition_id, policy_decision_id, approval_request_id,
    event_type, actor_type, actor_id, correlation_id, details,
    runtime_contract_version, workflow_version, policy_version
  ) values (
    p_account_id, v_run.id, v_transition_id, v_policy.id, v_request.id,
    'runtime.dashboard_approval_rejected', 'user', p_user_id::text, v_run.correlation_id,
    pg_catalog.jsonb_build_object('decision', 'reject', 'reason', nullif(left(coalesce(p_reason, ''), 500), '')),
    'runtime-v1', v_run.workflow_version, v_policy.policy_version
  );

  return pg_catalog.jsonb_build_object(
    'decision', 'reject', 'workflow_id', v_run.id, 'state', 'cancelled'
  );
end
$$;

create function public.runtime_dashboard_workflow_trace(
  p_account_id uuid,
  p_workflow_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_run runtime.workflow_runs%rowtype;
begin
  select run.* into strict v_run
  from runtime.workflow_runs as run
  where run.account_id = p_account_id and run.id = p_workflow_id;

  return pg_catalog.jsonb_build_object(
    'workflow', pg_catalog.jsonb_build_object(
      'id', v_run.id,
      'workflow_type', v_run.workflow_type,
      'workflow_version', v_run.workflow_version,
      'execution_mode', v_run.execution_mode,
      'current_state', v_run.current_state,
      'attempt_count', v_run.attempt_count,
      'created_at', v_run.created_at,
      'updated_at', v_run.updated_at,
      'terminal_at', v_run.terminal_at,
      'terminal_reason_code', v_run.terminal_reason_code
    ),
    'transitions', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', timeline.id,
        'sequence', timeline.transition_seq,
        'from_state', timeline.from_state,
        'to_state', timeline.to_state,
        'transition_type', timeline.transition_type,
        'actor_type', timeline.actor_type,
        'created_at', timeline.created_at,
        'phase_duration_ms', greatest(0, floor(extract(epoch from
          timeline.created_at - coalesce(timeline.previous_at, v_run.created_at)) * 1000))::bigint
      ) order by timeline.transition_seq)
      from (
        select transition.*,
          lag(transition.created_at) over (order by transition.transition_seq) as previous_at
        from runtime.workflow_transitions as transition
        where transition.account_id = p_account_id and transition.workflow_id = p_workflow_id
      ) as timeline
    ), '[]'::jsonb),
    'compute_jobs', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', job.id,
        'profile', job.profile,
        'status', job.status,
        'attempt_count', job.attempt_count,
        'duration_ms', greatest(0, floor(extract(epoch from job.updated_at - job.created_at) * 1000))::bigint,
        'error_code', job.error_code,
        'result_manifest', case when job.result_manifest is null then null
          else job.result_manifest - 'stdout_sanitized' - 'stderr_sanitized' end,
        'created_at', job.created_at,
        'updated_at', job.updated_at
      ) order by job.created_at, job.id)
      from runtime.compute_jobs as job
      where job.account_id = p_account_id and job.workflow_id = p_workflow_id
    ), '[]'::jsonb),
    'outbox_actions', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', action.id,
        'connector_id', action.connector_id,
        'action_type', action.action_type,
        'execution_mode', action.execution_mode,
        'status', action.status,
        'attempt_count', action.attempt_count,
        'created_at', action.created_at,
        'completed_at', action.completed_at,
        'error_code', action.last_error_code
      ) order by action.created_at, action.id)
      from runtime.outbox_actions as action
      where action.account_id = p_account_id and action.workflow_id = p_workflow_id
    ), '[]'::jsonb),
    'self_healing_iterations', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', audit.id,
        'created_at', audit.created_at,
        'details', audit.details
      ) order by audit.created_at, audit.id)
      from runtime.audit_events as audit
      where audit.account_id = p_account_id
        and audit.workflow_id = p_workflow_id
        and audit.event_type = 'runtime.self_healing_iteration'
    ), '[]'::jsonb)
  );
end
$$;

revoke all on function public.runtime_dashboard_metrics(uuid) from public, anon, authenticated;
revoke all on function public.runtime_dashboard_list_approvals(uuid, integer) from public, anon, authenticated;
revoke all on function public.runtime_dashboard_decide_approval(uuid, uuid, uuid, text, text) from public, anon, authenticated;
revoke all on function public.runtime_dashboard_workflow_trace(uuid, uuid) from public, anon, authenticated;
grant execute on function public.runtime_dashboard_metrics(uuid) to service_role;
grant execute on function public.runtime_dashboard_list_approvals(uuid, integer) to service_role;
grant execute on function public.runtime_dashboard_decide_approval(uuid, uuid, uuid, text, text) to service_role;
grant execute on function public.runtime_dashboard_workflow_trace(uuid, uuid) to service_role;

comment on function public.runtime_dashboard_decide_approval(uuid, uuid, uuid, text, text) is
  'Tenant-scoped HITL decision. Approval uses the canonical payload-hash resolver; rejection cancels atomically.';
