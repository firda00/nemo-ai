-- Economics v2 — token balance is now in CREDITS.
-- 1 credit = 1000 LLM tokens of usage; $1 = 250 credits. New accounts start with 1000.
--
-- Edge Functions still pass RAW LLM token counts to decrement_token_balance; this
-- redefinition converts them to credits (ceil(llm/1000)) so NO function code changes.

create or replace function public.decrement_token_balance(p_account uuid, p_amount bigint)
returns void
language sql
security definer
set search_path = public
as $$
  update public.accounts
  set token_balance = greatest(0, token_balance - ceil(p_amount / 1000.0)::bigint)
  where id = p_account;
$$;

-- one-time: convert existing balances from raw LLM tokens to credits
update public.accounts set token_balance = ceil(token_balance / 1000.0)::bigint;

-- new accounts start with 1000 credits (was 100000 raw tokens)
alter table public.accounts alter column token_balance set default 1000;

-- keep the security hardening: only service_role (Edge Functions) may charge the balance
revoke execute on function public.decrement_token_balance(uuid, bigint) from public, anon, authenticated;
grant  execute on function public.decrement_token_balance(uuid, bigint) to service_role;
