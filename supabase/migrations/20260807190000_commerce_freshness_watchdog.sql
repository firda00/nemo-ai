-- A watchdog that lives inside the thing it watches is not a watchdog.
--
-- Every commerce finding is produced by the sync. If the Uzum key expires or the API changes shape,
-- no new finding appears — and the digest, which sends only findings it has not sent today, finds
-- nothing to send and stays quiet. The seller does not get an empty report that looks wrong; they
-- get no report at all, which looks exactly like a calm week. A silent failure that presents as
-- good news is the worst shape a failure can take, and it is the one shape this system had.
--
-- So freshness is read at delivery time, from the delivery path, which runs whether or not the
-- sync does.
alter table public.commerce_catalogs
  add column if not exists stale_alerted_at timestamptz;

comment on column public.commerce_catalogs.stale_alerted_at is
  'When the owner was told this catalogue stopped updating. Cleared the moment data returns, so a '
  'second outage alerts again while one continuous outage alerts once.';

-- max(observed_at) rather than last_synced_at. The two disagree in exactly the case that matters:
-- a sync that reaches Uzum, is answered with an empty list, and completes having written nothing
-- stamps last_synced_at and looks healthy forever. Snapshots are the data; a sync run is only an
-- attempt to fetch it.
create index if not exists commerce_inventory_snapshots_sku_observed_idx
  on public.commerce_inventory_snapshots(sku_id, observed_at desc);

-- One round trip for every pilot catalogue. Deliberately not security definer: under the service
-- role this sees everything the digest needs, and under a signed-in owner the underlying RLS
-- scopes it to their own catalogues without this function having to re-implement that check.
create or replace function public.commerce_catalog_freshness(p_account_ids uuid[])
returns table (
  catalog_id uuid,
  owner_account_id uuid,
  catalog_name text,
  connected_at timestamptz,
  last_synced_at timestamptz,
  last_observed_at timestamptz,
  last_sync_error text,
  stale_alerted_at timestamptz
)
language sql
stable
set search_path = ''
as $$
  select
    c.id,
    c.account_id,
    c.name,
    c.created_at,
    c.last_synced_at,
    (select max(s.observed_at)
       from public.commerce_inventory_snapshots s
       join public.commerce_skus k on k.id = s.sku_id
      where k.catalog_id = c.id),
    c.last_sync_error,
    c.stale_alerted_at
  from public.commerce_catalogs c
  where c.account_id = any(p_account_ids)
    and c.status = 'active'
  order by c.created_at, c.id
$$;

comment on function public.commerce_catalog_freshness(uuid[]) is
  'Per-catalogue freshness for the silence watchdog: when data last actually arrived, not when a '
  'sync last claimed to run.';
