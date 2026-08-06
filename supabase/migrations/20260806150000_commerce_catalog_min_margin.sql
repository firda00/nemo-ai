-- Minimum margin is the last field Price Guard needs and the only one no source can supply:
-- not the Uzum API, not the seller cabinet, not the browser extension. It is a decision about
-- how much the seller is willing to earn. Setting it per SKU across a 113-product catalogue is
-- busywork, so a catalogue-wide proposal covers it in one confirmation.
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

    -- Catalogue-wide values only FILL BLANKS, minimum margin included. A seller who set 30% on
    -- one product must not have it flattened to the catalogue default; a bulk convenience must
    -- never quietly overwrite a deliberate per-product decision.
    update public.commerce_skus s set
      commission_percent = coalesce(s.commission_percent, v_proposal.commission_percent),
      fulfillment_tiyin = coalesce(s.fulfillment_tiyin, v_proposal.fulfillment_tiyin),
      returns_reserve_percent = coalesce(s.returns_reserve_percent, v_proposal.returns_reserve_percent),
      min_margin_percent = coalesce(s.min_margin_percent, v_proposal.min_margin_percent),
      economics_revision = s.economics_revision + 1,
      economics_updated_at = now()
    where s.catalog_id = v_proposal.catalog_id
      and (
        (v_proposal.commission_percent is not null and s.commission_percent is null)
        or (v_proposal.fulfillment_tiyin is not null and s.fulfillment_tiyin is null)
        or (v_proposal.returns_reserve_percent is not null and s.returns_reserve_percent is null)
        or (v_proposal.min_margin_percent is not null and s.min_margin_percent is null)
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
