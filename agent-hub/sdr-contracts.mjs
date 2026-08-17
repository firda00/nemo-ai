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
