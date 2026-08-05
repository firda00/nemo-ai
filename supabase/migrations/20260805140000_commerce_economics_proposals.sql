-- Telegram economics input is a proposal, never a write. The bot parses what the owner said,
-- stores it here as 'pending', and only an explicit Yes press moves the numbers into
-- commerce_skus. Voice transcription and LLM extraction can both be wrong, so nothing touches
-- money until a human confirms the exact parsed values shown back to them.
create table if not exists public.commerce_economics_proposals (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.accounts(id) on delete cascade,
  channel_id uuid not null references public.channels(id) on delete cascade,
  chat_id text not null check (char_length(chat_id) between 1 and 40),
  sku_id uuid references public.commerce_skus(id) on delete cascade,
  candidates jsonb not null default '[]'::jsonb check (jsonb_typeof(candidates) = 'array'),
  product_query text not null check (char_length(product_query) between 1 and 200),
  source_text text not null check (char_length(source_text) between 1 and 2000),
  unit_cost_tiyin bigint check (unit_cost_tiyin >= 0),
  lead_time_days integer check (lead_time_days between 0 and 365),
  safety_stock integer check (safety_stock >= 0),
  min_margin_percent numeric(7,4) check (min_margin_percent between 0 and 99.9999),
  status text not null default 'pending' check (status in ('pending', 'applied', 'rejected', 'expired')),
  expires_at timestamptz not null default (now() + interval '1 hour'),
  applied_at timestamptz,
  created_at timestamptz not null default now(),
  -- A proposal that changes nothing is not worth confirming.
  check (unit_cost_tiyin is not null or lead_time_days is not null or safety_stock is not null or min_margin_percent is not null)
);

create index if not exists commerce_economics_proposals_chat_idx
  on public.commerce_economics_proposals(chat_id, status, created_at desc);

alter table public.commerce_economics_proposals enable row level security;
revoke all on public.commerce_economics_proposals from public, anon, authenticated;
grant select on public.commerce_economics_proposals to authenticated;
create policy commerce_economics_proposals_account_read on public.commerce_economics_proposals for select to authenticated
  using (account_id = public.current_account_id());

-- Applying a proposal is the same contract as an owner edit in the UI: the confirmed fields stop
-- being estimates and the revision advances so recommendations recompute against real numbers.
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
  -- The SKU must still belong to the proposing account.
  if not exists (
    select 1 from public.commerce_skus s
    join public.commerce_catalogs c on c.id = s.catalog_id
    where s.id = v_proposal.sku_id and c.account_id = v_proposal.account_id
  ) then
    raise exception using errcode = '42501', message = 'SKU does not belong to this account';
  end if;

  if v_proposal.unit_cost_tiyin is not null then v_applied := v_applied || 'unit_cost_tiyin'; end if;
  if v_proposal.lead_time_days is not null then v_applied := v_applied || 'lead_time_days'; end if;
  if v_proposal.safety_stock is not null then v_applied := v_applied || 'safety_stock'; end if;
  if v_proposal.min_margin_percent is not null then v_applied := v_applied || 'min_margin_percent'; end if;

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
