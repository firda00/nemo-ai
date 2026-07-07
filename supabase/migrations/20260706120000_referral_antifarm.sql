-- Anti-farm hardening for the referral / signup economy (CSO finding).
--
-- Before: handle_new_user() paid +200 to BOTH sides at signup (auth.users INSERT),
-- i.e. before the invited user proved a real email. A script could mass-register
-- and farm the referrer's balance (200 x N) with throwaway/unconfirmed emails.
--
-- After:
--   * signup only RECORDS the referral link (accounts.referred_by),
--   * the +200/+200 bonus is paid ONCE, when the invited user's email is CONFIRMED
--     (or immediately for pre-verified OAuth signups),
--   * a per-referrer CAP limits how many referral bonuses one account can earn.
--
-- Requires email confirmation to be ON in Supabase Auth (Dashboard → Authentication)
-- for the email/password path — otherwise there is no confirmation event to gate on.

-- 1) Bookkeeping columns: idempotency flag + per-referrer counter.
alter table public.accounts add column if not exists referral_bonus_paid boolean not null default false;
alter table public.accounts add column if not exists referral_count      int     not null default 0;

-- 2) Shared payout. Idempotent (claims the payout atomically via the
--    referral_bonus_paid flag) and caps the referrer. Safe to call more than once.
create or replace function public.pay_referral_bonus(p_new_account uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  ref_acc uuid;
  bonus   bigint := 200;  -- credits to each side on a confirmed referral
  cap     int    := 25;   -- max referral bonuses a single referrer can earn
  claimed int;
begin
  -- Atomically claim the one-time payout for this invited account. Only the first
  -- call where a referral link exists and the bonus is unpaid proceeds.
  update public.accounts
    set referral_bonus_paid = true
    where id = p_new_account
      and referred_by is not null
      and referral_bonus_paid = false
    returning referred_by into ref_acc;
  get diagnostics claimed = row_count;
  if claimed = 0 or ref_acc is null then
    return;
  end if;

  -- Referrer: credit only while under the cap (blocks unbounded Sybil farming).
  update public.accounts
    set token_balance  = token_balance + bonus,
        referral_count = referral_count + 1
    where id = ref_acc
      and referral_count < cap;

  -- Invited side: always gets its one-time bonus.
  update public.accounts
    set token_balance = token_balance + bonus
    where id = p_new_account;
end;
$$;

-- 3) Signup hook (auth.users INSERT): create account + user, record the referral
--    link, and pay the bonus IMMEDIATELY only when the email is already verified at
--    creation (OAuth / pre-confirmed). Email/password signups wait for confirmation.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  new_account uuid;
  ref_code    text;
  ref_acc     uuid;
begin
  ref_code := upper(coalesce(new.raw_user_meta_data->>'ref', ''));
  insert into public.accounts (name, referral_code)
  values (coalesce(new.email, 'Nemo'), upper(substr(md5(new.id::text || random()::text), 1, 8)))
  returning id into new_account;

  insert into public.users (id, account_id, email, is_admin)
  values (new.id, new_account, new.email, coalesce(new.email, '') = 'ustudyit1@gmail.com');

  if ref_code <> '' then
    select id into ref_acc from public.accounts where referral_code = ref_code and id <> new_account limit 1;
    if ref_acc is not null then
      update public.accounts set referred_by = ref_acc where id = new_account;
    end if;
  end if;

  -- Pre-verified signups (OAuth providers set email_confirmed_at at creation) can be
  -- paid right away; everyone else is paid by the confirmation trigger below.
  if new.email_confirmed_at is not null then
    perform public.pay_referral_bonus(new_account);
  end if;

  return new;
end;
$$;

-- 4) Confirmation hook (auth.users UPDATE): the moment email_confirmed_at flips from
--    NULL to set, pay the pending referral bonus for that user's account.
create or replace function public.handle_email_confirmed()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  acc uuid;
begin
  if new.email_confirmed_at is not null and old.email_confirmed_at is null then
    select account_id into acc from public.users where id = new.id;
    if acc is not null then
      perform public.pay_referral_bonus(acc);
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists on_auth_user_confirmed on auth.users;
create trigger on_auth_user_confirmed
  after update on auth.users
  for each row execute function public.handle_email_confirmed();

-- 5) These run only as SECURITY DEFINER triggers / service-role helpers — no client
--    should hold EXECUTE (belt-and-suspenders; default-deny already applies).
revoke execute on function public.pay_referral_bonus(uuid)   from public, anon, authenticated;
revoke execute on function public.handle_email_confirmed()   from public, anon, authenticated;
