-- Economics defaults belong to the catalogue, not to a one-time bulk update of its products.
--
-- Until now a seller set a 20% margin, the catalogue grew, and every product added afterwards
-- arrived with empty economics — silently dropping out of Price Guard with nothing to signal
-- it. Filling the blanks again is a treadmill: it only ever covers what already exists.
--
-- The inheritance is a BEFORE INSERT trigger rather than logic in the sync worker, so it holds
-- for every path that can create a SKU — the worker, a CSV import, or code not written yet.
alter table public.commerce_catalogs
  add column if not exists default_min_margin_percent numeric(7,4) check (default_min_margin_percent between 0 and 99.9999),
  add column if not exists default_commission_percent numeric(7,4) check (default_commission_percent between 0 and 100),
  add column if not exists default_returns_reserve_percent numeric(7,4) check (default_returns_reserve_percent between 0 and 100),
  add column if not exists default_fulfillment_tiyin bigint check (default_fulfillment_tiyin >= 0),
  add column if not exists default_lead_time_days integer check (default_lead_time_days between 0 and 365),
  add column if not exists default_safety_stock integer check (default_safety_stock >= 0);

-- Unit cost has no catalogue default on purpose: it is a fact about one product's supplier,
-- and a shared guess would quietly poison every margin in the catalogue.

create or replace function public.commerce_sku_inherit_defaults()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  d public.commerce_catalogs;
begin
  select * into d from public.commerce_catalogs where id = new.catalog_id;
  if not found then return new; end if;

  -- Only fills what the caller left null: an explicit value always wins over the default.
  new.min_margin_percent := coalesce(new.min_margin_percent, d.default_min_margin_percent);
  new.commission_percent := coalesce(new.commission_percent, d.default_commission_percent);
  new.returns_reserve_percent := coalesce(new.returns_reserve_percent, d.default_returns_reserve_percent);
  new.fulfillment_tiyin := coalesce(new.fulfillment_tiyin, d.default_fulfillment_tiyin);
  new.lead_time_days := coalesce(new.lead_time_days, d.default_lead_time_days);
  new.safety_stock := coalesce(new.safety_stock, d.default_safety_stock);
  return new;
end
$$;

drop trigger if exists commerce_skus_inherit_defaults on public.commerce_skus;
create trigger commerce_skus_inherit_defaults
before insert on public.commerce_skus
for each row execute function public.commerce_sku_inherit_defaults();

-- Applying a catalogue-wide proposal now does two things: it records the value as the
-- catalogue's default so future products inherit it, and it fills the blanks that already
-- exist. Without the first half the seller would have to repeat the action after every sync.
create or replace function public.apply_commerce_economics_proposal(p_proposal_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_proposal public.commerce_economics_proposals;
  v_applied text[] := '{}';
  v_estimated jsonb;
  v_touched integer := 0;
begin
  select * into v_proposal from public.commerce_economics_proposals
  where id = p_proposal_id for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'proposal not found';
  end if;
  if v_proposal.status <> 'pending' then
    raise exception using errcode = '23514', message = 'proposal is not pending';
  end if;
  if v_proposal.expires_at <= now() then
    update public.commerce_economics_proposals set status = 'expired' where id = v_proposal.id;
    raise exception using errcode = '23514', message = 'proposal expired';
  end if;

  if v_proposal.unit_cost_tiyin is not null then v_applied := array_append(v_applied, 'unit_cost_tiyin'); end if;
  if v_proposal.lead_time_days is not null then v_applied := array_append(v_applied, 'lead_time_days'); end if;
  if v_proposal.safety_stock is not null then v_applied := array_append(v_applied, 'safety_stock'); end if;
  if v_proposal.min_margin_percent is not null then v_applied := array_append(v_applied, 'min_margin_percent'); end if;
  if v_proposal.commission_percent is not null then v_applied := array_append(v_applied, 'commission_percent'); end if;
  if v_proposal.fulfillment_tiyin is not null then v_applied := array_append(v_applied, 'fulfillment_tiyin'); end if;
  if v_proposal.returns_reserve_percent is not null then v_applied := array_append(v_applied, 'returns_reserve_percent'); end if;

  if v_proposal.sku_id is not null then
    if not exists (
      select 1 from public.commerce_skus s
      join public.commerce_catalogs c on c.id = s.catalog_id
      where s.id = v_proposal.sku_id and c.account_id = v_proposal.account_id
    ) then
      raise exception using errcode = '42501', message = 'SKU does not belong to this account';
    end if;

    select coalesce(jsonb_agg(field), '[]'::jsonb) into v_estimated
    from jsonb_array_elements_text((select estimated_fields from public.commerce_skus where id = v_proposal.sku_id)) as field
    where field <> all (v_applied);

    update public.commerce_skus s set
      unit_cost_tiyin = coalesce(v_proposal.unit_cost_tiyin, s.unit_cost_tiyin),
      lead_time_days = coalesce(v_proposal.lead_time_days, s.lead_time_days),
      safety_stock = coalesce(v_proposal.safety_stock, s.safety_stock),
      min_margin_percent = coalesce(v_proposal.min_margin_percent, s.min_margin_percent),
      commission_percent = coalesce(v_proposal.commission_percent, s.commission_percent),
      fulfillment_tiyin = coalesce(v_proposal.fulfillment_tiyin, s.fulfillment_tiyin),
      returns_reserve_percent = coalesce(v_proposal.returns_reserve_percent, s.returns_reserve_percent),
      estimated_fields = v_estimated,
      economics_revision = s.economics_revision + 1,
      economics_updated_at = now()
    where s.id = v_proposal.sku_id;
    v_touched := 1;
  else
    if not exists (
      select 1 from public.commerce_catalogs c
      where c.id = v_proposal.catalog_id and c.account_id = v_proposal.account_id
    ) then
      raise exception using errcode = '42501', message = 'catalogue does not belong to this account';
    end if;

    -- The value becomes the catalogue's standing default, so tomorrow's products inherit it.
    update public.commerce_catalogs c set
      default_min_margin_percent = coalesce(v_proposal.min_margin_percent, c.default_min_margin_percent),
      default_commission_percent = coalesce(v_proposal.commission_percent, c.default_commission_percent),
      default_returns_reserve_percent = coalesce(v_proposal.returns_reserve_percent, c.default_returns_reserve_percent),
      default_fulfillment_tiyin = coalesce(v_proposal.fulfillment_tiyin, c.default_fulfillment_tiyin),
      default_lead_time_days = coalesce(v_proposal.lead_time_days, c.default_lead_time_days),
      default_safety_stock = coalesce(v_proposal.safety_stock, c.default_safety_stock)
    where c.id = v_proposal.catalog_id;

    -- And the products that already exist get their blanks filled. Deliberate per-SKU values
    -- are never flattened by a catalogue-wide action.
    update public.commerce_skus s set
      commission_percent = coalesce(s.commission_percent, v_proposal.commission_percent),
      fulfillment_tiyin = coalesce(s.fulfillment_tiyin, v_proposal.fulfillment_tiyin),
      returns_reserve_percent = coalesce(s.returns_reserve_percent, v_proposal.returns_reserve_percent),
      min_margin_percent = coalesce(s.min_margin_percent, v_proposal.min_margin_percent),
      lead_time_days = coalesce(s.lead_time_days, v_proposal.lead_time_days),
      safety_stock = coalesce(s.safety_stock, v_proposal.safety_stock),
      economics_revision = s.economics_revision + 1,
      economics_updated_at = now()
    where s.catalog_id = v_proposal.catalog_id
      and (
        (v_proposal.commission_percent is not null and s.commission_percent is null)
        or (v_proposal.fulfillment_tiyin is not null and s.fulfillment_tiyin is null)
        or (v_proposal.returns_reserve_percent is not null and s.returns_reserve_percent is null)
        or (v_proposal.min_margin_percent is not null and s.min_margin_percent is null)
        or (v_proposal.lead_time_days is not null and s.lead_time_days is null)
        or (v_proposal.safety_stock is not null and s.safety_stock is null)
      );
    get diagnostics v_touched = row_count;
  end if;

  update public.commerce_economics_proposals
  set status = 'applied', applied_at = now() where id = v_proposal.id;

  return jsonb_build_object(
    'sku_id', v_proposal.sku_id,
    'catalog_id', v_proposal.catalog_id,
    'applied_fields', to_jsonb(v_applied),
    'skus_touched', v_touched
  );
end
$$;

revoke all on function public.apply_commerce_economics_proposal(uuid) from public, anon, authenticated;
grant execute on function public.apply_commerce_economics_proposal(uuid) to service_role;
