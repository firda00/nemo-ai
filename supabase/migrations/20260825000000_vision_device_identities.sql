-- ADR 002 Stage 3: tenant-bound camera identities. The gateway receives only an encrypted HMAC
-- key and tables remain invisible to PostgREST/browser roles.

create table runtime.vision_device_identities (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.accounts(id) on delete restrict,
  device_id text not null,
  secret_encrypted text not null,
  status text not null default 'active',
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  revoked_at timestamptz,
  constraint vision_device_id_shape check (
    char_length(device_id) between 1 and 160
    and device_id ~ '^[A-Za-z0-9._:-]+$'
  ),
  constraint vision_device_secret_encrypted check (
    secret_encrypted like 'enc:v2:%' and char_length(secret_encrypted) between 64 and 4096
  ),
  constraint vision_device_status check (status in ('active', 'revoked')),
  constraint vision_device_revocation_consistency check (
    (status = 'active' and revoked_at is null)
    or (status = 'revoked' and revoked_at is not null)
  ),
  constraint vision_device_global_identity unique (device_id),
  constraint vision_device_account_identity unique (account_id, device_id)
);

revoke all on table runtime.vision_device_identities from public, anon, authenticated;

create function public.runtime_configure_vision_device_identity(
  p_account_id uuid,
  p_device_id text,
  p_secret_encrypted text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  if p_account_id is null
    or p_device_id is null
    or char_length(p_device_id) not between 1 and 160
    or p_device_id !~ '^[A-Za-z0-9._:-]+$'
    or p_secret_encrypted is null
    or p_secret_encrypted not like 'enc:v2:%'
    or char_length(p_secret_encrypted) not between 64 and 4096 then
    raise exception using errcode = '22023', message = 'invalid vision device identity';
  end if;

  insert into runtime.vision_device_identities (
    account_id, device_id, secret_encrypted, status, revoked_at
  ) values (
    p_account_id, p_device_id, p_secret_encrypted, 'active', null
  )
  on conflict (device_id) do update
    set secret_encrypted = excluded.secret_encrypted,
        status = 'active',
        revoked_at = null,
        updated_at = clock_timestamp()
    where runtime.vision_device_identities.account_id = excluded.account_id
  returning id into v_id;

  if v_id is null then
    raise exception using errcode = '23505', message = 'vision device identity conflict';
  end if;

  return jsonb_build_object('device_identity_id', v_id, 'status', 'active');
end
$$;

create function public.runtime_resolve_vision_device_identity(p_device_id text)
returns table (account_id uuid, device_id text, secret_encrypted text)
language sql
stable
security definer
set search_path = ''
as $$
  select identity.account_id, identity.device_id, identity.secret_encrypted
  from runtime.vision_device_identities as identity
  where identity.device_id = p_device_id
    and identity.status = 'active'
  limit 1
$$;

revoke all on function public.runtime_configure_vision_device_identity(uuid, text, text)
  from public, anon, authenticated;
revoke all on function public.runtime_resolve_vision_device_identity(text)
  from public, anon, authenticated;
grant execute on function public.runtime_configure_vision_device_identity(uuid, text, text)
  to service_role;
grant execute on function public.runtime_resolve_vision_device_identity(text)
  to service_role;

comment on table runtime.vision_device_identities is
  'ADR 002 camera identities. HMAC keys are AES-GCM ciphertext bound to account and device AAD.';
