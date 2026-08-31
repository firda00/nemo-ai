# Staging migration manifest — Marketing and Finance

This manifest is the release checklist for the first staging deployment of the
Marketing Engine and Finance/Cash Flow backend. It must be executed against a
local Supabase stack before any staging project is linked.

## Scope

| Layer | Artifact | Database change | Rollback |
| --- | --- | --- | --- |
| Marketing Brand Kit | `supabase/migrations/20260830120000_marketing_brand_kits.sql` | Creates tenant-scoped `public.brand_kits`, its index, grants, constraints and RLS policy | `supabase/rollbacks/20260830120000_marketing_brand_kits.down.sql` |
| Finance Cash Flow | `_shared/financeCashFlow.ts`, `_shared/financeIngestion.ts`, `_shared/financeAnalyzer.ts` | None. This sprint is request/response contracts and an authenticated Edge Function; it does not create `accounting_documents` or transaction tables. | Deploy the previous function bundle; no SQL rollback is required. |
| HR order drafts | `_shared/hrOrderGenerator.ts` | None. Drafts remain review-gated service contracts and are not persisted by this sprint. | Deploy the previous function bundle. |

Do not add a destructive rollback for tables that are not owned by these
artifacts. In particular, this repository currently has no migration creating
`accounting_documents`.

## Local pre-flight

Prerequisites: Docker Desktop/Engine is running and no production Supabase
project is linked for the command being executed.

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\staging-migration-preflight.ps1
```

The script only runs local commands. It performs a clean `supabase db reset --local`,
executes pgTAP tenant-isolation tests, rehearses the down-migration, restores the
local schema, and runs the deterministic
Marketing/Finance/Research contract suites. A missing Docker daemon fails
closed before any database command.

Expected checks:

1. All migrations apply from zero without dependency errors.
2. `public.brand_kits` has RLS enabled and its tenant policy uses
   `public.current_account_id()` for both read and write paths.
3. Tenant A cannot read, create, update, or delete Tenant B's Brand Kits.
4. Finance and Research requests reject a `workspace_id` different from the
   authenticated account before an LLM call.
5. Authenticated Edge Functions remain in
   `supabase/functions/deployment-manifest.json` and have `verify_jwt = true`.

## Staging apply

1. Create or select a dedicated staging/preview Supabase project.
2. Configure `STAGING_SUPABASE_URL`, `STAGING_SUPABASE_ANON_KEY` and
   `STAGING_SUPABASE_SERVICE_ROLE_KEY` in the staging deployment environment.
   Never print their values; inspect only presence through the repository's
   safe tooling.
3. Link only the staging project:

   ```powershell
   npx supabase link --project-ref <staging-project-ref>
   npx supabase db push --dry-run
   npx supabase db push
   ```

4. Deploy authenticated functions without `--no-verify-jwt`:

   ```powershell
   npx supabase functions deploy generate-campaign
   npx supabase functions deploy finance-analyze-cashflow
   npx supabase functions deploy research-analyze-multimodal
   ```

5. Run staging auth/RLS smoke tests with two disposable tenant accounts.
6. Record migration versions, function bundle hashes, test output and operator
   identity in the staging release ticket.

## Rollback

If the Brand Kit migration fails before application traffic is enabled, run the
reviewed down script against staging only:

```powershell
npx supabase db query --linked --file .\supabase\rollbacks\20260830120000_marketing_brand_kits.down.sql
```

The down script intentionally drops only `public.brand_kits` objects. Export or
confirm that no staging Brand Kits must be retained before running it. For Edge
Functions, redeploy the previously recorded bundle; do not disable JWT checks
as a rollback shortcut.

## Production gate

Production remains out of scope until local reset, staging migration, tenant
isolation, authenticated endpoint smoke tests, and an explicit human approval
all pass. This manifest does not authorize a production migration.
