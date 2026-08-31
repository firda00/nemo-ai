begin;

select plan(9);

insert into public.accounts (id, name) values
  ('81000000-0000-4000-8000-000000000001', 'staging-tenant-a'),
  ('82000000-0000-4000-8000-000000000002', 'staging-tenant-b');
insert into auth.users (id) values
  ('81100000-0000-4000-8000-000000000001'),
  ('82100000-0000-4000-8000-000000000002');
update public.users set account_id = '81000000-0000-4000-8000-000000000001'
where id = '81100000-0000-4000-8000-000000000001';
update public.users set account_id = '82000000-0000-4000-8000-000000000002'
where id = '82100000-0000-4000-8000-000000000002';

insert into public.brand_kits (id, account_id, name, tone_of_voice) values
  ('81300000-0000-4000-8000-000000000001', '81000000-0000-4000-8000-000000000001', 'Tenant A Kit', 'Direct and factual'),
  ('82300000-0000-4000-8000-000000000002', '82000000-0000-4000-8000-000000000002', 'Tenant B Kit', 'Warm and concise');

select has_table('public', 'brand_kits', 'Brand Kit migration created the table');
select ok(
  (select relrowsecurity from pg_catalog.pg_class where oid = 'public.brand_kits'::regclass),
  'Brand Kits have row level security enabled'
);
select results_eq(
  $$ select policyname from pg_catalog.pg_policies where schemaname = 'public' and tablename = 'brand_kits' order by policyname $$,
  $$ values ('brand_kits_tenant_access'::name) $$,
  'Only the reviewed Brand Kit policy is active'
);
select ok(not has_table_privilege('anon', 'public.brand_kits', 'SELECT'), 'Anonymous users cannot read Brand Kits');

set local role authenticated;
select set_config('request.jwt.claim.sub', '81100000-0000-4000-8000-000000000001', true);

select results_eq(
  $$ select name from public.brand_kits order by name $$,
  $$ values ('Tenant A Kit'::text) $$,
  'Tenant A sees only its own Brand Kit'
);
select lives_ok(
  $$ insert into public.brand_kits (name, tone_of_voice) values ('Tenant A New Kit', 'Precise') $$,
  'Tenant A may create a Brand Kit in its own account'
);
select throws_ok(
  $$ insert into public.brand_kits (account_id, name, tone_of_voice) values ('82000000-0000-4000-8000-000000000002', 'Cross tenant insert', 'Forbidden') $$,
  '42501',
  'Tenant A cannot create a Brand Kit for Tenant B'
);
select results_eq(
  $$ update public.brand_kits set name = 'Tampered' where id = '82300000-0000-4000-8000-000000000002' returning id $$,
  $$ select null::uuid where false $$,
  'Tenant A cannot update Tenant B Brand Kits'
);
select results_eq(
  $$ delete from public.brand_kits where id = '82300000-0000-4000-8000-000000000002' returning id $$,
  $$ select null::uuid where false $$,
  'Tenant A cannot delete Tenant B Brand Kits'
);

reset role;
select * from finish();
rollback;
