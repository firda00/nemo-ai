-- Security hardening (2026-07-02 audit). Defense-in-depth over the existing,
-- already-solid account-scoped RLS. Safe to run once against prod.

-- 1) Stripe webhook idempotency store. add_token_balance is additive, so a Stripe
--    retry or a replay of a captured signed payload must not credit twice. The
--    stripe-webhook function records each processed event id here (unique PK) and
--    skips crediting on a duplicate. Service_role only (RLS on, no policy).
create table if not exists public.webhook_events (
  id         text primary key,          -- stripe event id (evt_...)
  type       text,
  created_at timestamptz not null default now()
);
alter table public.webhook_events enable row level security;
revoke all on public.webhook_events from anon, authenticated;

-- 2) provider_keys is WRITE-ONLY from the browser. The stored api_key must never
--    be selectable by anon/authenticated — not even for the caller's own account —
--    regardless of any future stray table-level SELECT grant. Replace the single
--    FOR ALL policy (which also governed SELECT) with explicit write policies and
--    NO select policy, then revoke the SELECT grant as belt-and-suspenders.
--    (Agents read keys server-side via service_role in _shared/keys.ts.)
drop policy if exists provider_keys_write on public.provider_keys;

create policy provider_keys_insert on public.provider_keys for insert
  with check (account_id = public.current_account_id());
create policy provider_keys_update on public.provider_keys for update
  using (account_id = public.current_account_id())
  with check (account_id = public.current_account_id());
create policy provider_keys_delete on public.provider_keys for delete
  using (account_id = public.current_account_id());

revoke select on public.provider_keys from anon, authenticated;

-- 3) handle_new_user is a SECURITY DEFINER trigger that writes public.users
--    (incl. the is_admin flag) and public.accounts. It only runs from the
--    auth.users trigger; a client has no reason to hold EXECUTE on it. Revoke it
--    (same hygiene applied to the token-balance helpers in 20260627100000).
revoke execute on function public.handle_new_user() from public, anon, authenticated;
