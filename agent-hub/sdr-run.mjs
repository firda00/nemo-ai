// Прогон SDR-пайплайна. Два режима, и выбор между ними ЯВНЫЙ.
//
//   npm run sdr:run -- --query "стоматология" --city "Ташкент" --limit 50
//     Местный прогон: всё считается здесь, ключи берутся с этой машины.
//
//   ... --details
//     Показать ВСЕХ найденных, а не только горячих. Горячие с готовым первым касанием печатаются
//     и без флага: они и есть причина запуска, и прятать их за флагом значит просить прогнать всё
//     заново ради того, что уже посчитано и оплачено.
//
//   NEMO_API_KEY=nemo_live_... npm run sdr:run -- --query "..." --city "..."
//     Через платформу: задача уходит в Nemo, считает сервер своими ключами, CLI ждёт результат.
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
import { renderLeadReport } from './lead-report.mjs'

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

const query = arg('query', process.env.SDR_QUERY ?? '')
const city = arg('city', process.env.SDR_CITY ?? '')
const limit = Number(arg('limit', process.env.SDR_LIMIT ?? '20'))
const icp = arg('icp', process.env.SDR_ICP ?? '')
// Горячие печатаются подробно ВСЕГДА — за флагом их прятать незачем. --details добавляет остальных.
const details = process.argv.includes('--details')

if (!query || !city) {
  console.error('Нужны --query и --city. Пример: npm run sdr:run -- --query "стоматология" --city "Ташкент"')
  process.exit(1)
}

// ─────────────────────────  Режим платформы: считает сервер  ─────────────────────────
if (process.env.NEMO_API_KEY) {
  const apiBase = process.env.NEMO_API_URL
    ?? (process.env.SUPABASE_PROJECT_REF
      ? `https://${process.env.SUPABASE_PROJECT_REF}.supabase.co/functions/v1/sdr-api`
      : null)
  if (!apiBase) {
    console.error('[SDR] NEMO_API_KEY задан, но неизвестен адрес: укажите NEMO_API_URL или SUPABASE_PROJECT_REF.')
    process.exit(1)
  }

  const headers = {
    Authorization: `Bearer ${process.env.NEMO_API_KEY}`,
    'Content-Type': 'application/json',
    // Шлюз Supabase требует публичный ключ проекта отдельным заголовком — он не секрет и лежит в
    // каждом браузере, открывшем сайт. Без него запрос не доходит до функции вовсе.
    ...(process.env.SUPABASE_PUBLISHABLE_KEY ? { apikey: process.env.SUPABASE_PUBLISHABLE_KEY } : {}),
  }

  console.log(`[SDR] режим платформы: ${apiBase}`)
  const created = await fetch(`${apiBase}/jobs`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ query, city, limit, icp: icp || undefined }),
  }).catch((error) => { console.error(`[SDR] сеть: ${error.message}`); process.exit(1) })

  const createdBody = await created.json().catch(() => null)
  if (!created.ok || !createdBody?.job_id) {
    // Причину отказа печатаем как пришла: 403 action_not_allowed и 402 insufficient_credits
    // чинятся совершенно по-разному, и обобщать их в «не получилось» бесполезно.
    console.error(`[SDR] задача не поставлена (HTTP ${created.status}): ${JSON.stringify(createdBody)}`)
    process.exit(1)
  }

  const jobId = createdBody.job_id
  console.log(`[SDR] задача ${jobId} принята, списано ${createdBody.reserved_tokens} кредитов. Ждём воркер…`)

  const startedAt = Date.now()
  const TIMEOUT_MS = 15 * 60 * 1000
  for (;;) {
    if (Date.now() - startedAt > TIMEOUT_MS) {
      console.error(`[SDR] задача ${jobId} не завершилась за 15 минут. Состояние можно забрать позже:`)
      console.error(`      GET ${apiBase}/jobs/${jobId}`)
      process.exit(1)
    }
    await new Promise((resolve) => setTimeout(resolve, 5000))

    const status = await fetch(`${apiBase}/jobs/${jobId}`, { headers }).catch(() => null)
    const payload = await status?.json().catch(() => null)
    if (!payload?.job) { console.log('[SDR] …состояние недоступно, повторяю'); continue }

    if (payload.job.status === 'queued' || payload.job.status === 'running') {
      console.log(`[SDR] …${payload.job.status}`)
      continue
    }

    if (payload.job.status === 'failed') {
      console.error(`[SDR] задача провалилась: ${payload.job.error ?? 'причина не указана'}`)
      console.error('[SDR] кредиты возвращены на счёт.')
      process.exit(1)
    }

    const stats = payload.job.stats ?? {}
    process.stdout.write(renderLeadReport(payload.leads, { details }))
    console.log(`[SDR] Готово. Найдено ${stats.found ?? 0}, лидов ${payload.leads.length}, горячих ${stats.hot ?? 0}`)
    process.exit(0)
  }
}

// ─────────────────────────  Местный режим: считаем здесь  ─────────────────────────
let search
try {
  search = resolvePlacesSearch()
} catch (error) {
  console.error(`[SDR] ${error.message}`)
  process.exit(1)
}

const enrich = new WebEnricher()
const score = resolveScorer()
const store = resolveLeadStore()
const notify = resolveNotifier()

// Что именно подхватилось из файлов — ИМЕНАМИ, без значений. Без этой строки «ключ есть, но не
// доехал» невозможно отличить от «ключа нет вовсе», а мы этот разбор в проекте уже проходили.
if (localEnv.loaded.length) {
  console.log(`[SDR] ключи из ${localEnv.files.join(', ')}: ${localEnv.loaded.join(', ')}`)
} else if (localEnv.files.length) {
  console.log(`[SDR] ${localEnv.files.join(', ')} прочитаны, новых переменных нет — всё уже в окружении`)
}

console.log(`[SDR] источник поиска: ${search.constructor.name}`)
console.log(`[SDR] оценка: ${score ? `включена (${process.env.SDR_SCORER_MODEL ?? 'openai/gpt-4o-mini'})` : 'пропущена — нет OPENROUTER_API_KEY'}`)
console.log(`[SDR] хранилище: ${store ? 'Supabase' : 'пропущено — нет SUPABASE_PROJECT_REF/SUPABASE_SECRET_KEY'}`)
console.log(`[SDR] уведомления: ${notify ? 'Telegram' : 'пропущены — нет SDR_TELEGRAM_BOT_TOKEN/SDR_TELEGRAM_CHAT_ID'}`)

const result = await runSdrPipeline(
  { query, city, limit, icp: icp || undefined },
  { search, enrich, score, store, notify, log: (message) => console.log(`[SDR] ${message}`) },
)

// Сначала сами лиды, потом цифры. Горячие — то, ради чего запускали, и они не должны прокручиваться
// вверх за сводкой отсева.
process.stdout.write(renderLeadReport(result.leads, { details }))

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

// Сбой на этапе поиска — единственный, что превращает прогон в неудачный: остальные этапы
// деградируют осмысленно (без оценки, без сохранения, без уведомлений), и лиды всё равно найдены.
process.exit(result.failures.some((one) => one.stage === 'search') ? 1 : 0)
