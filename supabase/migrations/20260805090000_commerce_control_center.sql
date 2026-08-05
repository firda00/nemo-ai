-- Uzum Ecommerce Control Center V1. Marketplace facts are append-only snapshots;
-- owner-maintained unit economics never come from the marketplace connector.
create table if not exists public.commerce_pilots (
  account_id uuid primary key references public.accounts(id) on delete cascade,
  status text not null default 'active' check (status in ('active', 'read_only', 'ended')),
  started_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '14 days'),
  read_only_at timestamptz,
  created_at timestamptz not null default now(),
  check (expires_at > started_at)
);

create table if not exists public.commerce_catalogs (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.accounts(id) on delete cascade,
  source text not null check (source in ('uzum')),
  external_shop_id text not null check (external_shop_id ~ '^[0-9]{1,18}$'),
  name text not null check (char_length(name) between 1 and 120),
  timezone text not null default 'Asia/Tashkent' check (timezone = 'Asia/Tashkent'),
  status text not null default 'active' check (status in ('active', 'paused', 'no_access', 'error')),
  last_synced_at timestamptz,
  last_sync_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (account_id, source, external_shop_id)
);

create table if not exists public.commerce_skus (
  id uuid primary key default gen_random_uuid(),
  catalog_id uuid not null references public.commerce_catalogs(id) on delete cascade,
  external_sku text not null check (char_length(external_sku) between 1 and 60),
  external_product_id text,
  title text not null check (char_length(title) between 1 and 160),
  unit_cost_tiyin bigint check (unit_cost_tiyin >= 0),
  commission_percent numeric(7,4) check (commission_percent between 0 and 100),
  fulfillment_tiyin bigint check (fulfillment_tiyin >= 0),
  returns_reserve_percent numeric(7,4) check (returns_reserve_percent between 0 and 100),
  lead_time_days integer check (lead_time_days between 0 and 365),
  moq integer check (moq between 1 and 10000000),
  safety_stock integer check (safety_stock >= 0),
  min_margin_percent numeric(7,4) check (min_margin_percent between 0 and 99.9999),
  economics_revision bigint not null default 1 check (economics_revision > 0),
  economics_updated_at timestamptz,
  economics_updated_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (catalog_id, external_sku)
);

create table if not exists public.commerce_import_batches (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.accounts(id) on delete cascade,
  catalog_id uuid not null references public.commerce_catalogs(id) on delete cascade,
  created_by uuid not null references auth.users(id) on delete restrict,
  file_name text not null check (char_length(file_name) between 1 and 180),
  file_sha256 text not null check (file_sha256 ~ '^[a-f0-9]{64}$'),
  status text not null default 'staged' check (status in ('staged', 'confirmed', 'rejected', 'failed')),
  total_rows integer not null default 0 check (total_rows >= 0),
  valid_rows integer not null default 0 check (valid_rows >= 0),
  unmatched_rows integer not null default 0 check (unmatched_rows >= 0),
  error_rows integer not null default 0 check (error_rows >= 0),
  confirmed_at timestamptz,
  confirmed_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  check (valid_rows + error_rows <= total_rows),
  unique (account_id, catalog_id, file_sha256)
);

create table if not exists public.commerce_import_rows (
  id uuid primary key default gen_random_uuid(),
  batch_id uuid not null references public.commerce_import_batches(id) on delete cascade,
  row_number integer not null check (row_number > 0),
  raw jsonb not null default '{}'::jsonb check (jsonb_typeof(raw) = 'object'),
  external_sku text,
  matched_sku_id uuid references public.commerce_skus(id) on delete set null,
  match_status text not null check (match_status in ('matched', 'unmatched', 'invalid', 'confirmed')),
  errors jsonb not null default '[]'::jsonb check (jsonb_typeof(errors) = 'array'),
  unit_cost_tiyin bigint check (unit_cost_tiyin >= 0),
  commission_percent numeric(7,4) check (commission_percent between 0 and 100),
  fulfillment_tiyin bigint check (fulfillment_tiyin >= 0),
  returns_reserve_percent numeric(7,4) check (returns_reserve_percent between 0 and 100),
  lead_time_days integer check (lead_time_days between 0 and 365),
  moq integer check (moq between 1 and 10000000),
  safety_stock integer check (safety_stock >= 0),
  min_margin_percent numeric(7,4) check (min_margin_percent between 0 and 99.9999),
  created_at timestamptz not null default now(),
  unique (batch_id, row_number)
);

create table if not exists public.commerce_sync_runs (
  id uuid primary key default gen_random_uuid(),
  catalog_id uuid not null references public.commerce_catalogs(id) on delete cascade,
  scheduled_for timestamptz not null,
  status text not null default 'queued' check (status in ('queued', 'running', 'completed', 'failed', 'skipped')),
  claim_token uuid,
  claimed_at timestamptz,
  completed_at timestamptz,
  error text,
  created_at timestamptz not null default now(),
  unique (catalog_id, scheduled_for)
);

create table if not exists public.commerce_inventory_snapshots (
  id uuid primary key default gen_random_uuid(),
  sku_id uuid not null references public.commerce_skus(id) on delete cascade,
  sync_run_id uuid not null references public.commerce_sync_runs(id) on delete restrict,
  observed_slot timestamptz not null,
  observed_at timestamptz not null default now(),
  price_tiyin bigint check (price_tiyin >= 0),
  stock_total integer check (stock_total >= 0),
  stock_fbo integer check (stock_fbo >= 0),
  stock_fbs integer check (stock_fbs >= 0),
  sold_units_7d integer check (sold_units_7d >= 0),
  source jsonb not null default '{}'::jsonb check (jsonb_typeof(source) = 'object'),
  created_at timestamptz not null default now(),
  unique (sku_id, observed_slot)
);

create table if not exists public.commerce_recommendations (
  id uuid primary key default gen_random_uuid(),
  sku_id uuid not null references public.commerce_skus(id) on delete cascade,
  snapshot_id uuid not null references public.commerce_inventory_snapshots(id) on delete restrict,
  kind text not null check (kind in ('reorder', 'price_guard', 'missing_data')),
  severity text not null check (severity in ('info', 'warning', 'critical')),
  status text not null default 'open' check (status in ('open', 'dismissed', 'accepted', 'expired')),
  dedupe_key text not null unique check (char_length(dedupe_key) between 1 and 180),
  economics_revision bigint not null,
  calculation jsonb not null check (jsonb_typeof(calculation) = 'object'),
  suggested_action jsonb not null default '{}'::jsonb check (jsonb_typeof(suggested_action) = 'object'),
  approval_request_id uuid references public.approval_requests(id) on delete set null,
  first_detected_at timestamptz not null default now(),
  last_detected_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists commerce_catalogs_account_idx on public.commerce_catalogs(account_id, status);
create index if not exists commerce_skus_catalog_idx on public.commerce_skus(catalog_id);
create index if not exists commerce_import_batches_catalog_idx on public.commerce_import_batches(catalog_id, created_at desc);
create index if not exists commerce_import_rows_batch_status_idx on public.commerce_import_rows(batch_id, match_status);
create index if not exists commerce_sync_runs_due_idx on public.commerce_sync_runs(status, scheduled_for);
create index if not exists commerce_inventory_snapshots_sku_slot_idx on public.commerce_inventory_snapshots(sku_id, observed_slot desc);
create index if not exists commerce_recommendations_sku_status_idx on public.commerce_recommendations(sku_id, status, severity);

create or replace function public.commerce_touch_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end
$$;

drop trigger if exists commerce_catalogs_touch on public.commerce_catalogs;
create trigger commerce_catalogs_touch before update on public.commerce_catalogs
for each row execute function public.commerce_touch_updated_at();
drop trigger if exists commerce_skus_touch on public.commerce_skus;
create trigger commerce_skus_touch before update on public.commerce_skus
for each row execute function public.commerce_touch_updated_at();
drop trigger if exists commerce_recommendations_touch on public.commerce_recommendations;
create trigger commerce_recommendations_touch before update on public.commerce_recommendations
for each row execute function public.commerce_touch_updated_at();

alter table public.commerce_pilots enable row level security;
alter table public.commerce_catalogs enable row level security;
alter table public.commerce_skus enable row level security;
alter table public.commerce_import_batches enable row level security;
alter table public.commerce_import_rows enable row level security;
alter table public.commerce_sync_runs enable row level security;
alter table public.commerce_inventory_snapshots enable row level security;
alter table public.commerce_recommendations enable row level security;

revoke all on public.commerce_pilots, public.commerce_catalogs, public.commerce_skus,
  public.commerce_import_batches, public.commerce_import_rows, public.commerce_sync_runs,
  public.commerce_inventory_snapshots, public.commerce_recommendations from public, anon, authenticated;
grant select on public.commerce_pilots, public.commerce_catalogs, public.commerce_skus,
  public.commerce_import_batches, public.commerce_import_rows, public.commerce_inventory_snapshots,
  public.commerce_recommendations to authenticated;

create policy commerce_pilots_account_read on public.commerce_pilots for select to authenticated
  using (account_id = public.current_account_id());
create policy commerce_catalogs_account_read on public.commerce_catalogs for select to authenticated
  using (account_id = public.current_account_id());
create policy commerce_skus_account_read on public.commerce_skus for select to authenticated
  using (exists (select 1 from public.commerce_catalogs c where c.id = catalog_id and c.account_id = public.current_account_id()));
create policy commerce_import_batches_account_read on public.commerce_import_batches for select to authenticated
  using (account_id = public.current_account_id());
create policy commerce_import_rows_account_read on public.commerce_import_rows for select to authenticated
  using (exists (select 1 from public.commerce_import_batches b where b.id = batch_id and b.account_id = public.current_account_id()));
create policy commerce_inventory_snapshots_account_read on public.commerce_inventory_snapshots for select to authenticated
  using (exists (
    select 1 from public.commerce_skus s join public.commerce_catalogs c on c.id = s.catalog_id
    where s.id = sku_id and c.account_id = public.current_account_id()
  ));
create policy commerce_recommendations_account_read on public.commerce_recommendations for select to authenticated
  using (exists (
    select 1 from public.commerce_skus s join public.commerce_catalogs c on c.id = s.catalog_id
    where s.id = sku_id and c.account_id = public.current_account_id()
  ));

create or replace function public.confirm_commerce_import(p_batch_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_batch public.commerce_import_batches;
  v_user_id uuid := auth.uid();
  v_row public.commerce_import_rows;
  v_applied integer := 0;
begin
  select * into v_batch from public.commerce_import_batches where id = p_batch_id for update;
  if not found then raise exception using errcode = 'P0002', message = 'commerce import not found'; end if;
  if not exists (
    select 1 from public.users u
    where u.id = v_user_id and u.account_id = v_batch.account_id and u.role = 'owner'
  ) then
    raise exception using errcode = '42501', message = 'owner required';
  end if;
  if v_batch.status <> 'staged' then
    raise exception using errcode = '23514', message = 'commerce import is not staged';
  end if;

  for v_row in
    select * from public.commerce_import_rows
    where batch_id = v_batch.id and match_status in ('matched', 'confirmed') and jsonb_array_length(errors) = 0
    order by row_number
  loop
    if not exists (select 1 from public.commerce_skus s where s.id = v_row.matched_sku_id and s.catalog_id = v_batch.catalog_id) then
      raise exception using errcode = '42501', message = 'import row references a foreign SKU';
    end if;
    update public.commerce_skus s set
      unit_cost_tiyin = coalesce(v_row.unit_cost_tiyin, s.unit_cost_tiyin),
      commission_percent = coalesce(v_row.commission_percent, s.commission_percent),
      fulfillment_tiyin = coalesce(v_row.fulfillment_tiyin, s.fulfillment_tiyin),
      returns_reserve_percent = coalesce(v_row.returns_reserve_percent, s.returns_reserve_percent),
      lead_time_days = coalesce(v_row.lead_time_days, s.lead_time_days),
      moq = coalesce(v_row.moq, s.moq),
      safety_stock = coalesce(v_row.safety_stock, s.safety_stock),
      min_margin_percent = coalesce(v_row.min_margin_percent, s.min_margin_percent),
      economics_revision = s.economics_revision + 1,
      economics_updated_at = now(),
      economics_updated_by = v_user_id
    where s.id = v_row.matched_sku_id;
    update public.commerce_import_rows set match_status = 'confirmed' where id = v_row.id;
    v_applied := v_applied + 1;
  end loop;

  update public.commerce_import_batches
  set status = 'confirmed', confirmed_at = now(), confirmed_by = v_user_id
  where id = v_batch.id;
  return jsonb_build_object('batch_id', v_batch.id, 'applied_rows', v_applied);
end
$$;

revoke all on function public.confirm_commerce_import(uuid) from public, anon;
grant execute on function public.confirm_commerce_import(uuid) to authenticated;

create or replace function public.claim_commerce_sync_runs(p_limit integer default 20)
returns setof public.commerce_sync_runs
language plpgsql
security definer
set search_path = ''
as $$
begin
  return query
  with due as (
    select r.id
    from public.commerce_sync_runs r
    join public.commerce_catalogs c on c.id = r.catalog_id
    join public.commerce_pilots p on p.account_id = c.account_id
    where r.scheduled_for <= now()
      and p.status = 'active'
      and p.expires_at > now()
      and c.status = 'active'
      and (r.status = 'queued' or (r.status = 'running' and r.claimed_at < now() - interval '10 minutes'))
    order by r.scheduled_for
    limit least(greatest(p_limit, 1), 50)
    for update of r skip locked
  )
  update public.commerce_sync_runs r
  set status = 'running', claim_token = gen_random_uuid(), claimed_at = now(), error = null
  from due
  where r.id = due.id
  returning r.*;
end
$$;

revoke all on function public.claim_commerce_sync_runs(integer) from public, anon, authenticated;
grant execute on function public.claim_commerce_sync_runs(integer) to service_role;
