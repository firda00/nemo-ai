-- Platform admin + token economy (grants, gift codes, balance limits).

-- 1) platform admin flag on users
alter table public.users add column if not exists is_admin boolean not null default false;

-- bootstrap: promote the owner email if it already registered
update public.users set is_admin = true where email = 'ustudyit1@gmail.com';

-- auto-promote that email on future signups (re-declare the trigger fn)
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
declare new_account uuid;
begin
  insert into public.accounts (name) values (coalesce(new.email, 'Nemo')) returning id into new_account;
  insert into public.users (id, account_id, email, is_admin)
  values (new.id, new_account, new.email, coalesce(new.email, '') = 'ustudyit1@gmail.com');
  return new;
end; $$;

-- 2) admin balance helpers (SECURITY DEFINER — called by edge fns via service_role)
create or replace function public.add_token_balance(p_account uuid, p_amount bigint)
returns bigint language sql security definer set search_path = public as $$
  update public.accounts set token_balance = token_balance + p_amount where id = p_account
  returning token_balance;
$$;

create or replace function public.set_token_balance(p_account uuid, p_amount bigint)
returns bigint language sql security definer set search_path = public as $$
  update public.accounts set token_balance = greatest(p_amount, 0) where id = p_account
  returning token_balance;
$$;

-- 3) gift codes
create table if not exists public.gift_codes (
  id          uuid primary key default gen_random_uuid(),
  code        text not null unique,
  tokens      bigint not null,
  created_by  uuid,
  redeemed_by uuid,
  redeemed_at timestamptz,
  created_at  timestamptz not null default now()
);
alter table public.gift_codes enable row level security;
-- No client policies: only Edge Functions (service_role) touch this table.
