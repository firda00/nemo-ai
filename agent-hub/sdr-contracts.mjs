// Границы SDR-пайплайна, записанные проверками.
//
// Модуль ходит в четыре чужих сервиса и пишет в боевую таблицу продаж Ustudy IT. Здесь — то, что
// легко нарушить одной строкой и не заметить: статус лида, источник кнопок в Telegram, доступ к
// таблице.

import fs from 'node:fs'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..')
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8')

/** Код без комментариев. Проверять надо исполняемое, а не объяснение рядом с ним. */
const stripComments = (source) => source
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '')

const schemasFull = read('supabase/functions/_shared/leadgen/schemas.ts')
const schemas = stripComments(schemasFull)
const contracts = read('supabase/functions/_shared/leadgen/contracts.ts')
const scorer = read('supabase/functions/_shared/leadgen/scorer.ts')
const notifierFull = read('supabase/functions/_shared/leadgen/notifier.ts')
const notifier = stripComments(notifierFull)
const pipeline = read('supabase/functions/_shared/leadgen/pipeline.ts')
// Без комментариев: объяснение «раньше здесь был отказ places_search_not_configured» — это
// история, а не код, и проверка на отсутствие самого отказа не должна на неё срабатывать.
const placesSearch = stripComments(read('supabase/functions/_shared/leadgen/placesSearch.ts'))
const overpass = read('supabase/functions/_shared/leadgen/overpassSearch.ts')
const migration = read('supabase/migrations/20260817120000_sdr_leads.sql')
const tokensMigration = read('supabase/migrations/20260817180000_nemo_api_tokens_sdr_jobs.sql')
const apiTokens = read('supabase/functions/_shared/apiTokens.ts')
const sdrApi = read('supabase/functions/sdr-api/index.ts')
const worker = read('agent-hub/sdr-worker.mjs')
const sdrRun = read('agent-hub/sdr-run.mjs')
const packageJson = read('package.json')

const cases = [
  // ── Статус ────────────────────────────────────────────────────────────────────────────────
  // Модель охотно ставит «HOT» рядом с оценкой 45, если формулировка ей понравилась — этот факт
  // уже стоил одной прожитой ошибки в этом же проекте (agentPlan.ts). Промпт СИСТЕМНО не просит
  // status, и код вычисляет его заново из числа, не доверяя тому, что могло просочиться в ответе.
  ['the model is never asked for a status field',
    scorer.includes('Поля status в ответе быть не должно')
    && (() => {
      const block = scorer.split('const ModelScoreResponse = z.object({')[1]?.split('})')[0] ?? ''
      return block.length > 0 && !block.includes('status')
    })()],

  ['status always comes from statusFor(score), never from the parsed response',
    scorer.includes('status: statusFor(modelResult.data.score)')
    && !scorer.includes('modelResult.data.status')],

  // ── Уведомления ───────────────────────────────────────────────────────────────────────────
  // Алерт о каждом найденном лиде превращается в поток, который выключают на второй день —
  // вместе с теми несколькими сообщениями в неделю, ради которых всё делалось.
  ['only HOT leads reach alertHot',
    notifier.includes("if (lead.score?.status !== 'HOT') return { ok: false, error: 'not_hot' }")
    && pipeline.includes('const hot = leads.filter((lead) => lead.score?.status')
    && pipeline.includes('for (const lead of hot)')
    && !pipeline.includes('for (const lead of leads)')], // ни одного цикла уведомления по ВСЕМ лидам

  // callback_data требует запущенного вебхука, которого в этом пайплайне нет. Кнопка без
  // обработчика нажимается и ничего не делает — хуже отсутствия кнопки.
  ['notification buttons are links only, never callback_data',
    !notifier.includes('callback_data')
    && notifier.includes('url: lead.website')],

  // ── Пайплайн: одна компания не роняет весь прогон ────────────────────────────────────────────
  ['one company failing enrichment does not stop the run',
    pipeline.includes('try {\n      enrichment = await deps.enrich.enrich(company)')
    && pipeline.includes("failures.push({ stage: 'enrich'")],
  ['one company failing scoring does not stop the run',
    pipeline.split('if (deps.score) {')[1]?.split('leads.push')[0]?.includes('try {')
    && pipeline.includes("failures.push({ stage: 'score'")],
  ['a full search failure is reported, not thrown to the caller',
    pipeline.includes('try {\n    const result = await deps.search.search(parsedRequest)')
    && pipeline.includes("} catch (error) {\n    failures.push({ stage: 'search'")],

  // ── Стоимость: чужие API платные ─────────────────────────────────────────────────────────────
  ['Google Place Details is never fetched beyond the requested limit',
    placesSearch.includes('if (places.length >= request.limit) break')
    && placesSearch.indexOf('if (places.length >= request.limit) break') < placesSearch.indexOf('this.placeDetails(')],

  // ── Хранилище: не арендаторские данные, доступ только сервисным ключом ───────────────────────
  ['sdr_leads has RLS enabled with no public policy',
    migration.includes('enable row level security')
    && !/create policy/i.test(migration)],
  ['dedupe_key is unique so a re-run cannot duplicate a lead',
    migration.includes('dedupe_key text not null unique')],

  // ── Портируемость: пайплайн целиком под Node, не Deno ────────────────────────────────────────
  ['schemas.ts imports zod as an npm package, not a Deno URL',
    schemas.includes("import { z } from 'zod'")
    && !schemas.includes('esm.sh')],
  ['zod is a real root dependency, matching the schemas.ts import',
    JSON.parse(packageJson).dependencies?.zod !== undefined],
  ['the CLI is wired the same way every other Node-run .ts script in this repo is',
    packageJson.includes('"sdr:run": "node --experimental-strip-types agent-hub/sdr-run.mjs"')
    && packageJson.includes('"test:sdr": "node --experimental-strip-types agent-hub/sdr-pipeline-behavior.mjs"')],

  // ── Запуск «из коробки» ──────────────────────────────────────────────────────────────────────
  // Раньше без платного ключа или руками собранного JSON пайплайн не запускался вовсе —
  // resolvePlacesSearch бросал places_search_not_configured. Ключи остаются улучшением, а не
  // условием запуска.
  ['the pipeline runs with no keys at all — resolvePlacesSearch never throws',
    placesSearch.includes('return new OverpassPlacesSearch()')
    && !placesSearch.includes('places_search_not_configured')],

  ['a paid Google key still wins over the free directory when it is configured',
    placesSearch.indexOf('if (apiKey) return new GooglePlacesSearch(apiKey)')
      < placesSearch.indexOf('return new OverpassPlacesSearch()')],

  // Общие бесплатные службы требуют опознаваемого User-Agent с контактом. Анонимный поток
  // запросов справедливо блокируют, и виноваты в этом будем мы, а не они.
  ['the free OSM services are called with an identifying User-Agent',
    overpass.includes("'User-Agent': USER_AGENT")
    && /const USER_AGENT = 'NemoAI-SDR/.test(overpass)],

  // Занятость Overpass приходит как HTTP 200 с HTML-страницей об ошибке. Проверка только res.ok
  // приняла бы это за пустую выдачу, и прогон молча вернул бы ноль лидов на работающем городе.
  ['an overloaded Overpass response is detected by body, not just status',
    overpass.includes('isBusyResponse(text)')
    && overpass.includes('if (!res.ok || isBusyResponse(text))')],

  // В OSM телефон часто приходит списком через «;». Наивный разбор склеивает его в 36-значное
  // «число», toE164 возвращает null, и клиника с тремя рабочими номерами отсеивается как
  // «без телефона».
  ['a multi-value OSM phone is split, not concatenated into a non-number',
    overpass.includes('export function firstPhone(')
    && overpass.includes('raw.split(/[;,]/)[0]')],

  // Контакты в OSM размечены и с префиксом contact:, и без него — оба варианта встретились в одной
  // живой выдаче.
  ['both bare and contact:-prefixed OSM tags are read',
    overpass.includes('return tags[name] ?? tags[`contact:${name}`]')],

  // Лимит применяется к самым полным записям, а не к первым подряд: иначе «--limit 15» на OSM
  // давал один пригодный лид вместо одиннадцати. Ранжирование НЕ подменяет фильтр качества —
  // оно только решает, какие записи доедут до него первыми.
  ['the limit selects the most complete records, not the first N in response order',
    overpass.includes('const richness = (place: RawPlace): number =>')
    && overpass.includes('.sort((a, b) => (b.rank - a.rank) || (a.index - b.index))')
    && overpass.includes('ranked.slice(0, request.limit)')],

  // Таблица категорий неполная намеренно (платформа домен-нейтральна), поэтому поиск по названию
  // обязан идти ВСЕГДА — иначе неизвестная категория не нашлась бы вовсе.
  ['an unknown business category still searches by name',
    overpass.includes('const nameSelector = `"name"~"${escapeForOverpassRegex(query)}",i`')
    && overpass.includes('[...selectors, nameSelector]')],

  // ── Платформенные токены ─────────────────────────────────────────────────────────────────────
  // САМОЕ ВАЖНОЕ ЗДЕСЬ. commerce-control знает около тридцати действий, включая set_auto_submit и
  // apply_proposal. Если бы токен принимался ТАМ, единственной защитой был бы белый список — одна
  // проверка, которую забудут добавить к новому действию. Шлюз вынесен в отдельную функцию, и
  // опасные действия физически недостижимы: их код в другом файле.
  ['the token gateway is a separate function, never a branch inside commerce-control',
    fs.existsSync(path.join(root, 'supabase/functions/sdr-api/index.ts'))
    && !stripComments(read('supabase/functions/commerce-control/index.ts')).includes('nemo_live_')
    && !stripComments(read('supabase/functions/commerce-control/index.ts')).includes('apiTokens')],

  ['the gateway only knows sdr actions, and they do not include cabinet operations',
    apiTokens.includes("export const SDR_ACTIONS = ['sdr:trigger', 'sdr:read'] as const")
    && !apiTokens.includes('set_auto_submit')
    && !apiTokens.includes('apply_proposal')],

  // Пустой или отсутствующий список прав означает «нельзя». Обратная трактовка превратила бы
  // забытое поле в ключ от всех операций аккаунта.
  ['permissions are deny-by-default, never allow-when-unset',
    apiTokens.includes("if (!allowed.includes(action)) return { ok: false, refusal: 'action_not_allowed' }")
    && !apiTokens.includes('allowed.length &&')],

  // Токен не хранится: в базе только HMAC. Утечка дампа не даёт действующих ключей.
  ['tokens are stored as HMAC hashes, never in plain text',
    apiTokens.includes("{ name: 'HMAC', hash: 'SHA-256' }")
    && tokensMigration.includes("token_hash text not null unique check (token_hash ~ '^[0-9a-f]{64}$')")
    && !tokensMigration.includes('token text not null')],

  // Без перца отпечаток посчитать нечем, и «пока без проверки» означало бы принимать любой токен.
  ['a missing pepper fails closed, it does not disable the check',
    apiTokens.includes("if (!pepper) throw new Error('token_pepper_missing')")
    && sdrApi.includes("if (!PEPPER) {")
    && sdrApi.includes("json({ error: 'gateway_not_configured' }, 503)")],

  // Лимит расходуется ПОСЛЕ проверки прав: иначе чужой подобранный ключ жёг бы квоту настоящего.
  ['the rate limit is consumed only after the permission check passes',
    sdrApi.indexOf('authorizeAction(row, action)') < sdrApi.indexOf('nemo_token_consume_rate')],

  // Счётчик атомарный. Прочитать-потом-записать означало бы, что десять одновременных вызовов
  // увидят одно число и все решат, что лимит не исчерпан.
  ['rate counting is atomic in SQL, not read-then-write in the function',
    tokensMigration.includes('on conflict (token_id, minute_bucket)')
    && tokensMigration.includes('returning u.request_count into v_count')],

  // Подписка аккаунта и лимит токена — разные вопросы, и одного ответа на оба недостаточно.
  ['the subscription lock still applies on top of token auth',
    sdrApi.includes('entitlementFor(admin, auth.accountId)')
    && sdrApi.includes("error: 'subscription_required'")],

  // Чужой job_id не должен отдавать лиды другого аккаунта.
  ['reading a job is bound to the token account',
    sdrApi.includes(".eq('account_id', auth.accountId)")
    && sdrApi.indexOf(".eq('account_id', auth.accountId)") < sdrApi.indexOf("json({ error: 'job_not_found' }, 404)")],

  // ── Очередь вместо синхронного прогона ────────────────────────────────────────────────────────
  // 30–50 лидов это Overpass + N загрузок сайтов + N вызовов модели, то есть минуты. Edge Function
  // будет убита раньше, чем закончит.
  ['the gateway enqueues and never runs the pipeline inline',
    !sdrApi.includes('runSdrPipeline')
    && sdrApi.includes("admin.rpc('enqueue_sdr_job'")
    && sdrApi.includes('}, 202)')],

  ['enqueue and credit debit happen in one transaction',
    tokensMigration.includes('select token_balance into v_balance from public.accounts where id = p_account_id for update')
    && tokensMigration.includes('update public.accounts set token_balance = token_balance - p_cost')],

  // Возврат только при окончательном провале: иначе три повтора списывают раз, а возвращают трижды.
  // Проверка аренды ищется В ТЕЛЕ finish_sdr_job, а не по всему файлу: та же строка есть в
  // heartbeat_sdr_job, и поиск по всему файлу оставался бы зелёным, даже если убрать её именно
  // оттуда, где она защищает деньги. Ровно эту слабость нашла мутационная проверка.
  ['credits are refunded once, only on terminal failure, and only by the current lease holder',
    (() => {
      const body = tokensMigration.split('function public.finish_sdr_job(')[1]?.split('$$;')[0] ?? ''
      return body.includes("if p_status = 'failed' and v_job.reserved_tokens > 0 then")
        && body.includes("where id = p_job_id and claim_token = p_claim_token and status = 'running'")
    })()],

  // Воркер, убитый на середине, обязан вернуть задачу в очередь сам — иначе одна упавшая задача
  // блокирует очередь навсегда.
  ['the queue uses SKIP LOCKED with an expiring lease',
    tokensMigration.includes('for update skip locked')
    && tokensMigration.includes("or (status = 'running' and lease_expires_at < now())")
    && worker.includes("admin.rpc('heartbeat_sdr_job'")],

  // Тихий откат на местные ключи означал бы, что владелец думает, будто платит платформе, а на деле
  // жжёт свой ключ и пишет в свою базу.
  ['platform mode never silently falls back to local execution',
    sdrRun.includes('if (process.env.NEMO_API_KEY)')
    && sdrRun.includes('process.exit(1)')
    && sdrRun.indexOf('if (process.env.NEMO_API_KEY)') < sdrRun.indexOf('let search')],

  // ── LinkUp: контракт не подтверждён — это должно быть названо, а не спрятано ──────────────────
  ['the unverified LinkUp integration is flagged honestly in code, not presented as confirmed',
    read('supabase/functions/_shared/leadgen/enricher.ts').includes('НЕ ПОДТВЕРЖДЕНО РЕАЛЬНОЙ ДОКУМЕНТАЦИЕЙ')],

  // ── Контракты: LeadStore существует и симметричен SheetSync ──────────────────────────────────
  ['LeadStore mirrors SheetSync\'s idempotency contract',
    contracts.includes('export interface LeadStore')
    && contracts.split('export interface LeadStore')[1]?.includes('save(leads: Lead[]): Promise<{ added: number; skipped: number }>')],
]

let failed = 0
for (const [name, passed] of cases) {
  if (!passed) { console.log(`FAIL ${name}`); failed++ }
}
console.log(`SDR contracts: ${cases.length - failed}/${cases.length}`)
if (failed) process.exit(1)
