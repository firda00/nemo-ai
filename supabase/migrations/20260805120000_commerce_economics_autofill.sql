-- Owner-triggered economics estimates. Every estimated value is provenance-tracked per
-- field in commerce_skus.estimated_fields; recommendations computed from estimates are
-- capped at 'warning' severity, so critical Telegram alerts only ever fire from
-- owner-confirmed numbers. Estimates are never invented silently: only an explicit
-- owner action writes them, and any manual edit of a field removes its estimate mark.
alter table public.commerce_skus
  add column if not exists estimated_fields jsonb not null default '[]'::jsonb
  check (jsonb_typeof(estimated_fields) = 'array');

create or replace function public.autofill_commerce_economics(p_catalog_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_account uuid;
  v_run_id uuid;
  v_cost integer := 0;
  v_supply integer := 0;
begin
  select account_id into v_account from public.commerce_catalogs where id = p_catalog_id;
  if v_account is null then
    raise exception using errcode = 'P0002', message = 'commerce catalog not found';
  end if;
  if not exists (
    select 1 from public.users u
    where u.id = v_user_id and u.account_id = v_account and u.role = 'owner'
  ) then
    raise exception using errcode = '42501', message = 'owner required';
  end if;

  select id into v_run_id from public.commerce_sync_runs
  where catalog_id = p_catalog_id and status = 'completed'
  order by scheduled_for desc limit 1;
  if v_run_id is null then
    raise exception using errcode = '23514', message = 'no completed sync yet';
  end if;

  -- Cost estimate: 50% of the latest observed retail price. Only fills SKUs the owner
  -- has never priced, and is always marked as an estimate.
  with latest as (
    select n.sku_id, n.price_tiyin
    from public.commerce_inventory_snapshots n
    where n.sync_run_id = v_run_id
  )
  update public.commerce_skus s
  set unit_cost_tiyin = l.price_tiyin / 2,
      estimated_fields = s.estimated_fields || '["unit_cost_tiyin"]'::jsonb,
      economics_revision = s.economics_revision + 1,
      economics_updated_at = now(),
      economics_updated_by = v_user_id
  from latest l
  where s.id = l.sku_id and s.catalog_id = p_catalog_id
    and s.unit_cost_tiyin is null and l.price_tiyin > 0
    and not s.estimated_fields ? 'unit_cost_tiyin';
  get diagnostics v_cost = row_count;

  -- Supply estimate: 15-day lead time, zero safety stock. Enables the reorder planner;
  -- reorder alerts stay non-critical until the owner confirms these numbers.
  update public.commerce_skus s
  set lead_time_days = coalesce(s.lead_time_days, 15),
      safety_stock = coalesce(s.safety_stock, 0),
      estimated_fields = s.estimated_fields
        || case when s.lead_time_days is null then '["lead_time_days"]'::jsonb else '[]'::jsonb end
        || case when s.safety_stock is null then '["safety_stock"]'::jsonb else '[]'::jsonb end,
      economics_revision = s.economics_revision + 1,
      economics_updated_at = now(),
      economics_updated_by = v_user_id
  where s.catalog_id = p_catalog_id and (s.lead_time_days is null or s.safety_stock is null);
  get diagnostics v_supply = row_count;

  return jsonb_build_object('cost_estimated', v_cost, 'supply_estimated', v_supply);
end
$$;

revoke all on function public.autofill_commerce_economics(uuid) from public, anon;
grant execute on function public.autofill_commerce_economics(uuid) to authenticated;
