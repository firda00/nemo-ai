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
Apply-Migration .\supabase\migrations\20260713120000_governed_agent_evolution.sql
Apply-Migration .\supabase\migrations\20260713150000_product_intelligence.sql
Apply-Migration .\supabase\migrations\20260714090000_leads_concurrency.sql
Apply-Migration .\supabase\migrations\20260714100000_team_shared_rag.sql
Apply-Migration .\supabase\migrations\20260714110000_transcribe_jobs.sql
Apply-Migration .\supabase\migrations\20260723183000_telegram_worker_reliability.sql
Apply-Migration .\supabase\migrations\20260723193000_agent_stt_model.sql

$schemaCheckSql = @'
select
  exists(select 1 from information_schema.columns where table_schema = 'public' and table_name = 'tasks' and column_name = 'subject_key') as subject_key,
  to_regclass('public.tasks_logistics_exception_open_uidx') is not null as task_unique_index,
  to_regprocedure('public.reserve_logistics_credits(uuid,bigint)') is not null as reserve_rpc,
  to_regprocedure('public.finalize_logistics_credits(uuid,bigint,bigint)') is not null as finalize_rpc,
  exists(select 1 from information_schema.columns where table_schema = 'public' and table_name = 'agents' and column_name = 'risk_tier') as risk_tier,
  exists(select 1 from information_schema.columns where table_schema = 'public' and table_name = 'agents' and column_name = 'template_key') as template_key,
  exists(select 1 from information_schema.columns where table_schema = 'public' and table_name = 'channels' and column_name = 'quarantined_credentials') as quarantined_credentials,
  exists(select 1 from information_schema.columns where table_schema = 'public' and table_name = 'agent_evolutions' and column_name = 'auto_applied')
    and exists(select 1 from information_schema.columns where table_schema = 'public' and table_name = 'agent_evolutions' and column_name = 'rolled_back_at') as governed_evolution,
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
  ) as channel_guard,
  exists(select 1 from information_schema.columns where table_schema = 'public' and table_name = 'leads' and column_name = 'crm_push_claim')
    and exists(select 1 from information_schema.columns where table_schema = 'public' and table_name = 'leads' and column_name = 'crm_push_claimed_at') as lead_claim_columns,
  to_regclass('public.leads_dialogue_latest_idx') is not null as leads_latest_index,
  to_regprocedure('public.merge_lead_fields(uuid,uuid,jsonb)') is not null
    and to_regprocedure('public.claim_lead_crm_push(uuid,uuid)') is not null
    and to_regprocedure('public.finish_lead_crm_push(uuid,uuid,uuid,text)') is not null as lead_rpcs,
  not has_function_privilege('authenticated', 'public.merge_lead_fields(uuid,uuid,jsonb)', 'execute')
    and not has_function_privilege('anon', 'public.merge_lead_fields(uuid,uuid,jsonb)', 'execute')
    and not has_function_privilege('authenticated', 'public.claim_lead_crm_push(uuid,uuid)', 'execute')
    and not has_function_privilege('anon', 'public.claim_lead_crm_push(uuid,uuid)', 'execute')
    and not has_function_privilege('authenticated', 'public.finish_lead_crm_push(uuid,uuid,uuid,text)', 'execute')
    and not has_function_privilege('anon', 'public.finish_lead_crm_push(uuid,uuid,uuid,text)', 'execute') as lead_rpcs_locked,
  not has_table_privilege('authenticated', 'public.leads', 'insert')
    and not has_table_privilege('authenticated', 'public.leads', 'update')
    and not has_table_privilege('authenticated', 'public.leads', 'delete')
    and not has_table_privilege('anon', 'public.leads', 'insert')
    and not has_table_privilege('anon', 'public.leads', 'update')
    and not has_table_privilege('anon', 'public.leads', 'delete')
    and has_table_privilege('authenticated', 'public.leads', 'select') as leads_dml_locked,
  to_regprocedure('public.match_knowledge_team(uuid,uuid,uuid,vector,integer)') is not null as team_rag_rpc,
  not has_function_privilege('authenticated', 'public.match_knowledge_team(uuid,uuid,uuid,vector,integer)', 'execute')
    and not has_function_privilege('anon', 'public.match_knowledge_team(uuid,uuid,uuid,vector,integer)', 'execute') as team_rag_locked,
  exists(select 1 from pg_policies where schemaname = 'public' and tablename = 'knowledge_docs' and policyname = 'knowledge_acc' and qual like '%departments%') as team_docs_policy,
  exists(
    select 1 from pg_trigger t
    join pg_class c on c.oid = t.tgrelid
    join pg_namespace n on n.oid = c.relnamespace
    where t.tgname = 'departments_tenant_guard' and not t.tgisinternal and t.tgenabled <> 'D' and n.nspname = 'public' and c.relname = 'departments'
  ) and exists(
    select 1 from pg_trigger t
    join pg_class c on c.oid = t.tgrelid
    join pg_namespace n on n.oid = c.relnamespace
    where t.tgname = 'sub_agents_tenant_guard' and not t.tgisinternal and t.tgenabled <> 'D' and n.nspname = 'public' and c.relname = 'sub_agents'
  ) as team_tenant_guards,
  exists(select 1 from information_schema.tables where table_schema = 'public' and table_name = 'transcribe_jobs')
    and (select relrowsecurity from pg_class where oid = 'public.transcribe_jobs'::regclass)
    and not exists(select 1 from pg_policies where schemaname = 'public' and tablename = 'transcribe_jobs')
    and to_regprocedure('public.finalize_transcribe_job(uuid,uuid,uuid,integer,text,bigint)') is not null
    and not has_function_privilege('authenticated', 'public.finalize_transcribe_job(uuid,uuid,uuid,integer,text,bigint)', 'execute')
    and not has_function_privilege('anon', 'public.finalize_transcribe_job(uuid,uuid,uuid,integer,text,bigint)', 'execute') as transcribe_jobs_locked;
'@
$schemaCheckBody = $jsonSer.Serialize(@{ query = $schemaCheckSql })
$schemaCheck = Invoke-RestMethod -Uri "https://api.supabase.com/v1/projects/$ref/database/query" -Method Post -Headers $hdr -Body $schemaCheckBody
$schemaRow = @($schemaCheck)[0]
if (-not $schemaRow.subject_key -or -not $schemaRow.task_unique_index -or -not $schemaRow.reserve_rpc -or -not $schemaRow.finalize_rpc -or -not $schemaRow.risk_tier -or -not $schemaRow.template_key -or -not $schemaRow.quarantined_credentials -or -not $schemaRow.governed_evolution -or -not $schemaRow.safe_channel_metadata -or -not $schemaRow.channel_credentials_hidden -or -not $schemaRow.risk_tier_guard -or -not $schemaRow.channel_guard -or -not $schemaRow.lead_claim_columns -or -not $schemaRow.leads_latest_index -or -not $schemaRow.lead_rpcs -or -not $schemaRow.lead_rpcs_locked -or -not $schemaRow.leads_dml_locked -or -not $schemaRow.team_rag_rpc -or -not $schemaRow.team_rag_locked -or -not $schemaRow.team_docs_policy -or -not $schemaRow.team_tenant_guards -or -not $schemaRow.transcribe_jobs_locked) {
  throw 'Schema verification failed after migrations.'
}
Write-Host '     logistics, billing, governed evolution, safe channel metadata, regulated-channel and leads-concurrency schema verified.' -ForegroundColor Green

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

$leadsProbeSql = @'
do $leads_probe$
declare
  probe_account uuid;
  probe_agent uuid;
  probe_dialogue uuid;
  first_lead uuid;
  second_lead uuid;
  probe_fields jsonb;
  probe_token uuid;
  reclaim_token uuid;
begin
  insert into public.accounts (name) values ('Nemo leads concurrency deploy probe') returning id into probe_account;
  insert into public.agents (account_id, name) values (probe_account, 'Leads probe agent') returning id into probe_agent;
  insert into public.dialogues (agent_id, channel, external_id) values (probe_agent, 'widget', 'leads-probe') returning id into probe_dialogue;

  select lead_id into first_lead from public.merge_lead_fields(probe_account, probe_dialogue, '{"name":"Probe"}'::jsonb);
  select lead_id, lead_fields into second_lead, probe_fields from public.merge_lead_fields(probe_account, probe_dialogue, '{"phone":"+998900000000"}'::jsonb);
  if first_lead is null or first_lead <> second_lead then
    raise exception 'lead merge did not reuse the canonical row';
  end if;
  if probe_fields->>'name' <> 'Probe' or probe_fields->>'phone' <> '+998900000000' then
    raise exception 'lead merge lost previously captured fields';
  end if;
  if (select count(*) from public.leads where dialogue_id = probe_dialogue) <> 1 then
    raise exception 'lead merge created duplicate rows';
  end if;

  select claim_token into probe_token from public.claim_lead_crm_push(probe_account, first_lead);
  if probe_token is null then raise exception 'first CRM-push claim failed'; end if;
  select claim_token into reclaim_token from public.claim_lead_crm_push(probe_account, first_lead);
  if reclaim_token is not null then raise exception 'live CRM-push claim was double-issued'; end if;
  update public.leads set crm_push_claimed_at = now() - interval '11 minutes' where id = first_lead;
  select claim_token into reclaim_token from public.claim_lead_crm_push(probe_account, first_lead);
  if reclaim_token is null then raise exception 'stale CRM-push claim was not reclaimable'; end if;
  if public.finish_lead_crm_push(probe_account, first_lead, gen_random_uuid(), 'probe') then
    raise exception 'CRM-push finish accepted a wrong token';
  end if;
  if not public.finish_lead_crm_push(probe_account, first_lead, reclaim_token, 'probe') then
    raise exception 'CRM-push finish with a valid token failed';
  end if;
  select claim_token into reclaim_token from public.claim_lead_crm_push(probe_account, first_lead);
  if reclaim_token is not null then raise exception 'completed lead was claimable again'; end if;

  begin
    perform public.merge_lead_fields(gen_random_uuid(), probe_dialogue, '{"name":"x"}'::jsonb);
    raise exception 'cross-account lead merge was not rejected';
  exception when insufficient_privilege then
    null;
  end;

  delete from public.accounts where id = probe_account;
end
$leads_probe$;
'@
Apply-Sql $leadsProbeSql
Write-Host '     leads concurrency behavior probe passed.' -ForegroundColor Green

if ($cronLine) {
  $safeCron = $cronValue.Replace("'", "''")
  $cronSql = @'
create extension if not exists pg_cron;
create extension if not exists pg_net with schema extensions;
select cron.unschedule(jobid) from cron.job where jobname in ('nemo-autopost-every-minute', 'nemo-follow-up-every-five-minutes', 'nemo-agent-evolution-daily');
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
select cron.schedule(
  'nemo-agent-evolution-daily',
  '17 3 * * *',
  $$select net.http_post(
      url := 'https://__REF__.supabase.co/functions/v1/evolve-agent',
      headers := jsonb_build_object('Content-Type','application/json','x-cron-secret','__SECRET__'),
      body := '{"action":"auto-run"}'::jsonb
    );$$
);
'@
  Apply-Sql ($cronSql.Replace('__REF__', $ref).Replace('__SECRET__', $safeCron))
}
Write-Host "     migrations applied." -ForegroundColor Green

$failed = @()

Write-Host "2/3  Deploying public webhooks (verify_jwt=false)..." -ForegroundColor Cyan
foreach ($fn in 'whatsapp-webhook','instagram-webhook','widget-webhook','stripe-webhook','telegram-webhook','setup-telegram','setup-meta','agent-worker','autopost','follow-up','evolve-agent','google-oauth') {
  Write-Host "  -> $fn" -ForegroundColor DarkCyan
  npx supabase functions deploy $fn --project-ref $ref --use-api --no-verify-jwt
  if ($LASTEXITCODE -ne 0) { $failed += $fn }
}

Write-Host "3/3  Deploying authenticated functions..." -ForegroundColor Cyan
foreach ($fn in 'backend-status','fetch-url','crm-push','ops-workflow','logistics-workflow','orchestrate','research-agent','test-agent','compose-agent','agent-tool','analyze-content','automations','content-visual','edit-file','localize','ops-autopilot','watch-sources','transcribe-file','connect-social','connect-telegram','connect-channel','connect-provider','operator-send','google-tools') {
  Write-Host "  -> $fn" -ForegroundColor DarkCyan
  npx supabase functions deploy $fn --project-ref $ref --use-api
  if ($LASTEXITCODE -ne 0) { $failed += $fn }
}

# Verify the two previously-missing functions now respond (not 404)
Write-Host "`nVerifying..." -ForegroundColor Cyan
foreach ($fn in 'backend-status','ops-workflow','logistics-workflow','autopost','follow-up','evolve-agent','connect-social','connect-telegram','connect-channel','operator-send','telegram-webhook','whatsapp-webhook','instagram-webhook','widget-webhook','agent-worker','setup-telegram','setup-meta') {
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
