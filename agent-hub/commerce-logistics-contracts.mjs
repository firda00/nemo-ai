import { readFileSync } from 'node:fs'

// Окончания строк нормализуются ПРИ ЧТЕНИИ.
//
// Рабочее дерево здесь CRLF, а проверки сравнивают исходный текст. Без нормализации каждое
// сравнение с переводом строки надо писать как \r?\n, и забытое место падает НА ИСПРАВНОМ КОДЕ —
// обычно сразу после git checkout, когда причину ищут в последней правке, а она не там.
const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n')
const blueprints = read('src/lib/commerceTeams.ts')
const marketplace = read('src/pages/app/MarketplacePage.tsx')
const teamDetail = read('src/pages/app/TeamDetailPage.tsx')
const runner = read('src/components/platform/OpsWorkflowRunner.tsx')
const teamPersistence = read('src/lib/dynamicTeams.ts')
const workflow = read('supabase/functions/logistics-workflow/index.ts')
const parser = read('supabase/functions/_shared/logisticsInput.ts')
const config = read('supabase/config.toml')
const migration = read('supabase/migrations/20260711160000_logistics_workflow.sql')
const atomicTeamMigration = read('supabase/migrations/20260803140000_atomic_agent_teams.sql')
const deploy = read('deploy.ps1')
const commerceControl = read('supabase/functions/commerce-control/index.ts')
const commerceWorker = read('supabase/functions/commerce-worker/index.ts')
const trendModule = read('supabase/functions/_shared/salesTrend.ts')
const submitModule = read('supabase/functions/_shared/listingSubmit.ts')
const submissionsMigration = read('supabase/migrations/20260813140000_listing_submissions.sql')
const uzumModule = read('supabase/functions/_shared/uzum.ts')
const trendMigration = read('supabase/migrations/20260813120000_commerce_sales_trend.sql')
const commerceDigest = read('supabase/functions/commerce-digest/index.ts')
const telegramWebhook = read('supabase/functions/telegram-webhook/index.ts')
const commercePage = read('src/pages/app/CommercePage.tsx')
const commerceMigration = read('supabase/migrations/20260805090000_commerce_control_center.sql')
const telegramLinksMigration = read('supabase/migrations/20260805110000_commerce_telegram_links.sql')
const autofillMigration = read('supabase/migrations/20260805120000_commerce_economics_autofill.sql')
const notifyChannelMigration = read('supabase/migrations/20260805130000_commerce_notify_channel.sql')
const proposalsMigration = read('supabase/migrations/20260805140000_commerce_economics_proposals.sql')
const economicsChat = read('supabase/functions/_shared/commerceEconomicsChat.ts')
const freshness = read('supabase/functions/_shared/commerceFreshness.ts')
const emptyShop = read('supabase/migrations/20260808170000_commerce_empty_shop.sql')
const freshnessMigration = read('supabase/migrations/20260807190000_commerce_freshness_watchdog.sql')
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
const descriptionMigration = read('supabase/migrations/20260810120000_listing_description_blocks.sql')
const ownerStatedMigration = read('supabase/migrations/20260810130000_listing_owner_stated_fees.sql')
const categoryLabelsMigration = read('supabase/migrations/20260810140000_category_labels.sql')
const categoryLabelsModule = read('supabase/functions/_shared/categoryLabels.ts')
const categoryLabelUi = read('src/lib/categoryLabel.ts')
const deadstockMigration = read('supabase/migrations/20260810150000_commerce_deadstock.sql')
const priceTarget = read('supabase/functions/_shared/priceTarget.ts')
const quality = read('agent-hub/quality-gate.ps1')
const packageJson = read('package.json')
const paywallLib = read('src/lib/paywall.ts')
const visionModule = read('supabase/functions/_shared/listingVision.ts')
const llmModule = read('supabase/functions/_shared/llm.ts')
const imagesModule = read('supabase/functions/_shared/listingImages.ts')
const uploadLib = read('src/lib/listingImageUpload.ts')
const invoicesMigration = read('supabase/migrations/20260812110000_billing_invoices.sql')
const billingLive = read('agent-hub/billing-entitlement-live.mjs')
const entitlementModule = read('supabase/functions/_shared/entitlement.ts')
const protocolModule = read('supabase/functions/_shared/paymentProtocol.ts')
const protocolTest = read('agent-hub/payment-protocol-behavior.mjs')
const paymeEndpoint = read('supabase/functions/payme-webhook/index.ts')
const clickEndpoint = read('supabase/functions/click-webhook/index.ts')
const invoiceEndpoint = read('supabase/functions/billing-invoice/index.ts')
const numericIdsMigration = read('supabase/migrations/20260813090000_billing_numeric_ids.sql')
const transactionsMigration = read('supabase/migrations/20260812130000_billing_transactions.sql')
const planMigration = read('supabase/migrations/20260812120000_invoice_sets_plan.sql')
const agentWorker = read('supabase/functions/agent-worker/index.ts')
const opsAutopilot = read('supabase/functions/ops-autopilot/index.ts')
const orgMemoryWorker = read('supabase/functions/org-memory-worker/index.ts')
const uploadUi = read('src/components/platform/ListingImageUpload.tsx')
const imagesMigration = read('supabase/migrations/20260811130000_listing_images_bucket.sql')
const paywallDialog = read('src/components/ui/PaywallDialog.tsx')
const priceChat = read('supabase/functions/_shared/commercePriceChat.ts')
const priceChatTest = read('agent-hub/price-chat-behavior.mjs')
const webhook = read('supabase/functions/telegram-webhook/index.ts')
const acceptPriceMigration = read('supabase/migrations/20260810160000_commerce_accept_price.sql')
const adviceSentMigration = read('supabase/migrations/20260810170000_price_advice_sent.sql')
const listingMigration = read('supabase/migrations/20260806240000_commerce_listing_drafts.sql')
const listingUi = read('src/components/platform/CommerceListingAgent.tsx')
const listingChat = read('supabase/functions/_shared/commerceListingChat.ts')
const costMigration = read('supabase/migrations/20260806250000_commerce_uzum_purchase_price.sql')
const costCampaign = read('supabase/functions/_shared/commerceCostCampaign.ts')
const batchMigration = read('supabase/migrations/20260806260000_commerce_cost_batch.sql')
const ownerMigration = read('supabase/migrations/20260806270000_commerce_owner_value_outranks_uzum.sql')
const stockoutMigration = read('supabase/migrations/20260806280000_commerce_stockout.sql')
const llmShared = read('supabase/functions/_shared/llm.ts')
const skuTable = read('src/components/platform/CommerceSkuTable.tsx')
const findingsUi = read('src/components/platform/CommerceFindings.tsx')
const listingAgent = read('src/components/platform/CommerceListingAgent.tsx')
const providerKey = read('supabase/functions/_shared/providerKey.ts')
const connectProvider = read('supabase/functions/connect-provider/index.ts')
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
  // Was: "unsent.length && await tgSend(...)" — which pinned the digest to send ONLY when there
  // were unsent findings. That conjunction was the silence bug itself: a dead sync produces no
  // findings, so the seller heard nothing on the day it mattered. What must stay true is that a
  // finding is reported once per Tashkent day, not that an empty finding list buys silence.
  ['a finding is digested once per Tashkent day', /timeZone: 'Asia\/Tashkent'/.test(commerceDigest) && /digest_sent_at !== today/.test(commerceDigest) && /digest_sent_at: today/.test(commerceDigest)],
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
  // Граница функции режется по /\r?\n\}/, а не по строке '\n}': дерево CRLF, и такой строки в нём
  // нет — split вернул бы ВЕСЬ остаток файла, и проверка искала бы «price» в чужом коде.
  ['a price the model returned is discarded rather than stored', listingModule.includes('export function parseCopy') && !/price/i.test(listingModule.split('export function parseCopy')[1].split(/\r?\n\}/)[0])],
  ['the commission comes from categories the seller already sells in', listingModule.includes('The commission is never guessed') && listingChat.includes('Commission and returns are pooled per category')],
  ['an unmatched category asks the owner instead of borrowing a number', listingModule.includes('full list comes back to pick from') && commerceControl.includes('category_choices: category ? [] : candidates.options')],
  // The signal that actually bridges Russian input to Uzbek category names.
  ["the seller's own product names are what match the category", listingModule.includes('Words shared with their OWN PRODUCT NAMES') && listingModule.includes('export interface SkuExemplar') && listingChat.includes('exemplars: (rows ?? []).map')],
  ['one common word never picks a commission, and a tie never does either', listingModule.includes('Two matched words minimum') && listingModule.includes('const decisive = Boolean(best) && best.score > 0 && (!runnerUp || runnerUp.score < best.score)')],
  ['a product with no dimensions is priced at the real no-VGH rate', listingModule.includes('the expensive truth') && listingModule.includes("fulfillment_basis: input.dimension ? 'dimensions' : 'no_dimensions'")],
  ['no commission or no cost means no floor price, never a guessed one', listingModule.includes('a floor computed from a guessed commission') && listingModule.includes('const floor = fees && input.unitCostTiyin != null')],
  ['a draft missing inputs cannot be approved', commerceControl.includes('approving a listing with no floor price is how a product gets sold below cost') && commerceControl.includes("error: 'draft still missing inputs'")],
  ['the floor price and Price Guard share one definition', listingModule.includes("from './unitEconomics.ts'") && listingModule.includes("from './uzumLogistics.ts'")],
  ['a model outage still leaves the owner the economics', listingModule.includes('the ECONOMICS are the part that does not depend on') && commerceControl.includes('The copy is optional on purpose')],
  ['the interface names what the draft does not know', listingUi.includes('missingTitle') && listingUi.includes('disabled={missing.length > 0') && listingUi.includes('commerce.listing.missing.')],
  ['JSON fence stripping has one home, not two', llmShared.includes('export function stripJsonFence') && economicsChat.includes("import { stripJsonFence as stripFence }") && !/^function stripFence/m.test(economicsChat)],
  ['the listing drafts migration is registered for deploy', deploy.includes('20260806240000_commerce_listing_drafts.sql')],
  // Listing Agent in Telegram: same pipeline, same refusals, one more surface.
  ['a new listing is triggered explicitly, never guessed from an economics message', listingChat.includes('The trigger is EXPLICIT') && listingChat.includes('export function newListingText') && tgProcess.includes('BEFORE the economics branch on purpose')],
  ['the Telegram draft uses the same modules as the interface', listingChat.includes("from './listingDraft.ts'") && listingChat.includes('draftEconomics({') && !listingChat.includes('commission_percent: 30')],
  ['category buttons fit Telegram callback data instead of being truncated', listingChat.includes('export function categoryToken') && listingChat.includes('caps callback_data at 64 BYTES') && !/callback_data: .${CB_LISTING_CATEGORY}:${draft.id}:${option.category}/.test(listingChat)],
  ['approval is refused in Telegram while anything is missing', listingChat.includes("? [{ text: '✖️ Убрать черновик'") && telegramWebhook.includes('Approval is refused while anything is missing') && telegramWebhook.includes('if (missing.length) {')],
  ['a chosen category recomputes the floor price rather than patching it', listingChat.includes('Recomputed, not patched') && listingChat.includes('export async function applyCategory')],
  ['a forwarded listing button cannot move another account draft', telegramWebhook.includes('draft.account_id !== owner.accountId')],
  ['Telegram approval still publishes nothing', telegramWebhook.includes('Nemo туда ничего не пишет') && !telegramWebhook.includes("status: 'published'")],
  ['model text reaches Telegram escaped', listingChat.includes("import { escapeHtml } from './telegramFormat.ts'") && listingChat.includes('escapeHtml(draft.title_ru')],
  ['the commission is gathered from every catalogue, not one picked by a tie', listingChat.includes('Every catalogue, not one') && listingChat.includes("eq('status', 'active')") && !listingChat.includes("order('created_at').limit(1)") && !commerceControl.includes("eq('status', 'active').order('created_at').limit(1)")],
  ['both surfaces share one catalogue reader', commerceControl.includes("import { catalogueContext } from '../_shared/commerceListingChat.ts'") && commerceControl.includes('const context = await catalogueContext(admin, profile.account_id)')],
  ['a matched shelf brings its own shop and margin target', listingModule.includes('Which catalogue the shelf lives in') && listingChat.includes('category?.min_margin_percent ?? context.defaultMinMargin') && commerceControl.includes('catalog_id: category?.catalog_id ?? null')],
  // The sales report: every read since day one asked for a window in the year 55000.
  ['the sales window is expressed in seconds, which is what Uzum answers', uzum.includes('const to = Math.floor(Date.now() / 1000)') && uzum.includes('const from = to - days * 86_400') && !uzum.includes('const to = Date.now()')],
  ['a wrongly-asked window can no longer look like a quiet week', uzum.includes('reported: number | null') && uzum.includes('totalElements') && uzum.includes('indistinguishable from a')],
  ['finance pages are spaced so a 429 is not mistaken for no sales', uzum.includes('Uzum answers back-to-back finance calls with 429')],
  ['the purchase price Uzum states on a sale is captured', uzum.includes('costBySku') && uzum.includes("pick(item, ['purchasePrice'])")],
  ['sales are keyed by the variant Uzum names, not the product card', uzum.includes("pick(item, ['skuTitle', 'productId', 'id'])") && uzum.includes('skuTitle FIRST') && commerceWorker.includes('The finance report names the variant')],
  // The purchase price Uzum states on a completed sale.
  ['a cost Uzum charged replaces an estimate and never an owner value', costMigration.includes('never touches a number the owner stated') && costMigration.includes("v_owns_cost := v_sku.unit_cost_tiyin is not null") && costMigration.includes("'[\"unit_cost_tiyin\"]'::jsonb")],
  ['where a cost came from is recorded, not inferred later', costMigration.includes("unit_cost_source in ('uzum_sale', 'owner', 'estimate')") && costMigration.includes('Backfill the label')],
  ['the worker sends the real purchase price per variant', commerceWorker.includes('sales.costBySku?.[row.name]') && commerceWorker.includes('Reported in sum')],
  ['severity is gated by the inputs the margin really uses', unitEconomics.includes('export const MARGIN_INPUTS') && unitEconomics.includes('silently holding every price alert down to a warning') && commerceWorker.includes('const priceInputs = [...MARGIN_INPUTS]')],
  ['the purchase price migration is registered for deploy', deploy.includes('20260806250000_commerce_uzum_purchase_price.sql')],
  // The cost campaign: 135 SKUs still on a placeholder, dictated in batches.
  ['no model parses a dictated batch of costs', costCampaign.includes('NO MODEL PARSES THE BATCH') && costCampaign.includes('export function parseCostBatch') && !costCampaign.includes('callOpenRouter')],
  ['a number too small to be a price is reported, never stored', costCampaign.includes('MIN_COST_UZS') && costCampaign.includes('a margin of 99% on the table')],
  ['an ambiguous name is asked about, never resolved by picking the first', costCampaign.includes('Ambiguity is reported, never resolved by picking the first') && costCampaign.includes("kind: 'ambiguous'")],
  ['a batch with nothing savable offers no save button', costCampaign.includes('if (!savable) return undefined')],
  ['one dictation is one confirmation, applied under a lock', batchMigration.includes('apply_commerce_cost_batch') && batchMigration.includes('for update skip locked') && batchMigration.includes('cannot be applied later by a stale button')],
  ['a batch belongs to the chat that dictated it', telegramWebhook.includes('row.chat_id !== chatId || row.account_id !== owner.accountId')],
  ['the remaining count is scoped to the owner account', telegramWebhook.includes('costCampaignState(db, owner.accountId, 0)') && telegramWebhook.includes('another')],
  ['only estimated costs are ever asked for again', costCampaign.includes('is already the truth and must never be asked for again') && costCampaign.includes("includes('unit_cost_tiyin')")],
  ['the campaign runs above the single-item economics path', tgProcess.includes('asksWhatNext(text)') && tgProcess.includes('looksLikeCostBatch(text)') && tgProcess.indexOf('looksLikeCostBatch(text)') < tgProcess.indexOf('looksLikeEconomics(text)')],
  ['a pasted calculation is never read as a dictated cost', costCampaign.includes('COMPUTED_LINE') && costCampaign.includes('somebody else') && costCampaign.includes('COMPUTED_LINE.test(segment)')],
  ['a cost at or above the selling price is refused whatever the parse did', costCampaign.includes("kind: 'implausible'") && costCampaign.includes('Nobody buys for what they') && costCampaign.includes('item.costUzs >= price')],
  ['the plausibility check has the price to check against', costCampaign.includes('export async function latestPricesUzs') && tgProcess.includes('latestPricesUzs(db, skus.map')],
  ['a confirmed value leaves both provenance lists, so a sync cannot take it back', ownerMigration.includes('Out of BOTH lists') && ownerMigration.includes('api_fields = v_api') && ownerMigration.includes('outrank a reading')],
  ['a dictated cost is labelled as the owner value it is', ownerMigration.includes("unit_cost_source = case when v_proposal.unit_cost_tiyin is not null then 'owner'") && ownerMigration.includes('Repair the rows already confirmed')],
  ['the ownership migration is registered for deploy', deploy.includes('20260806270000_commerce_owner_value_outranks_uzum.sql')],
  // Out of stock is knowable from the first sync; the reorder planner needs a week of velocity.
  ['a stockout is reported without waiting for sales history', commerceWorker.includes("kind: 'stockout'") && commerceWorker.includes('needs a week of velocity before it can') && stockoutMigration.includes("'stockout'")],
  ['demand makes a stockout urgent, absence of demand does not', commerceWorker.includes("severity: (sold7d ?? 0) > 0 ? 'critical' : 'warning'") && commerceWorker.includes('stock is a fact from')],
  ['only stockouts with demand are listed; the rest are one line', commerceDigest.includes('ninety-four bullet points is a wall') && commerceDigest.includes('const urgentStockouts') && commerceDigest.includes('без продаж за неделю')],
  ['the stockout migration is registered for deploy', deploy.includes('20260806280000_commerce_stockout.sql')],
  // The web page showed every input and none of the conclusions.
  ['the interface shows what the sync concluded, not only what it read', findingsUi.includes('on the screen where the owner can act on it') && commerceControl.includes("action === 'list_findings'") && commercePage.includes('<CommerceFindings')],
  ['the Zero Noise rule holds on the page as it does in the digest', findingsUi.includes('the large quiet background collapses into a single') && findingsUi.includes('quietStockouts') && findingsUi.includes('stockoutQuiet')],
  ['a floor price built on an estimate is marked as such on screen', findingsUi.includes('estimated_inputs') && findingsUi.includes('rests on a Nemo guess rather than on their own figure')],
  ['findings are scoped to the account catalogues', commerceControl.includes("eq('account_id', profile.account_id)") && commerceControl.includes("in('sku_id', [...byId.keys()])")],
  ['the table says whose number the cost is, not merely that it is a guess', skuTable.includes('unit_cost_source') && skuTable.includes('they are not') && skuTable.includes('sourceOwner')],
  // Onboarding: from a pasted key to the first audit, without four buttons in the right order.
  ['a pasted Bearer prefix is stripped before Uzum can answer 403 for it', providerKey.includes('answers a Bearer prefix with') && providerKey.includes('Authorization') && connectProvider.includes('normalizeKey(body?.api_key)') && !/String\(body\?\.api_key \?\? ''\)\.trim\(\)/.test(connectProvider)],
  ['key normalisation lives where it can be tested outside Deno', providerKey.includes('tested outside Deno') && !providerKey.includes('esm.sh')],
  ['onboarding is one idempotent action, not four ordered buttons', commerceControl.includes("action === 'onboard'") && commerceControl.includes('Every step') && commerceControl.includes('alreadyQueued')],
  ['a first sync is started, not awaited and called finished', commerceControl.includes('sync_started: true') && commerceControl.includes('spinner that ends and one that lies')],
  ['an empty page offers one way to start, not four',
    // Раньше три кнопки прятались на пустой странице. Теперь их нет в шапке вовсе: редкие
    // действия переехали в «Настройки», а обновление осталось иконкой без слов. Свойство стало
    // строже — соседнюю кнопку больше не с чем спутать.
    commercePage.includes("Три равновеликие кнопки в шапке дважды приводили к тому")
    && commercePage.includes("{pilot?.status !== 'active' && (")
    && commercePage.includes('commerce.onboard.action')],
  ['the connect card disappears once there is something to look at', commercePage.includes('!loading && !catalogs.length') && commercePage.includes('commerce.onboard.action')],
  ['the first sync is kicked through waitUntil, not a bare un-awaited fetch', commerceControl.includes('waitUntil, NOT a bare un-awaited fetch') && commerceControl.includes('runtime?.waitUntil') && commerceControl.includes('const kick = fetch')],
  ['the cost batch migration is registered for deploy', deploy.includes('20260806260000_commerce_cost_batch.sql')],
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
  // Vita Market Plus стоял 55 часов, каждые четыре часа помечая себя здоровым: чтение прошло,
  // ошибки нет, товаров ноль. Пустой магазин и отвалившиеся на фильтре карточки давали одну и ту
  // же тишину — первое лечит продавец, второе мы.
  // Пустой магазин — не авария. Тревога о нём была бы неправдой о том, что случилось, и научила
  // бы владельца отключать уведомления.
  ['a connected shop with no products is a nudge, never an alarm',
    freshness.includes("state: 'empty'") && freshness.includes('export const brokenCatalogues')
    && commerceDigest.includes('const broken = brokenCatalogues(stale)')
    && commerceDigest.includes('const brokenForDigest = brokenCatalogues(stale)')
    && /emptyNotice\(stale, \{ multiShop \}\)/.test(commerceDigest)],

  ['the nudge is sent once, and never after the owner confirms',
    /empty_notified_at: new Date\(\)\.toISOString\(\)/.test(commerceDigest)
    && /\.is\('empty_notified_at', null\)/.test(commerceDigest)
    && /!item\.emptyConfirmed && !item\.emptyNotified/.test(freshness)],

  // Магазин, опустевший ПОСЛЕ того как торговал, — это уже новость, и подтверждение прошлого
  // месяца не должно её глушить.
  ['confirming emptiness expires the moment products appear',
    /empty_confirmed_at: null, empty_notified_at: null/.test(commerceWorker)],

  // Пауза выбросила бы магазин из синхронизации навсегда, включая тот день, когда продавец
  // добавит первый товар. Меняется суждение, а не наблюдение.
  ['a confirmed-empty shop keeps syncing rather than being paused out of existence',
    // Сломанная форма процитирована в комментарии намеренно — это и есть объяснение. Проверяем
    // исполняемую строку: `set status =`, а не упоминание.
    emptyShop.includes('ПОЧЕМУ НЕ status') && !/set status =/.test(emptyShop)
    && /and status = 'active' and empty_confirmed_at is null/.test(emptyShop)],

  ['only Uzum\'s own answer turns silence into "empty", never a guess',
    /const EMPTY_SHOP_REASON = \/вернул 0 карточек\/i/.test(freshness)],

  // Аккаунт держит несколько ботов, и назвать нужный можно только по привязке. Имя агента вдобавок
  // врёт: «Создай AI-команду для управления магазином» звучит как нужный бот и им не является.
  // Одиннадцать карточек подряд — лента, а не страница. Разложены по вкладкам, но вкладка ПРЯЧЕТ,
  // и это тот же дефект, что «страница есть, а пункта в меню нет», только внутри страницы.
  // marginTitle ждём дважды: заголовок карточки и aria-label поля ввода — поле без имени
  // недоступно для чтения с экрана, и убирать его ради круглого числа было бы регрессом.
  ['every block survived the split exactly once',
    Object.entries({
      // syncIssuesTitle ждём дважды: заголовок карточки и подпись красной точки на корешке —
      // точка без имени недоступна для чтения с экрана.
      'commerce.findings.title': 1, 'commerce.syncIssuesTitle': 2, 'commerce.proposalsTitle': 1,
      'commerce.economicsTitle': 1, 'commerce.listing.title': 1, 'commerce.stagedTitle': 1,
      'commerce.feesTitle': 1, 'commerce.marginTitle': 2, 'commerce.tgTitle': 1,
      'commerce.economicsFile': 1,
    }).every(([key, want]) => (commercePage.match(new RegExp(key.replace(/\./g, '\\.'), 'g')) ?? []).length === want)],

  // Выводы и сбои синка — единственное, что требует внимания сегодня. За корешком им не место.
  ['conclusions and sync failures stay on the first tab, never behind one',
    /\{\(tab === 'overview' \|\| !catalogs\.length\) && \(<>/.test(commercePage)
    && commercePage.indexOf("commerce.findings.title") > commercePage.indexOf("tab === 'overview'")
    // Последнее вхождение, а не первое: первое теперь принадлежит подписи точки на корешке,
    // а карточка со сбоями лежит ниже, внутри «Обзора».
    && commercePage.lastIndexOf("commerce.syncIssuesTitle") > commercePage.indexOf("tab === 'overview'")
    && commercePage.lastIndexOf("commerce.syncIssuesTitle") < commercePage.indexOf("tab === 'costs'")],

  ['what waits for a decision is counted on the tab it hides behind',
    /\['costs', t\('commerce\.tabs\.costs'\), proposals\.length, false\]/.test(commercePage)
    && /waiting > 0 && <span/.test(commercePage)
    // Поломка помечается точкой, а не числом: «Обзор 1» рядом с видимыми 78 находками читалось
    // как ошибка счёта — число на корешке обещает пересчитать содержимое вкладки.
    && /broken && <span className="h-1\.5 w-1\.5 rounded-full bg-danger"/.test(commercePage)],

  // От выбора магазина зависят комиссия, маржа, автозаполнение и загрузка файла — на четырёх
  // разных вкладках. Спрятать его на одной значило бы обесточить кнопки на трёх остальных.
  ['the shop selector sits above the tabs, not inside one',
    // Он стоит у названия модуля, выше вкладок: выбранный магазин меняет данные на всех сразу.
    commercePage.indexOf("aria-label={t('commerce.catalog')}") < commercePage.indexOf('role="tablist"')
    && commercePage.indexOf("aria-label={t('commerce.catalog')}") > commercePage.indexOf("commerce.title")],

  ['the tab labels exist in all three languages',
    ['tabs": { "overview": "Umumiy', 'tabs": { "overview": "Обзор', 'tabs": { "overview": "Overview']
      .every((label) => i18nExtra.includes(label))],

  // В кабинете Uzum заголовок, описание и каждая характеристика — отдельные поля. «Скопировать
  // всё» там бесполезно: пришлось бы вычищать чужие строки из буфера прямо в форме.
  ['each listing field can be copied on its own',
    /function CopyButton/.test(listingAgent)
    && /navigator\.clipboard\.writeText\(text\)/.test(listingAgent)
    && ['draft.title_ru ?? \'\'', 'draft.title_uz', 'draft.description_ru', 'draft.description_uz']
        .every((field) => listingAgent.includes(`<CopyButton text={${field}}`))],

  // Копируется значение, а не «Цвет: Чёрный»: название поля в форме уже написано слева.
  ['an attribute copies its value, not its label',
    /<CopyButton text=\{attribute\.value\}/.test(listingAgent)
    && !/<CopyButton text=\{`\$\{attribute\.name\}/.test(listingAgent)],

  // Буфер обмена не виден. Без ответа непонятно, сработало ли нажатие, а повторное нажатие
  // «на всякий случай» ничего не проверяет.
  ['copying confirms itself, because the clipboard is invisible',
    /setDone\(true\)/.test(listingAgent) && /done \? <Check/.test(listingAgent)],

  ['the uzbek description is shown, not only stored',
    /draft\.description_uz && \(/.test(listingAgent)],

  // ── Описание — четыре блока, а не абзац ────────────────────────────────────────────────────

  ['the prompt asks for hook, intro, advantages and specs in both languages',
    ['Block 1 — HOOK', 'Block 2 — INTRO', 'Основные преимущества:', 'Характеристики:',
     'Asosiy afzalliklari:', 'Xususiyatlari:'].every((part) => listingModule.includes(part))],

  // Разметка не переживает буфер обмена: writeText несёт голые символы, и `**жирный**` доедет до
  // формы Uzum звёздочками. Выделение делает структура, а не звёздочки.
  ['the generated text carries no markup, because the clipboard carries none',
    listingModule.includes('PLAIN TEXT ONLY') && /No markdown, no \*\*bold\*\*/.test(listingModule)],

  // Три символа регулярного выражения обесценивали бы весь промпт: \s+ → ' ' схлопывает буллеты
  // в абзац ещё до записи в базу.
  ['the parser keeps line breaks in a description and drops them in a title',
    /const block = \(value: unknown, limit: number\)/.test(listingModule)
    && /description_ru: block\(row\.description_ru, 2200\)/.test(listingModule)
    && /title_ru: text\(row\.title_ru, 100\)/.test(listingModule)],

  ['the column accepts the text the parser is willing to store',
    descriptionMigration.includes('char_length(description_ru) <= 2200')
    && descriptionMigration.includes('char_length(description_uz) <= 2200')
    && deploy.includes('20260810120000_listing_description_blocks.sql')],

  // Иначе в буфер уходит структура, а на экране остаётся абзац — расхождение хуже обоих вариантов.
  ['the screen renders the breaks it stores',
    (listingAgent.match(/whitespace-pre-line/g) ?? []).length >= 2],

  ['two structured descriptions have room to be generated',
    /maxTokens: 1800/.test(listingModule)],

  // ── Полка выбирается для существующего черновика ───────────────────────────────────────────

  ['picking a category recomputes an existing draft instead of regenerating it',
    /action === 'set_listing_category'/.test(commerceControl)
    // Модель не вызывается: полка меняет арифметику, а не текст.
    // Граница берётся по САМОМУ обработчику: имя действия встречается раньше, в списке
    // owner-действий, и отрезанный от него кусок захватил бы генерацию целиком.
    && !/generateCopy/.test(commerceControl.split("if (action === 'set_listing_category') {")[1].split("if (action === 'approve_listing_draft'")[0])
    && /min_selling_price_tiyin: economics\.min_selling_price_tiyin/.test(commerceControl)],

  ['the recompute is owner-only and refuses a draft already decided',
    /action === 'set_listing_category' \|\| action === 'onboard'/.test(commerceControl)
    && /draft\.status !== 'draft'/.test(commerceControl)],

  // Черновик без категории переживает перезагрузку страницы, а список из ответа на генерацию — нет.
  ['the shelves travel with the draft list, not only with a generation',
    /categories: context\.options/.test(commerceControl)
    && /setCategories\(result\?\.ok \? result\.categories \?\? \[\] : \[\]\)/.test(commercePage)],

  ['the picker sits on the card that lacks a category, not above the form',
    /!draft\.uzum_category && draft\.status === 'draft' && categories\.length > 0/.test(listingAgent)
    && !/categoryChoices/.test(listingAgent)
    && !/categoryChoices/.test(commercePage)],

  // Ключ с точкой внутри имени не разрешается резолвером t(): он идёт по вложенным путям, и
  // "missing.category" превращается в подпись `commerce.listing.missing.category` на экране.
  // Исключение — metricLabel и subjectWord: они читаются как словарь через dict, не через t().
  ['no i18n key hides a dot inside its own name',
    (() => {
      const withoutMaps = i18nExtra.replace(/"(metricLabel|subjectWord)": \{[\s\S]*?\n {4}\},/g, '')
      return [...withoutMaps.matchAll(/^\s*"([a-zA-Z_][a-zA-Z0-9_]*\.[a-zA-Z0-9_.]+)":/gm)].length === 0
    })()],

  ['every missing-field label resolves, in all three languages',
    (i18nExtra.match(/"missing": \{/g) ?? []).length === 3
    && i18nExtra.includes('"category": "Категория"')],

  // ── Полка, которой у продавца ещё нет ──────────────────────────────────────────────────────
  // Комиссия читается из категорий, где он УЖЕ торгует. Товар из новой ниши такой полки не имеет,
  // и без ручного ввода система отказывала на каждом первом товаре нового направления.

  ['a commission the owner states is validated, not trusted',
    /export function manualCategory/.test(listingModule)
    && /commission \+ input\.minMarginPercent >= 100/.test(listingModule)
    && /commission > 99\.99/.test(listingModule)],

  ['a stated commission is marked as stated, in the database and on the card',
    ownerStatedMigration.includes('owner_stated_fields')
    && /owner_stated_fields: ownerStated/.test(commerceControl)
    // Перезапись, а не дополнение: выбрав потом настоящую полку, владелец обязан потерять пометку.
    && /const ownerStated = known \? \[\] : \[\.\.\.OWNER_STATED_FEE_FIELDS\]/.test(commerceControl)
    && /owner_stated_fields \?\? \[\]\)\.includes\('commission_percent'\)/.test(listingAgent)
    && (listingAgent.match(/ownerStatedTitle/g) ?? []).length >= 2
    && deploy.includes('20260810130000_listing_owner_stated_fees.sql')],

  // Число, присланное для СВОЕЙ полки, молча заменило бы факт, прочитанный у Uzum.
  ['a stated commission cannot overwrite one Uzum already gave',
    /const known = context\.options\.find/.test(commerceControl)
    && /const manual = known \? null : manualCategory\(/.test(commerceControl)
    && /manual \? \{ commission_percent: manual\.commission_percent/.test(commercePage)],

  // Резерв на возвраты в минимальную цену не входит: RETURN_FEE_MULTIPLIER = 0, возврат по
  // тарифу Uzum не тарифицируется. Подпись поля обязана это сказать, иначе оно читается как
  // часть цены — и владелец будет крутить его, ожидая, что цена поедет.
  // ── Полки читаются на языке владельца ──────────────────────────────────────────────────────
  // Uzum отдаёт ОДНО имя полки, узбекское: в товарном ответе есть `category` и нет ни локали, ни
  // второго названия. «Забирать оба языка при синхронизации» — не вариант реализации.

  ['the shelf name is translated once and kept, not translated per render',
    categoryLabelsMigration.includes('create table if not exists public.commerce_category_labels')
    && /resolveCategoryLabels/.test(commerceControl)
    && /const missing = wanted\.filter\(\(name\) => !out\[name\]\)/.test(commerceControl)
    && /if \(!missing\.length\) return out/.test(commerceControl)],

  // Перевод — подпись. Ключом везде остаётся узбекское имя: по нему сходятся товары, считается
  // комиссия и лежат черновики. Полка, сменившая имя из-за нового перевода, разошлась бы со
  // своими же товарами — молча и необратимо.
  ['the translated name is never what gets sent back',
    /value=\{choice\.category\}/.test(listingAgent)
    && /\{categoryLabel\(choice\.category, labels, lang\)\}/.test(listingAgent)
    && /if \(!wanted\.has\(category\) \|\| seen\.has\(category\)\) continue/.test(categoryLabelsModule)],

  ['an untranslated shelf shows the name Uzum gave it, not a blank',
    /if \(!row\) return category/.test(categoryLabelsModule)
    && /return row\.label_ru \?\? category/.test(categoryLabelsModule)],

  ['a model outage costs the labels, not the list',
    /\.catch\(\(\) => \[\] as CategoryLabel\[\]\)/.test(commerceControl)
    && /if \(!apiKey\) return out/.test(commerceControl)
    && deploy.includes('20260810140000_category_labels.sql')],

  // ── Логистические алерты ───────────────────────────────────────────────────────────────────

  // Число считалось и раньше — им решалась срочность, — но наружу не выходило. «Пополнить» без
  // срока не задача: единственный вопрос владельца — когда.
  ['the reorder finding says when the stock runs out, not only that it will',
    /days_left: daysLeft/.test(commerceWorker)
    && /const daysLeft = dailyVelocity > 0 \? Math\.round\(\(stock \/ dailyVelocity\) \* 10\) \/ 10 : null/.test(commerceWorker)
    && /calculation\?\.days_left === 'number'/.test(findingsUi)
    && /calc\.days_left \?\?/.test(commerceDigest)],

  // Порог в 14 дней наблюдений — то, что отличает застой от вторника. На пяти днях истории
  // детектор пометил бы 45 позиций из 141: формально верно и практически бесполезно.
  ['deadstock stays silent until there is enough history to mean it',
    deadstockMigration.includes('p_min_days    integer default 14')
    && /w\.days_observed >= p_min_days/.test(deadstockMigration)
    // Считаются НАБЛЮДАВШИЕСЯ дни, а не разница дат: пропущенная синхронизация не должна
    // превращаться в «наблюдали, всё было плохо».
    && /count\(distinct date_trunc\('day', s\.observed_slot\)\)/.test(deadstockMigration)
    && /coalesce\(w\.max_sold, 0\) = 0/.test(deadstockMigration)
    && /coalesce\(l\.stock_total, 0\) > 0/.test(deadstockMigration)],

  ['deadstock never wakes anyone at night',
    /kind: 'deadstock',[\s\S]{0,400}?severity: 'warning'/.test(commerceWorker)
    && deadstockMigration.includes("kind in ('reorder', 'price_guard', 'missing_data', 'stockout', 'deadstock')")
    && deploy.includes('20260810150000_commerce_deadstock.sql')],

  // Без своей ветки застой вышел бы из одиночного алерта словами «Рекомендуем заказать N шт.»
  // про товар, который и так лежит — тот же дефект, что уже ловили на нулевых остатках.
  ['a stuck product is not told to be reordered',
    /row\.kind === 'deadstock'/.test(commerceDigest)
    && /Товар лежит без движения/.test(commerceDigest)
    && /function deadstockLine/.test(commerceDigest)],

  ['the digest and the screen both carry the two new alerts',
    /🧊 <b>Лежит без движения<\/b>/.test(commerceDigest)
    && /kind === 'deadstock'/.test(findingsUi)
    && ['"deadstock": "Лежит без движения"', '"deadstock": "Harakatsiz yotibdi"', '"deadstock": "Sitting still"']
      .every((label) => i18nExtra.includes(label))],

  // ── Целевая цена ───────────────────────────────────────────────────────────────────────────

  // Пол — не рекомендация, а граница. Совет ниже него означал бы «продайте дешевле, чем вы сами
  // назвали приемлемым», и владелец перенёс бы это число в кабинет.
  ['no price advice ever goes below the floor',
    /Math\.max\(target, floor\)/.test(priceTarget)
    && /Math\.max\(discounted, floor\)/.test(priceTarget)
    && /if \(floor >= input\.currentTiyin\) return null/.test(priceTarget)],

  // Своей алгебры здесь нет: две копии одной формулы однажды разойдутся, и продавец встретит
  // противоречие — калькулятор назовёт цену, а дайджест назовёт её убыточной.
  ['the advice borrows the platform arithmetic instead of copying it',
    /from '\.\/unitEconomics\.ts'/.test(priceTarget)
    && !/\/ \(100 - load\)/.test(priceTarget)],

  // Неразрывный пробел из toLocaleString уехал бы вместе с числом в поле цены Uzum.
  ['the number meant for the clipboard is bare digits',
    /<code>\$\{Math\.round\(advice\.target_tiyin \/ 100\)\}<\/code>/.test(priceTarget)
    && /Nemo не меняет цену на Uzum/.test(priceTarget)],

  // ── Кнопки и гипотеза ──────────────────────────────────────────────────────────────────────

  // Кнопку можно переслать, callback_data — подделать, а число из чата набирает человек.
  // Единственное место, где проверку пола нельзя обойти, — база.
  ['the floor is enforced in the database, not only in the button',
    acceptPriceMigration.includes('if p_price_tiyin < v_floor then')
    && acceptPriceMigration.includes("'below_floor'")
    && acceptPriceMigration.includes("'no_floor'")
    && /kind not in \('price_guard', 'deadstock'\)/.test(acceptPriceMigration)],

  // Ожидание называет ЧИСЛО. «Цена выше пола» сбудется и когда владелец поставил пол, и когда он
  // поставил ровно то, что советовали, — а это разные исходы с разной прибылью.
  ['accepting a price registers that exact number as the hypothesis',
    /'value', p_price_tiyin/.test(acceptPriceMigration)
    && /make_interval\(days => 7\)/.test(acceptPriceMigration)
    && /org_decision_register/.test(acceptPriceMigration)
    && /accepted_price_tiyin/.test(acceptPriceMigration)],

  ['a repeated press cannot register a second decision',
    /if v_rec\.status <> 'open' then/.test(acceptPriceMigration)
    && /where id = p_recommendation_id and status = 'open'/.test(acceptPriceMigration)],

  // Лимит Telegram — 64 БАЙТА. Кнопка, вышедшая за него, приходит обрезанной и не совпадает ни с
  // чем: нажатие молча не делает ничего.
  ['the price buttons fit the telegram limit and carry the number they show',
    /callback_data: `\$\{CB_PRICE\}:\$\{recommendationId\}:y:\$\{uzs\}`/.test(priceChat)
    && /const encoder = new TextEncoder\(\)/.test(priceChatTest)],

  // Вебхук без памяти: состояние «ждём число от этого чата» держать негде, и потерянное
  // состояние означало бы молча проглоченный ответ.
  ['own price is matched by a marker in the reply, not by stored state',
    /export function replyTarget/.test(priceChat)
    && /force_reply: true/.test(webhook)
    && /rows\.length > 1\) return null/.test(webhook)],

  // Фраза не содержит цены. Угаданная из неё цифра уехала бы в решение как согласие владельца.
  ['a sentence is not a price',
    priceChat.includes(String.raw`.test(raw)) return null`) && priceChat.includes('return Number.isSafeInteger(uzs) && uzs > 0 ? uzs * 100 : null') && /if \(!\/\^\[/.test(priceChat)],

  // Предела не было, ручной запуск на всём каталоге выдал 78 сообщений с кнопками подряд.
  // Кнопка требует решения по каждому товару, а семьдесят восемь решений подряд не принимает
  // никто — все они превращаются в непрочитанное.
  ['no run can bury the owner in buttons',
    /const ADVICE_PER_RUN = 3/.test(commerceDigest)
    && commerceDigest.includes('if (sent >= ADVICE_PER_RUN) break')
    && commerceDigest.includes('.sort((a, b) => Math.abs(')],

  ['the advice is sent once, with its own mark',
    adviceSentMigration.includes('advice_sent_at')
    && commerceDigest.includes("!row.advice_sent_at && row.status === 'open'")
    && /inline_keyboard: priceKeyboard\(row\.id, advice\.target_tiyin\)/.test(commerceDigest)
    && deploy.includes('20260810160000_commerce_accept_price.sql')
    && deploy.includes('20260810170000_price_advice_sent.sql')],

  // ── Замок на экране ────────────────────────────────────────────────────────────────────────

  // На любой не-2xx invoke кладёт null в data, а тело прячет в error.context. Без чтения оттуда
  // 402 выглядел бы как «не удалось собрать черновик», и про подписку владелец не узнал бы.
  ['the 402 body is read from where supabase actually puts it',
    paywallLib.includes('(error as { context?: unknown })?.context')
    && paywallLib.includes('await (context as Response).json()')
    && commercePage.includes('const payload = await payloadOf(error, data)')
    && commercePage.includes('if (locked) { setPaywall(locked); return false }')],

  // Владелец, решивший, что потерял каталог, не платит, а уходит. Поэтому «данные на месте» —
  // не вежливость, а половина сообщения, и она обязана быть на всех трёх языках.
  ['the lock says the data is still there',
    paywallDialog.includes("t('paywall.dataKept')")
    && ['"dataKept": "Каталоги', '"dataKept": "Kataloglar', '"dataKept": "Catalogues']
      .every((label) => i18nExtra.includes(label))],

  ['the lock names what stopped, not just that something did',
    ["t('paywall.lockedListing')", "t('paywall.lockedDigest')", "t('paywall.lockedPrice')"]
      .every((key) => paywallDialog.includes(key))],

  // Вписать чужой телеграм-хендл в код значит однажды отправить клиента не туда и не узнать.
  ['the sales link comes from the environment, not from a hardcoded guess',
    paywallLib.includes('import.meta.env?.VITE_SALES_TELEGRAM')
    && paywallLib.includes("configured.startsWith('https://t.me/')")],

  // ── Зрение ─────────────────────────────────────────────────────────────────────────────────
  // Габариты и вес на фотографии НЕ ВИДНЫ. Угаданный габарит уходит в тариф логистики Uzum и
  // оттуда в минимальную цену: одно правдоподобное число молча портит каждый расчёт по товару.

  ['the forbidden fields are refused in code, not only asked for in the prompt',
    visionModule.includes('NEVER state size, dimensions, weight')
    && /const MEASURED_VALUE =/.test(visionModule)
    && /const MEASURED_NAME =/.test(visionModule)
    && /if \(measured\) rejected\.push\(entry\.name\)/.test(visionModule)],

  // «Модель промолчала» и «модель не имела права это утверждать» — разные вещи, и вторая должна
  // оставлять след: отброшенное имя превращается в вопрос владельцу.
  ['what vision is not allowed to claim becomes a question, not silence',
    /\[\.\.\.new Set\(\[\.\.\.stated, \.\.\.rejected\]\)\]/.test(visionModule)],

  // Слово владельца главнее снимка: числа по-прежнему берутся только из его текста.
  ['a photograph adds to the owner text and never replaces it',
    /export function mergeVisionIntoSource/.test(visionModule)
    && visionModule.includes('!seen.includes(attribute.value.toLowerCase())')
    && /return `\$\{sourceText\}/.test(visionModule)],

  // Строка осталась разрешённой: сузить content до массива значило бы переписать каждый вызов
  // на платформе ради одной новой возможности.
  ['the message type widened without breaking every existing caller',
    /content: string \| ContentPart\[\]/.test(llmModule)
    && /type: 'image_url'; image_url: \{ url: string/.test(llmModule)],

  // llm.ts читает Deno.env при загрузке и под Node не импортируется вовсе — логика, которую
  // нельзя проверить тестом, это логика, о которой мы узнаём от владельца.
  ['the testable half of vision lives outside the Deno-bound module',
    /export function visionMessage/.test(visionModule)
    && !/export function visionMessage/.test(llmModule)
    && quality.includes('npm run test:listing-vision')],

  // ── Фотографии ─────────────────────────────────────────────────────────────────────────────

  // Фото нового товара — коммерческая тайна продавца до публикации. Публичный бакет отдал бы его
  // ассортимент любому, кто угадает имя файла.
  ['product photographs sit in a private bucket, not a public one',
    imagesMigration.includes("'listing-temp-images'")
    && /public, file_size_limit, allowed_mime_types/.test(imagesMigration)
    && imagesMigration.includes('false,')
    && imagesMigration.includes('array[\'image/jpeg\', \'image/png\', \'image/webp\']')],

  // RLS защищает ЗАГРУЗКУ из браузера. Читаем мы сервисным ключом, которому доступно всё, поэтому
  // проверка владения обязана стоять в коде: путь приходит из тела запроса.
  ['a path from the request body is checked against the account that sent it',
    /export function ownsImagePath/.test(imagesModule)
    && imagesModule.includes("path.includes('..')")
    && imagesModule.includes("path.startsWith('/')")
    && /\.filter\(\(path\) => ownsImagePath\(path, accountId\)\)/.test(imagesModule)],

  ['the signature lives minutes, not hours',
    /SIGNED_URL_TTL_SECONDS = 900/.test(imagesModule)
    && /createSignedUrl\(path, SIGNED_URL_TTL_SECONDS\)/.test(imagesModule)],

  // Бакет, из которого никто не выносит мусор, растёт молча и обнаруживается счётом за хранение.
  ['the temporary bucket is actually emptied',
    /create or replace function public\.commerce_purge_listing_images/.test(imagesMigration)
    && imagesMigration.includes("created_at < now() - p_older_than")],

  // Разбор фотографии уже выбрасывает измеримое. Здесь стоит ВТОРАЯ преграда: числа читаются из
  // исходного текста владельца, а не из объединённого с увиденным.
  ['numbers are still read from the owner text, never from the merged one',
    /const numbers = extractNumbers\(sourceText\)/.test(commerceControl)
    && /const copyText = mergeVisionIntoSource\(sourceText, vision\)/.test(commerceControl)
    && /generateCopy\(apiKey, PRIMARY_MODEL, copyText\)/.test(commerceControl)],

  ['what vision was refused becomes a gap on the card',
    commerceControl.includes('...(vision?.unknown_attributes ?? [])')],

  // ── Загрузчик ──────────────────────────────────────────────────────────────────────────────

  // Восьмимегабайтный снимок в теле запроса упёрся бы в лимит функции, а base64 раздул бы его
  // ещё на треть. В edge-функцию едет строка пути, файл идёт в Storage напрямую из браузера.
  ['the browser uploads to storage and sends only the path',
    uploadUi.includes(".upload(path, file, { contentType: file.type, upsert: false })")
    && commercePage.includes('image_paths: imagePaths')
    && !/FileReader|readAsDataURL|arrayBuffer()/.test(uploadUi)],

  // Владелец перетащил пять фотографий, увидел четыре — и должен знать, какая пропала и почему.
  ['every refused file says why it was refused',
    /reason: 'type'/.test(uploadLib) && /reason: 'size'/.test(uploadLib) && /reason: 'limit'/.test(uploadLib)
    && uploadUi.includes("t(`commerce.listing.photoRejected.${item.reason}`)")
    && ['"limit": "больше четырёх фото не берём"', '"limit": "to‘rttadan ortiq rasm olinmaydi"', '"limit": "no more than four photos"']
      .every((label) => i18nExtra.includes(label))],

  // Лимит считается вместе с уже загруженными: иначе четыре плюс четыре дали бы восемь.
  ['the limit counts what is already there',
    uploadLib.includes('already + accepted.length >= MAX_IMAGES')],

  // Иначе владелец приложит снимок и будет ждать, что габариты заполнятся сами.
  ['the uploader says out loud what a photo cannot give',
    uploadUi.includes("t('commerce.listing.photoProvenance')")
    && i18nExtra.includes('Габариты, вес и себестоимость — нет')],

  // Ссылки на объекты живут до отзыва: без этого каждая перевыбранная фотография оставляет за
  // собой удерживаемый blob, и вкладка растёт, пока её не закроют.
  ['object urls are revoked, not leaked',
    (uploadUi.match(/URL\.revokeObjectURL/g) ?? []).length >= 2],

  ['the uploader is covered by the gate',
    quality.includes('npm run test:listing-upload')],

  // ── Фото из Telegram ───────────────────────────────────────────────────────────────────────

  // Мелкий превью-вариант Telegram — 90 пикселей, на которых не видно ни материала, ни узора.
  ['the largest size is taken, by area rather than by array order',
    /export function largestPhotoId/.test(imagesModule)
    && imagesModule.includes('if (!best || area > best.area) best =')],

  // Подпись и снимок приходят одним сообщением, связывать их ничем не нужно.
  ['a captioned photo drafts a listing with the picture attached',
    /const imagePaths = await storeTelegramPhoto\(db, botToken, owner\.accountId, msg\)/.test(tgProcess)
    && /buildListingDraft\(db, apiKey, owner, listingText, imagePaths\)/.test(tgProcess)],

  // Альбом приходит несколькими обновлениями, подпись несёт только первое, а связать их без
  // хранимого состояния нельзя. Ограничение названо владельцу словами, а не оставлено на догадку.
  // Требование волшебного слова перед фотографией теряло каждую попытку, где оно не угадано, и
  // понять причину владелец не мог: подпись есть, карточки нет, объяснения нет.
  ['a captioned photo is intent enough, without a magic word',
    tgProcess.includes('const hasPhoto = Array.isArray(msg.photo) && msg.photo.length > 0')
    && tgProcess.includes('newListingText(text) ?? (hasPhoto && text.trim().length >= 10 ? text.trim() : null)')],

  ['the album limitation is stated to the owner, not hidden',
    listingChat.includes('Альбом Telegram присылает по одному сообщению на снимок')
    && listingChat.includes('Габариты, вес и себестоимость с фотографии не берутся')],

  // То же разделение, что в веб-пути, и по той же причине: габарит, угаданный по снимку, ушёл бы
  // в тариф логистики и оттуда в минимальную цену.
  ['the telegram path computes numbers before it ever looks at the photo',
    listingChat.includes('const numbers = extractNumbers(sourceText)')
    && listingChat.includes('generateCopy(apiKey, model, mergeVisionIntoSource(sourceText, vision))')
    && listingChat.includes('...(vision?.unknown_attributes ?? [])')],

  ['the image helpers are covered by the gate',
    quality.includes('npm run test:listing-images')
    && deploy.includes('20260811130000_listing_images_bucket.sql')],

  // ── Замок стоит там, где ТРАТЯТСЯ деньги ───────────────────────────────────────────────────
  //
  // Первая версия проверяла подписку на трёх дверях, куда стучится человек. Платную работу при
  // этом делают воркеры по расписанию и очередь — обращения владельца там нет вовсе, и аккаунт с
  // истёкшим триалом продолжал получать синхронизацию, автопилот, память и вызовы модели.
  // Оплата закрывала три двери, а дом стоял открытым с четырёх сторон.
  ['every worker that spends money checks the subscription first',
    [agentWorker, commerceWorker, opsAutopilot, orgMemoryWorker].every((file) => file.includes('entitlementFor('))],

  // pgmq вернёт сообщение через время видимости: аккаунт без подписки крутил бы одну задачу вечно.
  ['a blocked queue message is dropped, not retried forever',
    agentWorker.includes('const stopped = !agent?.account_id')
    && agentWorker.includes('if (stopped) {') && agentWorker.includes("q_delete', { mid: m.msg_id }")],

  // Пакетный прогон, где один плательщик открывает работу всем в списке, — имитация замка.
  ['a batch run checks each account on its own',
    opsAutopilot.includes('!(await entitlementFor(db, r.account_id)).allowed')],

  // ── Фундамент биллинга ─────────────────────────────────────────────────────────────────────
  //
  // Уникальность (provider, transaction_id) защищает СТРОКУ, а не начисление. Две попытки Click
  // дают разные click_trans_id при одном merchant_trans_id, и обе продлили бы срок; тот же счёт
  // можно оплатить и через Payme, и через Click. Единица покупки — счёт, и права по нему выдаются
  // ровно один раз, чем бы за него ни платили.
  ['entitlement is granted once per invoice, not once per payment row',
    invoicesMigration.includes('entitlement_applied_at timestamptz')
    && invoicesMigration.includes('if v_invoice.entitlement_applied_at is not null then')
    && invoicesMigration.includes('where id = v_invoice.id and entitlement_applied_at is null')
    && invoicesMigration.includes('for update')],

  // От now() всегда — крадёт остаток у продлившего заранее. От paid_until всегда — продлевает в
  // прошлое вернувшемуся после перерыва: платёж прошёл, а замок не открылся.
  ['the period stacks forward without stealing or backdating',
    invoicesMigration.includes('greatest(coalesce(paid_until, pg_catalog.now()), pg_catalog.now())')],

  // Иначе защита по сумме бессмысленна: подправил amount под пришедший платёж — и «сумма совпала».
  ['invoice terms cannot be edited after issuing',
    invoicesMigration.includes('invoice terms are immutable once issued')
    && invoicesMigration.includes('create trigger billing_invoices_freeze before update')],

  // Триал по почте обходится новым ящиком раз в три дня и стоит ноль.
  // Правило, записанное в базе и никем не вызываемое, — это не правило, а комментарий.
  ['the shop rule is actually asked, and only where it matters',
    entitlementModule.includes("admin.rpc('trial_allowed_for_account'")
    && entitlementModule.includes("const onTrial = !sub || sub.status === 'trial'")
    && entitlementModule.includes('if (onTrial) {')],

  // Заплатил — работает, чей бы магазин ни был: правило про бесплатный период, а не про доступ.
  ['a paid account is never refused for a shop that is not its own',
    entitlementModule.indexOf('trialAllowed === false') > entitlementModule.indexOf("sub?.status === 'active'")],

  // Сбой запроса о магазине не должен закрывать доступ владельцу.
  ['a failed lookup is read in the owner favour',
    entitlementModule.includes('trialAllowed = error ? true : data !== false')],

  ['the refusal names the reason instead of saying access is closed',
    entitlementModule.includes('Пробный период по этому магазину уже был использован')],

  ['the trial belongs to the shop, not to the email',
    invoicesMigration.includes('create table if not exists public.billing_trial_claims')
    && invoicesMigration.includes('shop_id    text primary key')
    && invoicesMigration.includes('create or replace function public.trial_allowed_for_account')],

  // Заявка на магазин заводится ровно в момент подключения — больше его номер нигде не всплывает.
  // Без этого вызова занятых магазинов не бывает, и правило выше отвечает «можно» всегда.
  ['connecting a shop registers the claim',
    commerceControl.includes("admin.rpc('claim_shop_trial'")
    && commerceControl.split('await claimShops(').length - 1 === 2],

  // Подключение каталога важнее учёта пробных периодов: сорванная заявка не должна стоить продавцу
  // магазина.
  ['a failed claim does not break the connection',
    commerceControl.includes("console.error('claim_shop_trial failed:'")
    && !commerceControl.includes('could not claim the shop')],

  // Гейт обязан быть воспроизводимым без боевых ключей, поэтому живой тест запускается руками.
  ['the race is covered by a live test, kept out of the offline gate',
    packageJson.includes('agent-hub/billing-entitlement-live.mjs')
    && !quality.includes('test:billing-live')
    && billingLive.includes('await Promise.all([')],

  // ── Протоколы касс ─────────────────────────────────────────────────────────────────────────
  //
  // Модуль намеренно чист: ни Deno.env, ни базы, ни сети. Здесь весь риск платёжного контура, и
  // потому здесь же проверяются ветки, случающиеся в бою раз в год.
  ['the protocol module stays pure enough to be tested',
    // Исполняемая форма, а не слово: `Deno.env` встречается в шапке модуля объяснением того,
    // почему его там нет. Пятый случай в проекте, когда контракт ловил прозу вместо кода.
    !protocolModule.includes('Deno.env.get(')
    && !protocolModule.includes('createClient(')
    && quality.includes('npm run test:payment-protocol')],

  // Обычное === выходит на первом несовпавшем байте, и подпись подбирается побайтово по времени.
  ['signatures and keys are compared without leaking time',
    protocolModule.includes('export function constantTimeEqual')
    && protocolModule.includes('diff |= (left[i] ?? 0) ^ (right[i] ?? 0)')
    && protocolModule.includes('constantTimeEqual(clickSignature(request, secret).toLowerCase()')],

  // Ненастроенная касса не должна принимать оплату ни от кого.
  ['an unconfigured merchant accepts nothing',
    protocolModule.includes('if (!expectedKey || !expectedLogin) return false')
    && protocolModule.includes('if (!secret) return false')],

  // «290000.00» * 100 через Number однажды даст 28999999.999999996.
  ['the amount is parsed from the string, never multiplied into a float',
    protocolModule.includes('Number.isSafeInteger(tiyin) && tiyin > 0')
    && protocolTest.includes("amountToTiyin('2.9e5')") === false
    && protocolTest.includes("'2.9e5'")],

  // Порядок полей — часть протокола: перестановка даёт другой хеш, и проверка начинает пропускать
  // либо всё, либо ничего. У Complete в середине merchant_prepare_id — он связывает фазы.
  ['the click signature keeps the documented field order for both phases',
    protocolModule.includes('request.merchant_prepare_id ?? ')
    && protocolTest.includes('порядок полей Prepare')
    && protocolTest.includes('порядок полей Complete')],

  // Общий 400 или 500 провайдер считает сбоем связи и ретраит вечно.
  ['refusals speak the provider protocol, not HTTP',
    protocolModule.includes('UNAUTHORIZED: -32504')
    && protocolModule.includes('INVALID_AMOUNT: -31001')
    && protocolModule.includes('TRANSACTION_NOT_FOUND: -31003')
    && protocolModule.includes('SIGN_CHECK_FAILED: -1')
    && protocolModule.includes('TRANSACTION_NOT_FOUND: -6')],

  // Провайдеру нужно различие «уже оплачено» и «сумма не та», иначе он будет повторять.
  ['a settled invoice answers already_paid, not a wrong amount',
    protocolModule.indexOf("reason: 'already_paid'") < protocolModule.indexOf("reason: 'wrong_amount'")],

  // ── Эндпоинты касс ─────────────────────────────────────────────────────────────────────────

  // Обе кассы читают ТЕЛО, а не код: 4xx и 5xx они считают сбоем связи и повторяют запрос, а
  // покупатель видит бесконечное ожидание вместо внятного отказа.
  ['both endpoints answer 200 and speak the protocol in the body',
    (paymeEndpoint.match(/status: 200/g) ?? []).length >= 1
    && (clickEndpoint.match(/status: 200/g) ?? []).length >= 1
    && paymeEndpoint.includes('return reply(paymeFailure(id, PAYME_ERRORS.CANNOT_PERFORM')
    && clickEndpoint.includes('return fail(CLICK_ERRORS.BAD_REQUEST)')],

  // Неавторизованный запрос не должен уметь даже узнать, существует ли счёт с таким номером.
  ['authentication runs before the database is touched',
    paymeEndpoint.indexOf('checkPaymeAuth(') < paymeEndpoint.indexOf('createClient(URL, SERVICE)')
    && clickEndpoint.indexOf('checkClickSignature(') < clickEndpoint.indexOf('createClient(URL, SERVICE)')],

  // Perform до Create — транзакции нет. Создавать её задним числом значит подтвердить платёж,
  // которого не было.
  ['a perform without a create is refused, not invented',
    paymeEndpoint.includes('if (!existing) return reply(paymeFailure(id, PAYME_ERRORS.TRANSACTION_NOT_FOUND')],

  // Именно эта сверка не даёт второму Complete закрыться по чужой подготовке.
  ['click complete must match its own prepare',
    clickEndpoint.includes("String(request.merchant_prepare_id ?? '') !== String(existing.transaction_no ?? '')")
    && clickEndpoint.includes('amount !== Number(existing.amount_tiyin)')],

  // Click сообщает отказ банка полем error в том же Complete, и подпись при этом верная — запрос
  // настоящий. Пока поле не читалось, месяц начислялся за деньги, которых никто не списывал.
  ['a declined click payment does not buy a month',
    clickEndpoint.includes('const providerError = Number(request.error ?? 0)')
    && clickEndpoint.includes('if (providerError < 0)')
    && clickEndpoint.indexOf('providerError < 0') < clickEndpoint.indexOf("db.rpc('apply_invoice_entitlement'")
    && protocolModule.includes("error: text('error')")],

  // ── Отправка карточки на модерацию ─────────────────────────────────────────────────────────
  //
  // Отправки пока нет: Uzum закрывает адреса создания товара для ключа продавца. Контур вокруг неё
  // заведён заранее, и проверяется здесь именно то, что легко подменить заглушкой.

  // Заглушка, возвращающая «успех», сообщала бы, что товар уехал, — а продавец узнавал бы правду
  // через сутки, не найдя его в кабинете. Успех выставляется ТОЛЬКО по ответу площадки.
  ['a submission is only successful when the marketplace said so',
    submitModule.includes('if (httpStatus >= 200 && httpStatus < 300) return { status: \'sent\'')
    && commerceControl.includes("const outcome = classifyProviderResponse(httpStatus)")
    && commerceControl.includes("if (outcome.status === 'sent') {")
    // Черновик помечается отправленным только внутри этой ветки, а не заранее.
    && commerceControl.indexOf("outcome.status === 'sent'") < commerceControl.indexOf("status: 'submitted'")],

  // Два пути к отправке разошлись бы через месяц, и ручная кнопка начала бы проверять не то, что
  // проверяет автомат.
  ['auto and manual submission share one road',
    (commerceControl.match(/await submitDraft\(admin, \{/g) ?? []).length === 2
    && commerceControl.includes("mode: 'auto'")
    && commerceControl.includes("mode: 'manual'")],

  // Автономия решает КОГДА отправить одобренное, а не отменяет одобрение.
  ['autonomy never skips the owner approval',
    submitModule.includes("if (input.draft.status !== 'ready') return { attempt: false, reason: 'not_ready' }")
    && commerceControl.includes('if (approving) {')
    && commerceControl.indexOf("pilot?.auto_submit_to_moderation !== false") > commerceControl.indexOf("status: 'ready', approved_by: user.id")],

  // Повторная отправка создала бы дубль в чужом кабинете, и разбирать его пришлось бы вручную.
  ['a submitted listing is not sent twice',
    submitModule.includes("if (input.draft.status === 'submitted') return { attempt: false, reason: 'already_submitted' }")
    && submissionsMigration.includes("check (status in ('draft', 'ready', 'discarded', 'submitted'))")],

  // 403 — не поломка и не ошибка владельца. Тот, кому показали «ошибка 403», идёт проверять
  // интернет; тот, кому назвали причину, идёт в поддержку Uzum за правами.
  ['the refusal names who can lift it',
    submitModule.includes("if (httpStatus === 401 || httpStatus === 403) return { status: 'refused', reason: 'no_write_access' }")
    && submitModule.includes('403')
    && submitModule.includes('чтение каталога работает')],

  // Журнал, дописанный после того, как отправка заработала, не помнит первых попыток — а
  // разбирают обычно именно их. Ответ площадки хранится целиком, а не пересказом.
  ['every attempt leaves a row, refusals included',
    submissionsMigration.includes('create table if not exists public.commerce_listing_submissions')
    && submissionsMigration.includes("check (status in ('refused', 'failed', 'sent'))")
    && submissionsMigration.includes('provider_response text')
    && submissionsMigration.includes('owner_message text')
    && commerceControl.includes("status: 'refused', reason: decision.reason")],

  // Тумблер показывается при первом запуске, а не обнаруживается потом по факту уехавшей карточки.
  ['the mode is a stored setting, defaulted deliberately',
    submissionsMigration.includes('auto_submit_to_moderation boolean not null default true')
    && commerceControl.includes("action === 'set_auto_submit'")],

  // ── Два окна продаж ────────────────────────────────────────────────────────────────────────
  //
  // Одно окно не отличает медленный товар от умирающего: «продано 3» одинаково выглядит у того,
  // кто всегда шёл по три, и у того, кто шёл по тридцать и встал.

  // Прошлая неделя не читается отдельно — Uzum отдаёт итог за окно, не по дням. Значит второе
  // окно обязано быть прочитано ОТДЕЛЬНЫМ запросом и с паузой: финансовые вызовы вплотную
  // Uzum отвечает 429, и параллельный вызов измерял бы ограничитель, а не продажи.
  ['the previous week comes from a second window, read without tripping the limiter',
    commerceWorker.includes("uzumSalesRows(token, typedCatalog.external_shop_id, 14, 8)")
    && commerceWorker.includes('await new Promise((resolve) => setTimeout(resolve, 1500))')
    && commerceWorker.indexOf('setTimeout(resolve, 1500)') < commerceWorker.indexOf('salesTwoWeeks = await')],

  // Разность двух НЕПОЛНЫХ чисел выглядит как обвал продаж. Обрезка обязана быть видна наружу.
  ['a truncated window refuses to become a trend',
    uzumModule.includes('truncated: boolean')
    && uzumModule.includes('if (page === maxPages - 1 && batch.length === 50) pagesExhausted = true')
    && trendModule.includes('if (input.truncated7 || input.truncated14) return null')
    && trendModule.includes('if (units14 < units7) return null')
    && commerceWorker.includes('truncated7: sales.truncated, truncated14: salesTwoWeeks.truncated')],

  // totalElements проверен на боевом магазине и опровергнут: за 7 дней он вернул 0, а синхронизация
  // в тот же день разобрала из того же фида четыре проданные единицы. Признак обрезки, который
  // срабатывает без причины, ХУЖЕ отсутствующего — он молча выключает сравнение недель.
  ['the truncation guard rests on observation, not on a provider counter',
    // Проверяется исполняемая форма, а не комментарий рядом с ней: отвергнутое выражение названо
    // в тексте по имени, и поиск по нему ловил бы собственное объяснение.
    /const truncated = pagesExhausted\r?\n/.test(uzumModule)],

  // Два порога сразу: только проценты — и рост с одной штуки до двух это «+100%»; только штуки —
  // и падение с 40 до 36 попадает в отчёт наравне с обвалом.
  ['the trend needs both a size and a share to be worth saying',
    trendModule.includes('volume >= TREND_MIN_UNITS')
    && trendModule.includes('Math.abs(delta) >= TREND_MIN_DELTA')
    && trendModule.includes('Math.abs(deltaPercent) >= TREND_MIN_PERCENT')],

  // Рост учитывается скоростью расхода и без отдельного сообщения. Будит только падение.
  ['only a fall wakes the owner, and a full shelf makes it critical',
    trendModule.includes("if (trend.direction === 'gone') return (stock ?? 0) > 0 ? 'critical' : 'warning'")
    && trendModule.includes("if (trend.direction === 'down') return 'warning'")
    && commerceWorker.includes("kind: 'sales_trend'")
    && trendMigration.includes("'sales_trend'")],

  // Процент без штук скрывает масштаб: «-80%» одинаково выглядит на двадцати продажах и на двух.
  ['the message names units, not only percent',
    trendModule.includes('${trend.prev7} → ${trend.last7} шт')
    && trendModule.includes("deltaPercent === null")],

  // ── Сертификация касс ──────────────────────────────────────────────────────────────────────
  //
  // Требования провайдеров, без которых кассу не подключат. Проверяются здесь, а не «на глаз при
  // сдаче»: сертификация проходится один раз, а ломается любой правкой.

  // Click работает целыми числами. Uuid проходит по формату строки и не проходит сертификацию —
  // и узнать об этом на приёмке дороже, чем сейчас.
  ['the cassa gets a number, not a uuid',
    numericIdsMigration.includes('create sequence if not exists public.billing_invoice_no_seq')
    && numericIdsMigration.includes('create sequence if not exists public.billing_transaction_no_seq')
    && numericIdsMigration.includes('create unique index if not exists billing_invoices_no_key')
    && protocolModule.includes('transaction_param=${input.invoiceNo}')
    && invoiceEndpoint.includes('const invoiceNo = Number(invoice.invoice_no)')],

  // Подготовку с завершением связывает номер транзакции: отдельный случайный uuid для этого не
  // нужен, а Click его и не принимает.
  ['click links its phases by the numeric transaction number',
    clickEndpoint.includes('merchantPrepareId: existing.transaction_no')
    && clickEndpoint.includes('merchantConfirmId: existing.transaction_no')
    && clickEndpoint.includes("String(request.merchant_prepare_id ?? '') !== String(existing.transaction_no ?? '')")
    && !clickEndpoint.includes('crypto.randomUUID()')],

  // error.data называет поле, которое покупатель может исправить. Имя поля обязано совпадать с
  // тем, что уходит в ссылку на кассу, иначе Payme пришлёт account без известного нам ключа.
  ['payme names the field it refuses on',
    protocolModule.includes("PAYME_DATA_FIELD = { ACCOUNT: 'invoice_no', AMOUNT: 'amount' }")
    && protocolModule.includes('ac.${PAYME_DATA_FIELD.ACCOUNT}=${input.invoiceNo}')
    && (paymeEndpoint.match(/PAYME_DATA_FIELD\.ACCOUNT/g) ?? []).length >= 4
    && paymeEndpoint.includes('PAYME_DATA_FIELD.AMOUNT')],

  // Битый JSON и правильный JSON не того вида — разные отказы. Ответить на первый «метод не
  // найден» значит послать инженера кассы искать опечатку в методе, которого в запросе не было.
  ['a broken body is a parse error, not a missing method',
    paymeEndpoint.includes('const rawBody = await req.text()')
    && paymeEndpoint.includes('PAYME_ERRORS.PARSE, PAYME_MESSAGES.parse_error')
    && paymeEndpoint.includes('PAYME_ERRORS.INVALID_REQUEST, PAYME_MESSAGES.invalid_request')
    // Авторизация всё равно первая: неавторизованный не должен узнавать даже это.
    && paymeEndpoint.indexOf('checkPaymeAuth(') < paymeEndpoint.indexOf('if (parseFailed)')],

  // Брошенная транзакция иначе висит в состоянии 1 вечно и держит счёт занятым: новый платёж по
  // нему касса создать не даст, а этот уже никто не завершит.
  ['a transaction abandoned for 12 hours is cancelled, not left hanging',
    protocolModule.includes('PAYME_TIMEOUT_MS = 12 * 60 * 60 * 1000')
    && protocolModule.includes('PAYME_CANCEL_TIMEOUT = 4')
    && paymeEndpoint.includes('cancel_reason: PAYME_CANCEL_TIMEOUT')
    // Все три метода, которыми касса может застать просроченную транзакцию.
    && (paymeEndpoint.match(/paymeExpired\(existing\.created_at\)/g) ?? []).length === 3
    && paymeEndpoint.includes('PAYME_MESSAGES.timeout')],

  // Отмена по таймауту не должна затирать уже выполненный платёж: условие на состояние 1 — это то,
  // что отделяет закрытие брошенной попытки от отбирания оплаченного.
  ['the timeout closes only a waiting transaction',
    paymeEndpoint.includes(".eq('id', row.id).eq('state', PAYME_STATE.CREATED)")
    && protocolModule.includes('if (!Number.isFinite(started)) return false')],

  // Уникальность по провайдеру не запрещает две РАЗНЫЕ транзакции на один счёт: две попытки Click
  // или оплату через Payme и Click сразу. Запрещает частичный индекс.
  ['one invoice can be settled by exactly one transaction',
    transactionsMigration.includes('billing_transactions_one_performed_per_invoice')
    && transactionsMigration.includes('on public.billing_transactions (invoice_id) where state = 2')],

  // Замок читает подписку, а квоты — accounts.plan. Оплата обязана двигать обе, иначе клиент,
  // заплативший вчера, упирается в лимит бесплатного тарифа сегодня.
  ['a payment moves the quota as well as the lock',
    planMigration.includes('update public.accounts')
    && planMigration.includes('set plan = v_invoice.plan_code')],

  ['the paywall helper is covered by the gate',
    quality.includes('npm run test:paywall')
    && packageJson.includes('agent-hub/paywall-behavior.mjs')],

  ['the price engine is covered by the gate, not only by hope',
    quality.includes('npm run test:price-target')
    && packageJson.includes('agent-hub/price-target-behavior.mjs')
    && quality.includes('npm run test:price-chat')],

  ['the returns field says out loud that it does not move the price',
    ['на цену не влияет', 'narxga ta’sir qilmaydi', 'does not affect the price']
      .every((label) => i18nExtra.includes(label))
    && /RETURN_FEE_MULTIPLIER = 0/.test(unitEconomics)],

  ['the copy strings exist in all three languages',
    ['"copy": "Nusxa olish"', '"copy": "Скопировать"', '"copy": "Copy"',
     '"copyAll": "Hammasini nusxalash"', '"copyAll": "Скопировать всё"', '"copyAll": "Copy all"']
      .every((label) => i18nExtra.includes(label))],

  ['the page names the bot that serves this shop, taken from the binding',
    commerceControl.includes('notify_bot: notifyBot')
    && /select\('credentials'\)\.eq\('id', notificationProfile\.notify_channel_id\)/.test(commerceControl)
    && /https:\/\/t\.me\/\$\{notifyBot\}/.test(commercePage)
    && ['tgBot": "Xabarnomalar', 'tgBot": "Уведомления', 'tgBot": "Notifications']
        .every((label) => i18nExtra.includes(label))],

  ['a sync that found nothing says what it saw',
    commerceWorker.includes('fetched: products.rows.length, usable: productRows.length')
    && commerceWorker.includes('Uzum вернул 0 карточек')
    && commerceWorker.includes('дефект разбора на нашей стороне')
    && deploy.includes('20260808160000_sync_run_counts.sql')],

  ['auto-fill migration is deployed and probed', /20260805120000_commerce_economics_autofill\.sql/.test(deploy) && /column_name = 'estimated_fields'/.test(deploy) && /to_regprocedure\('public\.autofill_commerce_economics\(uuid\)'\) is not null/.test(deploy)],

  // --- The silence watchdog: a broken sync must announce itself ---
  // Every other finding is produced by the sync. When the sync dies no finding is produced, the
  // digest has nothing unsent, and the seller receives nothing at all — a failure that presents
  // as a calm week. These contracts hold the parts that stop that from being true again.
  ['freshness is judged in the delivery path, not inside the sync it watches', commerceDigest.includes('commerce_catalog_freshness') && freshness.includes('the sync is the suspect') && !commerceWorker.includes('commerce_catalog_freshness')],
  ['the digest reaches an account that has no findings at all', /for \(const accountId of accountIds\)/.test(commerceDigest) && !/for \(const \[accountId, accountRows\] of byAccount\)/.test(commerceDigest) && commerceDigest.includes('has no new findings by definition')],
  ['a stale account is written to even when nothing is unsent', /if \(!unsent\.length && !warning\) continue/.test(commerceDigest) && /if \(unsent\.length\) \{[\s\S]{0,200}digest_sent_at: today/.test(commerceDigest)],
  ['staleness is measured from data that arrived, not from a sync that claimed to run', freshnessMigration.includes('max(s.observed_at)') && freshness.includes('last_observed_at') && !/last_synced_at >=|last_synced_at <=/.test(freshness)],
  ['the outage alert fires once per outage and rearms on recovery', commerceDigest.includes('stale_alerted_at: new Date().toISOString()') && /update\(\{ stale_alerted_at: null \}\)/.test(commerceDigest) && commerceDigest.includes('hygiene, not a notification')],
  ['the threshold is whole worker cycles, so one hiccup is not an outage', /export const STALE_AFTER_HOURS = 12\b/.test(freshness) && freshness.includes('every four hours')],
  // Три состояния, а не два: остановился, не начинал, и пуст по собственному признанию Uzum.
  // Четыре состояния, а не два: свежий, остановился, не начинал, и пуст по признанию Uzum.
  ['a never-synced shop reads differently from one that stopped', /FreshnessState = 'fresh' \| 'stale' \| 'never' \| 'empty'/.test(freshness) && freshness.includes('не пришло ни одного товара') && freshness.includes('не обновлялись')],
  ['the warning says the remaining numbers cannot be trusted', freshness.includes('Проверьте API-ключ или статус кабинета') && freshness.includes('на них нельзя опираться')],
  // One dead shop out of four does not make the other three untrustworthy. A watchdog that
  // overstates the damage gets muted exactly like one that understates it.
  ['the warning claims no more breakage than there is', freshness.includes('allStale') && freshness.includes('Остальные магазины обновляются нормально') && /allStale: broken(?:ForDigest)?\.length >= \(catalogsPerAccount\.get\(accountId\) \?\? 1\)/.test(commerceDigest)],
  ['shop names from Uzum cannot inject markup into the warning', /escapeHtml\(item\.name\)/.test(freshness) && /escapeHtml\(item\.error/.test(freshness)],
  ['the watchdog rules can be tested outside Deno', !freshness.includes('esm.sh') && !/Deno\./.test(freshness)],
  ['the freshness migration is registered for deploy', deploy.includes('20260807190000_commerce_freshness_watchdog.sql')],
]

let failed = 0
for (const [name, ok] of checks) {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`)
  if (!ok) failed++
}
if (failed) process.exit(1)
console.log(`Commerce/logistics contracts: ${checks.length}/${checks.length}`)
