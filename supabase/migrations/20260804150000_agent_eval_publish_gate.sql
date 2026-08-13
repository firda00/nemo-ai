-- A published agent is an active agent whose exact configuration passed an
-- immutable sandbox evaluation. The database enforces this rather than trusting UI.
alter table public.agents
  add column if not exists config_revision bigint not null default 1 check (config_revision > 0),
  add column if not exists published_revision bigint,
  add column if not exists published_at timestamptz,
  add column if not exists latest_eval_run_id uuid;

alter table public.agents alter column status set default 'draft';
-- Existing live agents are explicitly grandfathered for a non-disruptive rollout.
-- Any behavior edit clears this marker and requires the normal eval/publish path.
update public.agents
set published_revision = config_revision, published_at = coalesce(published_at, now())
where status = 'active' and published_revision is null;

create table if not exists public.agent_eval_suites (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.accounts(id) on delete cascade,
  agent_id uuid not null references public.agents(id) on delete cascade,
  config_revision bigint not null check (config_revision > 0),
  suite_version integer not null default 1 check (suite_version > 0),
  cases jsonb not null check (jsonb_typeof(cases) = 'array' and jsonb_array_length(cases) between 3 and 12),
  generator_model text not null,
  generator_version text not null default 'deterministic-v1',
  created_at timestamptz not null default now(),
  unique (agent_id, config_revision, suite_version)
);

create table if not exists public.agent_eval_runs (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.accounts(id) on delete cascade,
  agent_id uuid not null references public.agents(id) on delete cascade,
  suite_id uuid not null references public.agent_eval_suites(id) on delete restrict,
  config_revision bigint not null check (config_revision > 0),
  status text not null check (status in ('running', 'passed', 'failed', 'error')),
  results jsonb not null default '[]'::jsonb check (jsonb_typeof(results) = 'array'),
  total_count integer not null default 0 check (total_count >= 0),
  passed_count integer not null default 0 check (passed_count >= 0),
  critical_failed_count integer not null default 0 check (critical_failed_count >= 0),
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  runner_version text not null default 'sandbox-v1',
  judge_model text
);

create index if not exists agent_eval_suites_agent_revision_idx on public.agent_eval_suites(agent_id, config_revision, created_at desc);
create index if not exists agent_eval_runs_agent_revision_idx on public.agent_eval_runs(agent_id, config_revision, completed_at desc);
create unique index if not exists agent_eval_runs_one_active_account_uidx
  on public.agent_eval_runs(account_id) where status = 'running';

alter table public.agent_eval_suites enable row level security;
alter table public.agent_eval_runs enable row level security;
revoke all on public.agent_eval_suites, public.agent_eval_runs from public, anon, authenticated;
drop policy if exists agent_eval_suites_account_read on public.agent_eval_suites;
drop policy if exists agent_eval_runs_account_read on public.agent_eval_runs;
create policy agent_eval_suites_account_read on public.agent_eval_suites for select to authenticated using (account_id = public.current_account_id());
create policy agent_eval_runs_account_read on public.agent_eval_runs for select to authenticated using (account_id = public.current_account_id());

create or replace function public.invalidate_agent_publication()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if row(
    new.name, new.type, new.prompt, new.model, new.temperature, new.timezone,
    new.schedule, new.work_start, new.work_end, new.default_lang, new.country,
    new.purpose, new.niche, new.risk_tier, new.action_policy, new.voice_enabled,
    new.voice_mode, new.voice_id, new.stt_model, new.persona_mode, new.owner_name,
    new.skills, new.lead_form
  ) is distinct from row(
    old.name, old.type, old.prompt, old.model, old.temperature, old.timezone,
    old.schedule, old.work_start, old.work_end, old.default_lang, old.country,
    old.purpose, old.niche, old.risk_tier, old.action_policy, old.voice_enabled,
    old.voice_mode, old.voice_id, old.stt_model, old.persona_mode, old.owner_name,
    old.skills, old.lead_form
  ) then
    new.config_revision := old.config_revision + 1;
    new.published_revision := null;
    new.published_at := null;
    new.latest_eval_run_id := null;
    if old.status = 'active' then new.status := 'draft'; end if;
  end if;
  return new;
end
$$;

drop trigger if exists agents_invalidate_publication on public.agents;
create trigger agents_invalidate_publication
before update on public.agents
for each row execute function public.invalidate_agent_publication();

create or replace function public.require_passing_agent_eval()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.status = 'active' and (tg_op = 'INSERT' or old.status is distinct from 'active') then
    if current_setting('nemo.publish_authorized', true) is distinct from '1' then
      raise exception using errcode = '42501', message = 'AGENT_PUBLISH_OWNER_REQUIRED';
    end if;
    if not exists (
      select 1 from public.agent_eval_runs r
      where r.id = new.latest_eval_run_id
        and r.agent_id = new.id
        and r.account_id = new.account_id
        and r.config_revision = new.config_revision
        and r.status = 'passed'
        and r.critical_failed_count = 0
    ) then
      raise exception using errcode = '23514', message = 'AGENT_EVAL_REQUIRED';
    end if;
  end if;
  return new;
end
$$;

drop trigger if exists agents_require_passing_eval on public.agents;
create trigger agents_require_passing_eval
before insert or update of status on public.agents
for each row execute function public.require_passing_agent_eval();

create or replace function public.publish_agent(p_agent_id uuid, p_eval_run_id uuid)
returns public.agents
language plpgsql
security definer
set search_path = ''
as $$
declare v_agent public.agents; v_run public.agent_eval_runs;
begin
  select * into v_agent from public.agents where id = p_agent_id for update;
  if not found then raise exception 'agent not found'; end if;
  if not exists (select 1 from public.users where id = auth.uid() and account_id = v_agent.account_id and role = 'owner') then
    raise exception using errcode = '42501', message = 'owner required';
  end if;
  select * into v_run from public.agent_eval_runs where id = p_eval_run_id for update;
  if not found or v_run.account_id <> v_agent.account_id or v_run.agent_id <> v_agent.id
    or v_run.config_revision <> v_agent.config_revision or v_run.status <> 'passed' or v_run.critical_failed_count <> 0 then
    raise exception using errcode = '23514', message = 'AGENT_EVAL_REQUIRED';
  end if;
  perform set_config('nemo.publish_authorized', '1', true);
  update public.agents set status = 'active', published_revision = config_revision,
    published_at = now(), latest_eval_run_id = p_eval_run_id where id = v_agent.id
  returning * into v_agent;
  return v_agent;
end
$$;

revoke all on function public.publish_agent(uuid, uuid) from public, anon;
grant execute on function public.publish_agent(uuid, uuid) to authenticated;
