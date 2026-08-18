// Распределение задач SDR через DragonflyDB.
//
// ЧТО ИМЕННО ЖИВЁТ В DRAGONFLY, А ЧТО ОБЯЗАНО ОСТАТЬСЯ В POSTGRES — главное решение этого файла,
// и принято оно не по вкусу.
//
// Постановка задачи СПИСЫВАЕТ КРЕДИТЫ. `enqueue_sdr_job` резервирует их и создаёт строку задачи в
// ОДНОЙ транзакции; `finish_sdr_job` возвращает их при окончательном провале. Если сделать источником
// правды Redis, то потерянная запись означает: кредиты списаны, задачи нет, владелец заплатил за
// пустоту. Dragonfly — база в памяти; её перезапуск без сохранения снапшота теряет всё, что не успело
// лечь на диск. Ставить платёжную гарантию в такую зависимость нельзя.
//
// Поэтому Postgres остаётся ЕДИНСТВЕННЫМ источником правды: состояние задачи, аренда, попытки,
// резерв и возврат кредитов. Dragonfly снимает другое — ОПРОС.
//
// Сейчас воркер спрашивает `claim_sdr_job` каждые 15 секунд, всегда, даже когда очередь пуста. Четыре
// воркера — это шестнадцать запросов в минуту круглосуточно и ни одной полезной строки в ответ. При
// пиковом трафике к этому добавляется борьба за блокировки строк. С Dragonfly воркер ВИСИТ на BLPOP и
// просыпается в момент постановки задачи: ноль запросов в простое и мгновенная реакция под нагрузкой.
//
// Сигнал НЕНАДЁЖЕН НАМЕРЕННО. Потерянное сообщение не теряет задачу: она лежит в Postgres, и запасной
// редкий опрос её подберёт. Именно поэтому здесь нет ни подтверждений, ни повторной доставки, ни
// consumer group — всё это дублировало бы аренду и счётчик попыток, которые уже есть в базе. Две
// системы, каждая из которых считает себя ответственной за повтор, дают задачу, выполненную дважды, и
// кредиты, списанные дважды.
//
// ПОЧЕМУ НЕ BullMQ. Ровно поэтому же: BullMQ ведёт собственный жизненный цикл задачи (waiting/active/
// failed), собственные повторы и собственное обнаружение зависших. Всё это у нас уже есть в
// `sdr_jobs` — с арендой, heartbeat и attempts. Совмещение двух таких механизмов не складывается, а
// конфликтует. Здесь нужен канал уведомлений, и голый список Redis описывает его точно.

import type Redis from 'ioredis'

/** Список, в который кладут идентификаторы поставленных задач. */
export const JOB_SIGNAL_KEY = 'nemo:sdr:jobs'

/**
 * Сколько воркер висит на BLPOP за один заход.
 *
 * Не бесконечность: соединение, висящее вечно, не переживает перезапуск Dragonfly и промежуточные
 * прокси, которые рвут молчащие сокеты по своему таймауту. Тридцать секунд — это и редкая проверка
 * живости соединения, и верхняя граница задержки, если сигнал всё-таки потерялся.
 */
export const BLOCK_SECONDS = 30

/** Сколько сигналов держим. Больше — значит очередь давно не разбирается, и хвост уже бесполезен. */
const MAX_SIGNAL_BACKLOG = 10_000

export interface QueueHealth {
  configured: boolean
  reachable: boolean
  latencyMs: number | null
  pending: number | null
  error: string | null
}

/**
 * Адрес Dragonfly.
 *
 * Отсутствие адреса — НЕ ошибка: местный прогон и CLI работают без очереди вовсе, а воркер в этом
 * случае возвращается к опросу. Пустая строка тоже считается отсутствием: в docker-compose переменная
 * легко оказывается объявленной и незаполненной, и «redis://» в таком виде не подключится никуда.
 */
export function resolveRedisUrl(env: Record<string, string | undefined> = process.env): string | null {
  const raw = (env.REDIS_URL ?? env.DRAGONFLY_URL ?? '').trim()
  return raw.length > 0 ? raw : null
}

/** То, что нам нужно от клиента Redis. Интерфейс — ради проверок без запущенного Dragonfly. */
export interface RedisLike {
  rpush(key: string, ...values: string[]): Promise<number>
  ltrim(key: string, start: number, stop: number): Promise<unknown>
  blpop(key: string, timeoutSeconds: number): Promise<[string, string] | null>
  llen(key: string): Promise<number>
  ping(): Promise<string>
  quit(): Promise<unknown>
}

export interface JobQueue {
  readonly enabled: boolean
  /** Сообщить воркерам о новой задаче. Никогда не бросает: сигнал — ускорение, а не гарантия. */
  publish(jobId: string): Promise<boolean>
  /** Дождаться сигнала. null — за отведённое время ничего не пришло, пора сходить в базу самому. */
  waitForJob(blockSeconds?: number): Promise<string | null>
  health(): Promise<QueueHealth>
  close(): Promise<void>
}

/** Очередь, которой нет: адрес не задан. Все методы отвечают «пусто», ничего не ломая. */
export function disabledQueue(reason = 'REDIS_URL не задан'): JobQueue {
  return {
    enabled: false,
    publish: async () => false,
    waitForJob: async () => null,
    health: async () => ({ configured: false, reachable: false, latencyMs: null, pending: null, error: reason }),
    close: async () => {},
  }
}

/**
 * Очередь поверх Dragonfly.
 *
 * `publish` НЕ БРОСАЕТ ни при каких обстоятельствах и возвращает false при отказе. Это не небрежность:
 * задача к моменту вызова уже создана в Postgres и кредиты списаны. Исключение здесь означало бы
 * ответ клиенту «не получилось» при существующей задаче — он поставит её второй раз и заплатит дважды.
 */
export function createQueue(client: RedisLike): JobQueue {
  return {
    enabled: true,

    async publish(jobId) {
      try {
        await client.rpush(JOB_SIGNAL_KEY, jobId)
        // Обрезаем хвост: список сигналов, который никто не разбирает, растёт неограниченно и однажды
        // съедает память Dragonfly целиком. Оставляем свежие — старые задачи всё равно подберёт опрос.
        await client.ltrim(JOB_SIGNAL_KEY, -MAX_SIGNAL_BACKLOG, -1)
        return true
      } catch {
        return false
      }
    },

    async waitForJob(blockSeconds = BLOCK_SECONDS) {
      try {
        const popped = await client.blpop(JOB_SIGNAL_KEY, blockSeconds)
        return popped ? popped[1] : null
      } catch {
        // Обрыв соединения не должен останавливать воркер: он сходит в базу опросом и попробует
        // подключиться на следующем круге.
        return null
      }
    },

    async health() {
      const startedAt = Date.now()
      try {
        await client.ping()
        const latencyMs = Date.now() - startedAt
        const pending = await client.llen(JOB_SIGNAL_KEY).catch(() => null)
        return { configured: true, reachable: true, latencyMs, pending, error: null }
      } catch (error) {
        return {
          configured: true,
          reachable: false,
          latencyMs: Date.now() - startedAt,
          pending: null,
          error: error instanceof Error ? error.message : String(error),
        }
      }
    },

    async close() {
      await client.quit().catch(() => {})
    },
  }
}

/**
 * Подключение к Dragonfly для ОБЫЧНОЙ работы (публикация, health).
 *
 * `maxRetriesPerRequest: 1` вместо значения по умолчанию: команда, которая молча повторяется двадцать
 * раз, превращает недоступный Dragonfly в зависший HTTP-запрос — клиент шлюза ждёт минуту вместо того,
 * чтобы получить честный ответ о том, что задача поставлена, а сигнал не ушёл.
 *
 * `lazyConnect` тоже намеренно: создание клиента не должно ронять процесс при недоступном Dragonfly.
 * Шлюз обязан подниматься и работать при мёртвой очереди, просто без ускорения.
 */
export async function connectQueue(
  url: string | null = resolveRedisUrl(),
  factory?: (url: string) => RedisLike,
): Promise<JobQueue> {
  if (!url) return disabledQueue()
  try {
    const client = factory ? factory(url) : await defaultClient(url)
    return createQueue(client)
  } catch (error) {
    return disabledQueue(`Dragonfly недоступен: ${error instanceof Error ? error.message : String(error)}`)
  }
}

async function defaultClient(url: string): Promise<RedisLike> {
  const { default: IORedis } = await import('ioredis')
  const client: Redis = new IORedis(url, {
    maxRetriesPerRequest: 1,
    lazyConnect: true,
    // Пять секунд на подключение: дольше ждать нечего, шлюз работает и без очереди.
    connectTimeout: 5_000,
    enableOfflineQueue: false,
  })
  await client.connect()
  return client as unknown as RedisLike
}

/**
 * ОТДЕЛЬНОЕ соединение для ожидания.
 *
 * BLPOP блокирует ВЕСЬ клиент: пока команда висит, по этому же соединению нельзя ни опубликовать
 * сигнал, ни ответить на health. Держать одно соединение на оба дела означало бы, что health шлюза
 * начинает отвечать по тридцать секунд, как только воркер сел ждать. Разделение соединений — не
 * оптимизация, а условие работоспособности.
 */
export async function connectConsumer(
  url: string | null = resolveRedisUrl(),
  factory?: (url: string) => RedisLike,
): Promise<JobQueue> {
  return await connectQueue(url, factory)
}
