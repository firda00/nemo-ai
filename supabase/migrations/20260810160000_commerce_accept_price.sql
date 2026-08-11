-- Владелец принял КОНКРЕТНУЮ цену, а не совет вообще.
--
-- commerce_accept_finding регистрирует «беру в работу» и ждёт, что цена станет не ниже пола.
-- Здесь ожидание жёстче и честнее: названо число, и через неделю проверяется именно оно. Разница
-- не косметическая — «цена выше пола» сбудется и когда владелец поставил пол, и когда он поставил
-- ровно то, что советовали, а это разные исходы с разной прибылью.
--
-- ПОЛ ПРОВЕРЯЕТСЯ ЗДЕСЬ, а не только в интерфейсе и не только в кнопке. Цена приходит из
-- callback_data или из набранного в чате числа — и то и другое владелец может изменить, а кнопку
-- ещё и переслать. Единственное место, где проверку нельзя обойти, — база.
create or replace function public.commerce_accept_price(
  p_account_id        uuid,
  p_recommendation_id uuid,
  p_price_tiyin       bigint
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_rec      record;
  v_floor    numeric;
  v_claim    uuid;
  v_expected jsonb;
  v_horizon  timestamptz;
  v_decision jsonb;
begin
  select r.id, r.kind, r.status, r.sku_id, r.calculation, s.title, s.external_sku
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
    -- Повторное нажатие не создаёт второго решения.
    return jsonb_build_object('ok', false, 'reason', 'already_' || v_rec.status);
  end if;
  if v_rec.kind not in ('price_guard', 'deadstock') then
    return jsonb_build_object('ok', false, 'reason', 'unsupported_kind', 'kind', v_rec.kind);
  end if;

  v_floor := (v_rec.calculation->>'min_selling_price_tiyin')::numeric;
  if v_floor is null then
    -- Без пола принять цену нельзя: не с чем сравнивать, и «приняли» означало бы «согласились
    -- вслепую». Пол считается из себестоимости и комиссии — если его нет, нет и их.
    return jsonb_build_object('ok', false, 'reason', 'no_floor');
  end if;
  if p_price_tiyin is null or p_price_tiyin <= 0 then
    return jsonb_build_object('ok', false, 'reason', 'invalid_price');
  end if;
  if p_price_tiyin < v_floor then
    return jsonb_build_object('ok', false, 'reason', 'below_floor',
                              'floor_tiyin', v_floor, 'price_tiyin', p_price_tiyin);
  end if;

  -- Неделя: цена меняется в кабинете в тот же день, а продажи по новой цене нужно ещё накопить.
  v_horizon := now() + make_interval(days => 7);
  v_expected := jsonb_build_object(
    'metric', 'commerce.sku.price_tiyin', 'op', '>=', 'value', p_price_tiyin,
    'params', jsonb_build_object('sku_id', v_rec.sku_id)
  );
  v_claim := public.commerce_hypothesis_for(p_account_id, 'price_guard');

  update public.commerce_recommendations
     set status = 'accepted', updated_at = now(),
         suggested_action = coalesce(suggested_action, '{}'::jsonb)
                            || jsonb_build_object('accepted_price_tiyin', p_price_tiyin)
   where id = p_recommendation_id and status = 'open';

  v_decision := public.org_decision_register(
    p_account_id, 'recommendation', p_recommendation_id,
    left('price: ' || coalesce(v_rec.title, v_rec.external_sku, 'товар')
         || ' → ' || round(p_price_tiyin / 100) || ' сум', 400),
    v_expected, v_horizon,
    case when v_claim is null then '[]'::jsonb
         else jsonb_build_array(jsonb_build_object('claim_id', v_claim, 'role', 'primary')) end,
    jsonb_build_object('bridge', 'commerce', 'kind', v_rec.kind, 'price_tiyin', p_price_tiyin)
  );

  return jsonb_build_object('ok', true, 'decision', v_decision, 'horizon_at', v_horizon,
                            'hypothesis', v_claim, 'price_tiyin', p_price_tiyin);
end;
$$;

revoke all on function public.commerce_accept_price(uuid, uuid, bigint) from public, anon, authenticated;
grant execute on function public.commerce_accept_price(uuid, uuid, bigint) to service_role;
