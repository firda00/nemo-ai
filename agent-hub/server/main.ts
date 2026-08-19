// Запуск API Gateway. Единственное место, где шлюз встречается с настоящими Supabase и Dragonfly.
//
// Отделено от gateway.ts намеренно: там обработчики, которые проверяются без сокета и без сети, здесь
// — подключения, переменные окружения и остановка. Смешение дало бы набор тестов, поднимающий Postgres
// ради проверки границы прав.

import path from 'node:path'
import { createClient } from '@supabase/supabase-js'
import { loadLocalEnv } from '../load-local-env.mjs'
import { resolveGatewayEnv } from './env.ts'
import { buildGateway, type SupabaseLike } from './gateway.ts'
import { connectQueue, resolveRedisUrl } from './queue.ts'

/*
 * СЕКРЕТЫ ЧИТАЮТСЯ ДО ЛЮБЫХ ПРОВЕРОК.
 *
 * Раньше их здесь не читали вовсе: `npm run gateway` падал с «не заданы переменные: SUPABASE_URL…» на
 * машине, где все эти переменные лежат в `.secrets.local` и прекрасно подхватываются агентом. Со
 * стороны это выглядит как отсутствующая настройка, а не как забытая строка кода.
 *
 * В контейнере файла нет и загрузка ничего не делает — переменные приходят из окружения.
 */
const repoRoot = path.resolve(import.meta.dirname, '..', '..')
const localEnv = loadLocalEnv(repoRoot)

const PORT = Number(process.env.PORT ?? 3000)
// 0.0.0.0, а не localhost: внутри контейнера сервер, слушающий петлю, недоступен снаружи вовсе, и
// выглядит это как «порт проброшен, но соединение отвергнуто».
const HOST = process.env.HOST ?? '0.0.0.0'

function requireEnv(): { url: string; serviceKey: string; pepper: string } {
  const resolved = resolveGatewayEnv(process.env)
  if (!resolved.ok) {
    console.error(`[gateway] не заданы переменные: ${resolved.missing.join(', ')}`)
    console.error(`[gateway] положите их в ${path.join(repoRoot, '.secrets.local')} или задайте в окружении.`)
    if (localEnv.files.length) console.error(`[gateway] прочитано из: ${localEnv.files.join(', ')}`)
    else console.error('[gateway] файлов .secrets.local / .env.local / .env рядом с репозиторием не найдено')
    process.exit(1)
  }
  if (resolved.generatedPepper) {
    console.warn('[gateway] NEMO_TOKEN_PEPPER не задан — взят случайный на этот запуск.')
    console.warn('[gateway] Выданные токены перестанут проверяться после перезапуска. Для постоянных'
      + ` токенов задайте NEMO_TOKEN_PEPPER в ${path.join(repoRoot, '.secrets.local')}.`)
  }
  return { url: resolved.url, serviceKey: resolved.serviceKey, pepper: resolved.pepper }
}


const { url, serviceKey, pepper } = requireEnv()
const admin = createClient(url, serviceKey, { auth: { persistSession: false } })

const redisUrl = resolveRedisUrl()
const queue = await connectQueue(redisUrl)
if (!queue.enabled) {
  // Не ошибка, но и не мелочь: без очереди воркер узнаёт о задаче опросом раз в пятнадцать секунд.
  console.warn(`[gateway] Dragonfly не подключён (${redisUrl ? 'адрес задан, но соединения нет' : 'REDIS_URL не задан'}) — задачи разбираются опросом`)
}

const crmSecret = process.env.NEMO_CRM_WEBHOOK_SECRET ?? ''
if (!crmSecret) {
  console.warn('[gateway] NEMO_CRM_WEBHOOK_SECRET не задан — приём вебхуков CRM отключён')
} else if (!/^[!-~]+$/.test(crmSecret)) {
  // Секрет едет в HTTP-заголовке, а заголовок обязан быть ASCII: клиент с кириллицей в значении не
  // сможет даже отправить запрос — fetch и curl отвергнут его на своей стороне. Найдено проверкой:
  // шлюз при этом выглядит исправным, а вебхуки просто никогда не приходят.
  console.error('[gateway] NEMO_CRM_WEBHOOK_SECRET содержит не-ASCII: такой заголовок клиент отправить не сможет')
  process.exit(1)
}

const app = await buildGateway({
  admin: admin as unknown as SupabaseLike,
  queue,
  pepper,
  crmSecret,
  entitlement: async (accountId) => {
    // Проверка подписки живёт в Deno-модуле Edge Function и оттуда не импортируется. Здесь тот же
    // вопрос задаётся базе напрямую: активна ли подписка аккаунта.
    const { data } = await admin
      .from('billing_subscriptions')
      .select('status')
      .eq('account_id', accountId)
      .maybeSingle()
    const status = (data as { status?: string } | null)?.status
    const allowed = status === 'active' || status === 'trial'
    return { allowed, reason: allowed ? undefined : (status ?? 'no_subscription') }
  },
}, { logger: true })

await app.listen({ port: PORT, host: HOST })
console.log(`[gateway] слушаю ${HOST}:${PORT}, очередь: ${queue.enabled ? 'Dragonfly' : 'опрос'}`)

/**
 * Мягкая остановка.
 *
 * SIGTERM приходит от `docker stop` и от оркестратора при выкатке. Без обработчика процесс умирает
 * мгновенно, обрывая запросы на середине — клиент видит сброс соединения вместо ответа, а вебхук CRM
 * повторит доставку. `app.close()` дожидается текущих запросов и только потом отпускает порт.
 */
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    console.log(`[gateway] ${signal}: останавливаюсь`)
    // Порядок важен: сначала перестаём принимать запросы, потом рвём соединение с очередью. Иначе
    // запрос, уже вошедший в обработчик, обнаружит закрытый Dragonfly на публикации сигнала.
    app.close()
      .then(() => queue.close())
      .then(() => process.exit(0))
      .catch(() => process.exit(1))
  })
}
