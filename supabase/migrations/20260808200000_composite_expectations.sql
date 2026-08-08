-- Составное ожидание: пополнение засчитывается, только если товар ещё и продался.
--
-- Гипотеза пополнения проверялась одним условием — «остаток вышел из нуля». Ему удовлетворяет и
-- закупка, заморозившая деньги в неликвиде: товар лежит, остаток не ноль, гипотеза confirmed,
-- уверенность растёт. Система выучила бы, что её советы работают, не отличая выгодное пополнение
-- от разорительного.
--
-- Это та же лестная точность, против которой стоит правило про unmeasurable, — только пробравшаяся
-- с другой стороны: не через отсутствие метрики, а через её выбор. Метрика была измеримой и
-- честной; неверным был вопрос.
--
-- Теперь ожидание может быть конъюнкцией: {"all": [терм, терм]}. Одиночная форма продолжает
-- работать без изменений — цене второй вопрос не нужен.

-- ─────────────────────────────────────────────────────────────────────────────────────────────
-- Форма ожидания
-- ─────────────────────────────────────────────────────────────────────────────────────────────
create or replace function public.org_term_well_formed(t jsonb)
returns boolean
language sql
immutable
as $$
  select jsonb_typeof(t) = 'object'
     and jsonb_typeof(t -> 'metric') = 'string'
     and (t ->> 'op') in ('>=', '>', '<=', '<', '==', '!=')
     and t ? 'value'
$$;

create or replace function public.org_expectation_well_formed(p jsonb)
returns boolean
language sql
immutable
as $$
  select case
    when jsonb_typeof(p) <> 'object' then false
    when p ? 'all' then
      jsonb_typeof(p -> 'all') = 'array'
      -- Верхняя граница не украшение: решение, зависящее от шести условий сразу, невозможно
      -- атрибутировать — не узнаешь, какое из них подвело.
      and jsonb_array_length(p -> 'all') between 1 and 4
      and not exists (
        select 1 from jsonb_array_elements(p -> 'all') t where not public.org_term_well_formed(t)
      )
    else public.org_term_well_formed(p)
  end
$$;

alter table public.org_decisions drop constraint if exists org_decisions_expected_measurable;
alter table public.org_decisions
  add constraint org_decisions_expected_measurable check (public.org_expectation_well_formed(expected));

-- Разворачивает ожидание в список термов: одиночное — сам себе список из одного.
create or replace function public.org_expectation_terms(p jsonb)
returns setof jsonb
language sql
immutable
as $$
  select case when p ? 'all' then t else p end
    from jsonb_array_elements(case when p ? 'all' then p -> 'all' else jsonb_build_array(p) end) t
$$;

-- ─────────────────────────────────────────────────────────────────────────────────────────────
-- Резолвер по термам
-- ─────────────────────────────────────────────────────────────────────────────────────────────
-- Неизмеримый терм делает неизмеримым всё решение. Заключить «сработало» по половине условий
-- нельзя: это и была бы та самая точность, созданная отбором.
create or replace function public.org_decisions_resolve_due(p_limit int default 50)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_due       record;
  v_term      jsonb;
  v_obs       jsonb;
  v_actual    numeric;
  v_target    numeric;
  v_holds     boolean;
  v_all_hold  boolean;
  v_blocked   jsonb;
  v_trace     jsonb;
  v_confirmed int := 0;
  v_refuted   int := 0;
  v_unmeasurable int := 0;
begin
  for v_due in
    select d.id, d.account_id, d.expected, d.horizon_at
      from public.org_decisions d
     where d.outcome = 'pending' and d.horizon_at <= now()
     order by d.horizon_at
     limit greatest(1, least(p_limit, 500))
     for update skip locked
  loop
    v_all_hold := true;
    v_blocked := null;
    v_trace := '[]'::jsonb;

    for v_term in select * from public.org_expectation_terms(v_due.expected)
    loop
      v_obs := public.org_observe_metric(
        v_due.account_id, v_term->>'metric',
        coalesce(v_term->'params', '{}'::jsonb), v_due.horizon_at);

      if coalesce((v_obs->>'ok')::boolean, false) is not true then
        v_blocked := v_obs || jsonb_build_object('metric', v_term->>'metric');
        exit;
      end if;

      v_target := (v_term->>'value')::numeric;
      v_actual := (v_obs->>'value')::numeric;
      v_holds := case v_term->>'op'
                   when '>='  then v_actual >= v_target
                   when '>'   then v_actual >  v_target
                   when '<='  then v_actual <= v_target
                   when '<'   then v_actual <  v_target
                   when '=='  then v_actual =  v_target
                   when '!='  then v_actual <> v_target
                 end;
      if v_holds is null then
        v_blocked := v_obs || jsonb_build_object('reason', 'unknown_operator', 'op', v_term->>'op');
        exit;
      end if;

      -- След по каждому терму: если решение опровергнуто, видно каким именно условием.
      v_trace := v_trace || jsonb_build_array(jsonb_build_object(
        'metric', v_term->>'metric', 'op', v_term->>'op',
        'expected', v_target, 'actual', v_actual, 'holds', v_holds));
      if not v_holds then v_all_hold := false; end if;
    end loop;

    if v_blocked is not null then
      perform public.org_decision_resolve(v_due.id, 'unmeasurable', v_blocked || jsonb_build_object('terms', v_trace));
      v_unmeasurable := v_unmeasurable + 1;
    elsif v_all_hold then
      perform public.org_decision_resolve(v_due.id, 'confirmed', jsonb_build_object('terms', v_trace));
      v_confirmed := v_confirmed + 1;
    else
      perform public.org_decision_resolve(v_due.id, 'refuted', jsonb_build_object('terms', v_trace));
      v_refuted := v_refuted + 1;
    end if;
  end loop;

  return jsonb_build_object('confirmed', v_confirmed, 'refuted', v_refuted, 'unmeasurable', v_unmeasurable);
end;
$$;

-- ─────────────────────────────────────────────────────────────────────────────────────────────
-- Регистрация проверяет КАЖДЫЙ терм
-- ─────────────────────────────────────────────────────────────────────────────────────────────
-- Иначе составное ожидание стало бы лазейкой: один подключённый терм рядом с неподключённым
-- прошёл бы регистрацию и вернулся тихим unmeasurable через неделю.
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
  v_term     jsonb;
  v_metric   text;
  v_probe    jsonb;
  v_reason   text;
  v_link     jsonb;
  v_primaries int := 0;
  v_claim    record;
begin
  if p_account_id is null then
    raise exception using errcode = '22023', message = 'account is required';
  end if;

  for v_term in select * from public.org_expectation_terms(p_expected)
  loop
    v_metric := v_term->>'metric';
    v_probe := public.org_observe_metric(p_account_id, v_metric, coalesce(v_term->'params', '{}'::jsonb), now() + interval '100 years');
    v_reason := v_probe->>'reason';
    if v_reason = 'unknown_metric' then
      raise exception using errcode = '22023', message = 'unknown metric: ' || coalesce(v_metric, '(null)');
    end if;
    if v_reason = 'metric_not_wired' then
      raise exception using errcode = '22023',
        message = 'metric not wired: ' || coalesce(v_metric, '(null)') || ' — ' || coalesce(v_probe->>'detail', 'нет канала данных');
    end if;
    if v_reason in ('metric_misconfigured', 'unknown_strategy') then
      raise exception using errcode = '22023', message = 'metric misconfigured: ' || coalesce(v_metric, '(null)');
    end if;
  end loop;

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

-- ─────────────────────────────────────────────────────────────────────────────────────────────
-- Мостик Commerce спрашивает оба вопроса
-- ─────────────────────────────────────────────────────────────────────────────────────────────
create or replace function public.commerce_accept_finding(p_account_id uuid, p_recommendation_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_rec       record;
  v_lead      int;
  v_claim     uuid;
  v_expected  jsonb;
  v_horizon   timestamptz;
  v_decision  jsonb;
begin
  select r.id, r.kind, r.status, r.sku_id, r.calculation, s.lead_time_days, s.title, s.external_sku
    into v_rec
    from public.commerce_recommendations r
    join public.commerce_skus s on s.id = r.sku_id
    join public.commerce_catalogs c on c.id = s.catalog_id
   where r.id = p_recommendation_id and c.account_id = p_account_id
   for update of r;

  if v_rec.id is null then
    return jsonb_build_object('ok', false, 'reason', 'not_found');
  end if;
  if v_rec.status <> 'open' then
    return jsonb_build_object('ok', false, 'reason', 'already_' || v_rec.status);
  end if;
  if v_rec.kind = 'missing_data' then
    return jsonb_build_object('ok', false, 'reason', 'not_actionable');
  end if;

  if v_rec.kind in ('stockout', 'reorder') then
    v_lead := coalesce(v_rec.lead_time_days, 14) + 3;
    -- ДВА вопроса, а не один. «Остаток вышел из нуля» верно и для закупки, заморозившей деньги в
    -- неликвиде. Совет о пополнении хорош тогда, когда товар лежит И продаётся.
    v_expected := jsonb_build_object('all', jsonb_build_array(
      jsonb_build_object('metric', 'commerce.sku.stock_total', 'op', '>', 'value', 0,
                         'params', jsonb_build_object('sku_id', v_rec.sku_id)),
      jsonb_build_object('metric', 'commerce.sku.sold_units_7d', 'op', '>', 'value', 0,
                         'params', jsonb_build_object('sku_id', v_rec.sku_id))
    ));
  elsif v_rec.kind = 'price_guard' then
    v_lead := 7;
    -- Цене второй вопрос не нужен: поднялась до минимума или нет — это и есть весь исход.
    v_expected := jsonb_build_object('metric', 'commerce.sku.price_tiyin', 'op', '>=',
                                     'value', coalesce((v_rec.calculation->>'min_selling_price_tiyin')::numeric, 0),
                                     'params', jsonb_build_object('sku_id', v_rec.sku_id));
  else
    return jsonb_build_object('ok', false, 'reason', 'unsupported_kind', 'kind', v_rec.kind);
  end if;

  v_horizon := now() + make_interval(days => v_lead);
  v_claim := public.commerce_hypothesis_for(p_account_id, v_rec.kind);

  update public.commerce_recommendations
     set status = 'accepted', updated_at = now()
   where id = p_recommendation_id and status = 'open';

  v_decision := public.org_decision_register(
    p_account_id, 'recommendation', p_recommendation_id,
    left(v_rec.kind || ': ' || coalesce(v_rec.title, v_rec.external_sku, 'товар'), 400),
    v_expected, v_horizon,
    case when v_claim is null then '[]'::jsonb
         else jsonb_build_array(jsonb_build_object('claim_id', v_claim, 'role', 'primary')) end,
    jsonb_build_object('bridge', 'commerce', 'kind', v_rec.kind)
  );

  return jsonb_build_object('ok', true, 'decision', v_decision, 'horizon_at', v_horizon,
                            'hypothesis', v_claim, 'expected', v_expected);
end;
$$;

-- Формулировка гипотезы должна совпадать с тем, что теперь проверяется. Старая обещала только
-- выход из нуля, и оставить её значило бы измерять одно, а верить в другое.
update public.org_claims
   set statement = 'Пополнение по сигналу Nemo выводит остаток из нуля, и товар после этого продаётся.'
 where subject_key = 'commerce:restock' and status <> 'retired'
   and statement = 'Пополнение по сигналу Nemo выводит остаток из нуля к сроку поставки.';

create or replace function public.commerce_hypothesis_for(p_account_id uuid, p_kind text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_subject   text;
  v_statement text;
  v_id        uuid;
begin
  if p_kind in ('stockout', 'reorder') then
    v_subject := 'commerce:restock';
    v_statement := 'Пополнение по сигналу Nemo выводит остаток из нуля, и товар после этого продаётся.';
  elsif p_kind = 'price_guard' then
    v_subject := 'commerce:pricing';
    v_statement := 'Пересмотр цены по сигналу Nemo поднимает её до минимально допустимой.';
  else
    return null;
  end if;

  select id into v_id from public.org_claims
   where account_id = p_account_id and subject_key = v_subject and status <> 'retired'
   order by created_at limit 1;
  if v_id is not null then return v_id; end if;

  insert into public.org_claims (account_id, statement, kind, subject, subject_key, source, source_detail)
  values (p_account_id, v_statement, 'preference', v_subject, v_subject, 'agent',
          jsonb_build_object('origin', 'commerce_bridge'))
  returning id into v_id;
  return v_id;
end;
$$;

revoke all on function public.org_decisions_resolve_due(int) from public, anon, authenticated;
grant execute on function public.org_decisions_resolve_due(int) to service_role;
revoke all on function public.org_decision_register(uuid, text, uuid, text, jsonb, timestamptz, jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.org_decision_register(uuid, text, uuid, text, jsonb, timestamptz, jsonb, jsonb) to service_role;
revoke all on function public.commerce_accept_finding(uuid, uuid) from public, anon, authenticated;
grant execute on function public.commerce_accept_finding(uuid, uuid) to service_role;
revoke all on function public.commerce_hypothesis_for(uuid, text) from public, anon, authenticated;
grant execute on function public.commerce_hypothesis_for(uuid, text) to service_role;

comment on function public.org_expectation_well_formed(jsonb) is
  'Ожидание — одиночный терм либо конъюнкция до четырёх. Больше нельзя: решение, зависящее от '
  'шести условий, невозможно атрибутировать.';
