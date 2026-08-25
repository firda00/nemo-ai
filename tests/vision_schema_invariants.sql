begin;

select plan(1);

insert into public.accounts (id, name) values
  ('51000000-0000-4000-8000-000000000001', 'vision-device-a'),
  ('51000000-0000-4000-8000-000000000002', 'vision-device-b');

do $$
declare
  v_ciphertext text := 'enc:v2:' || repeat('a', 80);
  v_row record;
  v_rejected boolean := false;
begin
  perform public.runtime_configure_vision_device_identity(
    '51000000-0000-4000-8000-000000000001',
    'test-camera-01',
    v_ciphertext
  );

  select * into strict v_row
  from public.runtime_resolve_vision_device_identity('test-camera-01');
  if v_row.account_id <> '51000000-0000-4000-8000-000000000001'::uuid
    or v_row.secret_encrypted <> v_ciphertext then
    raise exception 'vision identity resolver broke tenant/ciphertext binding';
  end if;

  begin
    perform public.runtime_configure_vision_device_identity(
      '51000000-0000-4000-8000-000000000002',
      'test-camera-01',
      v_ciphertext
    );
  exception when unique_violation then
    v_rejected := true;
  end;
  if not v_rejected then
    raise exception 'a device identity was moved across tenants';
  end if;

  v_rejected := false;
  begin
    perform public.runtime_configure_vision_device_identity(
      '51000000-0000-4000-8000-000000000001',
      'plaintext-camera',
      repeat('p', 80)
    );
  exception when sqlstate '22023' then
    v_rejected := true;
  end;
  if not v_rejected then raise exception 'plaintext vision secret was accepted'; end if;
end
$$;

do $$
begin
  if pg_catalog.has_schema_privilege('authenticated', 'runtime', 'USAGE')
    or pg_catalog.has_function_privilege(
      'authenticated', 'public.runtime_resolve_vision_device_identity(text)', 'EXECUTE'
    )
    or pg_catalog.has_function_privilege(
      'anon', 'public.runtime_configure_vision_device_identity(uuid,text,text)', 'EXECUTE'
    ) then
    raise exception 'application roles can access vision device secrets';
  end if;
  if not pg_catalog.has_function_privilege(
    'service_role', 'public.runtime_resolve_vision_device_identity(text)', 'EXECUTE'
  ) then
    raise exception 'service_role cannot resolve vision devices';
  end if;
end
$$;

select pass('vision device identities preserve ciphertext, tenant and service-role invariants');
select * from finish();

rollback;
