-- Usage and credit charging are one transaction. A worker retry reuses the
-- logical transition key, so it cannot insert or charge the same stage twice.
alter table public.usage add column if not exists billing_key text;

alter table public.usage
  drop constraint if exists usage_billing_key_length_check;
alter table public.usage
  add constraint usage_billing_key_length_check
  check (billing_key is null or length(billing_key) between 1 and 200) not valid;
alter table public.usage validate constraint usage_billing_key_length_check;

create unique index if not exists usage_account_billing_key_uidx
  on public.usage (account_id, billing_key)
  where billing_key is not null;

create or replace function public.record_token_usage(
  p_account_id uuid,
  p_billing_key text,
  p_tokens bigint,
  p_cost numeric,
  p_model text default null,
  p_stage text default null,
  p_run_ref uuid default null
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  affected_rows bigint;
begin
  if p_account_id is null
    or p_billing_key is null
    or length(p_billing_key) not between 1 and 200
    or p_tokens <= 0
    or p_cost < 0 then
    raise exception 'invalid usage accounting input';
  end if;

  insert into public.usage (account_id, billing_key, tokens, cost, model, stage, run_ref)
  values (p_account_id, p_billing_key, p_tokens, p_cost, p_model, p_stage, p_run_ref)
  on conflict (account_id, billing_key) where billing_key is not null do nothing;

  get diagnostics affected_rows = row_count;
  if affected_rows = 1 then
    update public.accounts
    set token_balance = greatest(0, token_balance - ceil(p_tokens / 1000.0)::bigint)
    where id = p_account_id;
    if not found then raise exception 'account not found'; end if;
  end if;

  return affected_rows = 1;
end
$$;

revoke all on function public.record_token_usage(uuid,text,bigint,numeric,text,text,uuid) from public, anon, authenticated;
grant execute on function public.record_token_usage(uuid,text,bigint,numeric,text,text,uuid) to service_role;
