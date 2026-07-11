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
Apply-Migration .\supabase\migrations\20260711200000_industry_risk_policy.sql
Apply-Migration .\supabase\migrations\20260711210000_channel_safe_read_columns.sql

$schemaCheckSql = @'
select
  exists(select 1 from information_schema.columns where table_schema = 'public' and table_name = 'tasks' and column_name = 'subject_key') as subject_key,
  to_regclass('public.tasks_logistics_exception_open_uidx') is not null as task_unique_index,
  to_regprocedure('public.reserve_logistics_credits(uuid,bigint)') is not null as reserve_rpc,
  to_regprocedure('public.finalize_logistics_credits(uuid,bigint,bigint)') is not null as finalize_rpc,
  exists(select 1 from information_schema.columns where table_schema = 'public' and table_name = 'agents' and column_name = 'risk_tier') as risk_tier,
  exists(select 1 from information_schema.columns where table_schema = 'public' and table_name = 'agents' and column_name = 'template_key') as template_key,
  exists(select 1 from information_schema.columns where table_schema = 'public' and table_name = 'channels' and column_name = 'quarantined_credentials') as quarantined_credentials,
  has_column_privilege('authenticated', 'public.channels', 'sub_agent_id', 'select')
    and has_column_privilege('authenticated', 'public.channels', 'scope', 'select')
    and has_column_privilege('authenticated', 'public.channels', 'label', 'select') as safe_channel_metadata,
  not has_column_privilege('authenticated', 'public.channels', 'credentials', 'select')
    and not has_column_privilege('authenticated', 'public.channels', 'quarantined_credentials', 'select') as channel_credentials_hidden,
  exists(
    select 1 from pg_trigger t
    join pg_class c on c.oid = t.tgrelid
    join pg_namespace n on n.oid = c.relnamespace
    join pg_proc p on p.oid = t.tgfoid
    where t.tgname = 'agents_risk_tier_guard' and not t.tgisinternal and t.tgenabled <> 'D'
      and n.nspname = 'public' and c.relname = 'agents' and p.proname = 'enforce_agent_risk_tier'
  ) as risk_tier_guard,
  exists(
    select 1 from pg_trigger t
    join pg_class c on c.oid = t.tgrelid
    join pg_namespace n on n.oid = c.relnamespace
    join pg_proc p on p.oid = t.tgfoid
    where t.tgname = 'channels_regulated_agent_guard' and not t.tgisinternal and t.tgenabled <> 'D'
      and n.nspname = 'public' and c.relname = 'channels' and p.proname = 'block_regulated_agent_channel'
  ) as channel_guard;
'@
$schemaCheckBody = $jsonSer.Serialize(@{ query = $schemaCheckSql })
$schemaCheck = Invoke-RestMethod -Uri "https://api.supabase.com/v1/projects/$ref/database/query" -Method Post -Headers $hdr -Body $schemaCheckBody
$schemaRow = @($schemaCheck)[0]
if (-not $schemaRow.subject_key -or -not $schemaRow.task_unique_index -or -not $schemaRow.reserve_rpc -or -not $schemaRow.finalize_rpc -or -not $schemaRow.risk_tier -or -not $schemaRow.template_key -or -not $schemaRow.quarantined_credentials -or -not $schemaRow.safe_channel_metadata -or -not $schemaRow.channel_credentials_hidden -or -not $schemaRow.risk_tier_guard -or -not $schemaRow.channel_guard) {
  throw 'Schema verification failed after migrations.'
}
Write-Host '     logistics, billing, safe channel metadata and regulated-channel schema verified.' -ForegroundColor Green

$riskProbeSql = @'
do $risk_probe$
declare
  probe_account uuid;
  probe_agent uuid;
  probe_channel uuid;
  channel_blocked boolean := false;
  credential_restore_blocked boolean := false;
  downgrade_blocked boolean := false;
begin
  insert into public.accounts (name) values ('Nemo risk policy deploy probe') returning id into probe_account;
  insert into public.agents (account_id, name, risk_tier)
    values (probe_account, 'Risk policy probe', 'standard')
    returning id into probe_agent;
  insert into public.channels (agent_id, type, credentials, status)
    values (probe_agent, 'telegram', '{"bot_token":"deploy-probe"}'::jsonb, 'connected')
    returning id into probe_channel;
  update public.agents set template_key = 'clinic-front-desk' where id = probe_agent;

  if (select risk_tier from public.agents where id = probe_agent) <> 'regulated' then
    raise exception 'regulated template was not classified by the database';
  end if;
  if not exists (
    select 1 from public.channels
    where id = probe_channel
      and status = 'safety_blocked'
      and credentials = '{}'::jsonb
      and quarantined_credentials->>'bot_token' = 'deploy-probe'
  ) then
    raise exception 'regulated channel credentials were not quarantined';
  end if;

  begin
    insert into public.channels (agent_id, type, status) values (probe_agent, 'widget', 'connected');
  exception when insufficient_privilege then
    channel_blocked := true;
  end;
  if not channel_blocked then raise exception 'regulated channel insert was not blocked'; end if;

  begin
    update public.channels set credentials = '{"bot_token":"restore-attempt"}'::jsonb where id = probe_channel;
  exception when insufficient_privilege then
    credential_restore_blocked := true;
  end;
  if not credential_restore_blocked then raise exception 'regulated credentials could be restored'; end if;

  begin
    update public.agents set risk_tier = 'standard' where id = probe_agent;
  exception when insufficient_privilege then
    downgrade_blocked := true;
  end;
  if not downgrade_blocked then raise exception 'regulated risk downgrade was not blocked'; end if;

  delete from public.accounts where id = probe_account;
end
$risk_probe$;
'@
Apply-Sql $riskProbeSql
Write-Host '     regulated-channel behavior probe passed.' -ForegroundColor Green

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
foreach ($fn in 'whatsapp-webhook','instagram-webhook','widget-webhook','stripe-webhook','telegram-webhook','setup-telegram','setup-meta','agent-worker','autopost','follow-up') {
  Write-Host "  -> $fn" -ForegroundColor DarkCyan
  npx supabase functions deploy $fn --project-ref $ref --use-api --no-verify-jwt
  if ($LASTEXITCODE -ne 0) { $failed += $fn }
}

Write-Host "3/3  Deploying authenticated functions..." -ForegroundColor Cyan
foreach ($fn in 'backend-status','fetch-url','crm-push','ops-workflow','logistics-workflow','orchestrate','research-agent','test-agent','connect-social','connect-telegram','connect-channel','operator-send') {
  Write-Host "  -> $fn" -ForegroundColor DarkCyan
  npx supabase functions deploy $fn --project-ref $ref --use-api
  if ($LASTEXITCODE -ne 0) { $failed += $fn }
}

# Verify the two previously-missing functions now respond (not 404)
Write-Host "`nVerifying..." -ForegroundColor Cyan
foreach ($fn in 'backend-status','ops-workflow','logistics-workflow','autopost','follow-up','connect-social','connect-telegram','connect-channel','operator-send','telegram-webhook','whatsapp-webhook','instagram-webhook','widget-webhook','agent-worker','setup-telegram','setup-meta') {
  $code = -1
  $responseBody = ''
  $isInboundWebhook = $fn -in @('telegram-webhook','whatsapp-webhook','instagram-webhook')
  $probePath = if ($isInboundWebhook) { "$fn/00000000-0000-0000-0000-000000000000" } else { $fn }
  $probeMethod = if ($isInboundWebhook) { 'Get' } else { 'Options' }
  try {
    $r = Invoke-WebRequest -Uri "https://$ref.supabase.co/functions/v1/$probePath" -Method $probeMethod -UseBasicParsing -TimeoutSec 10
    $code = [int]$r.StatusCode
    $responseBody = [string]$r.Content
  } catch {
    if ($_.Exception.Response) { $code = [int]$_.Exception.Response.StatusCode }
    $responseBody = [string]$_.ErrorDetails.Message
    if (-not $responseBody -and $_.Exception.Response) {
      try { $reader = New-Object IO.StreamReader($_.Exception.Response.GetResponseStream()); $responseBody = $reader.ReadToEnd(); $reader.Dispose() } catch { $responseBody = '' }
    }
  }
  $ok = if ($isInboundWebhook) { $code -eq 404 -and $responseBody -match 'channel not found' } else { @(200, 204, 400, 401, 403, 405) -contains $code }
  Write-Host ("  {0} -> {1} {2}" -f $fn, $code, $(if ($ok) { 'OK' } else { 'STILL MISSING' })) -ForegroundColor $(if ($ok) { 'Green' } else { 'Red' })
  if (-not $ok) { $failed += "verify:$fn" }
}

if ($failed.Count) {
  Write-Host "`nSOME DEPLOYS FAILED: $($failed -join ', ')" -ForegroundColor Red
  Write-Host "Re-run this script, or check your internet / Supabase token in .secrets.local." -ForegroundColor Yellow
  exit 1
} else {
  Write-Host "`nDONE. All functions in this Nemo release set deployed, OpenRouter key funded, model = openai/gpt-4o-mini." -ForegroundColor Green
  Write-Host "The AI team now runs on Telegram (connect a bot from the team page)." -ForegroundColor Green
}
Write-Host "Optional full check:  powershell -ExecutionPolicy Bypass -File .\smoke-ops.ps1" -ForegroundColor Yellow
exit 0
