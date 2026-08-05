-- Uzum's seller API does not expose commission, fulfillment or the returns reserve, so
-- Price Guard cannot compute a margin at all today. Those three numbers live in the seller
-- cabinet, which the read-only browser extension can already observe. This lets an
-- observation become a proposal — never a write — and lets one proposal target a whole
-- catalogue, because a seller's fees are an account-level fact, not a per-SKU one.
alter table public.commerce_economics_proposals
  add column if not exists commission_percent numeric(7,4) check (commission_percent between 0 and 100),
  add column if not exists fulfillment_tiyin bigint check (fulfillment_tiyin >= 0),
  add column if not exists returns_reserve_percent numeric(7,4) check (returns_reserve_percent between 0 and 100),
  add column if not exists catalog_id uuid references public.commerce_catalogs(id) on delete cascade,
  add column if not exists source text not null default 'telegram'
    check (source in ('telegram', 'browser', 'ui'));

-- A browser or UI proposal has no chat behind it.
alter table public.commerce_economics_proposals alter column channel_id drop not null;
alter table public.commerce_economics_proposals alter column chat_id drop not null;

alter table public.commerce_economics_proposals
  drop constraint if exists commerce_economics_proposals_check;

alter table public.commerce_economics_proposals
  add constraint commerce_economics_proposals_target_check
  check (sku_id is not null or catalog_id is not null);

alter table public.commerce_economics_proposals
  add constraint commerce_economics_proposals_value_check
  check (
    unit_cost_tiyin is not null or lead_time_days is not null or safety_stock is not null
    or min_margin_percent is not null or commission_percent is not null
    or fulfillment_tiyin is not null or returns_reserve_percent is not null
  );

-- A telegram proposal must still carry the chat it came from, or the callback handler
-- could not verify who is allowed to press the button.
alter table public.commerce_economics_proposals
  add constraint commerce_economics_proposals_telegram_check
  check (source <> 'telegram' or (channel_id is not null and chat_id is not null));

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
    -- Single SKU: the owner named this product, so its values are overwritten.
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

    -- Catalogue-wide fees only FILL BLANKS. A seller who already typed a real commission for
    -- one product must not have it silently replaced by a number scraped off a fees page.
    update public.commerce_skus s set
      commission_percent = coalesce(s.commission_percent, v_proposal.commission_percent),
      fulfillment_tiyin = coalesce(s.fulfillment_tiyin, v_proposal.fulfillment_tiyin),
      returns_reserve_percent = coalesce(s.returns_reserve_percent, v_proposal.returns_reserve_percent),
      economics_revision = s.economics_revision + 1,
      economics_updated_at = now()
    where s.catalog_id = v_proposal.catalog_id
      and (
        (v_proposal.commission_percent is not null and s.commission_percent is null)
        or (v_proposal.fulfillment_tiyin is not null and s.fulfillment_tiyin is null)
        or (v_proposal.returns_reserve_percent is not null and s.returns_reserve_percent is null)
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
