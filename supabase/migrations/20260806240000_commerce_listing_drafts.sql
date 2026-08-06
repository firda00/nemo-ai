-- Listing Agent: a product the owner describes, turned into a draft that already knows what it
-- costs to sell.
--
-- THERE IS NO PUBLISHED STATUS, AND THERE MUST NOT BE ONE. The Uzum integration is read-only;
-- Nemo cannot create a listing in the seller's cabinet and will not pretend it did. 'ready' means
-- the owner approved the text and can paste it in themselves. A status the platform cannot
-- honestly set is a status that eventually lies to whoever reads the row.
create table if not exists public.commerce_listing_drafts (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.accounts(id) on delete cascade,
  -- Which catalogue's economics the draft was priced against. Commission comes from categories
  -- this catalogue already sells in, so the numbers are only meaningful next to it.
  catalog_id uuid references public.commerce_catalogs(id) on delete set null,
  source_text text not null check (char_length(source_text) between 1 and 4000),

  title_ru text check (char_length(title_ru) <= 100),
  title_uz text check (char_length(title_uz) <= 100),
  description_ru text check (char_length(description_ru) <= 800),
  description_uz text check (char_length(description_uz) <= 800),
  -- [{name, value}] the owner actually stated, and the names of the ones they did not.
  attributes jsonb not null default '[]'::jsonb check (jsonb_typeof(attributes) = 'array'),
  unknown_attributes jsonb not null default '[]'::jsonb check (jsonb_typeof(unknown_attributes) = 'array'),

  uzum_category text check (char_length(uzum_category) <= 160),
  commission_percent numeric(7,4) check (commission_percent between 0 and 100),
  returns_reserve_percent numeric(7,4) check (returns_reserve_percent between 0 and 100),
  length_mm integer check (length_mm > 0),
  width_mm integer check (width_mm > 0),
  height_mm integer check (height_mm > 0),
  weight_g integer check (weight_g > 0),
  fulfillment_tiyin bigint check (fulfillment_tiyin >= 0),
  unit_cost_tiyin bigint check (unit_cost_tiyin >= 0),
  min_margin_percent numeric(7,4) check (min_margin_percent between 0 and 99.9999),
  min_selling_price_tiyin bigint check (min_selling_price_tiyin >= 0),
  -- What the owner still has to supply. Empty means the draft is fully grounded.
  missing jsonb not null default '[]'::jsonb check (jsonb_typeof(missing) = 'array'),
  -- The exact substrings every extracted number came from, so the owner can check the parse.
  evidence jsonb not null default '[]'::jsonb check (jsonb_typeof(evidence) = 'array'),

  status text not null default 'draft' check (status in ('draft', 'ready', 'discarded')),
  created_by uuid references auth.users(id) on delete set null,
  approved_by uuid references auth.users(id) on delete set null,
  approved_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- A draft may only be marked ready by someone, at some time, together.
  check ((status = 'ready') = (approved_at is not null))
);

create index if not exists commerce_listing_drafts_account_idx
  on public.commerce_listing_drafts(account_id, status, created_at desc);

alter table public.commerce_listing_drafts enable row level security;
revoke all on public.commerce_listing_drafts from public, anon, authenticated;
grant select on public.commerce_listing_drafts to authenticated;

-- Read-only to the tenant, like every other commerce table: writes go through commerce-control,
-- which checks the owner role. Cross-tenant reads return zero rows rather than an error.
create policy commerce_listing_drafts_account_read on public.commerce_listing_drafts for select to authenticated
  using (account_id = public.current_account_id());
