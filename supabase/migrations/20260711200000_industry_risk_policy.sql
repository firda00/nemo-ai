-- Server-enforced safety tier for regulated industry teams.
-- The tier is persisted outside editable prompt/niche text, cannot be downgraded,
-- and a database trigger blocks every channel write regardless of API/RLS path.

alter table public.agents
  add column if not exists risk_tier text not null default 'standard';

alter table public.agents
  add column if not exists template_key text;

alter table public.channels
  add column if not exists quarantined_credentials jsonb;

update public.agents
set risk_tier = 'standard'
where risk_tier is null or risk_tier not in ('standard', 'regulated');
alter table public.agents alter column risk_tier set default 'standard';
alter table public.agents alter column risk_tier set not null;

alter table public.agents drop constraint if exists agents_risk_tier_check;
alter table public.agents
  add constraint agents_risk_tier_check
  check (risk_tier in ('standard', 'regulated'));

create index if not exists agents_risk_tier_idx on public.agents (risk_tier);

create or replace function public.enforce_agent_risk_tier()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  new.risk_tier := coalesce(new.risk_tier, 'standard');

  if tg_op = 'INSERT' then
    if new.template_key in (
      'hr-recruiting',
      'clinic-front-desk',
      'accounting-collections',
      'legal-office',
      'insurance-operations'
    ) or coalesce(new.niche, '') ~* '(^|[[:space:]])nemo-risk:regulated([[:space:]]|$)' then
      new.risk_tier := 'regulated';
    end if;
    return new;
  end if;

  if old.template_key is not null and new.template_key is distinct from old.template_key then
    raise exception 'agent template key cannot be changed or removed'
      using errcode = '42501';
  end if;

  if old.risk_tier = 'regulated' and new.risk_tier <> 'regulated' then
    raise exception 'regulated agent risk tier cannot be downgraded'
      using errcode = '42501';
  end if;

  if new.template_key in (
    'hr-recruiting',
    'clinic-front-desk',
    'accounting-collections',
    'legal-office',
    'insurance-operations'
  ) or coalesce(new.niche, '') ~* '(^|[[:space:]])nemo-risk:regulated([[:space:]]|$)' then
    new.risk_tier := 'regulated';
  end if;

  if new.risk_tier = 'regulated' and old.risk_tier <> 'regulated' then
    update public.channels
    set quarantined_credentials = case
          when credentials <> '{}'::jsonb then credentials
          else quarantined_credentials
        end,
        credentials = '{}'::jsonb,
        status = 'safety_blocked'
    where agent_id = old.id;
  end if;
  return new;
end;
$$;

drop trigger if exists agents_risk_tier_guard on public.agents;
create trigger agents_risk_tier_guard
  before insert or update of risk_tier, template_key, niche on public.agents
  for each row execute function public.enforce_agent_risk_tier();

create or replace function public.block_regulated_agent_channel()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  target_tier text;
begin
  select a.risk_tier into target_tier
  from public.agents as a
  where a.id = new.agent_id
  for update;

  if target_tier = 'regulated' and (
    tg_op = 'INSERT'
    or new.status <> 'safety_blocked'
    or new.credentials <> '{}'::jsonb
  ) then
    raise exception 'live channels are disabled for regulated safety-beta teams'
      using errcode = '42501';
  end if;
  return new;
end;
$$;

drop trigger if exists channels_regulated_agent_guard on public.channels;
create trigger channels_regulated_agent_guard
  before insert or update of agent_id, status, credentials on public.channels
  for each row execute function public.block_regulated_agent_channel();

-- Upgrade any template rows created during a rolling deployment. The update
-- trigger preserves credentials and quarantines an already-connected channel.
update public.agents
set risk_tier = 'regulated'
where risk_tier = 'standard'
  and niche ~* '(^|[[:space:]])nemo-risk:regulated([[:space:]]|$)';

-- Self-heal a partial/rolling deployment: no active credential remains in the
-- column read by outbound jobs, while a server-only DB copy is retained
-- for a future, explicitly approved restoration migration.
update public.channels as c
set quarantined_credentials = case
      when c.credentials <> '{}'::jsonb then c.credentials
      else c.quarantined_credentials
    end,
    credentials = '{}'::jsonb,
    status = 'safety_blocked'
from public.agents as a
where a.id = c.agent_id
  and a.risk_tier = 'regulated'
  and (
    c.status <> 'safety_blocked'
    or c.credentials <> '{}'::jsonb
  );
