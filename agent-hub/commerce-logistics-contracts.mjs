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
const deploy = read('deploy.ps1')

const checks = [
  ['four commerce team blueprints exist', ['marketplace:', 'dropshipping:', "'online-store':", 'logistics:'].every((key) => blueprints.includes(key))],
  ['templates create persistent teams', /createCommerceTeam\(tpl\.commerceKey, addAgent, deleteAgent, \{ model, niche \}\)/.test(marketplace) && /saveDynamicTeam\(addAgent, bp, deleteAgent\)/.test(blueprints)],
  ['partial team creation is rolled back', /const rollback = async/.test(teamPersistence) && /if \(subErr\)[\s\S]*rollback\(dep\.id\)/.test(teamPersistence) && /!res\.error && res\.agentId && res\.departmentId/.test(marketplace)],
  ['marketplace team is honest about read-only access', /WB\/Ozon tools are connected separately and remain read-only/.test(blueprints)],
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
]

let failed = 0
for (const [name, ok] of checks) {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`)
  if (!ok) failed++
}
if (failed) process.exit(1)
console.log(`Commerce/logistics contracts: ${checks.length}/${checks.length}`)
