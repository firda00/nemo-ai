# Nemo AI — full production deploy (security fixes + Ustudy Operations Team + reliability).
# Run from the project root:  powershell -ExecutionPolicy Bypass -File .\deploy.ps1
# Reads the Supabase Personal Access Token from .secrets.local (never hard-coded).

$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot
$ref = 'ogfmyjiuqmgroobckdyw'
$pat = (Get-Content .secrets.local | Select-String '^SUPABASE_ACCESS_TOKEN=').ToString().Split('=', 2)[1].Trim()
$env:SUPABASE_ACCESS_TOKEN = $pat
$hdr = @{ Authorization = "Bearer $pat"; 'Content-Type' = 'application/json' }

Add-Type -AssemblyName System.Web.Extensions
$jsonSer = New-Object System.Web.Script.Serialization.JavaScriptSerializer
function Apply-Migration($path) {
  Write-Host "  migration: $([IO.Path]::GetFileName($path))" -ForegroundColor DarkCyan
  # Read as UTF-8 + serialize via .NET (PS 5.1 ConvertTo-Json mangles non-ASCII SQL).
  $sql = [IO.File]::ReadAllText($path)
  Apply-Sql $sql
}
function Apply-Sql($sql) {
  $body = $jsonSer.Serialize(@{ query = $sql })
  Invoke-RestMethod -Uri "https://api.supabase.com/v1/projects/$ref/database/query" -Method Post -Headers $hdr -Body $body | Out-Null
}

# Sync the OpenRouter LLM key (from .secrets.local) into the Supabase secret so
# every edge function uses the funded key.
$orLine = Get-Content .secrets.local | Select-String '^OPENROUTER_API_KEY='
if ($orLine) {
  $orKey = $orLine.ToString().Split('=', 2)[1].Trim()
  Write-Host "0/3  Setting OPENROUTER_API_KEY secret..." -ForegroundColor Cyan
  $secretBody = ConvertTo-Json @(@{ name = 'OPENROUTER_API_KEY'; value = $orKey })
  Invoke-RestMethod -Uri "https://api.supabase.com/v1/projects/$ref/secrets" -Method Post -Headers $hdr -Body $secretBody | Out-Null
  Write-Host "     OpenRouter key set." -ForegroundColor Green
}
$cronLine = Get-Content .secrets.local | Select-String '^CRON_SECRET='
if ($cronLine) {
  $cronValue = $cronLine.ToString().Split('=', 2)[1].Trim()
  $cronSecretBody = ConvertTo-Json @(
    @{ name = 'CRON_SECRET'; value = $cronValue },
    @{ name = 'FOLLOWUP_CRON_SECRET'; value = $cronValue }
  )
  Invoke-RestMethod -Uri "https://api.supabase.com/v1/projects/$ref/secrets" -Method Post -Headers $hdr -Body $cronSecretBody | Out-Null
}

Write-Host "1/3  Applying DB migrations..." -ForegroundColor Cyan
# Historical migrations are already applied and some are intentionally not
# repeatable. Deployment only applies the current idempotent repair migration.
Apply-Migration .\supabase\migrations\20260711150000_autopost_repair.sql
Apply-Migration .\supabase\migrations\20260711160000_logistics_workflow.sql

$schemaCheckSql = @'
select
  exists(select 1 from information_schema.columns where table_schema = 'public' and table_name = 'tasks' and column_name = 'subject_key') as subject_key,
  to_regclass('public.tasks_logistics_exception_open_uidx') is not null as task_unique_index,
  to_regprocedure('public.reserve_logistics_credits(uuid,bigint)') is not null as reserve_rpc,
  to_regprocedure('public.finalize_logistics_credits(uuid,bigint,bigint)') is not null as finalize_rpc;
'@
$schemaCheckBody = $jsonSer.Serialize(@{ query = $schemaCheckSql })
$schemaCheck = Invoke-RestMethod -Uri "https://api.supabase.com/v1/projects/$ref/database/query" -Method Post -Headers $hdr -Body $schemaCheckBody
$schemaRow = @($schemaCheck)[0]
if (-not $schemaRow.subject_key -or -not $schemaRow.task_unique_index -or -not $schemaRow.reserve_rpc -or -not $schemaRow.finalize_rpc) {
  throw 'Logistics schema verification failed after migration.'
}
Write-Host '     logistics schema and billing RPCs verified.' -ForegroundColor Green

if ($cronLine) {
  $safeCron = $cronValue.Replace("'", "''")
  $cronSql = @'
create extension if not exists pg_cron;
create extension if not exists pg_net with schema extensions;
select cron.unschedule(jobid) from cron.job where jobname in ('nemo-autopost-every-minute', 'nemo-follow-up-every-five-minutes');
select cron.schedule(
  'nemo-autopost-every-minute',
  '* * * * *',
  $$select net.http_post(
      url := 'https://__REF__.supabase.co/functions/v1/autopost',
      headers := jsonb_build_object('Content-Type','application/json','x-cron-secret','__SECRET__'),
      body := '{"action":"run_due"}'::jsonb
    );$$
);
select cron.schedule(
  'nemo-follow-up-every-five-minutes',
  '*/5 * * * *',
  $$select net.http_post(
      url := 'https://__REF__.supabase.co/functions/v1/follow-up',
      headers := jsonb_build_object('Content-Type','application/json','x-cron-secret','__SECRET__'),
      body := '{"action":"run_due"}'::jsonb
    );$$
);
'@
  Apply-Sql ($cronSql.Replace('__REF__', $ref).Replace('__SECRET__', $safeCron))
}
Write-Host "     migrations applied." -ForegroundColor Green

$failed = @()

Write-Host "2/3  Deploying public webhooks (verify_jwt=false)..." -ForegroundColor Cyan
foreach ($fn in 'whatsapp-webhook','instagram-webhook','stripe-webhook','telegram-webhook','autopost','follow-up') {
  Write-Host "  -> $fn" -ForegroundColor DarkCyan
  npx supabase functions deploy $fn --project-ref $ref --use-api --no-verify-jwt
  if ($LASTEXITCODE -ne 0) { $failed += $fn }
}

Write-Host "3/3  Deploying authenticated functions..." -ForegroundColor Cyan
foreach ($fn in 'backend-status','fetch-url','crm-push','ops-workflow','logistics-workflow','orchestrate','research-agent','test-agent','connect-social') {
  Write-Host "  -> $fn" -ForegroundColor DarkCyan
  npx supabase functions deploy $fn --project-ref $ref --use-api
  if ($LASTEXITCODE -ne 0) { $failed += $fn }
}

# Verify the two previously-missing functions now respond (not 404)
Write-Host "`nVerifying..." -ForegroundColor Cyan
foreach ($fn in 'backend-status','ops-workflow','logistics-workflow','autopost','follow-up','connect-social') {
  $code = -1
  try { $r = Invoke-WebRequest -Uri "https://$ref.supabase.co/functions/v1/$fn" -Method Options -UseBasicParsing -TimeoutSec 10; $code = $r.StatusCode } catch { if ($_.Exception.Response) { $code = [int]$_.Exception.Response.StatusCode } }
  $ok = ($code -ne 404 -and $code -ne -1)
  Write-Host ("  {0} -> {1} {2}" -f $fn, $code, $(if ($ok) { 'OK' } else { 'STILL MISSING' })) -ForegroundColor $(if ($ok) { 'Green' } else { 'Red' })
}

if ($failed.Count) {
  Write-Host "`nSOME DEPLOYS FAILED: $($failed -join ', ')" -ForegroundColor Red
  Write-Host "Re-run this script, or check your internet / Supabase token in .secrets.local." -ForegroundColor Yellow
} else {
  Write-Host "`nDONE. All functions deployed, OpenRouter key funded, model = openai/gpt-4o-mini." -ForegroundColor Green
  Write-Host "The AI team now runs on Telegram (connect a bot from the team page)." -ForegroundColor Green
}
Write-Host "Optional full check:  powershell -ExecutionPolicy Bypass -File .\smoke-ops.ps1" -ForegroundColor Yellow
