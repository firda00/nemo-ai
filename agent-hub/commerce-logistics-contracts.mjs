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
const notifyChannelMigration = read('supabase/migrations/20260805130000_commerce_notify_channel.sql')
const proposalsMigration = read('supabase/migrations/20260805140000_commerce_economics_proposals.sql')
const economicsChat = read('supabase/functions/_shared/commerceEconomicsChat.ts')
const tgProcess = read('supabase/functions/_shared/tgProcess.ts')
const telegramHelper = read('supabase/functions/_shared/telegram.ts')
const telegramFormat = read('supabase/functions/_shared/telegramFormat.ts')
const i18nExtra = read('src/i18n/extra.ts')
const feeProposalsMigration = read('supabase/migrations/20260805160000_commerce_fee_proposals.sql')
const uzum = read('supabase/functions/_shared/uzum.ts')
const browserBridge = read('supabase/functions/browser-bridge/index.ts')
const uzumFees = read('supabase/functions/_shared/uzumFees.ts')
const unitEconomics = read('supabase/functions/_shared/unitEconomics.ts')
const minMarginMigration = read('supabase/migrations/20260806150000_commerce_catalog_min_margin.sql')
const defaultsMigration = read('supabase/migrations/20260806160000_commerce_catalog_defaults.sql')
const manualSyncMigration = read('supabase/migrations/20260806170000_commerce_manual_sync.sql')
const factsMigration = read('supabase/migrations/20260806210000_commerce_returns_sample.sql')
const returnsReserve = read('supabase/functions/_shared/returnsReserve.ts')
const economics = read('supabase/functions/_shared/unitEconomics.ts')
const logistics = read('supabase/functions/_shared/uzumLogistics.ts')
const resolvedMigration = read('supabase/migrations/20260806220000_commerce_recommendations_resolved.sql')
const listingModule = read('supabase/functions/_shared/listingDraft.ts')
const listingMigration = read('supabase/migrations/20260806240000_commerce_listing_drafts.sql')
const listingUi = read('src/components/platform/CommerceListingAgent.tsx')
const llmShared = read('supabase/functions/_shared/llm.ts')
const skuTable = read('src/components/platform/CommerceSkuTable.tsx')
const extensionExtract = read('extensions/nemo-browser/extract.js')
const extensionBackground = read('extensions/nemo-browser/background.js')
const extensionManifest = read('extensions/nemo-browser/manifest.json')

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
  ['critical alerts are deduplicated and marked only after Telegram accepts', /severity === 'critical' && !item\.alerted_at/.test(commerceDigest) && /if \(await tgSendHtml\(target\.token, target\.chatId, criticalText\(row\)\)\)/.test(commerceDigest) && /\.is\('alerted_at', null\)/.test(commerceDigest)],
  ['daily digest is sent once per Tashkent day', /timeZone: 'Asia\/Tashkent'/.test(commerceDigest) && /digest_sent_at !== today/.test(commerceDigest) && /unsent\.length && await tgSend/.test(commerceDigest)],
  ['telegram deep links are short-lived and single-use', /interval '15 minutes'/.test(telegramLinksMigration) && /revoke all on public\.commerce_telegram_links from public, anon, authenticated/.test(telegramLinksMigration) && telegramWebhook.includes('commerce_([0-9a-f-]{36})') && /const expired = link \? new Date\(link\.expires_at\) <= new Date\(\) : false/.test(telegramWebhook) && /if \(link && !link\.used_at && !expired\)/.test(telegramWebhook) && /\.is\('used_at', null\)/.test(telegramWebhook)],
  ['commerce money is stored as integer tiyin', /unit_cost_tiyin: integer\(/.test(commerceControl) && /row\.price \* 100/.test(commerceWorker) && /Math\.round\(Number\(normalized\) \* 100\)/.test(commercePage) && /unit_cost_tiyin bigint/.test(commerceMigration)],
  ['SKU matching is exact with an unmatched queue', /matching is intentionally exact/.test(commerceControl) && /'unmatched'/.test(commerceControl) && /unique \(catalog_id, external_sku\)/.test(commerceMigration)],
  ['import staging is atomic, hashed and capped', /SHA256\.test\(fileHash\)/.test(commerceControl) && /inputRows\.length < 1 \|\| inputRows\.length > 500/.test(commerceControl) && /'import already staged'/.test(commerceControl) && /commerce_import_batches'\)\.delete\(\)\.eq\('id', batch\.id\)/.test(commerceControl) && /unique \(account_id, catalog_id, file_sha256\)/.test(commerceMigration)],
  // The read-only promise now lives in the dictionaries, so it is asserted in every language
  // a seller can actually read — a translation that quietly dropped it would ship a page
  // claiming less than the system guarantees.
  ['Uzum stays read-only with approval-gated recommendations', /Read-only Uzum catalogue synchronizer/.test(commerceWorker) && /no recommendation is executed/.test(commerceDigest) && /'reorder', 'price_guard', 'missing_data'/.test(commerceMigration)
    && /never changes Uzum prices/.test(i18nExtra) && /не меняет цены на Uzum/.test(i18nExtra) && /Uzumda narxni o‘zgartirmaydi/.test(i18nExtra)],
  ['production E2E accounts cannot trigger external commerce actions', /blocksExternalActions\(admin, profile\.account_id\)/.test(commerceControl) && /blocksExternalActions\(db, accountId\)/.test(commerceDigest)],
  ['commerce UI exposes the Telegram connect flow honestly', /telegram_connected/.test(commercePage) && /create_telegram_link/.test(commercePage) && /commerce\.tgOpen/.test(commercePage) && /Connect a Telegram bot in AI Teams first/.test(commerceControl)
    && /Open Telegram and press Start/.test(i18nExtra) && /Откройте Telegram и нажмите Start/.test(i18nExtra) && /Telegramni ochib, Start bosing/.test(i18nExtra)],
  ['worker slots are floored to four Tashkent hours', /Tashkent has no DST/.test(commerceWorker) && /getUTCHours\(\) % 4/.test(commerceWorker)],
  ['commerce cron schedules run on Tashkent time', /nemo-commerce-worker-tashkent/.test(deploy) && /0 19,23,3,7,11,15 \* \* \*/.test(deploy) && /nemo-commerce-digest-tashkent/.test(deploy) && /'0 4 \* \* \*'/.test(deploy)],
  ['all three commerce migrations are deployed and probed', /20260805090000_commerce_control_center\.sql/.test(deploy) && /20260805100000_commerce_alert_delivery\.sql/.test(deploy) && /20260805110000_commerce_telegram_links\.sql/.test(deploy) && /to_regclass\('public\.commerce_telegram_links'\) is not null/.test(deploy)],
  ['commerce-control keeps JWT verification enabled', /\[functions\.commerce-control\][\s\S]*?verify_jwt = true/.test(config)],

  // --- Smart auto-fill: estimates are provenance-tracked and never raise critical alerts ---
  ['estimated economics are provenance-tracked per field', /estimated_fields jsonb not null default '\[\]'::jsonb/.test(autofillMigration) && /jsonb_typeof\(estimated_fields\) = 'array'/.test(autofillMigration) && /estimated_fields/.test(commerceWorker)],
  ['auto-fill is owner-only and needs a completed sync', /security definer/.test(autofillMigration) && /u\.role = 'owner'/.test(autofillMigration) && /errcode = '42501'/.test(autofillMigration) && /status = 'completed'/.test(autofillMigration) && /no completed sync yet/.test(autofillMigration) && /revoke all on function public\.autofill_commerce_economics\(uuid\) from public, anon/.test(autofillMigration)],
  ['auto-fill never overwrites owner-entered economics', /s\.unit_cost_tiyin is null/.test(autofillMigration) && /not s\.estimated_fields \? 'unit_cost_tiyin'/.test(autofillMigration) && /coalesce\(s\.lead_time_days, 15\)/.test(autofillMigration)],
  ['estimates can only ever warn, never page', /can never raise a critical alert/.test(commerceWorker) && /const severityFor = \(critical: boolean, inputs: string\[\]\)/.test(commerceWorker) && /return critical && !guessed\.length \? 'critical' : 'warning'/.test(commerceWorker) && /severity: severityFor\(/.test(commerceWorker) && !/severity: stock \/ dailyVelocity/.test(commerceWorker) && !/severity: marginPercent <= 0/.test(commerceWorker)],
  // A valued reorder rests on the cost and fee fields too, so its disclosure covers those as
  // well — otherwise a profit figure built on an estimated cost would look confirmed.
  ['recommendations disclose which inputs were estimated', commerceWorker.includes('estimatesUsed(outcome ? valueInputs : reorderInputs)') && commerceWorker.includes('estimated_inputs: estimatesUsed(priceInputs)')],
  ['owner edits confirm a field and clear its estimate mark', /An explicit owner value confirms the field/.test(commerceControl) && /!providedKeys\.includes\(field\)/.test(commerceControl) && /economics_revision: sku\.economics_revision \+ 1/.test(commerceControl)],
  ['SKU economics edits are validated and concurrency-safe', /`\$\{field\} is invalid`/.test(commerceControl) && /eq\('economics_revision', sku\.economics_revision\)/.test(commerceControl) && /updated concurrently, reload and retry/.test(commerceControl)],
  ['auto-fill and inline editing are owner-gated actions', /action === 'autofill_economics' \|\| action === 'update_sku_economics'/.test(commerceControl) && /userDb\.rpc\('autofill_commerce_economics'/.test(commerceControl)],
  // The estimate cap is the one promise that stops a guessed number from paging someone at
  // night. Every language must still say it, and the CSV path must still read as optional.
  ['UI marks estimates and explains the alert cap', /commerce\.autofill/.test(commercePage) && /commerce\.economicsHint/.test(commercePage) && /commerce\.sku\.estimatedTitle/.test(skuTable) && /commerce\.bulkHint/.test(commercePage)
    && /never trigger critical alerts until you confirm them/.test(i18nExtra) && /не вызывает срочных оповещений, пока вы её не подтвердите/.test(i18nExtra) && /shoshilinch ogohlantirish yubormaydi/.test(i18nExtra)],
  ['commerce copy exists in all three languages', ['extraUz', 'extraRu', 'extraEn'].every((name) => {
    const at = i18nExtra.indexOf(`export const ${name} = {`)
    return at >= 0 && i18nExtra.slice(at, at + 6000).includes('"commerce":')
  })],
  ['inline editing keeps money in tiyin', /Math\.round\(Number\(value\) \* 100\)/.test(skuTable) && /sku\.unit_cost_tiyin \/ 100/.test(skuTable)],

  // --- Telegram onboarding must never fail silently or through the wrong bot ---
  ['a dead or unknown deep link gets an answer, not silence', /must say so\. Staying silent here/.test(telegramWebhook) && /уже использована или истекла/.test(telegramWebhook) && /Ссылка не распознана/.test(telegramWebhook)],
  ['successful linking confirms in chat', /Nemo Commerce подключён/.test(telegramWebhook) && /не меняет цены и не оформляет заказы на Uzum/.test(telegramWebhook)],
  ['notifications bind to the channel that received /start', /notify_channel_id: channelId/.test(telegramWebhook) && /channel_id: channelId/.test(telegramWebhook) && /notify_channel_id uuid references public\.channels\(id\)/.test(notifyChannelMigration)],
  ['digest sends through the bound bot first', /notify_chat_id, notify_channel_id/.test(commerceDigest) && /eq\('id', profile\.notify_channel_id\)/.test(commerceDigest) && /cannot\s*\n?\s*\/\/ open a conversation|cannot/.test(commerceDigest)],
  ['bot fallback is deterministic and connected-only', /eq\('status', 'connected'\)\.order\('created_at', \{ ascending: true \}\)/.test(commerceDigest) && /order\('created_at', \{ ascending: true \}\)/.test(commerceControl)],
  ['notify channel migration is deployed', /20260805130000_commerce_notify_channel\.sql/.test(deploy)],
  ['connect button cannot mint duplicate links', /setBusy\('connect'\)/.test(commercePage) && /a double click minted several one-time links/.test(commercePage)],

  // --- Telegram economics input: parse, confirm, only then write ---
  ['only the bound owner chat can propose economics', /eq\('notify_chat_id', chatId\)\.eq\('notify_channel_id', channelId\)/.test(economicsChat) && /const owner = await ownerChatFor\(db, channelId, chatId\)/.test(tgProcess) && /const owner = await ownerChatFor\(db, channelId, chatId\)/.test(telegramWebhook)],
  ['the model only parses, it never writes', /The LLM only PARSES/.test(economicsChat) && /Never writes to\r?\n\/\/ commerce_skus/.test(tgProcess) && /never invent a number that was not stated/.test(economicsChat)],
  ['proposals are stored pending and expire', /status text not null default 'pending'/.test(proposalsMigration) && /interval '1 hour'/.test(proposalsMigration) && /proposal expired/.test(proposalsMigration)],
  ['a proposal that changes nothing is rejected by the schema', /check \(unit_cost_tiyin is not null or lead_time_days is not null or safety_stock is not null or min_margin_percent is not null\)/.test(proposalsMigration)],
  ['applying is service-role only and re-checks ownership', /revoke all on function public\.apply_commerce_economics_proposal\(uuid\) from public, anon, authenticated/.test(proposalsMigration) && /grant execute on function public\.apply_commerce_economics_proposal\(uuid\) to service_role/.test(proposalsMigration) && /SKU does not belong to this account/.test(proposalsMigration) && /for update;/.test(proposalsMigration)],
  ['confirming clears estimate marks and bumps the revision', /estimated_fields = v_estimated/.test(proposalsMigration) && /economics_revision = s\.economics_revision \+ 1/.test(proposalsMigration) && /field <> all \(v_applied\)/.test(proposalsMigration)],
  ['money moves only on an explicit Yes', /if \(arg !== 'y'\)/.test(telegramWebhook) && /status: 'rejected'/.test(telegramWebhook) && /apply_commerce_economics_proposal/.test(telegramWebhook) && /only place money moves/.test(telegramWebhook)],
  ['a button press is bound to its own chat and account', /proposal\.chat_id !== chatId \|\| proposal\.account_id !== owner\.accountId/.test(telegramWebhook) && /Это подтверждение недоступно/.test(telegramWebhook)],
  ['a decided or expired proposal cannot be pressed again', /proposal\.status !== 'pending'/.test(telegramWebhook) && /eq\('status', 'pending'\)/.test(telegramWebhook) && /Срок подтверждения истёк/.test(telegramWebhook)],
  ['SKU matching stays exact with disambiguation buttons', /matching stays exact/.test(economicsChat) && /normalize\(sku\.external_sku\) === needle/.test(economicsChat) && /pickKeyboard/.test(tgProcess) && /я не подставляю похожие товары/.test(tgProcess)],
  ['voice works because parsing runs after transcription', /Runs after transcription, so voice behaves like text/.test(tgProcess)],
  ['non-economics owner messages still reach the agent', /looksLikeEconomics\(text\)/.test(tgProcess) && /if \(OPENROUTER_API_KEY && looksLikeEconomics\(text\)\)/.test(tgProcess)],
  // A team bot carries scope='group'; that branch returns for private chats too, so anything
  // placed after it never runs in the owner's DM.
  ['owner DM handling runs before the group-bot branch', tgProcess.indexOf('const owner = await ownerChatFor') < tgProcess.indexOf('// GROUP task-bot') && /has to run BEFORE the group branch/.test(tgProcess)],
  ['a bare /start is answered instead of ignored', /\^\\\/start\(\?:@\\w\+\)\?\$/.test(tgProcess) && /Здравствуйте! Это Nemo/.test(tgProcess) && /Connect Telegram notifications/.test(tgProcess)],
  ['only internal bots get Nemo-branded greetings', /customer-facing DM bot, which must keep its persona/.test(tgProcess) && /channel\.scope === 'group' && \/\^\\\/start/.test(tgProcess)],
  ['extraction does not depend on the agent chat model', /Deliberately NOT agent\.model/.test(tgProcess) && /parseEconomicsMessage\(apiKey, PRIMARY_MODEL, text\)/.test(tgProcess)],
  // Lives in llm.ts since the Listing Agent needed the same parser. One copy, two callers.
  ['a fenced or chatty JSON reply is still parsed', /export function stripJsonFence/.test(llmShared) && /text\.slice\(start, end \+ 1\)/.test(llmShared) && /stripJsonFence as stripFence/.test(economicsChat)],
  ['matching survives real marketplace whitespace and either name field', /replace\(\/\\s\+\/g, ' '\)/.test(economicsChat) && /normalize\(sku\.external_sku\) === needle \|\| normalize\(sku\.title\) === needle/.test(economicsChat) && /external\.includes\(needle\)/.test(economicsChat)],
  ['cabinet fees are read deterministically, never by a model', /Deliberately NOT an LLM call/.test(uzumFees) && /(?<!\d)/.test(uzumFees) && !/callOpenRouter|openai/i.test(uzumFees)],
  ['an unrecognised fees page yields nothing rather than a guess', /returns nothing when it is unsure/.test(uzumFees) && /value < 0 || value > max/.test(uzumFees)],
  ['catalogue-wide fees only fill blanks', /only FILL BLANKS/.test(feeProposalsMigration)
    && feeProposalsMigration.includes('coalesce(s.commission_percent, v_proposal.commission_percent)')
    && feeProposalsMigration.includes('v_proposal.commission_percent is not null and s.commission_percent is null')],
  ['a browser proposal still needs an owner and a confirmation', /action === 'propose_fees' || action === 'apply_proposal'/.test(commerceControl) && /Ownership is re-checked here/.test(commerceControl) && /source: 'browser'/.test(commerceControl)],
  ['the owner sees the evidence behind a scraped number', /Echo the exact lines the numbers were read from/.test(commercePage) && /evidence/.test(commerceControl)],
  ['every commerce migration is registered for deploy', ['20260805140000','20260805150000','20260805160000'].every((id) => deploy.includes(id))],
  // Plain substring checks: these assert exact code, and escaping them as regexes has broken
  // this file twice already for no added strictness.
  ['one definition of margin, shared by alerts and calculators', unitEconomics.includes('The single definition of unit economics')
    && commerceWorker.includes("from '../_shared/unitEconomics.ts'")
    && !commerceWorker.includes('const net = priceTiyin - sku.unit_cost_tiyin')],
  // Was: the reserve added to commission as a share of price. That is what this replaces.
  ['margin accounts for the returns reserve', unitEconomics.includes('effectiveFulfillmentTiyin(fees)') && commerceWorker.includes('returns_reserve_percent')],
  ['impossible economics return no answer rather than a negative', unitEconomics.includes('if (load >= 100) return null') && unitEconomics.includes('value > 0 ? Math.round(value) : null')],
  ['a reorder states what it costs and returns', commerceWorker.includes('batchOutcome(units') && commerceWorker.includes('investment_tiyin: outcome?.investment_tiyin') && commerceWorker.includes('roi_percent: outcome?.roi_percent')],
  ['price guard states the floor price, not only the breach', commerceWorker.includes('min_selling_price_tiyin: floorTiyin')],
  ['batch valuation is flagged when it rests on estimates', commerceWorker.includes('estimatesUsed(outcome ? valueInputs : reorderInputs)')],
  ['a failed product read is recorded on the catalogue, not just the run', commerceWorker.includes('Record the reason on the catalogue') && commerceWorker.includes('last_sync_error:')],
  ['a shop the key cannot read stays queued so it can heal', commerceWorker.includes('Status deliberately stays') && !commerceWorker.includes("status: products.access === 'no_access'")],
  ['the HTTP status is kept so permissions and shop state stay distinguishable', commerceWorker.includes('(HTTP ${products.status})') && uzum.includes('status: response.status')],
  ['the owner sees which shops are not syncing', commercePage.includes('commerce.syncIssuesTitle') && commercePage.includes('catalog.last_sync_error')],
  ['a catalogue margin fills blanks and spares a deliberate per-SKU value', minMarginMigration.includes('min_margin_percent = coalesce(s.min_margin_percent, v_proposal.min_margin_percent)') && minMarginMigration.includes('v_proposal.min_margin_percent is not null and s.min_margin_percent is null') && minMarginMigration.includes('must not have it flattened')],
  ['the deploy probe executes the no-overwrite guarantee', deploy.includes('catalogue margin overwrote a deliberate per-SKU margin') && deploy.includes('catalogue margin did not reach a blank SKU')],
  ['setting a catalogue margin is owner-only and only a proposal', commerceControl.includes("action === 'propose_min_margin'") && commerceControl.includes("source: 'ui'") && commercePage.includes('propose_min_margin')],
  ['the margin confirmation counts only blank SKUs', commerceControl.includes(".is('min_margin_percent', null)") && commercePage.includes('commerce.okMargin')],
  ['tenant isolation runs before any function is updated on deploy', deploy.includes('npm run test:security-live') && deploy.includes('TENANT ISOLATION FAILED')],
  ['catalogue defaults are inherited by a trigger, not by one caller', defaultsMigration.includes('before insert on public.commerce_skus') && defaultsMigration.includes('holds\n-- for every path that can create a SKU')],
  ['an explicit value always beats the catalogue default', defaultsMigration.includes('coalesce(new.min_margin_percent, d.default_min_margin_percent)') && defaultsMigration.includes('Only fills what the caller left null')],
  ['unit cost has no catalogue default on purpose', defaultsMigration.includes('Unit cost has no catalogue default on purpose') && !defaultsMigration.includes('default_unit_cost')],
  ['a catalogue proposal records the default as well as filling blanks', defaultsMigration.includes('default_min_margin_percent = coalesce(v_proposal.min_margin_percent') && defaultsMigration.includes("becomes the catalogue's standing default")],
  ['the deploy probe proves a later SKU inherits', deploy.includes('a later SKU did not inherit the catalogue default margin') && deploy.includes('the catalogue default overwrote an explicit value on insert')],
  ['the defaults migration is registered for deploy', deploy.includes('20260806160000_commerce_catalog_defaults.sql')],
  ['the manual sync cooldown is claimed in SQL, not checked in the function', manualSyncMigration.includes('the UPDATE\'s own WHERE clause is the lock') && manualSyncMigration.includes('last_manual_sync_at <= now() - make_interval') && commerceControl.includes('claim_commerce_manual_sync')],
  ['a manual retry only requeues the caller\'s own runs', manualSyncMigration.includes('c.account_id = p_account') && manualSyncMigration.includes('must never reset another tenant')],
  ['manual sync is owner-only and reports this account\'s failures by name', commerceControl.includes("action === 'sync_now'") && commerceControl.includes('issues:') && commercePage.includes('issues.map((i) => i.name)')],
  ['the cooldown message explains whose key it protects', i18nExtra.includes('не нагружать ваш ключ Uzum') && i18nExtra.includes('your own Uzum key from being throttled')],
  ['auto-fill covers every catalogue on the account', commerceControl.includes('No catalogue id means every catalogue on the account') && commercePage.includes("action: 'autofill_economics' }") && !commercePage.includes("action: 'autofill_economics', catalog_id")],
  ['the manual sync migration is registered for deploy', deploy.includes('20260806170000_commerce_manual_sync.sql')],
  ['the digest lists only what needs a decision', commerceDigest.includes('Zero noise: the list contains only what needs a decision today') && commerceDigest.includes("rows.filter((row) => row.kind === 'reorder')") && commerceDigest.includes("rows.filter((row) => row.kind === 'price_guard')")],
  ['missing-data rows never enter the list', !commerceDigest.includes("не хватает данных для расчёта") && commerceDigest.includes('they are a single standing fact about the catalogue, not a hundred events')],
  ['incomplete economics collapse into one closing line', commerceDigest.includes('One line, never a list') && commerceDigest.includes('себестоимость заполнена примерно')],
  ['a reorder in the digest carries its money, not just a count', commerceDigest.includes('action.investment_tiyin != null && action.profit_tiyin != null') && commerceDigest.includes('ROI')],
  ['a margin breach names the floor price', commerceDigest.includes('calc.min_selling_price_tiyin != null') && commerceDigest.includes('Минимальная цена')],
  ['catalogue facts are counted from SKUs, not from recommendations', commerceDigest.includes('Counted from the SKUs themselves rather than') && commerceDigest.includes('statsByAccount')],
  // The capture that was supposed to settle the tariff brought back the chapter list instead.
  ['a snapshot captures the article, not the chapter list', extensionExtract.includes('a documentation page is mostly navigation') && extensionExtract.includes('MORE PROSE THAN ALL ITS SIBLINGS')],
  ['content is found by prose, so a div-built menu cannot hide as content', extensionExtract.includes('is made of links') && extensionExtract.includes("querySelectorAll('a')") && extensionExtract.includes('prose: Math.max(0, text.length - linked)')],
  ['a short article is never answered with the whole page', extensionExtract.includes('No length floor here') && !/return bestMeasure.length > MIN_CONTENT_LENGTH/.test(extensionExtract)],
  ['the extractor runs on the path the snapshot button actually uses', extensionBackground.includes("import { extractObservation } from './extract.js'") && extensionBackground.includes('func: extractObservation') && !extensionBackground.includes('document.body?.innerText ||')],
  ['there is no second, unregistered copy of the extractor', !extensionManifest.includes('content_scripts')],
  ['a truncated snapshot reports that it was truncated', extensionExtract.includes('totalLength: full.length') && browserBridge.includes('const truncated = Number.isFinite(totalLength)') && browserBridge.includes('stored_characters: text.length')],
  ['no edge function may shadow the global URL constructor', !browserBridge.includes("const URL = Deno.env.get") && browserBridge.includes('NOT named URL')],
  ['the bridge still constructs URLs to validate the host', browserBridge.includes('new URL(sourceUrl)') && browserBridge.includes("HOSTS.has(parsed.hostname)")],
  // Uzum facts: the commission, category and dimensions the API already returns.
  ['the logistics fee comes from the published tariff, not a guess', logistics.includes('seller.uzum.uz/manual/3.tariffs') && logistics.includes('effectiveFrom') && logistics.includes('Math.ceil((l * w * h) / 1_000_000)')],
  ['a SKU without dimensions pays the maximum, never zero', logistics.includes('withoutDimensionsTiyin') && logistics.includes('would overstate margin on exactly the products whose data is weakest')],
  ['Uzum commission and dimensions are captured by the worker', uzum.includes('commissionPercent') && uzum.includes('skuDimension') && commerceWorker.includes('commerce_apply_uzum_facts_batch')],
  ['the return reserve is stored as an estimate, never as fact', factsMigration.includes('Shrinking the rate makes it usable; it does not') && factsMigration.includes("'[\"returns_reserve_percent\"]'::jsonb")],
  ['a sync never overwrites a value the owner set', factsMigration.includes('The owner owns it') && factsMigration.includes('v_owns_commission := v_sku.commission_percent is not null')],
  ['a value Uzum supplied stops counting as a guess', factsMigration.includes('A value Uzum supplied is no longer a guess')],
  ['an unchanged sync writes nothing', factsMigration.includes('Nothing moved: no write, no revision bump') && factsMigration.includes('is not distinct from v_sku.commission_percent')],
  ['facts are applied per catalogue, not per SKU round trip', commerceWorker.includes('One call for the whole catalogue') && !commerceWorker.includes("db.rpc('commerce_apply_uzum_facts',")],
  // The return reserve: Uzum's raw percentage hid its own denominator.
  ['the reserve is derived from counts, never from returnedPercentage', uzum.includes('quantitySold') && uzum.includes('quantityReturned') && !/num\((?:sku|product)\?\.returnedPercentage\)/.test(uzum)],
  ['a thin sample borrows its rate from the category, and the category from the catalogue', returnsReserve.includes('a SKU toward its') && returnsReserve.includes('borrows from the catalogue before it') && returnsReserve.includes('export function reservesForCatalogue')],
  ['the reserve is never capped, so a genuinely bad product still shows', returnsReserve.includes('There is deliberately no upper cap')],
  ['an unsold SKU in an unsold catalogue gets no invented reserve', returnsReserve.includes('inventing a reserve for it would put a number the owner never gave')],
  ['the worker shrinks across the whole catalogue before writing facts', commerceWorker.includes('reservesForCatalogue') && commerceWorker.includes('return_sample_units: row.soldUnits')],
  ['the sample behind the reserve is stored for the owner to judge', factsMigration.includes('returns_sample_units integer') && factsMigration.includes('returns_sample_units = v_next_sample')],
  ['rates written by the old unshrunk path are cleared, not left to rot', factsMigration.includes('would repair on its own') && factsMigration.includes('set returns_reserve_percent = null')],
  ['the old nine-argument facts function cannot survive as an overload', factsMigration.includes('drop function if exists public.commerce_apply_uzum_facts(uuid, text, numeric, bigint, numeric, integer, integer, integer, integer)')],
  // A return costs shipping, not the retail price.
  ['a return is not charged as a lost sale price', economics.includes('A RETURN IS NOT A LOST SALE PRICE') && economics.includes('const percentageLoad = (fees: Fees) => fees.commission_percent') && !/percentageLoad[^\n]*returns_reserve_percent/.test(economics)],
  ['the return rate cannot touch the margin, per the published tariff', economics.includes('export function effectiveFulfillmentTiyin') && economics.includes('(1 + RETURN_FEE_MULTIPLIER * (r / (1 - r)))') && economics.includes('the published tariff each of those is billed nothing')],
  ['the floor price and the margin use the same fee', economics.includes('effectiveFulfillmentTiyin(fees)) * 100) / (100 - load)') && economics.includes('/ 100 - effectiveFulfillmentTiyin(fees)')],
  ['a total-return rate stays finite instead of becoming NaN', economics.includes('RETURN_RATE_CEILING = 0.95') && economics.includes('a NaN would compare false against the minimum margin and silently')],
  ['a returned unit is billed nothing, and the tariff is cited for it', economics.includes('export const RETURN_FEE_MULTIPLIER = 0') && economics.includes('ZERO, and that is the tariff talking') && economics.includes('per sold unit at handover')],
  ['the alert shows the fee its own margin used', commerceWorker.includes('effective_fulfillment_tiyin: Math.round(effectiveFulfillmentTiyin(fees))') && commerceWorker.includes('the owner cannot')],
  ['an alert that stopped being true is closed, not left open', commerceWorker.includes("status: 'resolved', resolved_at: new Date().toISOString()") && commerceWorker.includes(".lt('last_detected_at', runStartedAt)")],
  ['an alert that came back re-opens, so closing it once cannot silence it', commerceWorker.includes("status: 'open', resolved_at: null") && commerceWorker.includes(".gte('last_detected_at', runStartedAt)")],
  ['a sync never overwrites the owner dismissing an alert', commerceWorker.includes("Those are the owner's verbs") && !commerceWorker.includes("status: 'dismissed'")],
  ['resolved is a status the database actually allows', resolvedMigration.includes("check (status in ('open', 'dismissed', 'accepted', 'expired', 'resolved'))") && resolvedMigration.includes('resolved_at timestamptz')],
  ['price guards from the old margin model are cleared once', resolvedMigration.includes('charged a returned unit') && resolvedMigration.includes("and kind = 'price_guard'")],
  // Listing Agent: the draft is the product, and Nemo does not publish it.
  ['Nemo never publishes a listing, and the schema cannot express that it did', listingMigration.includes("status in ('draft', 'ready', 'discarded')") && !listingMigration.includes("'published'") && listingMigration.includes('THERE IS NO PUBLISHED STATUS')],
  ['a draft is owner-only to create and decide', commerceControl.includes("action === 'draft_listing'") && commerceControl.includes("|| action === 'draft_listing' || action === 'approve_listing_draft' || action === 'discard_listing_draft'")],
  ['the model writes prose and never a number', listingModule.includes('Never write a price, a discount, a delivery time or a warranty') && listingModule.includes('Never invent a material')],
  ['numbers are extracted from the owner text by pattern, not by model', listingModule.includes('export function extractNumbers') && listingModule.includes('A cost needs a word that means cost')],
  ['a price the model returned is discarded rather than stored', listingModule.includes('export function parseCopy') && !/price/i.test(listingModule.split('export function parseCopy')[1].split('\n}')[0])],
  ['the commission comes from categories the seller already sells in', listingModule.includes('The commission is never guessed') && commerceControl.includes('Commission and returns are read off')],
  ['an unmatched category asks the owner instead of borrowing a number', listingModule.includes('full list comes back to pick from') && commerceControl.includes('category_choices: category ? [] : candidates.options')],
  // The signal that actually bridges Russian input to Uzbek category names.
  ["the seller's own product names are what match the category", listingModule.includes('Words shared with their OWN PRODUCT NAMES') && listingModule.includes('export interface SkuExemplar') && commerceControl.includes('const exemplars = (skuRows ?? []).map')],
  ['one common word never picks a commission, and a tie never does either', listingModule.includes('Two matched words minimum') && listingModule.includes('const decisive = Boolean(best) && best.score > 0 && (!runnerUp || runnerUp.score < best.score)')],
  ['a product with no dimensions is priced at the real no-VGH rate', listingModule.includes('the expensive truth') && listingModule.includes("fulfillment_basis: input.dimension ? 'dimensions' : 'no_dimensions'")],
  ['no commission or no cost means no floor price, never a guessed one', listingModule.includes('a floor computed from a guessed commission') && listingModule.includes('const floor = fees && input.unitCostTiyin != null')],
  ['a draft missing inputs cannot be approved', commerceControl.includes('approving a listing with no floor price is how a product gets sold below cost') && commerceControl.includes("error: 'draft still missing inputs'")],
  ['the floor price and Price Guard share one definition', listingModule.includes("from './unitEconomics.ts'") && listingModule.includes("from './uzumLogistics.ts'")],
  ['a model outage still leaves the owner the economics', listingModule.includes('the ECONOMICS are the part that does not depend on') && commerceControl.includes('The copy is optional on purpose')],
  ['the interface names what the draft does not know', listingUi.includes('missingTitle') && listingUi.includes('disabled={missing.length > 0') && listingUi.includes('commerce.listing.missing.')],
  ['JSON fence stripping has one home, not two', llmShared.includes('export function stripJsonFence') && economicsChat.includes("import { stripJsonFence as stripFence }") && !/^function stripFence/m.test(economicsChat)],
  ['the listing drafts migration is registered for deploy', deploy.includes('20260806240000_commerce_listing_drafts.sql')],
  ['the Uzum facts migrations are registered for deploy', ['20260806180000', '20260806190000', '20260806200000', '20260806210000', '20260806220000'].every((id) => deploy.includes(id))],
  ['proposals migration is deployed', /20260805140000_commerce_economics_proposals\.sql/.test(deploy)],

  // --- Hand-written Telegram copy must render, and marketplace data must not break it ---
  ['our own markup is sent unescaped, agent output still is not', /tgSend\(\) runs agent output through/.test(telegramHelper) && /export async function tgSendHtml/.test(telegramHelper) && /parse_mode: 'HTML'/.test(telegramHelper)],
  ['commerce messages never go through the escaping sender', !/\btgSend\(/.test(commerceDigest) && !/\btgSend\(/.test(telegramWebhook) && /tgSendHtml/.test(commerceDigest) && /tgSendHtml/.test(telegramWebhook)],
  ['interpolated marketplace data is escaped', /export function escapeHtml/.test(telegramFormat) && /escapeHtml\(String\(row\.title/.test(commerceDigest) && /escapeHtml\(sku\.title\)/.test(economicsChat) && /escapeHtml\(parsed\.product\)/.test(tgProcess)],
  // The wording moved into the single closing line when the digest stopped listing every
  // incomplete product; what must not disappear is the instruction on how to fix it.
  ['the digest tells the owner how to unblock the numbers', commerceDigest.includes('надиктуйте её текстом или голосом прямо в этот чат') && commerceDigest.includes('себестоимость 20000, доставка 12 дней')],
  ['the welcome message explains that the chat accepts input', /Можно отвечать прямо сюда/.test(telegramWebhook) && /наговорите голосом/.test(telegramWebhook)],
  ['auto-fill migration is deployed and probed', /20260805120000_commerce_economics_autofill\.sql/.test(deploy) && /column_name = 'estimated_fields'/.test(deploy) && /to_regprocedure\('public\.autofill_commerce_economics\(uuid\)'\) is not null/.test(deploy)],
]

let failed = 0
for (const [name, ok] of checks) {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`)
  if (!ok) failed++
}
if (failed) process.exit(1)
console.log(`Commerce/logistics contracts: ${checks.length}/${checks.length}`)
