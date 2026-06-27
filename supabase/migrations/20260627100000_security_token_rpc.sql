-- Security hardening (vibe-security audit).
--
-- CRITICAL FIX — privilege escalation via PostgREST RPC.
-- add_token_balance / set_token_balance / decrement_token_balance are
-- SECURITY DEFINER (they bypass RLS to update accounts.token_balance) and were
-- EXECUTE-able by anon + authenticated. Any logged-in user could mint themselves
-- unlimited tokens, e.g.:
--   supabase.rpc('add_token_balance', { p_account: <own account>, p_amount: 1e12 })
-- draining the shared OpenRouter pool / bypassing billing entirely.
--
-- These helpers are only ever called by Edge Functions (service_role). Restrict
-- EXECUTE to service_role so the client (anon/authenticated) cannot call them.
revoke execute on function public.add_token_balance(uuid, bigint)       from public, anon, authenticated;
revoke execute on function public.set_token_balance(uuid, bigint)       from public, anon, authenticated;
revoke execute on function public.decrement_token_balance(uuid, bigint) from public, anon, authenticated;

grant execute on function public.add_token_balance(uuid, bigint)       to service_role;
grant execute on function public.set_token_balance(uuid, bigint)       to service_role;
grant execute on function public.decrement_token_balance(uuid, bigint) to service_role;
