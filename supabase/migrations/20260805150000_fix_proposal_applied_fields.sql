-- `v_applied || 'unit_cost_tiyin'` looks like an append but Postgres resolves the untyped literal
-- against anyarray||anyarray and fails with "malformed array literal" at runtime. Function
-- creation does not catch it, so every Yes press failed in production while the SQL looked fine.
-- array_append is unambiguous.
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
  if v_proposal.sku_id is null then
    raise exception using errcode = '23514', message = 'proposal has no resolved SKU';
  end if;
  if not exists (
    select 1 from public.commerce_skus s
    join public.commerce_catalogs c on c.id = s.catalog_id
    where s.id = v_proposal.sku_id and c.account_id = v_proposal.account_id
  ) then
    raise exception using errcode = '42501', message = 'SKU does not belong to this account';
  end if;

  if v_proposal.unit_cost_tiyin is not null then v_applied := array_append(v_applied, 'unit_cost_tiyin'); end if;
  if v_proposal.lead_time_days is not null then v_applied := array_append(v_applied, 'lead_time_days'); end if;
  if v_proposal.safety_stock is not null then v_applied := array_append(v_applied, 'safety_stock'); end if;
  if v_proposal.min_margin_percent is not null then v_applied := array_append(v_applied, 'min_margin_percent'); end if;

  select coalesce(jsonb_agg(field), '[]'::jsonb) into v_estimated
  from jsonb_array_elements_text((select estimated_fields from public.commerce_skus where id = v_proposal.sku_id)) as field
  where field <> all (v_applied);

  update public.commerce_skus s set
    unit_cost_tiyin = coalesce(v_proposal.unit_cost_tiyin, s.unit_cost_tiyin),
    lead_time_days = coalesce(v_proposal.lead_time_days, s.lead_time_days),
    safety_stock = coalesce(v_proposal.safety_stock, s.safety_stock),
    min_margin_percent = coalesce(v_proposal.min_margin_percent, s.min_margin_percent),
    estimated_fields = v_estimated,
    economics_revision = s.economics_revision + 1,
    economics_updated_at = now()
  where s.id = v_proposal.sku_id;

  update public.commerce_economics_proposals
  set status = 'applied', applied_at = now() where id = v_proposal.id;

  return jsonb_build_object('sku_id', v_proposal.sku_id, 'applied_fields', to_jsonb(v_applied));
end
$$;

revoke all on function public.apply_commerce_economics_proposal(uuid) from public, anon, authenticated;
grant execute on function public.apply_commerce_economics_proposal(uuid) to service_role;
