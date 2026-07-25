create or replace function public.current_account_id()
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select u.account_id
  from public.users u
  join public.accounts a on a.id = u.account_id
  where u.id = auth.uid()
    and coalesce(a.blocked, false) = false
$$;
