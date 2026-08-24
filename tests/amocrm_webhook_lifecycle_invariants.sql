-- Phase 3 Block 1 lifecycle checks. Run only on the disposable local database.
begin;

insert into public.accounts (id, name)
values ('40000000-0000-4000-8000-000000000004', 'amocrm-lifecycle-test');

select public.configure_amocrm_webhook_identity(
  '40000000-0000-4000-8000-000000000004', 'nemo-test', repeat('a', 64), null
);

do $$
declare
  v_count integer;
begin
  select count(*) into v_count
  from public.resolve_amocrm_webhook('nemo-test', repeat('a', 64));
  if v_count <> 1 then raise exception 'TEST_FAILURE [active identity did not resolve]'; end if;

  select count(*) into v_count
  from public.resolve_amocrm_webhook('other-company', repeat('a', 64));
  if v_count <> 0 then raise exception 'TEST_FAILURE [wrong subdomain resolved]'; end if;

  select count(*) into v_count
  from public.resolve_amocrm_webhook('nemo-test', repeat('f', 64));
  if v_count <> 0 then raise exception 'TEST_FAILURE [wrong secret resolved]'; end if;
  raise notice 'PASS [resolver uses generic empty result for either binding failure]';
end;
$$;

select public.configure_amocrm_webhook_identity(
  '40000000-0000-4000-8000-000000000004', 'nemo-test', repeat('b', 64), null
);

do $$
declare
  v_active integer;
  v_grace integer;
  v_hours numeric;
begin
  select count(*) filter (where status = 'active'), count(*) filter (where status = 'grace')
  into v_active, v_grace
  from runtime.amocrm_webhook_identities
  where account_id = '40000000-0000-4000-8000-000000000004' and subdomain = 'nemo-test';
  if v_active <> 1 or v_grace <> 1 then
    raise exception 'TEST_FAILURE [rotation did not preserve one active and one grace]';
  end if;

  select extract(epoch from (expires_at - clock_timestamp())) / 3600 into v_hours
  from runtime.amocrm_webhook_identities
  where secret_hash = repeat('a', 64);
  if v_hours < 23.99 or v_hours > 24.01 then
    raise exception 'TEST_FAILURE [grace is not 24 hours: %]', v_hours;
  end if;
  raise notice 'PASS [rotation creates exactly one active plus 24-hour grace]';
end;
$$;

do $$
declare
  v_identity uuid;
  v_count integer;
begin
  select id into v_identity from runtime.amocrm_webhook_identities where secret_hash = repeat('b', 64);
  perform public.revoke_amocrm_webhook_identity(
    '40000000-0000-4000-8000-000000000004', 'nemo-test', v_identity, null
  );
  select count(*) into v_count from public.resolve_amocrm_webhook('nemo-test', repeat('b', 64));
  if v_count <> 0 then raise exception 'TEST_FAILURE [revoked identity resolved]'; end if;
  raise notice 'PASS [revoked identity is rejected]';
end;
$$;

do $$
begin
  begin
    perform public.configure_amocrm_webhook_identity(
      '40000000-0000-4000-8000-000000000004', 'nemo-test', 'plaintext-secret', null
    );
    raise exception 'TEST_FAILURE [plaintext secret accepted]';
  exception when invalid_parameter_value then
    raise notice 'PASS [only a SHA-256 digest is accepted]';
  end;
end;
$$;

set local role authenticated;
do $$
begin
  begin
    perform public.resolve_amocrm_webhook('nemo-test', repeat('a', 64));
    raise exception 'TEST_FAILURE [authenticated executed resolver]';
  exception when insufficient_privilege then
    raise notice 'PASS [application role cannot execute lifecycle RPC]';
  end;
end;
$$;
reset role;

rollback;
