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
Apply-Migration .\supabase\migrations\20260729110000_worker_lease_rls.sql
Apply-Migration .\supabase\migrations\20260730110000_queue_and_tenant_integrity.sql
Apply-Migration .\supabase\migrations\20260801100000_ops_checks_admin_only.sql
Apply-Migration .\supabase\migrations\20260803100000_browser_observations.sql
Apply-Migration .\supabase\migrations\20260803110000_owner_approval_queue.sql
Apply-Migration .\supabase\migrations\20260803120000_agent_action_policy.sql
Apply-Migration .\supabase\migrations\20260803130000_mandatory_onboarding.sql
Apply-Migration .\supabase\migrations\20260803140000_atomic_agent_teams.sql
Apply-Migration .\supabase\migrations\20260803150000_data_leakage_hardening.sql
Apply-Migration .\supabase\migrations\20260803160000_production_test_account.sql
Apply-Migration .\supabase\migrations\20260803170000_autonomous_run_checkpoints.sql
Apply-Migration .\supabase\migrations\20260803180000_autonomous_run_worker.sql
Apply-Migration .\supabase\migrations\20260804120000_idempotent_usage_accounting.sql
Apply-Migration .\supabase\migrations\20260804130000_research_review_inbox.sql
Apply-Migration .\supabase\migrations\20260804140000_token_usage_reservations.sql
Apply-Migration .\supabase\migrations\20260804150000_agent_eval_publish_gate.sql
Apply-Migration .\supabase\migrations\20260804160000_team_draft_and_usage_aggregate.sql
Apply-Migration .\supabase\migrations\20260805090000_commerce_control_center.sql
Apply-Migration .\supabase\migrations\20260805100000_commerce_alert_delivery.sql
Apply-Migration .\supabase\migrations\20260805110000_commerce_telegram_links.sql
Apply-Migration .\supabase\migrations\20260805120000_commerce_economics_autofill.sql
Apply-Migration .\supabase\migrations\20260805130000_commerce_notify_channel.sql
Apply-Migration .\supabase\migrations\20260805140000_commerce_economics_proposals.sql
Apply-Migration .\supabase\migrations\20260805150000_fix_proposal_applied_fields.sql
Apply-Migration .\supabase\migrations\20260805160000_commerce_fee_proposals.sql
Apply-Migration .\supabase\migrations\20260806150000_commerce_catalog_min_margin.sql

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
    and not has_function_privilege('anon', 'public.finalize_transcribe_job(uuid,uuid,uuid,integer,text,bigint)', 'execute') as transcribe_jobs_locked,
  to_regclass('public.approval_requests') is not null
    and (select relrowsecurity from pg_class where oid = 'public.approval_requests'::regclass) as approval_queue_ready,
  exists(select 1 from information_schema.columns where table_schema = 'public' and table_name = 'agents' and column_name = 'action_policy')
    and exists(select 1 from information_schema.columns where table_schema = 'public' and table_name = 'business_profiles' and column_name = 'default_action_policy') as action_policies_ready,
  to_regclass('public.user_consents') is not null
    and not has_table_privilege('authenticated', 'public.user_consents', 'insert')
    and not has_table_privilege('authenticated', 'public.user_consents', 'update')
    and not has_table_privilege('authenticated', 'public.user_consents', 'delete') as consent_records_locked,
  exists(select 1 from pg_policies where schemaname = 'public' and tablename = 'business_profiles' and policyname = 'Owners read onboarding business profile') as onboarding_profile_policy,
  to_regprocedure('public.create_agent_team(jsonb,jsonb,jsonb)') is not null
    and has_function_privilege('authenticated', 'public.create_agent_team(jsonb,jsonb,jsonb)', 'execute')
    and not has_function_privilege('anon', 'public.create_agent_team(jsonb,jsonb,jsonb)', 'execute') as atomic_team_rpc,
  to_regprocedure('public.monthly_token_usage(uuid)') is not null
    and has_function_privilege('service_role', 'public.monthly_token_usage(uuid)', 'execute')
    and not has_function_privilege('authenticated', 'public.monthly_token_usage(uuid)', 'execute')
    and not has_function_privilege('anon', 'public.monthly_token_usage(uuid)', 'execute') as monthly_usage_rpc,
  to_regclass('public.commerce_catalogs') is not null
    and to_regclass('public.commerce_skus') is not null
    and to_regclass('public.commerce_import_batches') is not null
    and to_regclass('public.commerce_inventory_snapshots') is not null
    and to_regclass('public.commerce_recommendations') is not null
    and to_regprocedure('public.claim_commerce_sync_runs(integer)') is not null
    and not has_function_privilege('authenticated', 'public.claim_commerce_sync_runs(integer)', 'execute')
    and exists(select 1 from information_schema.columns where table_schema = 'public' and table_name = 'commerce_recommendations' and column_name = 'alerted_at')
    and to_regclass('public.commerce_telegram_links') is not null
    and exists(select 1 from information_schema.columns where table_schema = 'public' and table_name = 'commerce_skus' and column_name = 'estimated_fields')
    and to_regprocedure('public.autofill_commerce_economics(uuid)') is not null
    and not has_function_privilege('anon', 'public.autofill_commerce_economics(uuid)', 'execute') as commerce_control_ready,
  to_regclass('public.google_oauth_transactions') is not null
    and to_regprocedure('public.consume_google_oauth_transaction(text)') is not null
    and not has_function_privilege('authenticated', 'public.consume_google_oauth_transaction(text)', 'execute') as oauth_state_hardened,
  exists(select 1 from storage.buckets where id = 'private-audio' and public = false) as private_audio_ready,
  exists(select 1 from information_schema.columns where table_schema = 'public' and table_name = 'browser_observations' and column_name = 'expires_at')
    and to_regprocedure('public.purge_expired_browser_observations()') is not null as browser_retention_ready,
  exists(select 1 from information_schema.columns where table_schema = 'public' and table_name = 'accounts' and column_name = 'is_production_e2e')
    and to_regclass('public.accounts_single_production_e2e_idx') is not null
    and 11 = (
      select count(distinct cls.relname)
      from pg_trigger trg
      join pg_class cls on cls.oid = trg.tgrelid
      join pg_namespace ns on ns.oid = cls.relnamespace
      join pg_proc proc on proc.oid = trg.tgfoid
      where ns.nspname = 'public'
        and cls.relname = any(array['provider_keys','google_accounts','google_oauth_apps','social_accounts','custom_tools','scheduled_posts','follow_ups','watched_sources','channels','business_profiles','user_consents'])
        and trg.tgname = 'production_e2e_external_config_guard'
        and trg.tgenabled <> 'D'
        and not trg.tgisinternal
        and proc.proname = 'guard_production_e2e_external_config'
    ) as production_e2e_guard;
'@
$schemaCheckBody = $jsonSer.Serialize(@{ query = $schemaCheckSql })
$schemaCheck = Invoke-RestMethod -Uri "https://api.supabase.com/v1/projects/$ref/database/query" -Method Post -Headers $hdr -Body $schemaCheckBody
$schemaRow = @($schemaCheck)[0]
if (-not $schemaRow.subject_key -or -not $schemaRow.task_unique_index -or -not $schemaRow.reserve_rpc -or -not $schemaRow.finalize_rpc -or -not $schemaRow.risk_tier -or -not $schemaRow.template_key -or -not $schemaRow.quarantined_credentials -or -not $schemaRow.governed_evolution -or -not $schemaRow.safe_channel_metadata -or -not $schemaRow.channel_credentials_hidden -or -not $schemaRow.risk_tier_guard -or -not $schemaRow.channel_guard -or -not $schemaRow.lead_claim_columns -or -not $schemaRow.leads_latest_index -or -not $schemaRow.lead_rpcs -or -not $schemaRow.lead_rpcs_locked -or -not $schemaRow.leads_dml_locked -or -not $schemaRow.team_rag_rpc -or -not $schemaRow.team_rag_locked -or -not $schemaRow.team_docs_policy -or -not $schemaRow.team_tenant_guards -or -not $schemaRow.transcribe_jobs_locked -or -not $schemaRow.approval_queue_ready -or -not $schemaRow.action_policies_ready -or -not $schemaRow.consent_records_locked -or -not $schemaRow.onboarding_profile_policy -or -not $schemaRow.atomic_team_rpc -or -not $schemaRow.monthly_usage_rpc -or -not $schemaRow.commerce_control_ready -or -not $schemaRow.oauth_state_hardened -or -not $schemaRow.private_audio_ready -or -not $schemaRow.browser_retention_ready -or -not $schemaRow.production_e2e_guard) {
  throw 'Schema verification failed after migrations.'
}
Write-Host '     logistics, approvals, onboarding, atomic teams, private data retention and test-tenant isolation verified.' -ForegroundColor Green

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

# A plpgsql body is not validated when the function is created: an array-append typo shipped and
# every Telegram confirmation failed in production while the SQL read fine. Execute the RPC for
# real against throwaway rows so that class of bug cannot reach an owner again.
$commerceProbeSql = @'
do $commerce_probe$
declare
  probe_account uuid;
  probe_agent uuid;
  probe_channel uuid;
  probe_catalog uuid;
  probe_sku uuid;
  probe_proposal uuid;
  probe_result jsonb;
  probe_cost bigint;
  probe_lead integer;
  probe_estimated jsonb;
begin
  insert into public.accounts (name) values ('Nemo commerce proposal deploy probe') returning id into probe_account;
  insert into public.agents (account_id, name) values (probe_account, 'Commerce probe agent') returning id into probe_agent;
  insert into public.channels (agent_id, type) values (probe_agent, 'telegram') returning id into probe_channel;
  insert into public.commerce_catalogs (account_id, source, external_shop_id, name)
    values (probe_account, 'uzum', '999999', 'Commerce probe catalog') returning id into probe_catalog;
  insert into public.commerce_skus (catalog_id, external_sku, title, estimated_fields)
    values (probe_catalog, 'PROBE-SKU', 'Commerce probe SKU', '["unit_cost_tiyin","safety_stock"]'::jsonb)
    returning id into probe_sku;
  insert into public.commerce_economics_proposals
    (account_id, channel_id, chat_id, sku_id, product_query, source_text, unit_cost_tiyin, lead_time_days)
    values (probe_account, probe_channel, 'probe-chat', probe_sku, 'PROBE-SKU', 'probe', 123456, 7)
    returning id into probe_proposal;

  probe_result := public.apply_commerce_economics_proposal(probe_proposal);
  if probe_result->>'sku_id' is null then raise exception 'commerce proposal apply returned no sku'; end if;

  select unit_cost_tiyin, lead_time_days, estimated_fields
    into probe_cost, probe_lead, probe_estimated
    from public.commerce_skus where id = probe_sku;
  if probe_cost <> 123456 or probe_lead <> 7 then
    raise exception 'confirmed economics were not written';
  end if;
  if probe_estimated ? 'unit_cost_tiyin' then
    raise exception 'confirmed field kept its estimate mark';
  end if;

  -- A catalogue-wide value fills blanks without flattening a deliberate per-SKU decision.
  -- Bulk convenience must never quietly overwrite a number the seller chose on purpose.
  insert into public.commerce_skus (catalog_id, external_sku, title, min_margin_percent)
    values (probe_catalog, 'PROBE-SKU-PRICED', 'Deliberately priced probe SKU', 35);
  insert into public.commerce_economics_proposals
    (account_id, catalog_id, source, product_query, source_text, min_margin_percent)
    values (probe_account, probe_catalog, 'ui', 'catalogue minimum margin', 'probe', 20)
    returning id into probe_proposal;
  probe_result := public.apply_commerce_economics_proposal(probe_proposal);
  if (select min_margin_percent from public.commerce_skus where catalog_id = probe_catalog and external_sku = 'PROBE-SKU') is distinct from 20 then
    raise exception 'catalogue margin did not reach a blank SKU';
  end if;
  if (select min_margin_percent from public.commerce_skus where catalog_id = probe_catalog and external_sku = 'PROBE-SKU-PRICED') is distinct from 35 then
    raise exception 'catalogue margin overwrote a deliberate per-SKU margin';
  end if;
  if not probe_estimated ? 'safety_stock' then
    raise exception 'untouched field lost its estimate mark';
  end if;
  if (select status from public.commerce_economics_proposals where id = probe_proposal) <> 'applied' then
    raise exception 'proposal was not marked applied';
  end if;

  delete from public.accounts where id = probe_account;
end
$commerce_probe$;
'@
Apply-Sql $commerceProbeSql
Write-Host '     commerce proposal apply probe passed.' -ForegroundColor Green

if ($cronLine) {
  $safeCron = $cronValue.Replace("'", "''")
  $cronSql = @'
create extension if not exists pg_cron;
create extension if not exists pg_net with schema extensions;
  select cron.unschedule(jobid) from cron.job where jobname in ('nemo-autopost-every-minute', 'nemo-follow-up-every-five-minutes', 'nemo-agent-evolution-daily', 'nemo-ops-watchdog-every-ten-minutes', 'nemo-daily-digest-tashkent', 'nemo-autonomous-worker-every-minute', 'nemo-commerce-worker-tashkent', 'nemo-commerce-digest-tashkent');
select cron.schedule(
  'nemo-autonomous-worker-every-minute',
  '* * * * *',
  $$select net.http_post(
      url := 'https://__REF__.supabase.co/functions/v1/autonomous-worker',
      headers := jsonb_build_object('Content-Type','application/json','x-cron-secret','__SECRET__'),
      body := '{}'::jsonb
    );$$
);
select cron.schedule(
  'nemo-commerce-worker-tashkent',
  '0 19,23,3,7,11,15 * * *',
  $$select net.http_post(
      url := 'https://__REF__.supabase.co/functions/v1/commerce-worker',
      headers := jsonb_build_object('Content-Type','application/json','x-cron-secret','__SECRET__'),
      body := '{}'::jsonb
    );$$
);
select cron.schedule(
  'nemo-commerce-digest-tashkent',
  '0 4 * * *',
  $$select net.http_post(
      url := 'https://__REF__.supabase.co/functions/v1/commerce-digest',
      headers := jsonb_build_object('Content-Type','application/json','x-cron-secret','__SECRET__'),
      body := '{}'::jsonb
    );$$
);
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
select cron.schedule(
  'nemo-ops-watchdog-every-ten-minutes',
  '*/10 * * * *',
  $$select net.http_post(
      url := 'https://__REF__.supabase.co/functions/v1/ops-watchdog',
      headers := jsonb_build_object('Content-Type','application/json','x-cron-secret','__SECRET__'),
      body := '{}'::jsonb
    );$$
);
select cron.schedule(
  'nemo-daily-digest-tashkent',
  '5 3 * * *',
  $$select net.http_post(
      url := 'https://__REF__.supabase.co/functions/v1/daily-digest',
      headers := jsonb_build_object('Content-Type','application/json','x-cron-secret','__SECRET__'),
      body := '{}'::jsonb
    );$$
);
'@
  Apply-Sql ($cronSql.Replace('__REF__', $ref).Replace('__SECRET__', $safeCron))
}
Write-Host "     migrations applied." -ForegroundColor Green

# Tenant isolation is verified against the schema that was just migrated and BEFORE any new
# function code goes out: a migration that weakens RLS must stop the deploy, not be discovered
# afterwards. The smoke creates two real accounts and deletes them; a mid-run failure can leave
# them behind, so the message below tells the operator exactly what to look for.
Write-Host "1b/3 Verifying tenant isolation against the migrated schema..." -ForegroundColor Cyan
npm run test:security-live
if ($LASTEXITCODE -ne 0) {
  Write-Host "     TENANT ISOLATION FAILED - deploy stopped before any function was updated." -ForegroundColor Red
  Write-Host "     Check for leftover accounts named 'security-*@example.invalid' before retrying." -ForegroundColor Yellow
  exit 1
}
Write-Host "     tenant isolation verified." -ForegroundColor Green

$failed = @()
$edgeManifestPath = Join-Path $PSScriptRoot 'supabase\functions\deployment-manifest.json'
$edgeManifest = Get-Content -LiteralPath $edgeManifestPath -Raw | ConvertFrom-Json

Write-Host "2/3  Deploying public webhooks (verify_jwt=false)..." -ForegroundColor Cyan
foreach ($fn in @($edgeManifest.public)) {
  Write-Host "  -> $fn" -ForegroundColor DarkCyan
  npx supabase functions deploy $fn --project-ref $ref --use-api --no-verify-jwt
  if ($LASTEXITCODE -ne 0) { $failed += $fn }
}

Write-Host "3/3  Deploying authenticated functions..." -ForegroundColor Cyan
foreach ($fn in @($edgeManifest.authenticated)) {
  Write-Host "  -> $fn" -ForegroundColor DarkCyan
  npx supabase functions deploy $fn --project-ref $ref --use-api
  if ($LASTEXITCODE -ne 0) { $failed += $fn }
}

# Verify the two previously-missing functions now respond (not 404)
Write-Host "`nVerifying..." -ForegroundColor Cyan
foreach ($fn in 'backend-status','ops-workflow','logistics-workflow','autopost','follow-up','evolve-agent','ops-watchdog','daily-digest','connect-social','connect-telegram','connect-channel','operator-send','telegram-webhook','whatsapp-webhook','instagram-webhook','widget-webhook','agent-worker','autonomous-worker','setup-telegram','setup-meta','approval-queue','complete-onboarding') {
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
