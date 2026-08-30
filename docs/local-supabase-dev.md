# Local Supabase development

Production project `ogfmyjiuqmgroobckdyw` is intentionally out of scope for development migrations.

## Prerequisite

Install and start Docker Desktop with the Linux engine. Verify it before Supabase:

```powershell
docker desktop start
docker info
```

If `docker info` cannot connect to `dockerDesktopLinuxEngine`, open Docker Desktop once, complete its
WSL 2 setup/restart prompt, and wait until the engine reports **Running**.

## Start and migrate

From `C:\Users\firda\nemo-ai`:

```powershell
npx supabase start
npx supabase migration up --local
npx supabase status
```

The second command applies pending migrations, including
`20260830120000_marketing_brand_kits.sql`, only to the local Postgres container. Do not use
`--linked`, `db push`, the production project ref, or `deploy.ps1` for this verification.

To verify the migration without exposing credentials:

```powershell
npx supabase db diff --local
```

Stop the local stack without deleting volumes:

```powershell
npx supabase stop
```
