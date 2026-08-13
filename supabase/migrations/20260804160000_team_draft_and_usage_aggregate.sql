-- Repair production/source skew after the publish gate: atomic team creation must
-- create a draft manager, and token admission must aggregate without a row cap.
create or replace function public.create_agent_team(
  p_manager jsonb,
  p_department jsonb,
  p_specialists jsonb
)
returns jsonb
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_account_id uuid := public.current_account_id();
  v_agent_id uuid;
  v_department_id uuid;
  v_specialist jsonb;
  v_name text := left(trim(coalesce(p_manager->>'name', '')), 60);
  v_policy text := coalesce(p_manager->>'action_policy', 'approval_required');
  v_risk text := coalesce(p_manager->>'risk_tier', 'standard');
  v_count integer;
begin
  if auth.uid() is null or v_account_id is null then
    raise exception using errcode = '42501', message = 'authenticated account required';
  end if;
  if jsonb_typeof(p_manager) <> 'object' or v_name = '' then
    raise exception using errcode = '22023', message = 'valid manager is required';
  end if;
  if jsonb_typeof(coalesce(p_manager->'prompt', '{}'::jsonb)) <> 'object' then
    raise exception using errcode = '22023', message = 'manager prompt must be an object';
  end if;
  if v_policy not in ('read_only', 'approval_required') then
    raise exception using errcode = '22023', message = 'invalid action policy';
  end if;
  if v_risk not in ('standard', 'regulated') then
    raise exception using errcode = '22023', message = 'invalid risk tier';
  end if;
  if jsonb_typeof(p_specialists) <> 'array' then
    raise exception using errcode = '22023', message = 'specialists must be an array';
  end if;
  v_count := jsonb_array_length(p_specialists);
  if v_count < 2 or v_count > 6 then
    raise exception using errcode = '22023', message = 'a team requires 2 to 6 specialists';
  end if;

  insert into public.agents (
    account_id, name, type, avatar_color, prompt, model, temperature, timezone,
    schedule, work_start, work_end, default_lang, country, purpose, niche,
    risk_tier, action_policy, template_key, status, lead_form, skills
  ) values (
    v_account_id,
    v_name,
    'workflow',
    left(coalesce(p_manager->>'avatar_color', 'violet'), 20),
    coalesce(p_manager->'prompt', '{}'::jsonb),
    left(coalesce(p_manager->>'model', 'openai/gpt-4o-mini'), 160),
    least(2, greatest(0, coalesce((p_manager->>'temperature')::numeric, 0.6))),
    left(coalesce(p_manager->>'timezone', 'Asia/Tashkent'), 80),
    case when p_manager->>'schedule' = 'work-hours' then 'work-hours' else '24/7' end,
    nullif(left(coalesce(p_manager->>'work_start', ''), 5), ''),
    nullif(left(coalesce(p_manager->>'work_end', ''), 5), ''),
    left(coalesce(p_manager->>'default_lang', 'auto'), 10),
    nullif(left(trim(coalesce(p_manager->>'country', '')), 120), ''),
    nullif(left(trim(coalesce(p_manager->>'purpose', '')), 500), ''),
    nullif(left(trim(coalesce(p_manager->>'niche', '')), 120), ''),
    v_risk,
    v_policy,
    nullif(left(trim(coalesce(p_manager->>'template_key', '')), 120), ''),
    'draft',
    coalesce(p_manager->'lead_form', '{}'::jsonb),
    case
      when jsonb_typeof(coalesce(p_manager->'skills', '[]'::jsonb)) = 'array'
      then array(select jsonb_array_elements_text(p_manager->'skills') limit 6)
      else '{}'::text[]
    end
  ) returning id into v_agent_id;

  insert into public.departments (account_id, main_agent_id, name, niche)
  values (
    v_account_id,
    v_agent_id,
    left(coalesce(nullif(trim(p_department->>'name'), ''), v_name), 60),
    nullif(left(trim(coalesce(p_department->>'niche', '')), 120), '')
  ) returning id into v_department_id;

  for v_specialist in select value from jsonb_array_elements(p_specialists)
  loop
    if jsonb_typeof(v_specialist) <> 'object'
      or trim(coalesce(v_specialist->>'role', '')) = ''
      or trim(coalesce(v_specialist->>'name', '')) = ''
      or jsonb_typeof(coalesce(v_specialist->'prompt', '{}'::jsonb)) <> 'object'
      or jsonb_typeof(coalesce(v_specialist->'skills', '[]'::jsonb)) <> 'array'
      or jsonb_array_length(coalesce(v_specialist->'skills', '[]'::jsonb)) > 6
      or coalesce(v_specialist->>'status', 'active') not in ('active', 'paused') then
      raise exception using errcode = '22023', message = 'invalid specialist';
    end if;

    insert into public.sub_agents (
      account_id, department_id, role, name, prompt, skills, model, status
    ) values (
      v_account_id,
      v_department_id,
      left(trim(v_specialist->>'role'), 60),
      left(trim(v_specialist->>'name'), 60),
      v_specialist->'prompt',
      v_specialist->'skills',
      left(coalesce(v_specialist->>'model', 'openai/gpt-4o-mini'), 160),
      coalesce(v_specialist->>'status', 'active')
    );
  end loop;

  return jsonb_build_object('agent_id', v_agent_id, 'department_id', v_department_id, 'specialist_count', v_count);
end;
$$;

revoke all on function public.create_agent_team(jsonb, jsonb, jsonb) from public, anon;
grant execute on function public.create_agent_team(jsonb, jsonb, jsonb) to authenticated;

create or replace function public.monthly_token_usage(p_account_id uuid)
returns bigint
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(sum(u.tokens), 0)::bigint
  from public.usage u
  where u.account_id = p_account_id
    and u.created_at >= date_trunc('month', now() at time zone 'UTC') at time zone 'UTC'
$$;

revoke all on function public.monthly_token_usage(uuid) from public, anon, authenticated;
grant execute on function public.monthly_token_usage(uuid) to service_role;
