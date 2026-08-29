-- Marketing Engine 2.0: tenant-scoped brand identity used by structured campaign generation.
create table if not exists public.brand_kits (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null default public.current_account_id()
    references public.accounts(id) on delete cascade,
  name text not null,
  colors text[] not null default array['#8B7CF8'::text, '#22D3EE'::text],
  fonts jsonb not null default '{"heading":"Inter","body":"Inter"}'::jsonb,
  tone_of_voice text not null,
  stop_words text[] not null default '{}',
  visual_preset text not null default 'minimal_tech_ui',
  custom_visual_rules text not null default '',
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  constraint brand_kits_account_id_id_key unique (account_id, id),
  constraint brand_kits_account_name_key unique (account_id, name),
  constraint brand_kits_name_check check (char_length(btrim(name)) between 1 and 120),
  constraint brand_kits_colors_count_check check (cardinality(colors) between 1 and 8),
  constraint brand_kits_colors_format_check check (
    array_position(colors, null) is null
    and array_to_string(colors, ',') ~ '^#[0-9A-Fa-f]{6}(,#[0-9A-Fa-f]{6})*$'
  ),
  constraint brand_kits_fonts_check check (
    jsonb_typeof(fonts) = 'object'
    and char_length(btrim(coalesce(fonts->>'heading', ''))) between 1 and 120
    and char_length(btrim(coalesce(fonts->>'body', ''))) between 1 and 120
  ),
  constraint brand_kits_tone_check check (char_length(btrim(tone_of_voice)) between 1 and 1200),
  constraint brand_kits_stop_words_check check (
    cardinality(stop_words) <= 100 and array_position(stop_words, null) is null
  ),
  constraint brand_kits_visual_preset_check check (visual_preset in (
    'editorial_photo_35mm',
    'minimal_tech_ui',
    '3d_modern_clay_isometric',
    'flat_vector_infographic'
  )),
  constraint brand_kits_custom_visual_rules_check check (char_length(custom_visual_rules) <= 2000)
);

create index if not exists brand_kits_account_updated_idx
  on public.brand_kits (account_id, updated_at desc);

alter table public.brand_kits enable row level security;

revoke all on table public.brand_kits from public, anon;
grant select, insert, update, delete on table public.brand_kits to authenticated;
grant all on table public.brand_kits to service_role;

drop policy if exists brand_kits_tenant_access on public.brand_kits;
create policy brand_kits_tenant_access
  on public.brand_kits for all to authenticated
  using (account_id = public.current_account_id())
  with check (account_id = public.current_account_id());

comment on table public.brand_kits is
  'Tenant-scoped text and visual identity injected into Marketing Engine campaign generation.';
