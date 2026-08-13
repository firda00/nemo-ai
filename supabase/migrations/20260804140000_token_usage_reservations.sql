-- Reserve quota before concurrent provider calls, then atomically settle actual
-- usage and cache the logical action result for lost-response recovery.
create table if not exists public.token_usage_reservations (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.accounts(id) on delete cascade,
  billing_key text not null,
  run_id uuid not null,
  claim_token uuid not null,
  reserved_tokens bigint not null check (reserved_tokens > 0),
  reserved_credits bigint not null check (reserved_credits > 0),
  monthly_limit bigint not null check (monthly_limit > 0),
  status text not null default 'active' check (status in ('active', 'finalized', 'released', 'expired')),
  actual_tokens bigint,
  result jsonb,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  finalized_at timestamptz,
  unique (account_id, billing_key)
);

alter table public.token_usage_reservations
  add column if not exists monthly_limit bigint;
alter table public.token_usage_reservations add column if not exists run_id uuid;
alter table public.token_usage_reservations add column if not exists claim_token uuid;
update public.token_usage_reservations set monthly_limit = 9223372036854775807 where monthly_limit is null;
alter table public.token_usage_reservations alter column monthly_limit set not null;

alter table public.token_usage_reservations enable row level security;
revoke all on public.token_usage_reservations from public, anon, authenticated;

create or replace function public.reserve_token_usage(
  p_account_id uuid,
  p_billing_key text,
  p_reserved_tokens bigint,
  p_monthly_limit bigint,
  p_run_id uuid,
  p_claim_token uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  existing public.token_usage_reservations;
  balance bigint;
  credits bigint;
  expired_credits bigint;
  used_tokens bigint;
  active_tokens bigint;
  month_start timestamptz := date_trunc('month', now() at time zone 'UTC') at time zone 'UTC';
begin
  if p_account_id is null or p_billing_key is null or length(p_billing_key) not between 1 and 200
    or p_reserved_tokens <= 0 or p_monthly_limit <= 0 then raise exception 'invalid reservation input'; end if;
  perform 1 from public.autonomous_run_checkpoints where id = p_run_id and account_id = p_account_id and status = 'running' and claim_token = p_claim_token for update;
  if not found then raise exception 'worker claim lost'; end if;

  select * into existing from public.token_usage_reservations
  where account_id = p_account_id and billing_key = p_billing_key;
  if found and existing.status = 'finalized' then
    return jsonb_build_object('status', existing.status, 'result', existing.result);
  end if;
  if found and existing.status = 'active' and existing.expires_at > now() then
    return jsonb_build_object('status', 'in_progress');
  end if;

  select token_balance into balance from public.accounts where id = p_account_id for update;
  if not found then raise exception 'account not found'; end if;

  select * into existing from public.token_usage_reservations
  where account_id = p_account_id and billing_key = p_billing_key;
  if found and existing.status = 'finalized' then
    return jsonb_build_object('status', existing.status, 'result', existing.result);
  end if;
  if found and existing.status = 'active' and existing.expires_at > now() then
    return jsonb_build_object('status', 'in_progress');
  end if;

  with released as (
    update public.token_usage_reservations
    set status = 'expired'
    where account_id = p_account_id and status = 'active' and expires_at <= now()
    returning reserved_credits
  ) select coalesce(sum(reserved_credits), 0) into expired_credits from released;
  balance := balance + expired_credits;
  if expired_credits > 0 then update public.accounts set token_balance = balance where id = p_account_id; end if;

  credits := ceil(p_reserved_tokens / 1000.0)::bigint;
  select coalesce(sum(tokens), 0) into used_tokens from public.usage
  where account_id = p_account_id and created_at >= month_start;
  select coalesce(sum(reserved_tokens), 0) into active_tokens from public.token_usage_reservations
  where account_id = p_account_id and status = 'active';

  if balance < credits then return jsonb_build_object('status', 'denied_balance'); end if;
  if used_tokens + active_tokens + p_reserved_tokens > p_monthly_limit then return jsonb_build_object('status', 'denied_quota'); end if;

  insert into public.token_usage_reservations(account_id, billing_key, run_id, claim_token, reserved_tokens, reserved_credits, monthly_limit, expires_at)
  values (p_account_id, p_billing_key, p_run_id, p_claim_token, p_reserved_tokens, credits, p_monthly_limit, now() + interval '10 minutes')
  on conflict (account_id, billing_key) do update
    set reserved_tokens = excluded.reserved_tokens,
        reserved_credits = excluded.reserved_credits,
        monthly_limit = excluded.monthly_limit,
        run_id = excluded.run_id,
        claim_token = excluded.claim_token,
        status = 'active', result = null, actual_tokens = null,
        expires_at = excluded.expires_at, finalized_at = null;
  update public.accounts set token_balance = balance - credits where id = p_account_id;
  return jsonb_build_object('status', 'reserved');
end
$$;

create or replace function public.finalize_token_usage(
  p_account_id uuid,
  p_billing_key text,
  p_tokens bigint,
  p_cost numeric,
  p_model text,
  p_stage text,
  p_run_ref uuid,
  p_result jsonb,
  p_run_id uuid,
  p_claim_token uuid
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  reservation public.token_usage_reservations;
  actual_credits bigint;
begin
  -- Billing reflects provider work already performed. Cancellation or lease reclaim may
  -- stop state writes, but must not erase that external spend.
  perform 1 from public.autonomous_run_checkpoints where id = p_run_id and account_id = p_account_id for update;
  if not found then raise exception 'worker run not found'; end if;
  perform 1 from public.accounts where id = p_account_id for update;
  if not found then raise exception 'account not found'; end if;
  select * into reservation from public.token_usage_reservations
  where account_id = p_account_id and billing_key = p_billing_key for update;
  if not found then raise exception 'reservation not found'; end if;
  if reservation.run_id is distinct from p_run_id or reservation.claim_token is distinct from p_claim_token then
    raise exception 'reservation ownership mismatch';
  end if;
  if reservation.status = 'finalized' then return false; end if;
  if reservation.status <> 'active' or reservation.expires_at <= now() then raise exception 'reservation not active'; end if;
  if p_tokens <= 0 or p_cost < 0 then raise exception 'invalid actual usage'; end if;
  if p_result is null or octet_length(p_result::text) > 50000 then raise exception 'invalid cached result'; end if;

  actual_credits := ceil(p_tokens / 1000.0)::bigint;
  insert into public.usage(account_id, billing_key, tokens, cost, model, stage, run_ref)
  values(p_account_id, p_billing_key, p_tokens, p_cost, p_model, p_stage, p_run_ref);
  update public.accounts
  set token_balance = token_balance + reservation.reserved_credits - actual_credits
  where id = p_account_id;
  update public.token_usage_reservations
  set status = 'finalized', actual_tokens = p_tokens, result = p_result, finalized_at = now()
  where id = reservation.id;
  return true;
end
$$;

create or replace function public.complete_worker_from_research_run(
  p_worker_run_id uuid, p_claim_token uuid, p_account_id uuid, p_run_ref uuid
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare existing public.research_runs;
begin
  perform 1 from public.autonomous_run_checkpoints
  where id = p_worker_run_id and account_id = p_account_id and status = 'running' and claim_token = p_claim_token
  for update;
  if not found then raise exception 'worker claim lost'; end if;
  select * into existing from public.research_runs
  where account_id = p_account_id and run_ref = p_run_ref;
  if not found or existing.report is null then return false; end if;
  update public.autonomous_run_checkpoints
  set state = state || jsonb_build_object('result', existing.report, 'resultId', existing.id),
      phase = 'synth', transition = 'synth', status = 'completed',
      claim_token = null, claimed_at = null, last_error = null,
      next_attempt_at = now(), updated_at = now()
  where id = p_worker_run_id and claim_token = p_claim_token and status = 'running';
  return found;
end
$$;

drop function if exists public.release_token_usage(uuid, text);
create or replace function public.release_token_usage(
  p_account_id uuid, p_billing_key text, p_run_id uuid, p_claim_token uuid
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare reservation public.token_usage_reservations;
begin
  perform 1 from public.accounts where id = p_account_id for update;
  if not found then raise exception 'account not found'; end if;
  select * into reservation from public.token_usage_reservations
  where account_id = p_account_id and billing_key = p_billing_key for update;
  if not found or reservation.status <> 'active' then return false; end if;
  if reservation.run_id is distinct from p_run_id or reservation.claim_token is distinct from p_claim_token then return false; end if;
  update public.accounts set token_balance = token_balance + reservation.reserved_credits where id = p_account_id;
  update public.token_usage_reservations set status = 'released', result = null where id = reservation.id;
  return true;
end
$$;

create or replace function public.record_worker_token_usage(
  p_run_id uuid, p_claim_token uuid, p_account_id uuid, p_billing_key text,
  p_tokens bigint, p_cost numeric, p_model text, p_stage text, p_run_ref uuid
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform 1 from public.autonomous_run_checkpoints
  where id = p_run_id and account_id = p_account_id and status = 'running' and claim_token = p_claim_token
  for update;
  if not found then raise exception 'worker claim lost'; end if;
  return public.record_token_usage(p_account_id, p_billing_key, p_tokens, p_cost, p_model, p_stage, p_run_ref);
end
$$;

create or replace function public.persist_worker_research_run(
  p_worker_run_id uuid, p_claim_token uuid, p_account_id uuid, p_task text,
  p_status text, p_department_id uuid, p_run_ref uuid, p_report text,
  p_sources jsonb, p_steps jsonb, p_model text, p_tokens bigint, p_cost numeric
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare persisted_id uuid;
begin
  perform 1 from public.autonomous_run_checkpoints
  where id = p_worker_run_id and account_id = p_account_id and status = 'running' and claim_token = p_claim_token
  for update;
  if not found then raise exception 'worker claim lost'; end if;
  insert into public.research_runs(account_id, task, status, kind, department_id, run_ref, report, sources, steps, model, tokens, cost)
  values(p_account_id, p_task, p_status, 'team_run', p_department_id, p_run_ref, p_report, p_sources, p_steps, p_model, p_tokens, p_cost)
  returning id into persisted_id;
  update public.autonomous_run_checkpoints
  set state = state || jsonb_build_object(
        'result', p_report,
        'resultId', persisted_id,
        'escalatedCount', (select count(*) from jsonb_array_elements(p_steps) step where coalesce((step->'review'->>'needs_human_review')::boolean, false))
      ),
      phase = 'synth', transition = 'synth', status = 'completed',
      specialist_cursor = jsonb_array_length(p_steps), review_cursor = jsonb_array_length(p_steps),
      claim_token = null, claimed_at = null, last_error = null,
      next_attempt_at = now(), updated_at = now()
  where id = p_worker_run_id and claim_token = p_claim_token and status = 'running';
  if not found then raise exception 'worker claim lost'; end if;
  return persisted_id;
end
$$;

revoke all on function public.reserve_token_usage(uuid,text,bigint,bigint,uuid,uuid) from public, anon, authenticated;
revoke all on function public.finalize_token_usage(uuid,text,bigint,numeric,text,text,uuid,jsonb,uuid,uuid) from public, anon, authenticated;
revoke all on function public.release_token_usage(uuid,text,uuid,uuid) from public, anon, authenticated;
revoke all on function public.record_worker_token_usage(uuid,uuid,uuid,text,bigint,numeric,text,text,uuid) from public, anon, authenticated;
revoke all on function public.persist_worker_research_run(uuid,uuid,uuid,text,text,uuid,uuid,text,jsonb,jsonb,text,bigint,numeric) from public, anon, authenticated;
revoke all on function public.complete_worker_from_research_run(uuid,uuid,uuid,uuid) from public, anon, authenticated;
grant execute on function public.reserve_token_usage(uuid,text,bigint,bigint,uuid,uuid) to service_role;
grant execute on function public.finalize_token_usage(uuid,text,bigint,numeric,text,text,uuid,jsonb,uuid,uuid) to service_role;
grant execute on function public.release_token_usage(uuid,text,uuid,uuid) to service_role;
grant execute on function public.record_worker_token_usage(uuid,uuid,uuid,text,bigint,numeric,text,text,uuid) to service_role;
grant execute on function public.persist_worker_research_run(uuid,uuid,uuid,text,text,uuid,uuid,text,jsonb,jsonb,text,bigint,numeric) to service_role;
grant execute on function public.complete_worker_from_research_run(uuid,uuid,uuid,uuid) to service_role;
