// Прогон SDR-пайплайна. Три способа запуска, и выбор между ними ЯВНЫЙ.
//
//   npm run sdr:cli                (или npm run sdr:run без флагов)
//     Интерактивный режим: пошаговый опросник, спиннер с этапами, меню действий после прогона.
//     Требует живой терминал. В конвейере, из cron или из CI НЕ запускается — вместо ожидания
//     невидимого вопроса печатает подсказку про флаги и выходит с ошибкой.
//
//   npm run sdr:run -- --query "стоматология" --city "Ташкент" --limit 50
//     Обычный прогон по флагам: для скриптов, cron и всего, где спрашивать некого. Работает ровно
//     как раньше — интерактив ничего здесь не поменял.
//
//   ... --details
//     Показать ВСЕХ найденных, а не только горячих. Горячие с готовым первым касанием печатаются
//     и без флага: они и есть причина запуска, и прятать их за флагом значит просить прогнать всё
//     заново ради того, что уже посчитано и оплачено.
//
//   NEMO_API_KEY=nemo_live_... npm run sdr:run -- --query "..." --city "..."
//     Через платформу: задача уходит в Nemo, считает сервер своими ключами, CLI ждёт результат.
//     Работает и в интерактивном режиме тоже.
//
// Если NEMO_API_KEY задан, а сервер недоступен — команда ПАДАЕТ, а не досчитывает молча на местных
// ключах. Тихий откат означал бы, что владелец думает, будто платит платформе и работает её
// лимитами, а на деле жжёт свой ключ OpenRouter и пишет в свою базу.
//
// Ключи подхватываются САМИ из .secrets.local / .env.local / .env — руками ничего экспортировать не
// нужно. Уже заданная в окружении переменная важнее файла: `KEY=... npm run sdr:run` продолжает
// работать. Местный прогон запускается и вообще без ключей — просто делает меньше на этом шаге, а не
// падает:
//   GOOGLE_PLACES_API_KEY нет           → поиск идёт через OpenStreetMap (бесплатно, без ключа)
//   OPENROUTER_API_KEY нет              → оценка пропускается, лиды уходят без score
//   SUPABASE_PROJECT_REF/SECRET_KEY нет → сохранение в базу пропускается
//   SDR_TELEGRAM_BOT_TOKEN/CHAT_ID нет  → уведомления пропускаются

import path from 'node:path'
import { loadLocalEnv } from './load-local-env.mjs'
import { isHot, phaseLine, renderLeadCards, renderLeadReport } from './lead-report.mjs'
import { copyToClipboard, writeExport } from './lead-export.mjs'
import { Ask, Spinner, c, dashboard, isInteractiveTerminal, statusMenu, stopActiveSpinner } from './tui.mjs'
import { parseCommand, parseNaturalQuery } from './query-parse.mjs'

// ДО импорта модулей пайплайна по смыслу, но фактически до ЧТЕНИЯ env ниже: сами модули читают
// process.env только внутри resolve*-функций, поэтому порядок импортов здесь роли не играет.
const repoRoot = path.resolve(import.meta.dirname, '..')
const localEnv = loadLocalEnv(repoRoot)

import { runSdrPipeline } from '../supabase/functions/_shared/leadgen/pipeline.ts'
import { resolvePlacesSearch } from '../supabase/functions/_shared/leadgen/placesSearch.ts'
import { WebEnricher } from '../supabase/functions/_shared/leadgen/enricher.ts'
import { resolveScorer } from '../supabase/functions/_shared/leadgen/scorer.ts'
import { resolveLeadStore, resolveNotifier } from '../supabase/functions/_shared/leadgen/notifier.ts'
import { createBrowserBridge } from './tools/enrich-browser.ts'
import { resolveLeadCardConfig } from './telegram/lead-card-bridge.ts'

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`)
  if (index === -1 || index === process.argv.length - 1) return fallback
  return process.argv[index + 1]
}

const flagQuery = arg('query', process.env.SDR_QUERY ?? '')
const flagCity = arg('city', process.env.SDR_CITY ?? '')
const flagLimit = Number(arg('limit', process.env.SDR_LIMIT ?? '20'))
const flagIcp = arg('icp', process.env.SDR_ICP ?? '')
// Горячие печатаются подробно ВСЕГДА — за флагом их прятать незачем. --details добавляет остальных.
const details = process.argv.includes('--details')
// В интерактивном режиме служебные строки («ключи из .secrets.local: …», источник поиска, состояние
// хранилища) прячутся за --debug: человек пришёл за лидами, а не за отчётом о конфигурации. В режиме
// флагов они печатаются как раньше — там это лог прогона, и по нему потом разбираются.
const debug = process.argv.includes('--debug')

/** Пресеты ICP: частые формулировки под рукой, но своими словами — всегда доступно. */
const ICP_PRESETS = [
  { label: 'Нужен ИИ-агент для приёма заявок и записи клиентов круглосуточно',
    value: 'Компании, которым нужен ИИ-агент для приёма заявок и записи клиентов круглосуточно' },
  { label: 'Теряют заявки из мессенджеров, некому отвечать вечером и в выходные',
    value: 'Компании, которые теряют заявки из мессенджеров: некому отвечать вечером и в выходные' },
  { label: 'Есть сайт и поток клиентов, но нет автоматизации продаж',
    value: 'Компании с сайтом и потоком клиентов, но без автоматизации продаж и обработки лидов' },
  { label: 'Своими словами…', value: null },
]

const LIMIT_OPTIONS = [
  { label: '10 — быстрая проверка', value: 10 },
  { label: '25 — обычный прогон', value: 25 },
  { label: '50 — широкий охват', value: 50 },
]

/** Адрес шлюза платформы. null — режим платформы не настроен. */
function platformBase() {
  if (!process.env.NEMO_API_KEY) return null
  return process.env.NEMO_API_URL
    ?? (process.env.SUPABASE_PROJECT_REF
      ? `https://${process.env.SUPABASE_PROJECT_REF}.supabase.co/functions/v1/sdr-api`
      : null)
}

/**
 * Прогон через платформу. Возвращает { ok, leads, stats } либо { ok: false, error }.
 *
 * Ошибки НЕ гасятся process.exit внутри: в интерактивном режиме после неудачи надо вернуться в меню,
 * а не уронить сеанс, в котором человек уже ввёл четыре ответа.
 */
async function runViaPlatform({ query, city, limit, icp }, spinner) {
  const apiBase = platformBase()
  if (!apiBase) {
    spinner?.silence()
    return { ok: false, error: 'NEMO_API_KEY задан, но неизвестен адрес: укажите NEMO_API_URL или SUPABASE_PROJECT_REF.' }
  }

  const headers = {
    Authorization: `Bearer ${process.env.NEMO_API_KEY}`,
    'Content-Type': 'application/json',
    // Шлюз Supabase требует публичный ключ проекта отдельным заголовком — он не секрет и лежит в
    // каждом браузере, открывшем сайт. Без него запрос не доходит до функции вовсе.
    ...(process.env.SUPABASE_PUBLISHABLE_KEY ? { apikey: process.env.SUPABASE_PUBLISHABLE_KEY } : {}),
  }

  spinner.start(`[1/3] Ставлю задачу в Nemo`)
  const created = await fetch(`${apiBase}/jobs`, {
    method: 'POST', headers, body: JSON.stringify({ query, city, limit, icp: icp || undefined }),
  }).catch((error) => ({ networkError: error.message }))
  if (created.networkError) { spinner.fail('сеть недоступна'); return { ok: false, error: created.networkError } }

  const createdBody = await created.json().catch(() => null)
  if (!created.ok || !createdBody?.job_id) {
    spinner.fail('задача не поставлена')
    // Причину отказа печатаем как пришла: 403 action_not_allowed и 402 insufficient_credits
    // чинятся совершенно по-разному, и обобщать их в «не получилось» бесполезно.
    return { ok: false, error: `HTTP ${created.status}: ${JSON.stringify(createdBody)}` }
  }

  const jobId = createdBody.job_id
  spinner.update(`[2/3] Задача ${jobId.slice(0, 8)} принята (${createdBody.reserved_tokens} кредитов), ждём воркер`)

  const startedAt = Date.now()
  const TIMEOUT_MS = 15 * 60 * 1000
  for (;;) {
    if (Date.now() - startedAt > TIMEOUT_MS) {
      spinner.fail('задача не завершилась за 15 минут')
      return { ok: false, error: `состояние можно забрать позже: GET ${apiBase}/jobs/${jobId}` }
    }
    await new Promise((resolve) => setTimeout(resolve, 5000))

    const status = await fetch(`${apiBase}/jobs/${jobId}`, { headers }).catch(() => null)
    const payload = await status?.json().catch(() => null)
    if (!payload?.job) { spinner.update('[2/3] состояние недоступно, повторяю'); continue }

    if (payload.job.status === 'queued' || payload.job.status === 'running') {
      const seconds = Math.round((Date.now() - startedAt) / 1000)
      spinner.update(`[3/3] Воркер: ${payload.job.status} — ${seconds}с`)
      continue
    }

    if (payload.job.status === 'failed') {
      spinner.fail(`задача провалилась: ${payload.job.error ?? 'причина не указана'}`)
      return { ok: false, error: 'кредиты возвращены на счёт' }
    }

    const stats = payload.job.stats ?? {}
    spinner.succeed(`Готово. Найдено ${stats.found ?? 0}, лидов ${payload.leads.length}, горячих ${stats.hot ?? 0}`)
    return { ok: true, leads: payload.leads, stats }
  }
}

/** Прогон на этой машине. Возвращает ту же форму, что и платформенный. */
async function runLocally({ query, city, limit, icp }, spinner, onPhase) {
  let search
  try {
    search = resolvePlacesSearch()
  } catch (error) {
    // Спиннер гасится ЗДЕСЬ, а не в вызывающем коде: раньше эта ветка возвращала ошибку с
    // работающей анимацией, и та продолжала писать в строку, где readline уже ждал ввод.
    spinner?.silence()
    return { ok: false, error: error.message }
  }

  // Браузер поднимается ОДИН на весь прогон и закрывается в finally. Незакрытый Chromium остаётся
  // зомби-процессом в системе: через сутки такого воркера машина уходит в свап.
  const browser = createBrowserBridge()
  // Карточки с кнопками ЗАМЕНЯЮТ обычные уведомления, а не добавляются к ним: иначе на каждый горячий
  // лид уходит два сообщения об одном и том же.
  const cards = resolveLeadCardConfig()
  try {
    const result = await runSdrPipeline(
      { query, city, limit, icp: icp || undefined },
      {
        search,
        enrich: new WebEnricher(process.env, fetch, browser.fallback),
        score: resolveScorer(),
        store: resolveLeadStore(),
        notify: cards.enabled ? null : resolveNotifier(),
        // В интерактивном режиме журнал уходит в спиннер: две системы, печатающие в одну строку
        // одновременно, дают кашу из перезаписанных строк.
        log: spinner ? () => {} : (message) => console.log(`[SDR] ${message}`),
        // onPhase снаружи важнее: интерактив формулирует этапы по-человечески («Поиск в Ташкенте через
        // OpenStreetMap»), а не технически («overpass_search»).
        onPhase: onPhase ?? (spinner
          ? (event) => {
            const progress = event.of ? ` ${event.done}/${event.of}` : ''
            spinner.update(`[${event.step}/${event.total}] ${event.message}${progress}`)
          }
          : undefined),
      },
    )
    // Карточки — ПОСЛЕ возврата пайплайна, то есть после сохранения в базу. Порядок тот же, что у
    // воркера: кнопка «Отправить оффер» ссылается на лид, которого до записи в базе нет.
    const cardReport = cards.enabled ? await deliverLeadCards(cards, result.leads) : null
    return { ok: true, leads: result.leads, result, browserStats: browser.stats(), cardReport }
  } finally {
    await browser.close()
  }
}

/**
 * Разослать карточки горячих лидов с кнопками действий.
 *
 * Ни одна ошибка здесь НЕ роняет прогон: лиды уже найдены, оценены и сохранены, а недоставленная
 * карточка — потеря одного уведомления. Отказы возвращаются списком, чтобы их можно было назвать.
 */
async function deliverLeadCards(config, leads) {
  try {
    const [{ TelegramNotificationService }, { sendLeadCards }] = await Promise.all([
      import('./telegram/bot-service.ts'),
      import('./telegram/lead-card-bridge.ts'),
    ])
    const service = new TelegramNotificationService(config.token)
    return await sendLeadCards(service, config.chatId, leads ?? [])
  } catch (error) {
    return { sent: 0, skipped: 0, errors: [`карточки не отправлены: ${error.message}`] }
  }
}

/** Сводка прогона цифрами — то же, что печаталось всегда. */
function printSummary(result) {
  console.log('[SDR] Итог:')
  console.log(`  найдено сырых: ${result.found}`)
  console.log(`  отброшено на очистке: ${result.rejected.length}`)
  console.log(`  дублей: ${result.duplicates}`)
  console.log(`  горячих: ${result.hot}`)
  console.log(`  тёплых: ${result.qualified}`)

  if (result.rejected.length) {
    const byReason = {}
    for (const one of result.rejected) byReason[one.reason] = (byReason[one.reason] ?? 0) + 1
    console.log(`  причины отсева: ${Object.entries(byReason).map(([reason, n]) => `${reason}=${n}`).join(' ')}`)
  }
  if (result.failures.length) {
    console.log(`  сбоев: ${result.failures.length}`)
    for (const failure of result.failures.slice(0, 20)) console.log(`    [${failure.stage}] ${failure.detail}`)
  }
}

/**
 * Итог рассылки карточек с кнопками.
 *
 * Молчание здесь недопустимо: непришедшая карточка о горячем лиде выглядит как «горячих не нашлось»,
 * и владелец будет искать причину в поиске, а не в Telegram.
 */
function printCardReport(report) {
  if (!report) return
  console.log(`[SDR] карточки в Telegram: отправлено ${report.sent}${report.skipped ? `, пропущено ${report.skipped}` : ''}`)
  for (const one of report.errors) console.warn(`[SDR] карточка не доставлена — ${one}`)
}

/** Что подхватилось из файлов — ИМЕНАМИ, без значений. */
function printEnvNotice() {
  if (localEnv.loaded.length) {
    console.log(`[SDR] ключи из ${localEnv.files.join(', ')}: ${localEnv.loaded.join(', ')}`)
  } else if (localEnv.files.length) {
    console.log(`[SDR] ${localEnv.files.join(', ')} прочитаны, новых переменных нет — всё уже в окружении`)
  }
}

/** Чем этот запуск располагает. Один и тот же текст в обоих режимах. */
function printCapabilities() {
  const score = resolveScorer()
  const store = resolveLeadStore()
  const notify = resolveNotifier()
  let searchName = 'не настроен'
  try { searchName = resolvePlacesSearch().constructor.name } catch { /* сообщим при прогоне */ }
  console.log(`[SDR] источник поиска: ${searchName}`)
  console.log(`[SDR] оценка: ${score ? `включена (${process.env.SDR_SCORER_MODEL ?? 'openai/gpt-4o-mini'})` : 'пропущена — нет OPENROUTER_API_KEY'}`)
  console.log(`[SDR] хранилище: ${store ? 'Supabase' : 'пропущено — нет SUPABASE_PROJECT_REF/SUPABASE_SECRET_KEY'}`)
  console.log(`[SDR] уведомления: ${notify ? 'Telegram' : 'пропущены — нет SDR_TELEGRAM_BOT_TOKEN/SDR_TELEGRAM_CHAT_ID'}`)
}

// ─────────────────────────  Режим по флагам (скрипты, cron, CI)  ─────────────────────────
//
// Работает точно как до появления интерактива: спиннера нет, журнал строками, выход кодом.
async function runFromFlags() {
  printEnvNotice()
  const request = { query: flagQuery, city: flagCity, limit: flagLimit, icp: flagIcp }

  if (platformBase() || process.env.NEMO_API_KEY) {
    console.log(`[SDR] режим платформы: ${platformBase() ?? '(адрес не задан)'}`)
    const spinner = new Spinner()
    const outcome = await runViaPlatform(request, spinner)
    if (!outcome.ok) { console.error(`[SDR] ${outcome.error}`); process.exit(1) }
    process.stdout.write(renderLeadReport(outcome.leads, { details }))
    process.exit(0)
  }

  printCapabilities()
  const outcome = await runLocally(request, null)
  if (!outcome.ok) { console.error(`[SDR] ${outcome.error}`); process.exit(1) }

  // Сначала сами лиды, потом цифры. Горячие — то, ради чего запускали, и они не должны
  // прокручиваться вверх за сводкой отсева.
  process.stdout.write(renderLeadReport(outcome.leads, { details }))
  printSummary(outcome.result)
  printCardReport(outcome.cardReport)

  // Сбой на этапе поиска — единственный, что превращает прогон в неудачный: остальные этапы
  // деградируют осмысленно (без оценки, без сохранения, без уведомлений), и лиды всё равно найдены.
  process.exit(outcome.result.failures.some((one) => one.stage === 'search') ? 1 : 0)
}

// ─────────────────────────  Интерактивный режим  ─────────────────────────

const ICP_PRESET_ROWS = ICP_PRESETS.map((one) => ({ label: one.label, value: one.value }))

/**
 * Аккаунт и баланс для панели состояния.
 *
 * Тихо возвращает пустое, если ключей нет или запрос не удался: панель — это оформление экрана, и
 * падать из-за неё, когда человек хочет местный прогон без Supabase, было бы абсурдом.
 */
async function accountSnapshot() {
  const ref = process.env.SUPABASE_PROJECT_REF
  const key = process.env.SUPABASE_SECRET_KEY
  if (!ref || !key) return { id: null, plan: null, balance: null }
  try {
    const { createClient } = await import('@supabase/supabase-js')
    const admin = createClient(`https://${ref}.supabase.co`, key)
    const { data: token } = await admin.from('nemo_api_tokens')
      .select('account_id').eq('is_active', true)
      .order('created_at', { ascending: false }).limit(1).maybeSingle()
    const accountId = token?.account_id
    if (!accountId) return { id: null, plan: null, balance: null }
    const [{ data: account }, { data: sub }] = await Promise.all([
      admin.from('accounts').select('token_balance').eq('id', accountId).maybeSingle(),
      admin.from('billing_subscriptions').select('status, plan_code').eq('account_id', accountId).maybeSingle(),
    ])
    return { id: accountId, plan: sub?.plan_code ?? sub?.status ?? null, balance: account?.token_balance ?? null }
  } catch {
    return { id: null, plan: null, balance: null }
  }
}

/** Панель состояния: чем этот запуск располагает и как начать. */
async function renderDashboard() {
  const account = await accountSnapshot()
  const gateway = platformBase() ? 'Nemo Platform' : (resolveScorer() ? 'локальный прогон' : 'без ICP-оценки')
  let source = 'не настроен'
  try { source = resolvePlacesSearch().constructor.name.replace(/PlacesSearch$/, '') } catch { /* скажем при прогоне */ }

  console.log(dashboard({
    title: c.bold('Nemo SDR'),
    left: [
      c.magenta('NEMO ENGINE'),
      account.id ? `Аккаунт: ${account.id.slice(0, 8)}…${account.plan ? ` (${account.plan})` : ''}` : 'Аккаунт: не подключён',
      `Баланс:  ${account.balance == null ? '—' : `${account.balance.toLocaleString('ru-RU')} кредитов`}`,
      `Поиск:   ${source}`,
      `Прогон:  ${gateway}`,
    ],
    right: [
      c.bold('Как начать'),
      `Напишите: ${c.cyan('<ниша> в <город> <сколько>')}`,
      c.dim('стоматология в Ташкенте 15'),
      '',
      c.dim('/help — справка   /exit — выход'),
    ],
  }))
}

const HELP = [
  '',
  `  ${c.bold('Одной строкой')} — ниша, город и сколько сразу:`,
  `    ${c.cyan('стоматология в Ташкенте 15')}`,
  `    ${c.cyan('кофейни в Бухаре, 10 штук')}`,
  `    ${c.cyan('до 25 фитнес-клубов в Самарканде')}`,
  '',
  `  ${c.bold('Частями')} — чего не хватило, спросим отдельно:`,
  `    ${c.cyan('автосервис')}`,
  '',
  `  ${c.bold('/help')}   эта справка`,
  `  ${c.bold('/clear')}  перерисовать экран`,
  `  ${c.bold('/exit')}   выход (или Ctrl+C)`,
  '',
  c.dim('  Город можно писать как в речи — «в Ташкенте», «в Бухаре»: падеж снимается сам.'),
].join('\n')

/**
 * Собирает параметры прогона: сначала из фразы, потом добираем недостающее.
 *
 * Спрашивается ТОЛЬКО то, чего в строке не было. Человек, написавший всё сразу, не должен трижды
 * жать Enter, подтверждая уже сказанное — иначе смысл разбора фразы теряется полностью.
 */
async function collectRequest(ask, phrase, previous) {
  const parsed = parseNaturalQuery(phrase)
  const query = parsed.query
    ?? await ask.text('Ниша', { required: true, min: 2, fallback: previous?.query ?? '' })
  const city = parsed.city
    ?? await ask.text('Город', { required: true, min: 2, fallback: previous?.city ?? 'Ташкент' })
  const limit = parsed.limit ?? (await ask.select('Сколько компаний', LIMIT_OPTIONS, 1)).value

  const preset = await ask.select('Кого ищем (ICP)', ICP_PRESET_ROWS, 0)
  const icp = preset.value
    ?? await ask.text('Опишите своими словами', { required: true, min: 10, fallback: previous?.icp ?? '' })

  return { query, city, limit, icp }
}

/** Меню после прогона. Возвращает 'again' либо 'exit'. */
async function afterRun(ask, leads) {
  const withPitch = (leads ?? []).filter((lead) => isHot(lead) && lead.score?.icebreaker_pitch)
  for (;;) {
    console.log(`  ${statusMenu([
      { key: '1', label: 'Копировать питч' },
      { key: '2', label: 'CSV' },
      { key: '3', label: 'Новый поиск' },
      { key: 'q', label: 'Выход' },
    ])}`)
    const raw = (await ask.line(`${c.magenta('❯')} `)).trim().toLowerCase()

    if (raw === 'q' || raw === 'exit' || raw === '/exit') return 'exit'
    if (raw === '3' || raw === '' || raw === '/new') return 'again'

    if (raw === '2' || raw === 'csv' || raw === 'json') {
      if (!leads?.length) { console.log(`  ${c.yellow('!')} выгружать нечего\n`); continue }
      const file = writeExport(leads, raw === 'json' ? 'json' : 'csv')
      console.log(`  ${c.green('✓')} ${leads.length} лидов → ${file}\n`)
      continue
    }

    if (raw === '1' || raw === 'copy') {
      if (!withPitch.length) { console.log(`  ${c.yellow('!')} готовых питчей нет\n`); continue }
      const pick = withPitch.length === 1
        ? withPitch[0]
        : (await ask.select('Чей питч', withPitch.map((lead) => ({ label: `${lead.name} (${lead.score.score}/100)`, value: lead })), 0)).value
      const pitch = pick.score.icebreaker_pitch
      const copied = await copyToClipboard(pitch)
      if (copied.ok) console.log(`  ${c.green('✓')} питч «${pick.name}» в буфере\n`)
      // Буфера может не быть вовсе (ssh без X, урезанный контейнер). Текст всё равно печатаем: иначе
      // человек остался без того, за чем шёл, из-за отсутствия сторонней утилиты.
      else console.log(`  ${c.yellow('!')} буфер недоступен (${copied.error}), вот текст:\n\n${pitch}\n`)
      continue
    }

    console.log(`  ${c.dim('1, 2, 3 или q')}\n`)
  }
}

async function runInteractive() {
  // Чистый экран: панель состояния должна быть первым, что видно, а не концом чужого вывода. Служебные
  // строки про ключи и источники прячутся за --debug — человек пришёл за лидами, а не за конфигурацией.
  console.clear()
  if (debug) { printEnvNotice(); printCapabilities(); console.log('') }
  await renderDashboard()

  const ask = new Ask()
  let previous = null
  try {
    for (;;) {
      console.log('')
      const phrase = (await ask.line(`${c.magenta('❯')} `)).trim()

      const command = parseCommand(phrase)
      if (command) {
        if (['exit', 'quit', 'q'].includes(command.name)) break
        if (['help', 'h', '?'].includes(command.name)) { console.log(HELP); continue }
        if (command.name === 'clear') { console.clear(); await renderDashboard(); continue }
        console.log(`  ${c.dim(`нет такой команды: /${command.name} — /help покажет список`)}`)
        continue
      }
      if (!phrase) { console.log(HELP); continue }

      const request = await collectRequest(ask, phrase, previous)
      previous = request

      const spinner = new Spinner()
      spinner.start(`[1/3] Поиск в ${request.city}…`)
      const outcome = platformBase()
        ? await runViaPlatform(request, spinner)
        : await runLocally(request, spinner, (event) => spinner.update(phaseLine(event, request.city)))

      // fail/succeed гасят анимацию и оставляют одну строку. Пропустить это нельзя ни в одной ветке:
      // забытый включённым спиннер продолжает писать в ту же строку, где readline уже ждёт ввод, и
      // набранный текст расползается по экрану. Повторный вызов молчит, так что путь через платформу,
      // который отчитался сам, второй строки не добавит.
      if (!outcome.ok) {
        spinner.fail(c.red(outcome.error))
        console.log('')
      } else {
        const numbers = outcome.result
          ? `найдено ${outcome.result.found}, горячих ${outcome.result.hot}, тёплых ${outcome.result.qualified}`
          : `лидов ${outcome.leads?.length ?? 0}`
        spinner.succeed(c.dim(`Готово: ${numbers}`))
        process.stdout.write(renderLeadCards(outcome.leads))
      }

      if (await afterRun(ask, outcome.leads ?? []) === 'exit') break
    }
  } finally {
    // Последняя защита: если какая-то ветка всё же оставила спиннер живым, гасим его до закрытия
    // readline — иначе таймер допишет свою строку поверх приглашения shell после выхода.
    stopActiveSpinner()
    ask.close()
  }
  console.log(`\n${c.dim('До связи.')}\n`)
  process.exit(0)
}


// ─────────────────────────  Выбор режима  ─────────────────────────
//
// Интерактив только когда флагов НЕТ и терминал живой. Оба условия обязательны: скрипт с флагами
// должен работать как раньше, а скрипт без флагов в конвейере — честно упасть с подсказкой, а не
// повиснуть на вопросе, которого никто не увидит.
const wantsInteractive = !flagQuery && !flagCity

if (!wantsInteractive) {
  await runFromFlags()
} else if (isInteractiveTerminal()) {
  await runInteractive()
} else {
  console.error('Нужны --query и --city. Пример: npm run sdr:run -- --query "стоматология" --city "Ташкент"')
  console.error('Интерактивный режим (npm run sdr:cli) требует терминала — здесь его нет.')
  process.exit(1)
}
