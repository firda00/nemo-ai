// Тестовый прогон SDR-пайплайна.
//
//   npm run sdr:run -- --query "стоматология" --city "Ташкент" --limit 20
//
// Ключи читаются из окружения — тем же способом, что и при деплое (source ./.secrets.local перед
// запуском, см. agent-hub deploy notes). Пайплайн работает и без части ключей — просто делает
// меньше на этом шаге, а не падает:
//   GOOGLE_PLACES_API_KEY отсутствует  → нужен SDR_PLACES_FALLBACK_FILE (путь к JSON/CSV)
//   OPENROUTER_API_KEY отсутствует     → оценка пропускается, лиды уходят без score
//   SUPABASE_PROJECT_REF/SECRET_KEY нет → сохранение в базу пропускается
//   SDR_TELEGRAM_BOT_TOKEN/CHAT_ID нет  → уведомления пропускаются

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

if (!query || !city) {
  console.error('Нужны --query и --city. Пример: npm run sdr:run -- --query "стоматология" --city "Ташкент"')
  process.exit(1)
}

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

console.log(`[SDR] источник поиска: ${search.constructor.name}`)
console.log(`[SDR] оценка: ${score ? `включена (${process.env.SDR_SCORER_MODEL ?? 'openai/gpt-4o-mini'})` : 'пропущена — нет OPENROUTER_API_KEY'}`)
console.log(`[SDR] хранилище: ${store ? 'Supabase' : 'пропущено — нет SUPABASE_PROJECT_REF/SUPABASE_SECRET_KEY'}`)
console.log(`[SDR] уведомления: ${notify ? 'Telegram' : 'пропущены — нет SDR_TELEGRAM_BOT_TOKEN/SDR_TELEGRAM_CHAT_ID'}`)

const result = await runSdrPipeline(
  { query, city, limit, icp: icp || undefined },
  { search, enrich, score, store, notify, log: (message) => console.log(`[SDR] ${message}`) },
)

console.log('\n[SDR] Итог:')
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
