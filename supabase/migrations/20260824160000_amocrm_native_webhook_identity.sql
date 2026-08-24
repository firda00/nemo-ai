-- Native amoCRM webhooks do not carry a documented request signature. Authenticate an inbound
-- webhook with a high-entropy secret embedded in its configured destination URL, but store only
-- the SHA-256 digest. The account subdomain in the form body is a second binding check, not an
-- authenticator by itself.

alter table public.crm_integrations
  add column if not exists inbound_webhook_secret_hash text;

alter table public.crm_integrations
  drop constraint if exists crm_integrations_webhook_secret_hash_shape;

alter table public.crm_integrations
  add constraint crm_integrations_webhook_secret_hash_shape
  check (
    inbound_webhook_secret_hash is null
    or inbound_webhook_secret_hash ~ '^[0-9a-f]{64}$'
  );

create unique index if not exists crm_integrations_webhook_secret_hash_unique
  on public.crm_integrations (inbound_webhook_secret_hash)
  where inbound_webhook_secret_hash is not null;

create or replace function public.resolve_amocrm_webhook(
  p_secret_hash text,
  p_account_domain text
)
returns table (
  account_id uuid,
  integration_id uuid,
  account_domain text
)
language sql
stable
security definer
set search_path = ''
as $$
  select integration.tenant_id, integration.id, integration.account_domain
  from public.crm_integrations as integration
  where integration.provider = 'AMOCRM'
    and integration.is_active
    and integration.inbound_webhook_secret_hash = p_secret_hash
    and integration.inbound_webhook_secret_hash ~ '^[0-9a-f]{64}$'
    and lower(
      regexp_replace(
        regexp_replace(
          regexp_replace(btrim(integration.account_domain), '^https?://', '', 'i'),
          '/.*$', ''
        ),
        '\.amocrm\.(ru|com)$', '', 'i'
      )
    ) = lower(btrim(p_account_domain))
  limit 1
$$;

revoke all on function public.resolve_amocrm_webhook(text, text) from public, anon, authenticated;
grant execute on function public.resolve_amocrm_webhook(text, text) to service_role;

comment on column public.crm_integrations.inbound_webhook_secret_hash is
  'SHA-256 of the per-integration secret embedded in the native amoCRM webhook destination URL.';
comment on function public.resolve_amocrm_webhook(text, text) is
  'Service-role-only fail-closed mapping of a native amoCRM webhook secret and body subdomain to a Nemo tenant.';
