-- Referral program: each account has a referral_code; signing up with a friend's
-- code credits BOTH sides a bonus. "Пригласи друга — получи токены."

alter table public.accounts add column if not exists referral_code text;
alter table public.accounts add column if not exists referred_by  uuid references public.accounts(id) on delete set null;

create unique index if not exists accounts_referral_code_idx on public.accounts (referral_code) where referral_code is not null;

-- backfill codes for existing accounts
update public.accounts
set referral_code = upper(substr(md5(id::text || random()::text), 1, 8))
where referral_code is null;

-- signup hook: create account (with a referral code) + user, and apply the
-- referral bonus when the new user signed up with a valid ref code (in metadata).
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  new_account uuid;
  ref_code text;
  ref_acc uuid;
  bonus bigint := 200;  -- credits granted to each side on a successful referral
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
      update public.accounts set token_balance = token_balance + bonus where id = ref_acc;
      update public.accounts set token_balance = token_balance + bonus where id = new_account;
    end if;
  end if;
  return new;
end; $$;
