-- Phase 1–2b review fixes (security + correctness).

-- 1) Close the RLS write hole: WITH CHECK must enforce the same ownership as USING,
--    otherwise an authenticated user could INSERT rows into other accounts' dialogues.
drop policy if exists messages_acc on public.messages;
create policy messages_acc on public.messages for all
  using (
    dialogue_id in (
      select id from public.dialogues
      where agent_id in (select id from public.agents where account_id = public.current_account_id())
    )
  )
  with check (
    dialogue_id in (
      select id from public.dialogues
      where agent_id in (select id from public.agents where account_id = public.current_account_id())
    )
  );

drop policy if exists leads_acc on public.leads;
create policy leads_acc on public.leads for all
  using (
    dialogue_id in (
      select id from public.dialogues
      where agent_id in (select id from public.agents where account_id = public.current_account_id())
    )
  )
  with check (
    dialogue_id in (
      select id from public.dialogues
      where agent_id in (select id from public.agents where account_id = public.current_account_id())
    )
  );

-- 2) Never expose channel secrets to the browser roles. Row access is still allowed
--    by RLS, but credentials/secret_token are unreadable by anon/authenticated.
--    NOTE: a column-level REVOKE is a no-op while the role holds a table-level SELECT
--    grant (Supabase grants one by default), so we revoke the table grant and re-grant
--    SELECT only on the safe columns. Edge Functions use service_role (bypasses this).
revoke select on public.channels from anon, authenticated;
grant select (id, agent_id, type, status, created_at) on public.channels to anon, authenticated;

-- 4) Cost guard: atomic token-balance decrement.
create or replace function public.decrement_token_balance(p_account uuid, p_amount bigint)
returns void
language sql
security definer
set search_path = public
as $$
  update public.accounts
  set token_balance = greatest(0, token_balance - p_amount)
  where id = p_account;
$$;
