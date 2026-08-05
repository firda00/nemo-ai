import { readFileSync } from 'node:fs'

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8')
const blueprints = read('src/lib/commerceTeams.ts')
const marketplace = read('src/pages/app/MarketplacePage.tsx')
const teamDetail = read('src/pages/app/TeamDetailPage.tsx')
const runner = read('src/components/platform/OpsWorkflowRunner.tsx')
const teamPersistence = read('src/lib/ustudyTeam.ts')
const workflow = read('supabase/functions/logistics-workflow/index.ts')
const parser = read('supabase/functions/_shared/logisticsInput.ts')
const config = read('supabase/config.toml')
const migration = read('supabase/migrations/20260711160000_logistics_workflow.sql')
const atomicTeamMigration = read('supabase/migrations/20260803140000_atomic_agent_teams.sql')
const deploy = read('deploy.ps1')
const commerceControl = read('supabase/functions/commerce-control/index.ts')
const commerceWorker = read('supabase/functions/commerce-worker/index.ts')
const commerceDigest = read('supabase/functions/commerce-digest/index.ts')
const telegramWebhook = read('supabase/functions/telegram-webhook/index.ts')
const commercePage = read('src/pages/app/CommercePage.tsx')
const commerceMigration = read('supabase/migrations/20260805090000_commerce_control_center.sql')
const telegramLinksMigration = read('supabase/migrations/20260805110000_commerce_telegram_links.sql')
const autofillMigration = read('supabase/migrations/20260805120000_commerce_economics_autofill.sql')
const skuTable = read('src/components/platform/CommerceSkuTable.tsx')

const checks = [
  ['four commerce team blueprints exist', ['marketplace:', 'dropshipping:', "'online-store':", 'logistics:'].every((key) => blueprints.includes(key))],
  ['templates create persistent teams', /createCommerceTeam\(tpl\.commerceKey, addAgent, deleteAgent, \{ model, niche \}\)/.test(marketplace) && /saveDynamicTeam\(addAgent, bp, deleteAgent\)/.test(blueprints)],
  ['team graph is created atomically', /rpc\(['"]create_agent_team['"]/.test(teamPersistence) && /insert into public\.agents[\s\S]*insert into public\.departments[\s\S]*insert into public\.sub_agents/.test(atomicTeamMigration) && /!res\.error && res\.agentId && res\.departmentId/.test(marketplace)],
  ['marketplace team is honest about read-only access', /Marketplace tools are connected separately and remain read-only unless a production executor is explicitly verified/.test(blueprints)],
  ['marketplace team scores assortment opportunities with evidence', /Assortment and Bilingual Listing Specialist/.test(blueprints) && /scale, keep, fix, clear, pause or insufficient data/.test(blueprints) && /Never invent characteristics, purchase or publish automatically/.test(blueprints)],
  ['marketplace customer care is grounded and approval-gated', /Customer Conversation and Reviews Specialist/.test(blueprints) && /Never invent price, stock, delivery, warranty or return terms/.test(blueprints) && /configured channel and its approval policy/.test(blueprints)],
  ['supplier purchases require approval', /Supplier orders, payments and customer refunds always require human approval/.test(blueprints)],
  ['non-production commerce badges are honest', /Manual analysis beta/.test(marketplace) && /Data \/ connector required/.test(marketplace)],
  ['commerce teams cannot be misclassified as planerka operations', /const isCommerceWorkspace/.test(teamDetail) && /!isCommerceWorkspace &&/.test(teamDetail) && /\\boperations\?\\b/.test(teamDetail)],
  ['logistics team routes to its dedicated workflow', /isLogistics \? 'logistics_control'/.test(teamDetail) && /setKind\('logistics_control'\)/.test(teamDetail) && /functions\.invoke\(functionName/.test(runner)],
  ['logistics input currently declares manual source', /source !== 'manual'/.test(workflow) && /SOURCE_NOT_CONNECTED/.test(workflow)],
  ['shipment facts are parsed before any LLM call', /const parsedInput = parseShipmentRows\(input\)/.test(workflow) && /const shipments = sourceRows\.map/.test(workflow)],
  ['dates accept strict ISO and explicit Tashkent offset', /function strictDateOnly/.test(parser) && /normalized \+= '\+05:00'/.test(parser) && /T23:59:59\+05:00/.test(workflow)],
  ['SLA risk is calculated deterministically from source rows', /promisedMs < now/.test(workflow) && /now - lastMs > 48 \* 3600000/.test(workflow) && /facts, owner and SLA are locked/.test(workflow)],
  ['missing or future facts become data-quality exceptions', /needs_data/.test(workflow) && /futureFacts/.test(workflow) && /data_quality/.test(workflow)],
  ['LLM outputs are limited to actual exceptions', /exceptionSet\.has/.test(workflow) && /Allowed risk order IDs/.test(workflow)],
  ['every exception gets a deterministic fallback task', /const candidateTasks = exceptions\.map/.test(workflow) && /Deterministic fallback tasks added/.test(workflow)],
  ['task owner and deadline come from source policy', /owner: shipment\.owner/.test(workflow) && /shipment\.promised_date >= today/.test(workflow)],
  ['external communications remain approval-only drafts', /requires_approval: true/.test(workflow) && /external_messages_sent: false/.test(workflow)],
  ['logistics creates durable deduplicated tasks', /source: 'logistics'/.test(workflow) && /subject_key: exceptionKey/.test(workflow) && /existingByOrder/.test(workflow)],
  ['concurrent duplicate task conflicts are recovered', /error\?\.code === '23505'/.test(workflow) && /concurrent run created the task/.test(workflow)],
  ['delivered shipments close old open tasks', /recoveredIds/.test(workflow) && /Logistics recovery rule/.test(workflow)],
  ['exception type transitions reconcile one open task', /Superseded by logistics state transition/.test(workflow) && /reconciled_task_ids/.test(workflow)],
  ['task and notification write errors are checked', /logistics task persistence failed/.test(workflow) && /logistics notification persistence failed/.test(workflow)],
  ['actual workflow stages are returned', /Shipment parser/.test(workflow) && /SLA rules engine/.test(workflow) && /steps: trace/.test(workflow)],
  ['shared maximum budget is reserved and unused credits refunded', /SHARED_CREDIT_RESERVATION = 50/.test(workflow) && /reserve_logistics_credits/.test(workflow) && /finalize_logistics_credits/.test(workflow) && /p_reserved - ceil/.test(migration)],
  ['BYO key runs are not charged Nemo credits', /const usingSharedKey/.test(workflow) && /if \(usingSharedKey\)/.test(workflow)],
  ['failed LLM calls are still accounted in finally', /finally \{[\s\S]*finalize_logistics_credits/.test(workflow)],
  ['only active specialists are selected', /sub_agents'[\s\S]*\.eq\('status', 'active'\)/.test(workflow)],
  ['rejected input rows are returned as warnings', /warnings: parsedInput\.warnings/.test(workflow) && /duplicate order_id/.test(parser)],
  ['input cap is explicit before LLM usage', /Maximum 40 unique shipment rows/.test(parser) && /max_rows: 40/.test(workflow)],
  ['carrier case drafts are rendered', /result\.carrier_cases\.map/.test(runner) && /no carrier API call was made/.test(runner)],
  ['function keeps JWT verification enabled', /\[functions\.logistics-workflow\][\s\S]*?verify_jwt = true/.test(config)],
  ['migration and function are included in deployment', /20260711160000_logistics_workflow\.sql/.test(deploy) && /'logistics-workflow'/.test(deploy) && /tasks_logistics_exception_open_uidx/.test(migration)],

  // --- Commerce Control Center (Uzum pilot) ---
  ['commerce mutations are owner-only in the API', /const ownerAction = action === 'start_pilot' \|\| action === 'discover_uzum' \|\| action === 'stage_import' \|\| action === 'resolve_import_row' \|\| action === 'confirm_import' \|\| action === 'create_telegram_link'/.test(commerceControl) && /ownerAction && profile\.role !== 'owner'\) return json\(\{ error: 'owner role required' \}, 403\)/.test(commerceControl)],
  ['confirm_commerce_import re-checks owner and staged status in SQL', /security definer/.test(commerceMigration) && /u\.role = 'owner'/.test(commerceMigration) && /errcode = '42501'/.test(commerceMigration) && /v_batch\.status <> 'staged'/.test(commerceMigration) && /for update;/.test(commerceMigration) && /references a foreign SKU/.test(commerceMigration)],
  ['confirm runs under the caller JWT so auth.uid() is honest', /userDb\.rpc\('confirm_commerce_import'/.test(commerceControl)],
  ['every commerce table has RLS and no write grants for clients', (commerceMigration.match(/enable row level security/g) ?? []).length === 8 && /revoke all on public\.commerce_pilots[\s\S]*?from public, anon, authenticated/.test(commerceMigration) && /grant select on public\.commerce_pilots/.test(commerceMigration) && !/grant (insert|update|delete|all)/.test(commerceMigration)],
  ['sync claim RPC is service-role only', /revoke all on function public\.claim_commerce_sync_runs\(integer\) from public, anon, authenticated/.test(commerceMigration) && /grant execute on function public\.claim_commerce_sync_runs\(integer\) to service_role/.test(commerceMigration)],
  ['pilot expiry is a hard stop for sync and claims', /eq\('status', 'active'\)\.gt\('expires_at'/.test(commerceWorker) && /p\.status = 'active'/.test(commerceMigration) && /p\.expires_at > now\(\)/.test(commerceMigration) && /commerce pilot is inactive or expired/.test(commerceWorker)],
  ['inventory snapshots are idempotent per four-hour slot', /unique \(sku_id, observed_slot\)/.test(commerceMigration) && /snapshotError\.code !== '23505'/.test(commerceWorker) && /eq\('sku_id', sku\.id\)\.eq\('observed_slot', run\.scheduled_for\)/.test(commerceWorker)],
  ['sync runs are fenced by claim token', /for update of r skip locked/.test(commerceMigration) && /claim_token = gen_random_uuid\(\)/.test(commerceMigration) && /interval '10 minutes'/.test(commerceMigration) && /eq\('claim_token', run\.claim_token\)\.eq\('status', 'running'\)/.test(commerceWorker) && /claim lost/.test(commerceWorker)],
  ['reorder alerts wait for seven full days of history', /7 \* 86_400_000/.test(commerceWorker) && /historyReady && stock != null/.test(commerceWorker)],
  ['critical alerts are deduplicated and marked only after Telegram accepts', /severity === 'critical' && !item\.alerted_at/.test(commerceDigest) && /if \(await tgSend\(target\.token, target\.chatId, criticalText\(row\)\)\)/.test(commerceDigest) && /\.is\('alerted_at', null\)/.test(commerceDigest)],
  ['daily digest is sent once per Tashkent day', /timeZone: 'Asia\/Tashkent'/.test(commerceDigest) && /digest_sent_at !== today/.test(commerceDigest) && /unsent\.length && await tgSend/.test(commerceDigest)],
  ['telegram deep links are short-lived and single-use', /interval '15 minutes'/.test(telegramLinksMigration) && /revoke all on public\.commerce_telegram_links from public, anon, authenticated/.test(telegramLinksMigration) && telegramWebhook.includes('commerce_([0-9a-f-]{36})') && /!link\.used_at && new Date\(link\.expires_at\) > new Date\(\)/.test(telegramWebhook) && /\.is\('used_at', null\)/.test(telegramWebhook)],
  ['commerce money is stored as integer tiyin', /unit_cost_tiyin: integer\(/.test(commerceControl) && /row\.price \* 100/.test(commerceWorker) && /Math\.round\(Number\(normalized\) \* 100\)/.test(commercePage) && /unit_cost_tiyin bigint/.test(commerceMigration)],
  ['SKU matching is exact with an unmatched queue', /matching is intentionally exact/.test(commerceControl) && /'unmatched'/.test(commerceControl) && /unique \(catalog_id, external_sku\)/.test(commerceMigration)],
  ['import staging is atomic, hashed and capped', /SHA256\.test\(fileHash\)/.test(commerceControl) && /inputRows\.length < 1 \|\| inputRows\.length > 500/.test(commerceControl) && /'import already staged'/.test(commerceControl) && /commerce_import_batches'\)\.delete\(\)\.eq\('id', batch\.id\)/.test(commerceControl) && /unique \(account_id, catalog_id, file_sha256\)/.test(commerceMigration)],
  ['Uzum stays read-only with approval-gated recommendations', /Read-only Uzum catalogue synchronizer/.test(commerceWorker) && /no recommendation is executed/.test(commerceDigest) && /never change Uzum prices/.test(commercePage) && /'reorder', 'price_guard', 'missing_data'/.test(commerceMigration)],
  ['production E2E accounts cannot trigger external commerce actions', /blocksExternalActions\(admin, profile\.account_id\)/.test(commerceControl) && /blocksExternalActions\(db, accountId\)/.test(commerceDigest)],
  ['commerce UI exposes the Telegram connect flow honestly', /telegram_connected/.test(commercePage) && /create_telegram_link/.test(commercePage) && /Open Telegram and press Start/.test(commercePage) && /Connect a Telegram bot in AI Teams first/.test(commerceControl)],
  ['worker slots are floored to four Tashkent hours', /Tashkent has no DST/.test(commerceWorker) && /getUTCHours\(\) % 4/.test(commerceWorker)],
  ['commerce cron schedules run on Tashkent time', /nemo-commerce-worker-tashkent/.test(deploy) && /0 19,23,3,7,11,15 \* \* \*/.test(deploy) && /nemo-commerce-digest-tashkent/.test(deploy) && /'0 4 \* \* \*'/.test(deploy)],
  ['all three commerce migrations are deployed and probed', /20260805090000_commerce_control_center\.sql/.test(deploy) && /20260805100000_commerce_alert_delivery\.sql/.test(deploy) && /20260805110000_commerce_telegram_links\.sql/.test(deploy) && /to_regclass\('public\.commerce_telegram_links'\) is not null/.test(deploy)],
  ['commerce-control keeps JWT verification enabled', /\[functions\.commerce-control\][\s\S]*?verify_jwt = true/.test(config)],

  // --- Smart auto-fill: estimates are provenance-tracked and never raise critical alerts ---
  ['estimated economics are provenance-tracked per field', /estimated_fields jsonb not null default '\[\]'::jsonb/.test(autofillMigration) && /jsonb_typeof\(estimated_fields\) = 'array'/.test(autofillMigration) && /estimated_fields/.test(commerceWorker)],
  ['auto-fill is owner-only and needs a completed sync', /security definer/.test(autofillMigration) && /u\.role = 'owner'/.test(autofillMigration) && /errcode = '42501'/.test(autofillMigration) && /status = 'completed'/.test(autofillMigration) && /no completed sync yet/.test(autofillMigration) && /revoke all on function public\.autofill_commerce_economics\(uuid\) from public, anon/.test(autofillMigration)],
  ['auto-fill never overwrites owner-entered economics', /s\.unit_cost_tiyin is null/.test(autofillMigration) && /not s\.estimated_fields \? 'unit_cost_tiyin'/.test(autofillMigration) && /coalesce\(s\.lead_time_days, 15\)/.test(autofillMigration)],
  ['estimates can only ever warn, never page', /can never raise a critical alert/.test(commerceWorker) && /const severityFor = \(critical: boolean, inputs: string\[\]\)/.test(commerceWorker) && /return critical && !guessed\.length \? 'critical' : 'warning'/.test(commerceWorker) && /severity: severityFor\(/.test(commerceWorker) && !/severity: stock \/ dailyVelocity/.test(commerceWorker) && !/severity: marginPercent <= 0/.test(commerceWorker)],
  ['recommendations disclose which inputs were estimated', /estimated_inputs: estimatesUsed\(reorderInputs\)/.test(commerceWorker) && /estimated_inputs: estimatesUsed\(priceInputs\)/.test(commerceWorker)],
  ['owner edits confirm a field and clear its estimate mark', /An explicit owner value confirms the field/.test(commerceControl) && /!providedKeys\.includes\(field\)/.test(commerceControl) && /economics_revision: sku\.economics_revision \+ 1/.test(commerceControl)],
  ['SKU economics edits are validated and concurrency-safe', /`\$\{field\} is invalid`/.test(commerceControl) && /eq\('economics_revision', sku\.economics_revision\)/.test(commerceControl) && /updated concurrently, reload and retry/.test(commerceControl)],
  ['auto-fill and inline editing are owner-gated actions', /action === 'autofill_economics' \|\| action === 'update_sku_economics'/.test(commerceControl) && /userDb\.rpc\('autofill_commerce_economics'/.test(commerceControl)],
  ['UI marks estimates and explains the alert cap', /Auto-fill estimates/.test(commercePage) && /never trigger critical alerts until you confirm them/.test(commercePage) && /Estimated by Nemo — confirm to enable critical alerts/.test(skuTable) && /Bulk alternative to the table above/.test(commercePage)],
  ['inline editing keeps money in tiyin', /Math\.round\(Number\(value\) \* 100\)/.test(skuTable) && /sku\.unit_cost_tiyin \/ 100/.test(skuTable)],
  ['auto-fill migration is deployed and probed', /20260805120000_commerce_economics_autofill\.sql/.test(deploy) && /column_name = 'estimated_fields'/.test(deploy) && /to_regprocedure\('public\.autofill_commerce_economics\(uuid\)'\) is not null/.test(deploy)],
]

let failed = 0
for (const [name, ok] of checks) {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`)
  if (!ok) failed++
}
if (failed) process.exit(1)
console.log(`Commerce/logistics contracts: ${checks.length}/${checks.length}`)
