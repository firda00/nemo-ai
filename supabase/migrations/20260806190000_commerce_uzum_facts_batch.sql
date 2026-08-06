-- One round trip per catalogue instead of one per SKU. The per-SKU version made 140 sequential
-- calls for a single shop and blew the function's 150-second limit — correct logic, unusable
-- shape. The ownership rules are unchanged; only the batching is.
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
