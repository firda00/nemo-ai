// Запуск медиа-воркера. Подключения к Dragonfly и Supabase, проба ffmpeg, мягкая остановка.

import { createClient } from '@supabase/supabase-js'
import { connectConsumer } from '../server/queue.ts'
import { probeCapabilities } from './ffmpeg-engine.ts'
import { processOnce, type RedisLike, type RenderWorkerDeps } from './render-worker.ts'
import type { VideoRenderResult } from '../contracts/media.ts'

const ffmpegPath = process.env.FFMPEG_PATH ?? 'ffmpeg'

/**
 * Проба возможностей — ДО первой задачи и с отказом при непригодном бинарнике.
 *
 * Стартовать без обязательных фильтров значит принимать задачи и заваливать их одну за другой, каждый
 * раз тратя время на скачивание исходников. Отказ при старте виден сразу и чинится настройкой образа.
 */
const capabilities = await probeCapabilities(ffmpegPath)
if (capabilities.missingRequired.length) {
  console.error(`[media] непригодный ffmpeg (${ffmpegPath}): нет ${capabilities.missingRequired.join(', ')}`)
  process.exit(1)
}
console.log(`[media] ffmpeg: ${ffmpegPath}, фильтров ${capabilities.filters.size}`)
for (const name of ['ass', 'xfade', 'sidechaincompress']) {
  if (!capabilities.has(name)) console.warn(`[media] нет фильтра ${name} — граф будет упрощён`)
}

const queue = await connectConsumer()
if (!queue.enabled) {
  // Без очереди воркеру нечего делать: задачи приходят только оттуда.
  console.error('[media] REDIS_URL не задан или Dragonfly недоступен — брать задачи неоткуда')
  process.exit(1)
}

const url = process.env.SUPABASE_URL
  ?? (process.env.SUPABASE_PROJECT_REF ? `https://${process.env.SUPABASE_PROJECT_REF}.supabase.co` : '')
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_SECRET_KEY ?? ''
const admin = url && serviceKey ? createClient(url, serviceKey, { auth: { persistSession: false } }) : null
if (!admin) console.warn('[media] Supabase не настроен — состояние рендеров нигде не записывается')

const deps: RenderWorkerDeps = {
  // Очередь голая: сама задача лежит в Dragonfly, а не сигнал о ней. Причина различия с очередью SDR
  // объяснена в заголовке render-worker.ts.
  redis: (queue as unknown as { client?: RedisLike }).client ?? await rawRedis(),
  ffmpegPath,
  capabilities,
  workRoot: process.env.RENDER_WORK_DIR,
  updateStatus: admin
    ? async (taskId, patch) => { await admin.from('media_renders').update(patch).eq('id', taskId) }
    : undefined,
  sendWebhook: async (webhookUrl: string, result: VideoRenderResult) => {
    try {
      const response = await fetch(webhookUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          // Ключ идемпотентности: вебхук повторяется при сетевом сбое, и без него приёмник создаст
          // вторую запись по одному ролику.
          'Idempotency-Key': `render:${result.id}`,
        },
        body: JSON.stringify(result),
        signal: AbortSignal.timeout(10_000),
      })
      return { ok: response.ok, error: response.ok ? undefined : `HTTP ${response.status}` }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  },
  onLog: (line) => console.log(`[media] ${line}`),
}

/** Собственное соединение, когда общая очередь его не отдаёт: BLPOP нужен прямой доступ к клиенту. */
async function rawRedis(): Promise<RedisLike> {
  const { default: IORedis } = await import('ioredis')
  const client = new IORedis(process.env.REDIS_URL!, { maxRetriesPerRequest: 1, lazyConnect: true })
  await client.connect()
  return client as unknown as RedisLike
}

console.log('[media] жду задачи рендера')
let stop = false
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    // Текущий рендер ДОводится до конца: убить его на середине значит выбросить уже потраченные минуты
    // процессорного времени и оставить временный каталог неубранным.
    console.log(`[media] ${signal}: закончу текущий рендер и остановлюсь`)
    stop = true
  })
}

while (!stop) {
  try {
    await processOnce(deps)
  } catch (error) {
    console.error(`[media] ошибка обхода очереди: ${error instanceof Error ? error.message : error}`)
  }
}
await queue.close()
process.exit(0)
