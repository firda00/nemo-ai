-- Platform health can expose operational topology. It is visible only to the
-- platform administrator, while the watchdog continues to write via service_role.
create or replace function public.is_platform_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((select is_admin from public.users where id = auth.uid()), false);
$$;

revoke all on function public.is_platform_admin() from public, anon;
grant execute on function public.is_platform_admin() to authenticated, service_role;

drop policy if exists ops_checks_read on public.ops_checks;
create policy ops_checks_read on public.ops_checks for select
  using (public.is_platform_admin());
