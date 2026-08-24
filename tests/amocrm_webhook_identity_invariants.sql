-- Native amoCRM webhook identity checks. Run against the disposable local database only.
begin;

insert into public.accounts (id, name)
values ('30000000-0000-4000-8000-000000000003', 'amocrm-native-test');

insert into public.crm_integrations (
  id, tenant_id, provider, account_domain, credentials_encrypted,
  inbound_webhook_secret_hash
) values (
  '31000000-0000-4000-8000-000000000003',
  '30000000-0000-4000-8000-000000000003',
  'AMOCRM',
  'https://nemo-test.amocrm.ru/',
  '{"ciphertext":"test-only"}'::jsonb,
  repeat('a', 64)
);

do $$
declare
  v_count integer;
  v_account uuid;
begin
  select count(*), min(account_id::text)::uuid
  into v_count, v_account
  from public.resolve_amocrm_webhook(repeat('a', 64), 'nemo-test');

  if v_count <> 1 or v_account <> '30000000-0000-4000-8000-000000000003'::uuid then
    raise exception 'TEST_FAILURE [valid secret and normalized subdomain did not resolve]';
  end if;
  raise notice 'PASS [valid secret and normalized subdomain resolve exactly one tenant]';

  select count(*) into v_count
  from public.resolve_amocrm_webhook(repeat('b', 64), 'nemo-test');
  if v_count <> 0 then raise exception 'TEST_FAILURE [wrong secret resolved]'; end if;
  raise notice 'PASS [wrong secret is rejected]';

  select count(*) into v_count
  from public.resolve_amocrm_webhook(repeat('a', 64), 'other-tenant');
  if v_count <> 0 then raise exception 'TEST_FAILURE [wrong subdomain resolved]'; end if;
  raise notice 'PASS [secret cannot be replayed against another subdomain]';
end;
$$;

do $$
begin
  begin
    insert into public.crm_integrations (
      tenant_id, provider, account_domain, credentials_encrypted, inbound_webhook_secret_hash
    ) values (
      '30000000-0000-4000-8000-000000000003', 'HUBSPOT', 'portal-1', '{}'::jsonb, 'plaintext-secret'
    );
    raise exception 'TEST_FAILURE [malformed secret hash was accepted]';
  exception
    when check_violation then
      raise notice 'PASS [malformed secret hash rejected by CHECK]';
  end;
end;
$$;

set local role authenticated;
do $$
begin
  begin
    perform * from public.resolve_amocrm_webhook(repeat('a', 64), 'nemo-test');
    raise exception 'TEST_FAILURE [authenticated role executed resolver]';
  exception
    when insufficient_privilege then
      raise notice 'PASS [authenticated role cannot execute resolver]';
  end;
end;
$$;
reset role;

rollback;
