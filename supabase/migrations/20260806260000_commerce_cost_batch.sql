-- A dictated batch is several proposals that must be confirmed as one thing. The owner said
-- "бони 18000, шарф 22000, заколки 9000" in one breath and pressed one button; applying two of
-- the three because the third raced would leave them believing all three landed.
alter table public.commerce_economics_proposals
  add column if not exists batch_key uuid;

comment on column public.commerce_economics_proposals.batch_key is
  'Groups proposals dictated in one message so a single confirmation applies all of them.';

create index if not exists commerce_economics_proposals_batch_idx
  on public.commerce_economics_proposals(batch_key, status) where batch_key is not null;

-- Applies every pending proposal in a batch, and reports what actually moved.
--
-- Ownership is unchanged: this calls the same per-proposal function the single-item flow uses, so
-- a confirmed cost lands exactly the way a dictated one does — as the owner's own number, which
-- outranks anything a later sync reads from Uzum.
create or replace function public.apply_commerce_cost_batch(p_batch_key uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_proposal record;
  v_applied integer := 0;
  v_skipped integer := 0;
  v_result jsonb;
begin
  if p_batch_key is null then
    raise exception using errcode = '22023', message = 'batch key is required';
  end if;

  -- Ordered and locked so two presses of the same button cannot both apply it. The second press
  -- finds nothing pending and reports zero, which is the truth.
  for v_proposal in
    select id from public.commerce_economics_proposals
     where batch_key = p_batch_key and status = 'pending' and expires_at > now()
     order by created_at
     for update skip locked
  loop
    v_result := public.apply_commerce_economics_proposal(v_proposal.id);
    if coalesce(jsonb_array_length(v_result->'applied_fields'), 0) > 0 then
      v_applied := v_applied + 1;
    else
      v_skipped := v_skipped + 1;
    end if;
  end loop;

  -- Anything left pending in this batch expired between the card and the press. Marked, so it
  -- cannot be applied later by a stale button.
  update public.commerce_economics_proposals
     set status = 'expired'
   where batch_key = p_batch_key and status = 'pending';

  return jsonb_build_object('applied', v_applied, 'skipped', v_skipped);
end
$$;

revoke all on function public.apply_commerce_cost_batch(uuid) from public, anon, authenticated;
grant execute on function public.apply_commerce_cost_batch(uuid) to service_role;
