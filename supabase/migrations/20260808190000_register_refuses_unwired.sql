-- Регистрация решения отказывает и на неподключённой метрике, не только на незнакомой.
--
-- Раньше проверялась одна причина — 'unknown_metric'. С появлением реестра возникла вторая:
-- метрика объявлена, система знает её по имени, но канала данных под ней нет. Если такую
-- пропустить, громкий отказ в момент регистрации превратится в тихое 'unmeasurable' через неделю,
-- и небрежность будет выглядеть свойством мира. Отказ должен звучать там, где его слышно.
create or replace function public.org_decision_register(
  p_account_id uuid,
  p_source     text,
  p_source_id  uuid,
  p_summary    text,
  p_expected   jsonb,
  p_horizon_at timestamptz,
  p_claims     jsonb default '[]'::jsonb,
  p_policy_ref jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id       uuid;
  v_metric   text := p_expected->>'metric';
  v_probe    jsonb;
  v_reason   text;
  v_link     jsonb;
  v_primaries int := 0;
  v_claim    record;
begin
  if p_account_id is null then
    raise exception using errcode = '22023', message = 'account is required';
  end if;

  -- Проба на заведомо пустом окне: значение не нужно, нужен ответ, можно ли эту метрику измерить
  -- в принципе.
  v_probe := public.org_observe_metric(p_account_id, v_metric, coalesce(p_expected->'params', '{}'::jsonb), now() + interval '100 years');
  v_reason := v_probe->>'reason';
  if v_reason = 'unknown_metric' then
    raise exception using errcode = '22023', message = 'unknown metric: ' || coalesce(v_metric, '(null)');
  end if;
  if v_reason = 'metric_not_wired' then
    raise exception using errcode = '22023',
      message = 'metric not wired: ' || coalesce(v_metric, '(null)') || ' — ' || coalesce(v_probe->>'detail', 'нет канала данных');
  end if;
  if v_reason = 'metric_misconfigured' or v_reason = 'unknown_strategy' then
    raise exception using errcode = '22023',
      message = 'metric misconfigured: ' || coalesce(v_metric, '(null)');
  end if;

  insert into public.org_decisions (account_id, source, source_id, summary, expected, horizon_at, policy_ref)
  values (p_account_id, p_source, p_source_id, p_summary, p_expected, p_horizon_at, coalesce(p_policy_ref, '{}'::jsonb))
  returning id into v_id;

  for v_link in select * from jsonb_array_elements(coalesce(p_claims, '[]'::jsonb))
  loop
    select c.id, c.confidence, c.statement into v_claim
      from public.org_claims c
     where c.id = (v_link->>'claim_id')::uuid and c.account_id = p_account_id;
    if not found then
      raise exception using errcode = '22023', message = 'claim not in account: ' || coalesce(v_link->>'claim_id', '(null)');
    end if;
    if coalesce(v_link->>'role', 'context') = 'primary' then
      v_primaries := v_primaries + 1;
    end if;
    insert into public.org_decision_claims (
      account_id, decision_id, claim_id, role, weight, confidence_at_decision, statement_hash
    ) values (
      p_account_id, v_id, v_claim.id,
      coalesce(v_link->>'role', 'context'),
      coalesce((v_link->>'weight')::numeric, 1.000),
      v_claim.confidence,
      md5(v_claim.statement)
    );
  end loop;

  return jsonb_build_object('id', v_id, 'claims', jsonb_array_length(coalesce(p_claims, '[]'::jsonb)),
                            'learnable', v_primaries = 1);
end;
$$;

revoke all on function public.org_decision_register(uuid, text, uuid, text, jsonb, timestamptz, jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.org_decision_register(uuid, text, uuid, text, jsonb, timestamptz, jsonb, jsonb) to service_role;
