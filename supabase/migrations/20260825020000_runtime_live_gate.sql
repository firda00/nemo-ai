-- ADR 002 Stage 4: evidence-backed evaluation summaries and a fail-closed live policy gate.
-- Outbox actions are intentionally NOT created here: runtime_enqueue_outbox_action binds the exact
-- approved action hash in the next step. This function only records the canonical policy decision.

create table runtime.vision_eval_summaries (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.accounts(id) on delete restrict,
  workflow_type text not null,
  dataset_hash text not null,
  sample_count integer not null,
  precision_score numeric(8,7) not null,
  recall_score numeric(8,7) not null,
  false_action_rate numeric(8,7) not null,
  average_grounding_score numeric(8,7) not null,
  passed boolean not null,
  created_at timestamptz not null default clock_timestamp(),
  constraint vision_eval_summary_account_id_id_key unique (account_id, id),
  constraint vision_eval_summary_workflow_type check (
    char_length(workflow_type) between 1 and 128
    and workflow_type ~ '^[a-z][a-z0-9_]{0,127}$'
  ),
  constraint vision_eval_summary_dataset_hash check (dataset_hash ~ '^[0-9a-f]{64}$'),
  constraint vision_eval_summary_sample_count check (sample_count between 1 and 10000000),
  constraint vision_eval_summary_metric_bounds check (
    precision_score between 0 and 1
    and recall_score between 0 and 1
    and false_action_rate between 0 and 1
    and average_grounding_score between 0 and 1
  ),
  constraint vision_eval_summary_pass_invariant check (
    passed = (
      sample_count >= 100
      and precision_score >= 0.95
      and false_action_rate <= 0.01
      and average_grounding_score >= 0.95
    )
  )
);

create index vision_eval_summaries_latest_idx
  on runtime.vision_eval_summaries (account_id, workflow_type, created_at desc, id desc);

create trigger vision_eval_summaries_immutable
before update or delete on runtime.vision_eval_summaries
for each row execute function runtime.prevent_mutation();

create table runtime.live_gate_evaluations (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null,
  workflow_id uuid not null,
  eval_summary_id uuid,
  policy_decision_id uuid not null,
  approval_request_id uuid,
  confidence_score numeric(8,7) not null,
  threshold numeric(8,7) not null,
  decision text not null,
  created_at timestamptz not null default clock_timestamp(),
  constraint live_gate_evaluations_account_id_id_key unique (account_id, id),
  constraint live_gate_workflow_fkey foreign key (account_id, workflow_id)
    references runtime.workflow_runs(account_id, id) on delete restrict,
  constraint live_gate_eval_summary_fkey foreign key (account_id, eval_summary_id)
    references runtime.vision_eval_summaries(account_id, id) on delete restrict,
  constraint live_gate_policy_fkey foreign key (account_id, workflow_id, policy_decision_id)
    references runtime.policy_decisions(account_id, workflow_id, id) on delete restrict,
  constraint live_gate_approval_fkey foreign key (account_id, workflow_id, approval_request_id)
    references public.approval_requests(account_id, workflow_id, id) on delete restrict,
  constraint live_gate_scores check (
    confidence_score between 0 and 1 and threshold between 0.95 and 1
  ),
  constraint live_gate_decision check (decision in ('allow', 'require_approval')),
  constraint live_gate_approval_consistency check (
    (decision = 'allow' and approval_request_id is null and eval_summary_id is not null)
    or (decision = 'require_approval' and approval_request_id is not null)
  )
);

create trigger live_gate_evaluations_immutable
before update or delete on runtime.live_gate_evaluations
for each row execute function runtime.prevent_mutation();

create function public.runtime_record_vision_eval_summary(
  p_account_id uuid,
  p_workflow_type text,
  p_precision_score numeric,
  p_recall_score numeric,
  p_false_action_rate numeric,
  p_sample_count integer,
  p_dataset_hash text,
  p_average_grounding_score numeric
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
  v_passed boolean;
begin
  if p_account_id is null
    or p_workflow_type is null
    or p_workflow_type !~ '^[a-z][a-z0-9_]{0,127}$'
    or p_dataset_hash is null or p_dataset_hash !~ '^[0-9a-f]{64}$'
    or p_sample_count not between 1 and 10000000
    or p_precision_score not between 0 and 1
    or p_recall_score not between 0 and 1
    or p_false_action_rate not between 0 and 1
    or p_average_grounding_score not between 0 and 1 then
    raise exception using errcode = '22023', message = 'invalid vision evaluation summary';
  end if;

  v_passed := p_sample_count >= 100
    and p_precision_score >= 0.95
    and p_false_action_rate <= 0.01
    and p_average_grounding_score >= 0.95;

  insert into runtime.vision_eval_summaries (
    account_id, workflow_type, dataset_hash, sample_count,
    precision_score, recall_score, false_action_rate, average_grounding_score, passed
  ) values (
    p_account_id, p_workflow_type, p_dataset_hash, p_sample_count,
    p_precision_score, p_recall_score, p_false_action_rate, p_average_grounding_score, v_passed
  ) returning id into v_id;

  return jsonb_build_object('eval_summary_id', v_id, 'passed', v_passed);
end
$$;

create function public.runtime_evaluate_live_gate(
  p_account_id uuid,
  p_workflow_id uuid,
  p_confidence_score numeric,
  p_threshold numeric
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_run runtime.workflow_runs%rowtype;
  v_eval runtime.vision_eval_summaries%rowtype;
  v_action jsonb;
  v_policy jsonb;
  v_decision text;
  v_reasons jsonb;
  v_gate_id uuid;
begin
  if p_confidence_score is null or p_confidence_score not between 0 and 1
    or p_threshold is null or p_threshold not between 0.95 and 1 then
    raise exception using errcode = '22023', message = 'invalid live gate score';
  end if;

  select run.* into strict v_run
  from runtime.workflow_runs as run
  where run.account_id = p_account_id and run.id = p_workflow_id
  for update;

  if v_run.execution_mode <> 'live' then
    raise exception using errcode = '55000', message = 'shadow workflow cannot enter live gate';
  end if;
  if v_run.current_state <> 'waiting_for_policy' then
    raise exception using errcode = '55000', message = 'workflow is not waiting for live policy';
  end if;

  v_action := v_run.context -> 'proposed_action';
  if v_action is null or jsonb_typeof(v_action) <> 'object'
    or v_action = '{}'::jsonb or octet_length(v_action::text) > 65536 then
    raise exception using errcode = '22023', message = 'live gate requires a bounded proposed action';
  end if;

  select summary.* into v_eval
  from runtime.vision_eval_summaries as summary
  where summary.account_id = p_account_id
    and summary.workflow_type = v_run.workflow_type
    and summary.passed = true
    and summary.created_at >= clock_timestamp() - interval '30 days'
  order by summary.created_at desc, summary.id desc
  limit 1;

  if p_confidence_score >= p_threshold and v_eval.id is not null then
    v_decision := 'allow';
    v_reasons := jsonb_build_array('CONFIDENCE_THRESHOLD_MET', 'PRECISION_EVAL_PASSED');
  else
    v_decision := 'require_approval';
    v_reasons := jsonb_build_array(
      case when p_confidence_score < p_threshold
        then 'CONFIDENCE_BELOW_THRESHOLD' else 'PRECISION_EVAL_NOT_PASSED' end
    );
  end if;

  v_policy := public.runtime_record_policy_decision(
    p_account_id => p_account_id,
    p_workflow_id => p_workflow_id,
    p_ruleset_id => 'adr002_live_gate',
    p_policy_version => 'adr002-stage4-v1',
    p_decision => v_decision,
    p_reasons => v_reasons,
    p_policy_input => jsonb_build_object(
      'confidence_score', p_confidence_score,
      'threshold', p_threshold,
      'eval_summary_id', v_eval.id,
      'eval_passed', coalesce(v_eval.passed, false)
    ),
    p_action_payload => v_action,
    p_actor_id => 'runtime-live-gate',
    p_evidence_ref => case when v_eval.id is null then null else 'vision-eval:' || v_eval.id::text end,
    p_approval_summary => left(
      coalesce(v_run.context ->> 'approval_summary', 'Vision action requires human approval'),
      240
    )
  );

  insert into runtime.live_gate_evaluations (
    account_id, workflow_id, eval_summary_id, policy_decision_id, approval_request_id,
    confidence_score, threshold, decision
  ) values (
    p_account_id, p_workflow_id, v_eval.id,
    (v_policy ->> 'policy_decision_id')::uuid,
    nullif(v_policy ->> 'approval_request_id', '')::uuid,
    p_confidence_score, p_threshold, v_decision
  ) returning id into v_gate_id;

  return v_policy || jsonb_build_object(
    'live_gate_evaluation_id', v_gate_id,
    'live_gate_decision', v_decision,
    'eval_summary_id', v_eval.id,
    -- Existing ADR 001 terminology: state is waiting_for_action; the next exact-hash Outbox action
    -- may now be enqueued. A workflow queued transition here would bypass the action lifecycle.
    'outbox_eligibility', case when v_decision = 'allow' then 'queued' else 'blocked' end
  );
end
$$;

revoke all on table runtime.vision_eval_summaries from public, anon, authenticated;
revoke all on table runtime.live_gate_evaluations from public, anon, authenticated;
revoke all on function public.runtime_record_vision_eval_summary(
  uuid, text, numeric, numeric, numeric, integer, text, numeric
) from public, anon, authenticated;
revoke all on function public.runtime_evaluate_live_gate(uuid, uuid, numeric, numeric)
  from public, anon, authenticated;
grant execute on function public.runtime_record_vision_eval_summary(
  uuid, text, numeric, numeric, numeric, integer, text, numeric
) to service_role;
grant execute on function public.runtime_evaluate_live_gate(uuid, uuid, numeric, numeric)
  to service_role;

comment on function public.runtime_evaluate_live_gate(uuid, uuid, numeric, numeric) is
  'Fail-closed ADR 002 gate. Uses the canonical Policy/Approval path and never upgrades shadow rows.';
