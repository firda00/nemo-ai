-- The return reserve used to be Uzum's `returnedPercentage` copied straight through. On this
-- catalogue that produced 83% on a scarf (five returns against six lifetime sales) and turned 98
-- of 140 SKUs into "loss-making" ones. The rate is now shrunk toward the category and the
-- catalogue in _shared/returnsReserve.ts, and the sample it rests on is stored alongside it so
-- the interface can say how much the number is worth.
alter table public.commerce_skus
  add column if not exists returns_sample_units integer;

comment on column public.commerce_skus.returns_sample_units is
  'Lifetime units sold behind returns_reserve_percent. Small samples mean the reserve is mostly borrowed from the category.';

-- The signature gains p_return_sample_units, so the old one is dropped rather than overloaded:
-- two functions differing only in arity would let a stale caller keep writing unshrunk rates.
drop function if exists public.commerce_apply_uzum_facts(uuid, text, numeric, bigint, numeric, integer, integer, integer, integer);

create function public.commerce_apply_uzum_facts(
  p_sku_id uuid,
  p_category text,
  p_commission numeric,
  p_fulfillment_tiyin bigint,
  p_return_percent numeric,
  p_return_sample_units integer,
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
  v_next_commission numeric;
  v_next_fulfillment bigint;
  v_next_returns numeric;
  v_next_sample integer;
begin
  select * into v_sku from public.commerce_skus where id = p_sku_id;
  if not found then return; end if;

  v_api := coalesce(v_sku.api_fields, '[]'::jsonb);
  v_estimated := coalesce(v_sku.estimated_fields, '[]'::jsonb);

  -- "The owner owns it" means: a value that came from neither Uzum nor a Nemo estimate.
  v_owns_commission := v_sku.commission_percent is not null
    and not (v_api ? 'commission_percent') and not (v_estimated ? 'commission_percent');
  v_owns_fulfillment := v_sku.fulfillment_tiyin is not null
    and not (v_api ? 'fulfillment_tiyin') and not (v_estimated ? 'fulfillment_tiyin');
  v_owns_returns := v_sku.returns_reserve_percent is not null
    and not (v_api ? 'returns_reserve_percent') and not (v_estimated ? 'returns_reserve_percent');

  v_next_commission := case when v_owns_commission or p_commission is null
    then v_sku.commission_percent else p_commission end;
  v_next_fulfillment := case when v_owns_fulfillment or p_fulfillment_tiyin is null
    then v_sku.fulfillment_tiyin else p_fulfillment_tiyin end;
  v_next_returns := case when v_owns_returns or p_return_percent is null
    then v_sku.returns_reserve_percent else least(p_return_percent, 100) end;
  -- The sample describes Uzum's own history, so it follows the reserve rather than the owner:
  -- when the owner has set their own reserve, the sample behind it is theirs and stays untouched.
  v_next_sample := case when v_owns_returns then v_sku.returns_sample_units
    else coalesce(p_return_sample_units, v_sku.returns_sample_units) end;

  -- Nothing moved: no write, no revision bump, no recomputation downstream.
  if v_next_commission is not distinct from v_sku.commission_percent
     and v_next_fulfillment is not distinct from v_sku.fulfillment_tiyin
     and v_next_returns is not distinct from v_sku.returns_reserve_percent
     and v_next_sample is not distinct from v_sku.returns_sample_units
     and coalesce(p_category, v_sku.uzum_category) is not distinct from v_sku.uzum_category
     and coalesce(p_length, v_sku.length_mm) is not distinct from v_sku.length_mm
     and coalesce(p_width, v_sku.width_mm) is not distinct from v_sku.width_mm
     and coalesce(p_height, v_sku.height_mm) is not distinct from v_sku.height_mm
     and coalesce(p_weight, v_sku.weight_g) is not distinct from v_sku.weight_g
  then
    return;
  end if;

  update public.commerce_skus s set
    uzum_category = coalesce(p_category, s.uzum_category),
    length_mm = coalesce(p_length, s.length_mm),
    width_mm = coalesce(p_width, s.width_mm),
    height_mm = coalesce(p_height, s.height_mm),
    weight_g = coalesce(p_weight, s.weight_g),
    commission_percent = v_next_commission,
    fulfillment_tiyin = v_next_fulfillment,
    -- Still an ESTIMATE, and deliberately so. Shrinking the rate makes it usable; it does not
    -- make it a policy the owner agreed to, so it can never raise a critical alert.
    returns_reserve_percent = v_next_returns,
    returns_sample_units = v_next_sample,
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

revoke all on function public.commerce_apply_uzum_facts(uuid, text, numeric, bigint, numeric, integer, integer, integer, integer, integer) from public, anon, authenticated;
grant execute on function public.commerce_apply_uzum_facts(uuid, text, numeric, bigint, numeric, integer, integer, integer, integer, integer) to service_role;

create or replace function public.commerce_apply_uzum_facts_batch(p_facts jsonb)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_fact jsonb;
  v_applied integer := 0;
begin
  if jsonb_typeof(p_facts) <> 'array' then
    raise exception using errcode = '22023', message = 'facts must be a json array';
  end if;

  for v_fact in select value from jsonb_array_elements(p_facts) loop
    perform public.commerce_apply_uzum_facts(
      (v_fact->>'sku_id')::uuid,
      v_fact->>'category',
      (v_fact->>'commission')::numeric,
      (v_fact->>'fulfillment_tiyin')::bigint,
      (v_fact->>'return_percent')::numeric,
      (v_fact->>'return_sample_units')::integer,
      (v_fact->>'length')::integer,
      (v_fact->>'width')::integer,
      (v_fact->>'height')::integer,
      (v_fact->>'weight')::integer
    );
    v_applied := v_applied + 1;
  end loop;
  return v_applied;
end
$$;

revoke all on function public.commerce_apply_uzum_facts_batch(jsonb) from public, anon, authenticated;
grant execute on function public.commerce_apply_uzum_facts_batch(jsonb) to service_role;

-- Rates already stored came from the unshrunk percentage. They are wrong in a way no future sync
-- would repair on its own: the skip-unchanged branch compares against them, so a corrected rate
-- that happens to match would be treated as "nothing moved". Clearing them forces one honest
-- rewrite on the next sync, and until then the SKU reports missing data rather than a bad number.
update public.commerce_skus
   set returns_reserve_percent = null,
       economics_revision = economics_revision + 1,
       economics_updated_at = now()
 where estimated_fields @> '["returns_reserve_percent"]'
   and returns_reserve_percent is not null;
