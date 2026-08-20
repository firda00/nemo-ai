import assert from 'node:assert/strict'
import fs from 'node:fs'

const read = (path) => fs.readFileSync(path, 'utf8')
const migration = read('supabase/migrations/20260723183000_telegram_worker_reliability.sql')
const sttMigration = read('supabase/migrations/20260723193000_agent_stt_model.sql')
const webhook = read('supabase/functions/telegram-webhook/index.ts')
const worker = read('supabase/functions/agent-worker/index.ts')
const tg = read('supabase/functions/_shared/tgProcess.ts')
const telegram = read('supabase/functions/_shared/telegram.ts')
const taskbot = read('supabase/functions/_shared/taskbot.ts')
const agentStore = read('src/store/useAgentStore.ts')
const agentEditor = read('src/pages/app/AgentEditorPage.tsx')

assert.match(migration, /insert into public\.worker_lease[\s\S]*on conflict \(id\) do nothing/i)
assert.match(migration, /enqueue_telegram_job[\s\S]*pgmq\.send\('tg_jobs'/i)
assert.match(migration, /revoke all on function public\.enqueue_telegram_job/i)
assert.match(webhook, /\.rpc\('enqueue_telegram_job'/)
assert.match(webhook, /status: 503/)
assert.match(worker, /\.rpc\('acquire_worker_lease'/)
assert.match(tg, /msg\.chat\?\.type === 'group'/)
assert.match(tg, /transcribeAudio\([\s\S]*agent\?\.default_lang[\s\S]*agent\?\.stt_model/)
assert.match(tg, /function decodeTextAttachment/, 'review exports must be decoded as text, not guessed from binary')
assert.ok(tg.includes('/\\.(csv|tsv|txt)$/i'), 'the bot must accept CSV/TXT review exports')
assert.match(tg, /2 \* 1024 \* 1024/, 'review attachment input must have a concrete size limit')
assert.match(tg, /XLSX и другие бинарные файлы/, 'unsupported binary reviews must receive an honest instruction')
assert.match(taskbot, /msg\.chat\?\.type === 'private'/)
assert.match(sttMigration, /ovozify-whisper-small-uz/)
assert.match(sttMigration, /gemini-openrouter/)
assert.match(agentStore, /stt_model: a\.sttModel/)
assert.match(agentEditor, /Ovozify Whisper Small UZ/)
assert.match(telegram, /parse_mode: 'HTML'/)
assert.match(telegram, /splitTelegramText\(text\)/)

globalThis.Deno = { env: { get: () => '' } }
const { parseGradioSse } = await import('../supabase/functions/_shared/transcribe.ts')
const { formatTelegramHtml, splitTelegramText } = await import('../supabase/functions/_shared/telegramFormat.ts')
assert.equal(parseGradioSse('event: complete\ndata: ["salom dunyo"]\n'), 'salom dunyo')
assert.equal(
  parseGradioSse('event: complete\ndata: ["[Audio duration: 31.2s - Processed in 2 chunks]\\n\\nassalomu alaykum"]\n'),
  'assalomu alaykum',
)

const formatted = formatTelegramHtml(`### Магазин: EVERLY Home (ID 84663)
| SKU | Название | Цена | Остаток |
|---|---|---|---|
| A-1 | Красивый товар | 55000 | 4 |`)
assert.match(formatted, /<b>🏪 Магазин: EVERLY Home/)
assert.match(formatted, /<b>• Красивый товар<\/b>/)
assert.match(formatted, /🏷 <b>SKU:<\/b> A-1/)
assert.match(formatted, /💰 <b>Цена:<\/b> 55000/)
assert.doesNotMatch(formatted, /\|---\|/)
assert.deepEqual(splitTelegramText('a'.repeat(5000)).map((part) => part.length), [2400, 2400, 200])


/*
 * БЕЛЫЙ СПИСОК ОБНОВЛЕНИЙ ОБЯЗАН СОВПАДАТЬ С ТЕМ, ЧТО РАЗБИРАЕТ ОБРАБОТЧИК.
 *
 * allowed_updates в setWebhook — это фильтр на стороне Telegram. Пока в нём стоял только
 * "message", ни одно нажатие инлайн-кнопки до бота не доходило, хотя ветки callback_query были
 * написаны и работали. Отказ был немой: ни ошибки, ни записи в журнале — просто кнопка,
 * на которую можно жать вечно.
 *
 * Поэтому список сверяется не с константой в тесте, а с исходником обработчика: добавили ветку
 * нового типа обновлений и забыли расширить фильтр — контракт падает здесь, а не у клиента.
 */
// update_id — сквозной счётчик, он есть у КАЖДОГО обновления и типом не является.
// Единственное поле Update, которое не называет тип, поэтому список исключений один в один такой.
const NOT_A_KIND = new Set(['update_id'])
const handledUpdates = new Set()
for (const piece of webhook.split('update?.').slice(1)) {
  let name = ''
  for (const ch of piece) { if (!"abcdefghijklmnopqrstuvwxyz_".includes(ch)) break; name += ch }
  if (name && !NOT_A_KIND.has(name)) handledUpdates.add(name)
}
const declared = telegram.slice(telegram.indexOf('TG_ALLOWED_UPDATES'))
const allowed = declared.slice(declared.indexOf('[') + 1, declared.indexOf(']'))
  .split(',').map((one) => one.trim().replace(/['"]/g, '')).filter(Boolean)

assert.ok(handledUpdates.size > 0, 'не удалось вычитать типы обновлений из обработчика')
assert.ok(allowed.length > 0, 'не удалось вычитать TG_ALLOWED_UPDATES')
assert.deepEqual(
  [...allowed].sort(),
  [...handledUpdates].sort(),
  `фильтр Telegram и обработчик разошлись: allowed_updates=${[...allowed].sort()}, разбирается=${[...handledUpdates].sort()}`,
)
assert.match(telegram, /allowed_updates: TG_ALLOWED_UPDATES/, 'setWebhook обязан передавать общий список, а не свой')
console.log('Telegram worker contracts passed: atomic queue, self-healing lease, chat routing, selectable Uzbek STT and a webhook filter that matches the handler.')
