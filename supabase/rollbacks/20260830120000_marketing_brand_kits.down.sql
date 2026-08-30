-- STAGING ROLLBACK ONLY.
-- Reverts exactly the objects owned by 20260830120000_marketing_brand_kits.sql.
-- Review/export staging Brand Kits before running: dropping the table deletes them.
begin;

drop policy if exists brand_kits_tenant_access on public.brand_kits;
drop index if exists public.brand_kits_account_updated_idx;
drop table if exists public.brand_kits;

commit;
