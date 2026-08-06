-- Uzum already returns the commission, the category and the physical dimensions of every SKU.
-- The worker fetched them every four hours and threw them away, while the seller was asked to
-- supply the same numbers by hand. These columns keep the facts, and api_fields records which
-- values came from Uzum so a later sync may refresh them WITHOUT ever overwriting a number the
-- owner typed or confirmed themselves.
alter table public.commerce_skus
  add column if not exists uzum_category text,
  add column if not exists length_mm integer check (length_mm >= 0),
  add column if not exists width_mm integer check (width_mm >= 0),
  add column if not exists height_mm integer check (height_mm >= 0),
  add column if not exists weight_g integer check (weight_g >= 0),
  add column if not exists api_fields jsonb not null default '[]'::jsonb
    check (jsonb_typeof(api_fields) = 'array');

comment on column public.commerce_skus.api_fields is
  'Economics fields whose current value came from the Uzum API. A sync may refresh these; it must never touch a field the owner set.';

-- Ownership of a value is three-way and the three are mutually exclusive per field:
--   api_fields        - Uzum said so; refreshable by the worker
--   estimated_fields  - Nemo guessed; cannot raise a critical alert
--   neither           - the owner stated it; nothing may overwrite it
create or replace function public.commerce_apply_uzum_facts(
  p_sku_id uuid,
  p_category text,
  p_commission numeric,
  p_fulfillment_tiyin bigint,
  p_return_percent numeric,
  p_length integer,
  p_width integer,
  p_height integer,
  p_weight integer
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_sku public.commerce_skus;
  v_api jsonb;
  v_estimated jsonb;
  v_owns_commission boolean;
  v_owns_fulfillment boolean;
  v_owns_returns boolean;
begin
  select * into v_sku from public.commerce_skus where id = p_sku_id;
  if not found then return; end if;

  v_api := coalesce(v_sku.api_fields, '[]'::jsonb);
  v_estimated := coalesce(v_sku.estimated_fields, '[]'::jsonb);

  -- "The owner owns it" means: it has a value that came from neither Uzum nor a Nemo estimate.
  v_owns_commission := v_sku.commission_percent is not null
    and not (v_api ? 'commission_percent') and not (v_estimated ? 'commission_percent');
  v_owns_fulfillment := v_sku.fulfillment_tiyin is not null
    and not (v_api ? 'fulfillment_tiyin') and not (v_estimated ? 'fulfillment_tiyin');
  v_owns_returns := v_sku.returns_reserve_percent is not null
    and not (v_api ? 'returns_reserve_percent') and not (v_estimated ? 'returns_reserve_percent');

  update public.commerce_skus s set
    uzum_category = coalesce(p_category, s.uzum_category),
    length_mm = coalesce(p_length, s.length_mm),
    width_mm = coalesce(p_width, s.width_mm),
    height_mm = coalesce(p_height, s.height_mm),
    weight_g = coalesce(p_weight, s.weight_g),
    commission_percent = case when v_owns_commission or p_commission is null
      then s.commission_percent else p_commission end,
    fulfillment_tiyin = case when v_owns_fulfillment or p_fulfillment_tiyin is null
      then s.fulfillment_tiyin else p_fulfillment_tiyin end,
    -- The observed return rate is a fact, but it is history on possibly tiny volumes rather
    -- than a policy reserve — so it lands as an ESTIMATE and can never raise a critical alert.
    returns_reserve_percent = case when v_owns_returns or p_return_percent is null
      then s.returns_reserve_percent else least(p_return_percent, 100) end,
    api_fields = (
      select coalesce(jsonb_agg(distinct field), '[]'::jsonb) from jsonb_array_elements_text(
        v_api
        || case when p_commission is not null and not v_owns_commission then '["commission_percent"]'::jsonb else '[]'::jsonb end
        || case when p_fulfillment_tiyin is not null and not v_owns_fulfillment then '["fulfillment_tiyin"]'::jsonb else '[]'::jsonb end
      ) as field
    ),
    estimated_fields = (
      select coalesce(jsonb_agg(distinct field), '[]'::jsonb) from jsonb_array_elements_text(
        -- A value Uzum supplied is no longer a guess.
        (select coalesce(jsonb_agg(e), '[]'::jsonb) from jsonb_array_elements_text(v_estimated) as e
         where not (p_commission is not null and not v_owns_commission and e = 'commission_percent')
           and not (p_fulfillment_tiyin is not null and not v_owns_fulfillment and e = 'fulfillment_tiyin'))
        || case when p_return_percent is not null and not v_owns_returns then '["returns_reserve_percent"]'::jsonb else '[]'::jsonb end
      ) as field
    ),
    economics_revision = s.economics_revision + 1,
    economics_updated_at = now()
  where s.id = p_sku_id;
end
$$;

revoke all on function public.commerce_apply_uzum_facts(uuid, text, numeric, bigint, numeric, integer, integer, integer, integer) from public, anon, authenticated;
grant execute on function public.commerce_apply_uzum_facts(uuid, text, numeric, bigint, numeric, integer, integer, integer, integer) to service_role;
