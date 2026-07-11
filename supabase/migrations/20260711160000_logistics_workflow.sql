-- Durable lookup paths for Logistics Control tasks, delay alerts and approval drafts.
alter table public.tasks add column if not exists subject_key text;

create index if not exists tasks_logistics_open_idx
  on public.tasks (account_id, department_id, status, created_at desc)
  where source = 'logistics';

create unique index if not exists tasks_logistics_exception_open_uidx
  on public.tasks (account_id, department_id, source, subject_key)
  where source = 'logistics' and status <> 'done' and subject_key is not null;

create index if not exists notifications_logistics_idx
  on public.notifications (account_id, department_id, kind, target, created_at desc)
  where kind in ('delay_alert', 'logistics_escalation', 'approval_request');

-- Reserve the full bounded workflow budget atomically before using Nemo's shared
-- model key. The function caps input at 40 rows / 12k characters and both model
-- calls cap output at 1800 tokens, so 50 credits is a conservative upper bound.
-- Finalization refunds every unused reserved credit.
create or replace function public.reserve_logistics_credits(p_account uuid, p_credits bigint)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare affected integer := 0;
begin
  if p_credits < 1 or p_credits > 50 then return false; end if;
  update public.accounts
     set token_balance = token_balance - p_credits
   where id = p_account and token_balance >= p_credits;
  get diagnostics affected = row_count;
  return affected = 1;
end;
$$;

create or replace function public.finalize_logistics_credits(p_account uuid, p_reserved bigint, p_tokens bigint)
returns void
language sql
security definer
set search_path = public
as $$
  update public.accounts
     set token_balance = token_balance + greatest(0, p_reserved - ceil(greatest(p_tokens, 0) / 1000.0)::bigint)
   where id = p_account;
$$;

revoke execute on function public.reserve_logistics_credits(uuid, bigint) from public, anon, authenticated;
revoke execute on function public.finalize_logistics_credits(uuid, bigint, bigint) from public, anon, authenticated;
grant execute on function public.reserve_logistics_credits(uuid, bigint) to service_role;
grant execute on function public.finalize_logistics_credits(uuid, bigint, bigint) to service_role;
