-- Застрявший товар: лежит, платит за хранение и не продаётся.
--
-- Это не «ноль продаж за неделю» — такое бывает у сезонного товара в межсезонье и у новинки,
-- которую ещё никто не нашёл. Застой — это ДЛИТЕЛЬНОЕ отсутствие продаж при живом остатке, и
-- отличить одно от другого можно только историей.
--
-- Поэтому детектор молчит, пока истории мало. Соблазн велик: за пять дней наблюдений формально
-- «ноль продаж» верно почти у всего каталога, и отчёт вышел бы внушительный и бесполезный.
-- Порог в 14 дней наблюдений — то, что делает вывод проверяемым, а не громким.
alter table public.commerce_recommendations
  drop constraint if exists commerce_recommendations_kind_check;
alter table public.commerce_recommendations
  add constraint commerce_recommendations_kind_check
  check (kind in ('reorder', 'price_guard', 'missing_data', 'stockout', 'deadstock'));

/*
 * Кто лежит без движения.
 *
 * sold_units_7d — скользящая семидневка от Uzum. Ноль на протяжении 14 дней наблюдений значит,
 * что продаж не было и в те семь дней, что предшествовали первому наблюдению: окно каждого
 * снимка заглядывает назад. Возвращается именно число НАБЛЮДАВШИХСЯ дней, а не разница дат:
 * пропущенная синхронизация не должна превращаться в «наблюдали, всё было плохо».
 */
create or replace function public.commerce_deadstock(
  p_catalog_id  uuid,
  p_window_days integer default 30,
  p_min_days    integer default 14
)
returns table (
  sku_id            uuid,
  stock_total       integer,
  price_tiyin       bigint,
  days_observed     integer,
  first_observed_at timestamptz
)
language sql
stable
security definer
set search_path = ''
as $$
  with window_rows as (
    select
      s.sku_id,
      count(distinct date_trunc('day', s.observed_slot))::integer as days_observed,
      max(s.sold_units_7d)                                        as max_sold,
      min(s.observed_slot)                                        as first_observed_at
    from public.commerce_inventory_snapshots s
    join public.commerce_skus k on k.id = s.sku_id
    where k.catalog_id = p_catalog_id
      and s.observed_slot >= now() - make_interval(days => p_window_days)
    group by s.sku_id
  ),
  latest as (
    select distinct on (s.sku_id) s.sku_id, s.stock_total, s.price_tiyin
    from public.commerce_inventory_snapshots s
    join public.commerce_skus k on k.id = s.sku_id
    where k.catalog_id = p_catalog_id
    order by s.sku_id, s.observed_slot desc
  )
  select w.sku_id, l.stock_total, l.price_tiyin, w.days_observed, w.first_observed_at
  from window_rows w
  join latest l on l.sku_id = w.sku_id
  -- Остаток живой, продаж нет ни в одном наблюдении, и наблюдений достаточно, чтобы это значило
  -- застой, а не тишину коротких выходных.
  where coalesce(l.stock_total, 0) > 0
    and coalesce(w.max_sold, 0) = 0
    and w.days_observed >= p_min_days;
$$;

revoke all on function public.commerce_deadstock(uuid, integer, integer) from public, anon;
grant execute on function public.commerce_deadstock(uuid, integer, integer) to service_role;
