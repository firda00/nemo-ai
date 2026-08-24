-- Phase 3 / Block 1: durable lifecycle for native amoCRM webhook identities.
-- Plaintext webhook secrets never enter PostgreSQL; only lowercase SHA-256 digests are stored.

create table runtime.amocrm_webhook_identities (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.accounts(id) on delete cascade,
  subdomain text not null,
  secret_hash text not null unique,
  status text not null default 'active'
    check (status in ('pending', 'active', 'grace', 'revoked')),
  valid_from timestamptz not null default clock_timestamp(),
  expires_at timestamptz,
  revoked_at timestamptz,
  rotated_from_id uuid references runtime.amocrm_webhook_identities(id) on delete restrict,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default clock_timestamp(),
  last_used_at timestamptz,
  constraint amocrm_webhook_identity_account_id_id_unique unique (account_id, id),
  constraint amocrm_webhook_identity_subdomain_shape check (
    subdomain = lower(subdomain)
    and subdomain ~ '^[a-z0-9](?:[a-z0-9-]{0,98}[a-z0-9])?$'
  ),
  constraint amocrm_webhook_identity_hash_shape check (secret_hash ~ '^[0-9a-f]{64}$'),
  constraint amocrm_webhook_identity_lifecycle check (
    (status = 'active' and expires_at is null and revoked_at is null)
    or (status = 'pending' and expires_at is not null and expires_at > valid_from and revoked_at is null)
    or (status = 'grace' and expires_at is not null and expires_at > valid_from and revoked_at is null)
    or (status = 'revoked' and revoked_at is not null)
  )
);

create unique index amocrm_webhook_identity_one_active
  on runtime.amocrm_webhook_identities (account_id, subdomain)
  where status = 'active';

create unique index amocrm_webhook_identity_one_grace
  on runtime.amocrm_webhook_identities (account_id, subdomain)
  where status = 'grace';

create index amocrm_webhook_identity_resolve
  on runtime.amocrm_webhook_identities (secret_hash, subdomain)
  where status in ('active', 'grace');

revoke all on runtime.amocrm_webhook_identities from public, anon, authenticated;

-- Migrate the single pre-Phase-3 identity before clearing the deprecated column. If historical
-- rows somehow share a hash, the old unique index has already prevented the ambiguity.
insert into runtime.amocrm_webhook_identities (
  account_id, subdomain, secret_hash, status, valid_from, created_at
)
select
  integration.tenant_id,
  lower(
    regexp_replace(
      regexp_replace(
        regexp_replace(btrim(integration.account_domain), '^https?://', '', 'i'),
        '/.*$', ''
      ),
      '\.amocrm\.(ru|com)$', '', 'i'
    )
  ),
  integration.inbound_webhook_secret_hash,
  'active',
  integration.updated_at,
  integration.updated_at
from public.crm_integrations as integration
where integration.provider = 'AMOCRM'
  and integration.is_active
  and integration.inbound_webhook_secret_hash ~ '^[0-9a-f]{64}$'
on conflict (secret_hash) do nothing;

update public.crm_integrations
set inbound_webhook_secret_hash = null
where inbound_webhook_secret_hash is not null;

comment on column public.crm_integrations.inbound_webhook_secret_hash is
  'DEPRECATED Phase 3 compatibility column. Always NULL; identities live in runtime.amocrm_webhook_identities.';

drop function if exists public.resolve_amocrm_webhook(text, text);

create function public.configure_amocrm_webhook_identity(
  p_account_id uuid,
  p_subdomain text,
  p_secret_hash text,
  p_created_by uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_subdomain text;
  v_previous_id uuid;
  v_identity_id uuid;
  v_grace_until timestamptz;
begin
  v_subdomain := lower(btrim(coalesce(p_subdomain, '')));
  if p_account_id is null
    or v_subdomain !~ '^[a-z0-9](?:[a-z0-9-]{0,98}[a-z0-9])?$'
    or p_secret_hash !~ '^[0-9a-f]{64}$' then
    raise exception using errcode = '22023', message = 'invalid amoCRM webhook identity';
  end if;
  if not exists (select 1 from public.accounts as account where account.id = p_account_id) then
    raise exception using errcode = '23503', message = 'unknown account';
  end if;
  if p_created_by is not null and not exists (
    select 1 from public.users as actor
    where actor.id = p_created_by and actor.account_id = p_account_id
  ) then
    raise exception using errcode = '42501', message = 'identity actor is outside account';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_account_id::text || ':' || v_subdomain, 0)
  );

  -- At most one old grace identity is retained. A second rotation revokes it immediately so the
  -- partial unique index remains an invariant rather than a best-effort convention.
  update runtime.amocrm_webhook_identities as identity
  set status = 'revoked', revoked_at = clock_timestamp(), expires_at = clock_timestamp()
  where identity.account_id = p_account_id
    and identity.subdomain = v_subdomain
    and identity.status = 'grace';

  select identity.id into v_previous_id
  from runtime.amocrm_webhook_identities as identity
  where identity.account_id = p_account_id
    and identity.subdomain = v_subdomain
    and identity.status = 'active'
  for update;

  if v_previous_id is not null then
    v_grace_until := clock_timestamp() + interval '24 hours';
    update runtime.amocrm_webhook_identities as identity
    set status = 'grace', expires_at = v_grace_until
    where identity.account_id = p_account_id and identity.id = v_previous_id;
  end if;

  insert into runtime.amocrm_webhook_identities (
    account_id, subdomain, secret_hash, status, rotated_from_id, created_by
  ) values (
    p_account_id, v_subdomain, p_secret_hash, 'active', v_previous_id, p_created_by
  )
  returning id into v_identity_id;

  return pg_catalog.jsonb_build_object(
    'identity_id', v_identity_id,
    'subdomain', v_subdomain,
    'status', 'active',
    'previous_valid_until', v_grace_until
  );
end
$$;

create function public.revoke_amocrm_webhook_identity(
  p_account_id uuid,
  p_subdomain text,
  p_identity_id uuid,
  p_revoked_by uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_subdomain text := lower(btrim(coalesce(p_subdomain, '')));
  v_changed integer;
begin
  if p_account_id is null or p_identity_id is null
    or v_subdomain !~ '^[a-z0-9](?:[a-z0-9-]{0,98}[a-z0-9])?$' then
    raise exception using errcode = '22023', message = 'invalid amoCRM webhook identity';
  end if;
  if p_revoked_by is not null and not exists (
    select 1 from public.users as actor
    where actor.id = p_revoked_by and actor.account_id = p_account_id
  ) then
    raise exception using errcode = '42501', message = 'identity actor is outside account';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_account_id::text || ':' || v_subdomain, 0)
  );

  update runtime.amocrm_webhook_identities as identity
  set status = 'revoked', revoked_at = clock_timestamp(), expires_at = clock_timestamp()
  where identity.account_id = p_account_id
    and identity.subdomain = v_subdomain
    and identity.id = p_identity_id
    and identity.status <> 'revoked';
  get diagnostics v_changed = row_count;

  return pg_catalog.jsonb_build_object('revoked', v_changed = 1, 'identity_id', p_identity_id);
end
$$;

create function public.resolve_amocrm_webhook(
  p_subdomain text,
  p_secret_hash text
)
returns table (
  account_id uuid,
  identity_id uuid,
  subdomain text
)
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- Unknown hash and wrong subdomain deliberately share the same empty result contract. The gateway
  -- reflects only one generic 401 response and never reveals which half of the binding failed.
  return query
  update runtime.amocrm_webhook_identities as identity
  set last_used_at = clock_timestamp()
  where identity.secret_hash = p_secret_hash
    and identity.subdomain = lower(btrim(coalesce(p_subdomain, '')))
    and (
      identity.status = 'active'
      or (identity.status = 'grace' and identity.expires_at > clock_timestamp())
    )
    and identity.valid_from <= clock_timestamp()
  returning identity.account_id, identity.id, identity.subdomain;
end
$$;

create function public.get_amocrm_webhook_identity_status(
  p_account_id uuid,
  p_subdomain text
)
returns table (
  identity_id uuid,
  status text,
  valid_from timestamptz,
  expires_at timestamptz,
  created_at timestamptz,
  last_used_at timestamptz
)
language sql
stable
security definer
set search_path = ''
as $$
  select identity.id, identity.status, identity.valid_from, identity.expires_at,
         identity.created_at, identity.last_used_at
  from runtime.amocrm_webhook_identities as identity
  where identity.account_id = p_account_id
    and identity.subdomain = lower(btrim(coalesce(p_subdomain, '')))
  order by identity.created_at desc, identity.id
$$;

revoke all on function public.configure_amocrm_webhook_identity(uuid, text, text, uuid)
  from public, anon, authenticated;
revoke all on function public.revoke_amocrm_webhook_identity(uuid, text, uuid, uuid)
  from public, anon, authenticated;
revoke all on function public.resolve_amocrm_webhook(text, text)
  from public, anon, authenticated;
revoke all on function public.get_amocrm_webhook_identity_status(uuid, text)
  from public, anon, authenticated;

grant execute on function public.configure_amocrm_webhook_identity(uuid, text, text, uuid) to service_role;
grant execute on function public.revoke_amocrm_webhook_identity(uuid, text, uuid, uuid) to service_role;
grant execute on function public.resolve_amocrm_webhook(text, text) to service_role;
grant execute on function public.get_amocrm_webhook_identity_status(uuid, text) to service_role;

comment on table runtime.amocrm_webhook_identities is
  'Hashed native amoCRM webhook identities with one active and one bounded grace key per tenant/subdomain.';
