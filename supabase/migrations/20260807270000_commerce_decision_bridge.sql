-- Мостик Commerce → память: принятая рекомендация становится проверяемой гипотезой.
--
-- До сих пор путь обучения был декоративным: решений никто не регистрировал, резолвер каждый час
-- честно возвращал нули, и все убеждения навсегда оставались на уверенности 0.5. Оказалось хуже —
-- статус 'accepted' существовал в схеме, но в него не переводила ни одна строка кода: принять
-- рекомендацию было физически нельзя.
--
-- Принятие и регистрация решения происходят ОДНОЙ транзакцией. Рекомендация, принятая без
-- решения, необучаема и молчит об этом — ровно тот декоративный путь, который мы и убираем.

-- Наблюдателю нужна цена: price_guard советует поднять её до минимально допустимой, и проверить
-- это можно только измерив цену. Метрика лежала в снимках всё это время.
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

  elsif p_metric = 'commerce.sku.price_tiyin' then
    select i.price_tiyin, i.observed_at into v_value, v_at
      from public.commerce_inventory_snapshots i
     where i.sku_id = v_sku and i.observed_at > p_after
     order by i.observed_at desc limit 1;

  elsif p_metric in ('commerce.catalog.sold_units_7d', 'commerce.catalog.skus_at_zero') then
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
    return jsonb_build_object('ok', false, 'reason', 'unknown_metric', 'metric', p_metric);
  end if;

  if v_value is null then
    return jsonb_build_object('ok', false, 'reason', 'no_observation_after_horizon');
  end if;
  return jsonb_build_object('ok', true, 'value', v_value, 'observed_at', v_at, 'metric', p_metric);
end;
$$;

revoke all on function public.org_observe_metric(uuid, text, jsonb, timestamptz) from public, anon, authenticated;
grant execute on function public.org_observe_metric(uuid, text, jsonb, timestamptz) to service_role;

-- Гипотеза, которую проверяет каждое принятие. Одна на вид находки, а не на рекомендацию:
-- утверждение «наш совет о пополнении работает» проверяется всеми пополнениями сразу, и
-- свидетельства копятся на нём. Одно принятие ничего не доказывает, двадцать — доказывают.
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
    v_statement := 'Пополнение по сигналу Nemo выводит остаток из нуля к сроку поставки.';
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

  -- Вектор не считаем: SQL не умеет. Утверждение до достройки не найдётся отзывом, и воркер
  -- достроит его в течение пяти минут — тот самый путь, что уже стоит для слова владельца.
  insert into public.org_claims (account_id, statement, kind, subject, subject_key, source, source_detail)
  values (p_account_id, v_statement, 'preference', v_subject, v_subject, 'agent',
          jsonb_build_object('origin', 'commerce_bridge'))
  returning id into v_id;
  return v_id;
end;
$$;

-- Принятие рекомендации.
--
-- Nemo по-прежнему ничего не пишет в Uzum: «принято» означает, что владелец берётся сделать это
-- сам. Проверяем не выполнение, а результат — остаток перестал быть нулевым, цена поднялась.
-- Поэтому согласование и исход остаются разными вещами даже здесь.
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
    -- Повторное нажатие не создаёт второго решения: принятие идемпотентно по статусу.
    return jsonb_build_object('ok', false, 'reason', 'already_' || v_rec.status);
  end if;

  -- Нехватка данных — не решение, а пробел. Регистрировать её как гипотезу значит засорить
  -- леглер тем, из чего нельзя научиться.
  if v_rec.kind = 'missing_data' then
    return jsonb_build_object('ok', false, 'reason', 'not_actionable');
  end if;

  if v_rec.kind in ('stockout', 'reorder') then
    -- Срок поставки плюс трое суток на то, чтобы приход отразился в снимке. Без запаса решение
    -- измерялось бы ровно в день, когда товар ещё едет.
    v_lead := coalesce(v_rec.lead_time_days, 14) + 3;
    v_expected := jsonb_build_object('metric', 'commerce.sku.stock_total', 'op', '>', 'value', 0,
                                     'params', jsonb_build_object('sku_id', v_rec.sku_id));
  elsif v_rec.kind = 'price_guard' then
    v_lead := 7;
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

revoke all on function public.commerce_hypothesis_for(uuid, text) from public, anon, authenticated;
grant execute on function public.commerce_hypothesis_for(uuid, text) to service_role;
revoke all on function public.commerce_accept_finding(uuid, uuid) from public, anon, authenticated;
grant execute on function public.commerce_accept_finding(uuid, uuid) to service_role;

comment on function public.commerce_accept_finding(uuid, uuid) is
  'Принятие и регистрация решения одной транзакцией: принятая рекомендация без решения '
  'необучаема и молчит об этом.';
