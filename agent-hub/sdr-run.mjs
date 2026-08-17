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
import { renderLeadReport, formatLead, isHot } from './lead-report.mjs'
import { copyToClipboard, writeExport } from './lead-export.mjs'
import { Ask, Spinner, banner, c, isInteractiveTerminal } from './tui.mjs'

// ДО импорта модулей пайплайна по смыслу, но фактически до ЧТЕНИЯ env ниже: сами модули читают
// process.env только внутри resolve*-функций, поэтому порядок импортов здесь роли не играет.
const repoRoot = path.resolve(import.meta.dirname, '..')
const localEnv = loadLocalEnv(repoRoot)

import { runSdrPipeline } from '../supabase/functions/_shared/leadgen/pipeline.ts'
import { resolvePlacesSearch } from '../supabase/functions/_shared/leadgen/placesSearch.ts'
import { WebEnricher } from '../supabase/functions/_shared/leadgen/enricher.ts'
import { resolveScorer } from '../supabase/functions/_shared/leadgen/scorer.ts'
import { resolveLeadStore, resolveNotifier } from '../supabase/functions/_shared/leadgen/notifier.ts'

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
async function runLocally({ query, city, limit, icp }, spinner) {
  let search
  try {
    search = resolvePlacesSearch()
  } catch (error) {
    return { ok: false, error: error.message }
  }

  const result = await runSdrPipeline(
    { query, city, limit, icp: icp || undefined },
    {
      search,
      enrich: new WebEnricher(),
      score: resolveScorer(),
      store: resolveLeadStore(),
      notify: resolveNotifier(),
      // В интерактивном режиме журнал уходит в спиннер: две системы, печатающие в одну строку
      // одновременно, дают кашу из перезаписанных строк.
      log: spinner ? () => {} : (message) => console.log(`[SDR] ${message}`),
      onPhase: spinner
        ? (event) => {
          const progress = event.of ? ` ${event.done}/${event.of}` : ''
          spinner.update(`[${event.step}/${event.total}] ${event.message}${progress}`)
        }
        : undefined,
    },
  )
  return { ok: true, leads: result.leads, result }
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

  // Сбой на этапе поиска — единственный, что превращает прогон в неудачный: остальные этапы
  // деградируют осмысленно (без оценки, без сохранения, без уведомлений), и лиды всё равно найдены.
  process.exit(outcome.result.failures.some((one) => one.stage === 'search') ? 1 : 0)
}

// ─────────────────────────  Интерактивный режим  ─────────────────────────

async function askRequest(ask, previous) {
  const query = await ask.text('Какую нишу ищем?', {
    required: true, min: 2, placeholder: 'стоматология, автосервис, языковые курсы',
    fallback: previous?.query ?? '',
  })
  const city = await ask.text('Город поиска?', { required: true, min: 2, fallback: previous?.city ?? 'Ташкент' })
  const limitChoice = await ask.select('Сколько компаний искать?', LIMIT_OPTIONS, 1)
  const icpChoice = await ask.select('Целевой профиль клиента (ICP)?', ICP_PRESETS, 0)
  const icp = icpChoice.value ?? await ask.text('Опишите профиль своими словами', {
    required: true, min: 10, fallback: previous?.icp ?? '',
  })
  return { query, city, limit: limitChoice.value, icp }
}

/** Меню после прогона. Возвращает 'again' | 'exit'. */
async function afterRun(ask, leads) {
  const hot = (leads ?? []).filter(isHot)
  for (;;) {
    const options = [
      { label: '📋 Скопировать питч лида', value: 'copy' },
      { label: '💾 Экспорт в CSV', value: 'csv' },
      { label: '💾 Экспорт в JSON', value: 'json' },
      { label: '🔍 Новый поиск', value: 'again' },
      { label: '🚪 Выход', value: 'exit' },
    ]
    const choice = await ask.select('Что дальше?', options, 3)

    if (choice.value === 'exit') return 'exit'
    if (choice.value === 'again') return 'again'

    if (choice.value === 'csv' || choice.value === 'json') {
      if (!leads?.length) { console.log(`   ${c.yellow('!')} выгружать нечего — лидов нет`); continue }
      const file = writeExport(leads, choice.value)
      console.log(`   ${c.green('✓')} ${leads.length} лидов → ${file}`)
      continue
    }

    // copy
    const withPitch = hot.filter((lead) => lead.score?.icebreaker_pitch)
    if (!withPitch.length) {
      console.log(`   ${c.yellow('!')} нет готовых питчей: горячих лидов ${hot.length}`)
      continue
    }
    const pick = await ask.select(
      'Чей питч скопировать?',
      withPitch.map((lead) => ({ label: `${lead.name} (${lead.score.score}/100)`, value: lead })),
      0,
    )
    const pitch = pick.value.score.icebreaker_pitch
    const copied = await copyToClipboard(pitch)
    if (copied.ok) {
      console.log(`   ${c.green('✓')} питч «${pick.value.name}» в буфере обмена`)
    } else {
      // Буфера может не быть (нет xclip, ssh без X). Текст всё равно надо отдать — иначе человек
      // остался без того, за чем шёл, из-за отсутствия сторонней утилиты.
      console.log(`   ${c.yellow('!')} буфер недоступен (${copied.error}) — текст ниже:\n`)
      console.log(pitch)
      console.log('')
    }
  }
}

async function runInteractive() {
  console.log(banner('Nemo SDR', 'поиск и оценка лидов'))
  printEnvNotice()
  if (platformBase()) console.log(`[SDR] режим платформы: ${platformBase()}`)
  else printCapabilities()

  const ask = new Ask()
  let previous = null
  try {
    for (;;) {
      const request = await askRequest(ask, previous)
      previous = request

      const spinner = new Spinner()
      spinner.start('[1/3] Готовлюсь')
      const outcome = platformBase()
        ? await runViaPlatform(request, spinner)
        : await runLocally(request, spinner)

      if (!outcome.ok) {
        // Неудача не выбрасывает из сеанса: человек уже ответил на четыре вопроса, и терять их
        // из-за занятого Overpass или просроченной подписки незачем.
        console.log(`\n   ${c.red('×')} ${outcome.error}\n`)
      } else {
        if (outcome.result) spinner.succeed(`Готово. Горячих ${outcome.result.hot}, тёплых ${outcome.result.qualified}`)
        process.stdout.write(renderLeadReport(outcome.leads, { details: true }))
        if (outcome.result) printSummary(outcome.result)
      }

      if (await afterRun(ask, outcome.leads ?? []) === 'exit') break
    }
  } finally {
    ask.close()
  }
  console.log(`\n${c.dim('До связи.')}`)
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
