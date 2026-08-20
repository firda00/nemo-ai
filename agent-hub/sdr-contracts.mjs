// Границы SDR-пайплайна, записанные проверками.
//
// Модуль ходит в четыре чужих сервиса и пишет в боевую таблицу продаж. Здесь — то, что
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
const leadReport = read('agent-hub/lead-report.mjs')
const tui = read('agent-hub/tui.mjs')
const queryParse = read('agent-hub/query-parse.mjs')
const leadExport = read('agent-hub/lead-export.mjs')
const crmSync = read('agent-hub/crm-sync.ts')
const crmMigration = read('supabase/migrations/20260817200000_sdr_leads_crm_sync.sql')
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

  // Воркер записывает лиды САМ (со своим job_id), уже после возврата пайплайна. Если пайплайну
  // отдать notify, алерт уйдёт раньше записи, и по ссылке из Telegram владелец не найдёт ничего.
  // В местном режиме CLI такого нет: там store внутри пайплайна и стоит перед notify.
  ['the worker alerts only after leads are durably saved',
    worker.includes('notify: null,')
    && worker.indexOf('const saved = await saveLeads(job, result.leads)')
      < worker.indexOf('const alerted = await alertHotLeads(result.leads)')
    && worker.indexOf('const alerted = await alertHotLeads(result.leads)')
      < worker.indexOf("admin.rpc('finish_sdr_job'")],

  // Пайплайн по-прежнему пишет ДО уведомления — этот порядок нужен местному режиму CLI.
  ['the pipeline still stores before it notifies',
    pipeline.indexOf('if (deps.store) {') < pipeline.indexOf('if (deps.notify) {')],

  // Провал Telegram не должен помешать зафиксировать задачу: незафиксированная задача будет взята
  // снова, и кредиты спишутся второй раз. Сообщение же можно отправить повторно.
  ['a Telegram failure can never block finish_sdr_job',
    worker.split('async function alertHotLeads(')[1]?.split('\n}')[0]?.includes('try {')
    && worker.includes("errors.push(`${lead.name}: ${String(error?.message ?? error)}`)")
    && !worker.split('async function alertHotLeads(')[1]?.split('\n}')[0]?.includes('throw')],

  // Telegram отвечает конвертом {"ok":boolean} и умеет прислать отказ с кодом 200 — например, на
  // кривую разметку. Проверка только HTTP-статуса считала бы отвергнутое сообщение доставленным.
  ['a rejection in the response body is not counted as delivered',
    notifier.includes('if (payload && payload.ok === false)')
    && notifier.includes('telegram_rejected')],

  // MarkdownV2 требует экранировать восемнадцать символов, включая точку и дефис, — то есть почти
  // всё, что есть в названии клиники и в питче. Один забытый даёт отказ 400, а не кривой текст.
  ['messages use HTML mode, whose escape list is three characters and does not grow',
    notifier.includes("parse_mode: 'HTML'")
    && !notifier.includes('MarkdownV2')
    && notifier.includes("replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')")],

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

  // ── Синхронизация с CRM ──────────────────────────────────────────────────────────────────────
  // Состав полей нагрузки — это контракт с приёмником у клиента: он настроен под эти имена, и
  // молчаливое переименование ломает его интеграцию, а узнают об этом по пустой CRM.
  ['the CRM payload field set is pinned',
    ['id', 'lead_id', 'name', 'city', 'phone', 'website', 'socials', 'score', 'status', 'icp_reasoning', 'icebreaker', 'created_at']
      .every((field) => new RegExp(`^\\s+${field}:`, 'm').test(crmSync))
    && crmSync.includes("status: 'HOT'")],

  // Повторять стоит только то, что может пройти со второй попытки. Повтор 400 трижды — это шум в
  // чужом журнале, а не надёжность.
  ['only transient failures are retried, never our own 4xx',
    crmSync.includes('export function isRetryable')
    && crmSync.includes('if (status === null) return true')
    && crmSync.includes('if (status >= 500 || status === 429) return true')
    // Тело функции заканчивается отказом: всё, что не перечислено выше, повторять нельзя.
    && (crmSync.split('export function isRetryable')[1]?.split('\n}')[0] ?? '').trimEnd().endsWith('return false')],

  // Зависший приёмник не должен держать воркер, а повторы обязаны расходиться по времени.
  ['the webhook call is time-boxed and backs off exponentially',
    crmSync.includes('const TIMEOUT_MS = 5_000')
    && crmSync.includes('signal: AbortSignal.timeout(TIMEOUT_MS)')
    && crmSync.includes('return base * 2 ** attempt')
    && crmSync.includes('const MAX_RETRIES = 2')],

  // Повторы без ключа идемпотентности создают дубли: первая попытка могла дойти, а ответ потеряться.
  ['retries carry an idempotency key so a lost response cannot duplicate a lead',
    crmSync.includes("'Idempotency-Key': payload.id")],

  // Ни один отказ приёмника не имеет права помешать фиксации задачи: незафиксированная задача будет
  // взята повторно и спишет кредиты второй раз.
  ['a CRM failure can never block finish_sdr_job',
    crmSync.includes('export async function syncHotLeadsToCrm')
    && !/\bthrow\b/.test(crmSync.split('export async function syncHotLeadsToCrm')[1] ?? '')
    && worker.split('async function syncToCrm(')[1]?.split('\n}')[0]?.includes('try {')
    && worker.indexOf('const alerted = await alertHotLeads(result.leads)')
      < worker.indexOf('const crm = await syncToCrm(result.leads, saved.idByKey)')
    && worker.indexOf('const crm = await syncToCrm(result.leads, saved.idByKey)')
      < worker.indexOf("admin.rpc('finish_sdr_job'")],

  // Отметка об отправке живёт в базе, а не только в журнале воркера: журнал умирает с процессом, а
  // вопрос «этот лид уже уехал в CRM?» задают через неделю.
  ['the sync is recorded durably, not only in the console',
    crmMigration.includes('add column if not exists crm_synced_at timestamptz')
    && worker.includes("update({ crm_synced_at: new Date().toISOString() })")
    && worker.includes('.in(\'dedupe_key\', outcome.syncedKeys)')],

  // ── Интерактивный режим ──────────────────────────────────────────────────────────────────────
  // ОБРАТНАЯ СОВМЕСТИМОСТЬ — главное здесь. Скрипты, cron и CI зовут этот файл с флагами, и
  // интерактив не должен ни включаться у них, ни менять их вывод и код возврата.
  ['flags still take the non-interactive path, unchanged',
    sdrRun.includes('const wantsInteractive = !flagQuery && !flagCity')
    && sdrRun.includes('await runFromFlags()')
    && sdrRun.indexOf('if (!wantsInteractive)') < sdrRun.indexOf('isInteractiveTerminal()')],

  // Скрипт без флагов в конвейере должен ЧЕСТНО УПАСТЬ с подсказкой, а не повиснуть на вопросе,
  // которого никто не увидит: зависший пайплайн разбирают по таймауту через час.
  ['no terminal and no flags means a clear failure, never a hidden prompt',
    sdrRun.includes('} else if (isInteractiveTerminal()) {')
    && sdrRun.split('Интерактивный режим (npm run sdr:cli) требует терминала')[1]?.includes('process.exit(1)')],

  // Ни один вопрос не задаётся до проверки терминала.
  ['the interactive session is only constructed behind the terminal check',
    sdrRun.indexOf('isInteractiveTerminal()') < sdrRun.indexOf('await runInteractive()')
    && !tui.includes('process.stdin.resume()')],

  // Спиннер в НЕ-терминале печатает обычные строки: возврат каретки и escape-последовательности
  // в файле журнала превращают его в кашу, а именно туда вывод и попадёт из cron.
  ['the spinner degrades to plain lines when output is not a terminal',
    tui.includes('this.animated = Boolean(output.isTTY) && !process.env.NO_COLOR')
    && tui.includes("if (!this.animated) { this.output.write(`… ${text}\\n`); return this }")],

  // Этапы приходят структурой, а не разбором русских строк журнала регулярками: такая связь рвётся
  // от любой правки формулировки, причём молча.
  ['phases are reported as events, not parsed out of log text',
    pipeline.includes('onPhase?: (event: PhaseEvent) => void')
    && pipeline.includes("phase({ phase: 'search'")
    && sdrRun.includes('spinner.update(phaseLine(event, request.city))')
    && !sdrRun.includes("message.includes('найдено сырых')")],

  // ── Спиннер и приглашение ввода не делят строку ───────────────────────────────────────────────
  // Баг возвращался ДВАЖДЫ: спиннер, забытый включённым, каждые 80 мс перезаписывает строку, в
  // которой readline уже ждёт ввод, и набранный текст расползается по экрану. Гарантия должна жить
  // в примитиве, а не в дисциплине вызывающего кода: ветки ошибок забывали про останов оба раза.
  ['every prompt kills the running spinner inside the primitive itself',
    tui.includes('export function stopActiveSpinner()')
    && tui.split('  async line(prompt) {')[1]?.trimStart().startsWith('stopActiveSpinner()')
    && tui.split('  async select(question, options, defaultIndex = 0) {')[1]?.trimStart().startsWith('stopActiveSpinner()')],

  // Ни одна ветка выхода из прогона не оставляет анимацию живой — включая отказы до старта поиска.
  // Якорь привязан к САМОЙ функции, а не к первому попавшемуся `} finally {`. Блоков finally в файле
  // стало несколько (браузер закрывается своим), и проверка «в первом finally есть stopActiveSpinner»
  // начала смотреть не туда — сломалась на верном коде.
  ['no failure path leaves the animation running',
    sdrRun.includes('spinner?.silence()')
    && sdrRun.includes('spinner.fail(c.red(outcome.error))')
    && sdrRun.split('async function runInteractive() {')[1]?.split('} finally {')[1]?.includes('stopActiveSpinner()')],

  // Повторный итог молчит: путь через платформу отчитывается сам, и вызывающий код добавлял вторую
  // строку под первой.
  ['a settled spinner never prints a second summary line',
    tui.includes('if (this.settled) return this')],

  // ── Первый экран ─────────────────────────────────────────────────────────────────────────────
  // Служебные строки про ключи и источники — за --debug. Человек открывает CLI за лидами, а не за
  // отчётом о конфигурации; в режиме флагов они остаются, там это журнал прогона.
  ['the interactive screen starts clean: no key inventory unless --debug',
    sdrRun.includes("const debug = process.argv.includes('--debug')")
    && sdrRun.includes('if (debug) { printEnvNotice(); printCapabilities()')
    && sdrRun.split('async function runFromFlags() {')[1]?.trimStart().startsWith('printEnvNotice()')
    // Позиция важна: console.clear() встречается ещё и в ветке команды /clear, поэтому просто
    // «есть в функции» проверяет не то. Экран должен чиститься ПЕРВЫМ делом, до панели состояния.
    && /^\s*(\/\/[^\n]*\n\s*)*console\.clear\(\)\s*\n[^]*?await renderDashboard\(\)/
      .test(sdrRun.split('async function runInteractive() {')[1] ?? '')],

  // Рамка панели считает ширину БЕЗ escape-последовательностей: с .length правая стенка уезжает на
  // восемь позиций за каждый цвет, и панель превращается в лестницу.
  //
  // Проверка была прибита к ТОЧНОМУ тексту строки `width - visibleWidth(text)` и упала на
  // переименовании переменной — при полностью исправном поведении. Ловить надо подмену меры, а не
  // выбор имени: значение имеет то, что ширина берётся visibleWidth, а не .length.
  // Саму ровность рамки теперь проверяет tui-behavior, отрисовкой панели с ячейками шире колонки.
  ['the dashboard measures visible width, not byte length',
    tui.includes('export function visibleWidth(text)')
    && /const gap = Math\.max\(0, width - visibleWidth\(/.test(tui)
    && !/const gap = Math\.max\(0, width - [A-Za-z.]*\.length/.test(tui)
    && tui.includes('const topFill = ') && tui.includes('inner - visibleWidth(titleText)')],

  // Управляющий байт ESC в исходнике уже дважды пропадал при правке, унося за собой цвета и меру
  // ширины. Он должен собираться из кода символа — и в примитивах, и в их проверках.
  ['no literal escape bytes live in the TUI sources',
    tui.includes("const ESC = String.fromCharCode(27)")
    && !tui.includes(String.fromCharCode(27))
    && !read('agent-hub/query-parse-behavior.mjs').includes(String.fromCharCode(27))],

  // ── Разбор фразы ─────────────────────────────────────────────────────────────────────────────
  // Разбор НЕ УГАДЫВАЕТ. Неверно угаданный город уводит прогон в другую страну, тратит кредиты и
  // возвращает «ничего не найдено» без объяснения — спросить дешевле в любом случае.
  ['the phrase parser asks instead of guessing',
    queryParse.includes('export function parseNaturalQuery(text)')
    && queryParse.includes("if (!raw) return { query: null, city: null, limit: null, rest: '' }")
    && queryParse.includes('const preposition = [...working.matchAll(PREPOSITION_RE)].at(-1)')
    && queryParse.includes('if (parsed >= MIN_LIMIT && parsed <= MAX_LIMIT) {')],

  // Значение по умолчанию — решение ИНТЕРФЕЙСА, а не разбора: подставь его разбор, и человек уже не
  // отличит «я сказал Ташкент» от «за меня решили».
  ['defaults belong to the prompt, not to the parser',
    !queryParse.includes("city = 'Ташкент'")
    && sdrRun.includes("fallback: previous?.city ?? 'Ташкент'")],

  // Вопрос задаётся ТОЛЬКО о том, чего в строке не было — иначе разбор фразы бессмыслен.
  ['already-parsed values are never asked again',
    sdrRun.includes('const query = parsed.query\n    ?? await ask.text(')
    && sdrRun.includes('const city = parsed.city\n    ?? await ask.text(')
    && sdrRun.includes('const limit = parsed.limit ?? (await ask.select(')],

  // Выгрузка открывается в Excel. BOM и CRLF — не украшение: без них русский текст читается как
  // ANSI, а перевод строки внутри питча рвёт запись на две.
  ['the CSV export survives Excel: BOM, CRLF and doubled quotes',
    leadExport.includes("return `﻿${rows.join('\\r\\n')}\\r\\n`")
    && leadExport.includes('text.replace(/"/g, \'""\')')
    && leadExport.includes("['icebreaker', (lead) => lead.score?.icebreaker_pitch ?? '']")],

  // Отсутствие xclip — не повод рушить сеанс: текст всё равно надо отдать человеку.
  ['a missing clipboard tool prints the pitch instead of failing',
    leadExport.includes('resolve({ ok: false, error:')
    && !leadExport.includes('throw new Error')
    && sdrRun.includes('буфер недоступен')],

  // ── Вывод лидов в консоль ────────────────────────────────────────────────────────────────────
  // Прогон, который сообщает «горячих: 3» и молчит о том, кто это и что им написать, заставляет
  // идти в SQL за данными, лежащими в двух шагах от экрана. Горячие печатаются БЕЗ флага: они и
  // есть причина запуска, и прятать их значит просить прогнать всё заново за уже оплаченным.
  ['hot leads with their icebreaker print without any flag',
    leadReport.includes('const shown = details ? [...hot, ...rest] : hot')
    && leadReport.includes('score.icebreaker_pitch')
    && sdrRun.includes('renderLeadReport(outcome.leads, { details })')],

  // Один форматтер на ВСЕ пути вывода: по флагам через платформу, по флагам локально и в
  // интерактиве. Раньше платформенный путь печатал свою строку, местный не печатал ничего, и эти
  // выводы разошлись бы при первой правке. Интерактив добавил третий — он тоже идёт через него.
  // Два вида вывода (журнал по флагам и карточки интерактива) — но оба живут в lead-report.mjs, и
  // ни одна строка лида не собирается прямо в sdr-run.mjs. Иначе они разойдутся при первой правке:
  // платформенный путь однажды печатал свою строку, местный — ничего.
  ['every CLI path renders leads through lead-report.mjs, never inline',
    (sdrRun.match(/renderLeadReport\(/g) ?? []).length === 2
    && (sdrRun.match(/renderLeadCards\(/g) ?? []).length === 1
    && leadReport.includes('export function renderLeadCards(leads)')
    && leadReport.includes('export function leadCard(lead, index)')
    && !sdrRun.includes("lead.score?.status === 'HOT' ? '🔥' : '  '")
    && !sdrRun.includes('icebreaker_pitch}`)')],

  // Питч копируют целиком и отправляют живому человеку. Наш значок внутри строки уедет вместе с ним.
  ['the icebreaker line carries no decoration of ours',
    leadReport.includes('`     ${score.icebreaker_pitch}`')
    && !leadReport.includes('🔥 первое касание')],

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
  // Проверяется ТЕЛО runFromFlags: платформенная ветка обязана завершить процесс сама и не
  // провалиться в местный прогон ниже. Поиск по всему файлу здесь не годится — интерактив тоже
  // упоминает и платформу, и местный путь, и совпадение нашлось бы всегда.
  ['platform mode never silently falls back to local execution',
    (() => {
      const body = sdrRun.split('async function runFromFlags() {')[1]?.split('\n}')[0] ?? ''
      const platformBranch = body.split('if (platformBase() || process.env.NEMO_API_KEY) {')[1]?.split('  }')[0] ?? ''
      return platformBranch.includes('process.exit(1)')
        && platformBranch.includes('process.exit(0)')
        && !platformBranch.includes('runLocally')
    })()],

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
