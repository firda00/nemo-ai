-- Обратная связь по исходу: регистрация решения и его разрешение по сроку.
--
-- Без этого «самообучение» остаётся переформулированием промпта. Убеждение получает свидетельство
-- только здесь, и только через измерение — ни агент, ни менеджер не могут его присвоить.
--
-- Резолвер живёт в SQL и вызывается cron'ом напрямую, без edge-функции. Не из экономии: у него
-- нет ни HTTP, ни секрета, ни холодного старта, а значит и трёх способов отказать молча.

-- ─────────────────────────────────────────────────────────────────────────────────────────────
-- Наблюдатель
-- ─────────────────────────────────────────────────────────────────────────────────────────────
-- Ядро доменно-нейтрально: оно знает не «остаток товара», а «метрику по ключу». Список метрик —
-- единственное место, где вертикаль просачивается внутрь, и просачивается явно.
--
-- ВАЖНО: измеряем только по наблюдениям ПОСЛЕ горизонта. Данные, собранные до решения, ничего о
-- его исходе не говорят, а измерить ими и назвать это результатом — самый дешёвый способ получить
-- красивую точность ни о чём.
create or replace function public.org_observe_metric(
  p_account_id uuid,
  p_metric     text,
  p_params     jsonb,
  p_after      timestamptz
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_sku     uuid := nullif(p_params->>'sku_id', '')::uuid;
  v_catalog uuid := nullif(p_params->>'catalog_id', '')::uuid;
  v_value   numeric;
  v_at      timestamptz;
begin
  -- Принадлежность арендатору проверяется здесь, а не доверяется вызывающему: функция
  -- security definer, RLS её не прикрывает.
  if v_sku is not null then
    perform 1 from public.commerce_skus s
      join public.commerce_catalogs c on c.id = s.catalog_id
     where s.id = v_sku and c.account_id = p_account_id;
    if not found then
      return jsonb_build_object('ok', false, 'reason', 'subject_not_in_account');
    end if;
  end if;
  if v_catalog is not null then
    perform 1 from public.commerce_catalogs c where c.id = v_catalog and c.account_id = p_account_id;
    if not found then
      return jsonb_build_object('ok', false, 'reason', 'subject_not_in_account');
    end if;
  end if;

  if p_metric = 'commerce.sku.stock_total' then
    select i.stock_total, i.observed_at into v_value, v_at
      from public.commerce_inventory_snapshots i
     where i.sku_id = v_sku and i.observed_at > p_after
     order by i.observed_at desc limit 1;

  elsif p_metric = 'commerce.sku.sold_units_7d' then
    select i.sold_units_7d, i.observed_at into v_value, v_at
      from public.commerce_inventory_snapshots i
     where i.sku_id = v_sku and i.observed_at > p_after
     order by i.observed_at desc limit 1;

  elsif p_metric in ('commerce.catalog.sold_units_7d', 'commerce.catalog.skus_at_zero') then
    -- По самому свежему полному слоту каталога после горизонта: смешивать соседние слоты значит
    -- складывать разные моменты времени и выдавать сумму за состояние.
    with slot as (
      select max(i.observed_slot) s
        from public.commerce_inventory_snapshots i
        join public.commerce_skus k on k.id = i.sku_id
       where k.catalog_id = v_catalog and i.observed_at > p_after
    )
    select case when p_metric = 'commerce.catalog.sold_units_7d'
                then sum(coalesce(i.sold_units_7d, 0))
                else count(*) filter (where coalesce(i.stock_total, 0) = 0) end,
           max(i.observed_at)
      into v_value, v_at
      from public.commerce_inventory_snapshots i
      join public.commerce_skus k on k.id = i.sku_id, slot
     where k.catalog_id = v_catalog and i.observed_slot = slot.s;

  else
    -- Незнакомая метрика — не ошибка вызова, а честное «измерить нечем».
    return jsonb_build_object('ok', false, 'reason', 'unknown_metric', 'metric', p_metric);
  end if;

  if v_value is null then
    return jsonb_build_object('ok', false, 'reason', 'no_observation_after_horizon');
  end if;
  return jsonb_build_object('ok', true, 'value', v_value, 'observed_at', v_at, 'metric', p_metric);
end;
$$;

-- ─────────────────────────────────────────────────────────────────────────────────────────────
-- Регистрация решения
-- ─────────────────────────────────────────────────────────────────────────────────────────────
-- Явная, а не автоматическая при согласовании. approval_requests фиксирует разрешение, а не
-- выполнение; учиться на разрешениях значит учиться на намерениях, включая те, что не состоялись.
--
-- Отказывает ГРОМКО на незнакомой метрике: лучше не зарегистрировать решение, чем зарегистрировать
-- и через неделю получить 'unmeasurable', приняв собственную небрежность за свойство мира.
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
  v_link     jsonb;
  v_primaries int := 0;
  v_claim    record;
begin
  if p_account_id is null then
    raise exception using errcode = '22023', message = 'account is required';
  end if;

  -- Проба наблюдателя на заведомо пустом окне: значение не нужно, нужен ответ, знает ли он метрику.
  v_probe := public.org_observe_metric(p_account_id, v_metric, coalesce(p_expected->'params', '{}'::jsonb), now() + interval '100 years');
  if v_probe->>'reason' = 'unknown_metric' then
    raise exception using errcode = '22023', message = 'unknown metric: ' || coalesce(v_metric, '(null)');
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

-- ─────────────────────────────────────────────────────────────────────────────────────────────
-- Резолвер
-- ─────────────────────────────────────────────────────────────────────────────────────────────
-- Идемпотентность обеспечивает org_decision_resolve: переход pending → решённое и начисление
-- свидетельства происходят одним оператором, поэтому повтор cron не начислит дважды.
create or replace function public.org_decisions_resolve_due(p_limit int default 50)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_due       record;
  v_obs       jsonb;
  v_op        text;
  v_target    numeric;
  v_actual    numeric;
  v_holds     boolean;
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
    v_obs := public.org_observe_metric(
      v_due.account_id, v_due.expected->>'metric',
      coalesce(v_due.expected->'params', '{}'::jsonb), v_due.horizon_at);

    if coalesce((v_obs->>'ok')::boolean, false) is not true then
      -- Неизмеримое — полноправный исход и попадает в отчёт. Система, тихо отбрасывающая то,
      -- что не смогла измерить, показывает растущую точность, целиком созданную отбором.
      perform public.org_decision_resolve(v_due.id, 'unmeasurable', v_obs);
      v_unmeasurable := v_unmeasurable + 1;
      continue;
    end if;

    v_op     := v_due.expected->>'op';
    v_target := (v_due.expected->>'value')::numeric;
    v_actual := (v_obs->>'value')::numeric;
    v_holds  := case v_op
                  when '>='  then v_actual >= v_target
                  when '>'   then v_actual >  v_target
                  when '<='  then v_actual <= v_target
                  when '<'   then v_actual <  v_target
                  when '=='  then v_actual =  v_target
                  when '!='  then v_actual <> v_target
                end;

    if v_holds is null then
      perform public.org_decision_resolve(v_due.id, 'unmeasurable',
        v_obs || jsonb_build_object('reason', 'unknown_operator', 'op', v_op));
      v_unmeasurable := v_unmeasurable + 1;
    elsif v_holds then
      perform public.org_decision_resolve(v_due.id, 'confirmed', v_obs);
      v_confirmed := v_confirmed + 1;
    else
      perform public.org_decision_resolve(v_due.id, 'refuted', v_obs);
      v_refuted := v_refuted + 1;
    end if;
  end loop;

  return jsonb_build_object('confirmed', v_confirmed, 'refuted', v_refuted, 'unmeasurable', v_unmeasurable);
end;
$$;

-- Доля неизмеримого стоит рядом с точностью. Отдельно её никто не посмотрит, а вместе она
-- показывает, чего измерения на самом деле стоят.
create or replace function public.org_learning_scoreboard(p_days int default 90)
returns table (resolved bigint, confirmed bigint, refuted bigint, unmeasurable bigint,
               accuracy numeric, unmeasurable_share numeric)
language sql stable security definer set search_path = ''
as $$
  select count(*) filter (where outcome <> 'pending'),
         count(*) filter (where outcome = 'confirmed'),
         count(*) filter (where outcome = 'refuted'),
         count(*) filter (where outcome = 'unmeasurable'),
         round(count(*) filter (where outcome = 'confirmed')::numeric
               / nullif(count(*) filter (where outcome in ('confirmed', 'refuted')), 0), 3),
         round(count(*) filter (where outcome = 'unmeasurable')::numeric
               / nullif(count(*) filter (where outcome <> 'pending'), 0), 3)
    from public.org_decisions
   where resolved_at >= now() - make_interval(days => greatest(1, least(p_days, 365)));
$$;

revoke all on function public.org_observe_metric(uuid, text, jsonb, timestamptz) from public, anon, authenticated;
grant execute on function public.org_observe_metric(uuid, text, jsonb, timestamptz) to service_role;
revoke all on function public.org_decision_register(uuid, text, uuid, text, jsonb, timestamptz, jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.org_decision_register(uuid, text, uuid, text, jsonb, timestamptz, jsonb, jsonb) to service_role;
revoke all on function public.org_decisions_resolve_due(int) from public, anon, authenticated;
grant execute on function public.org_decisions_resolve_due(int) to service_role;
revoke all on function public.org_learning_scoreboard(int) from public, anon;
grant execute on function public.org_learning_scoreboard(int) to authenticated, service_role;

comment on function public.org_observe_metric(uuid, text, jsonb, timestamptz) is
  'Измеряет метрику ПОСЛЕ горизонта решения. Данные до решения ничего о его исходе не говорят.';
comment on function public.org_learning_scoreboard(int) is
  'Точность рядом с долей неизмеримого: без второго первое врёт тем сильнее, чем хуже дела.';
