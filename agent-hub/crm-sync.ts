// Отправка горячих лидов во внешнюю CRM через обычный вебхук.
//
// Приёмником может быть что угодно, принимающее POST с JSON: Make, n8n, Zapier, собственный
// эндпоинт CRM. Поэтому здесь нет ни одного знания о конкретной CRM — только контракт полезной
// нагрузки и надёжность доставки.
//
// ГЛАВНОЕ ПРАВИЛО: ни один отказ вебхука не имеет права помешать воркеру зафиксировать задачу.
// Незафиксированная задача будет взята повторно и спишет кредиты второй раз, а недоставленный лид
// лежит в базе и уходит следующим прогоном. Цена ошибок разная на порядок, поэтому всё ниже
// возвращает результат, а не бросает.

import { z } from 'zod'

/** Пять секунд: вебхук — не долгая операция, а зависший приёмник не должен держать воркер. */
const TIMEOUT_MS = 5_000
/** Две повторные попытки поверх первой. Три подряд — уже похоже на «приёмник лежит», а не «икнул». */
const MAX_RETRIES = 2
const BASE_DELAY_MS = 500

export const CrmConfigSchema = z.object({
  CRM_WEBHOOK_URL: z.string().url('CRM_WEBHOOK_URL должен быть полным адресом, включая https://'),
  // Токен опционален: у Make и n8n адрес вебхука сам по себе секрет, и второй заголовок им не нужен.
  CRM_BEARER_TOKEN: z.string().min(1).optional(),
})
export type CrmConfig = z.infer<typeof CrmConfigSchema>

/**
 * Настройки из окружения.
 *
 * Адрес не задан — синхронизация просто выключена, это НЕ ошибка: большинство запусков идёт без CRM.
 * Адрес задан, но негодный — ЭТО ошибка, и она называется вслух: молча пропустить опечатку значит
 * пообещать доставку и не доставить, а узнают об этом через неделю по пустой CRM.
 */
export function resolveCrmConfig(env: Record<string, string | undefined> = process.env):
  { enabled: false; reason: string } | { enabled: true; config: CrmConfig } {
  if (!env.CRM_WEBHOOK_URL) return { enabled: false, reason: 'CRM_WEBHOOK_URL не задан' }
  const parsed = CrmConfigSchema.safeParse({
    CRM_WEBHOOK_URL: env.CRM_WEBHOOK_URL,
    CRM_BEARER_TOKEN: env.CRM_BEARER_TOKEN || undefined,
  })
  if (!parsed.success) {
    return { enabled: false, reason: parsed.error.issues.map((one) => one.message).join('; ') }
  }
  return { enabled: true, config: parsed.data }
}

export interface CrmLeadPayload {
  /** Устойчивый ключ лида: тот же бизнес в следующем прогоне даст тот же id. Годится для дедупликации. */
  id: string
  /** Строка в sdr_leads, чтобы приёмник мог сослаться обратно. null, если запись не вернула id. */
  lead_id: string | null
  name: string
  city: string
  phone: string | null
  website: string | null
  socials: { telegram: string | null; instagram: string | null; linkedin: string | null; facebook: string | null; emails: string[] }
  score: number | null
  status: 'HOT'
  /** Почему модель поставила такой балл — это и есть аргумент для менеджера. */
  icp_reasoning: string | null
  icebreaker: string | null
  created_at: string
}

/** Лид → полезная нагрузка. Отдельно от отправки, чтобы формат проверялся без сети. */
export function toCrmPayload(lead: Record<string, any>, leadId: string | null = null): CrmLeadPayload {
  const socials = lead.enrichment?.socials ?? {}
  return {
    id: lead.dedupe_key,
    lead_id: leadId,
    name: lead.name,
    city: lead.city,
    phone: lead.phone ?? null,
    website: lead.website ?? null,
    socials: {
      telegram: socials.telegram ?? null,
      instagram: socials.instagram ?? null,
      linkedin: socials.linkedin ?? null,
      facebook: socials.facebook ?? null,
      emails: lead.enrichment?.emails ?? [],
    },
    score: lead.score?.score ?? null,
    // Литерал, а не lead.score.status: в CRM уходят ТОЛЬКО горячие, и поле описывает контракт
    // эндпоинта, а не переменную состояние.
    status: 'HOT',
    icp_reasoning: lead.score?.reason ?? null,
    icebreaker: lead.score?.icebreaker_pitch ?? null,
    created_at: lead.found_at ?? new Date().toISOString(),
  }
}

/** Повторять стоит только то, что может пройти со второй попытки. */
export function isRetryable(status: number | null): boolean {
  // null — сеть не ответила вовсе (таймаут, DNS, обрыв): следующая попытка имеет смысл.
  if (status === null) return true
  // 5xx — приёмнику плохо, он может прийти в себя. 429 — попросил подождать.
  if (status >= 500 || status === 429) return true
  // 4xx — мы отправили что-то не то. Повтор пришлёт то же самое и получит тот же отказ, только
  // трижды: это не надёжность, а шум в чужом журнале.
  return false
}

export function backoffDelay(attempt: number, base = BASE_DELAY_MS): number {
  return base * 2 ** attempt
}

export interface CrmSyncOutcome {
  sent: number
  failed: number
  skipped: string | null
  /** Ключи успешно отправленных — по ним воркер отмечает crm_synced_at. */
  syncedKeys: string[]
  errors: string[]
}

/**
 * Отправка одного лида с повторами.
 *
 * Заголовок Idempotency-Key обязателен именно из-за повторов: если первая попытка ДОШЛА, а ответ
 * потерялся, вторая создаст в CRM дубль того же лида. Приёмник, который ключ понимает, дубль
 * отбросит; тот, который не понимает, просто его проигнорирует — вреда нет ни в одном случае.
 */
async function postOne(
  payload: CrmLeadPayload,
  config: CrmConfig,
  fetchImpl: typeof fetch,
  sleep: (ms: number) => Promise<void>,
): Promise<{ ok: true } | { ok: false; error: string }> {
  let lastError = 'не пробовали'

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) await sleep(backoffDelay(attempt - 1))

    let status: number | null = null
    try {
      const res = await fetchImpl(config.CRM_WEBHOOK_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': payload.id,
          ...(config.CRM_BEARER_TOKEN ? { Authorization: `Bearer ${config.CRM_BEARER_TOKEN}` } : {}),
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      })
      status = res.status
      if (res.ok) return { ok: true }
      lastError = `HTTP ${res.status}`
    } catch (error) {
      // Таймаут AbortSignal тоже приходит сюда. Отличать его от обрыва сети незачем: и то и другое
      // означает «ответа не было», и оба стоит повторить.
      lastError = String((error as Error)?.name === 'TimeoutError' ? 'таймаут 5с' : (error as Error)?.message ?? error)
    }

    if (!isRetryable(status)) return { ok: false, error: lastError }
  }
  return { ok: false, error: `${lastError} (после ${MAX_RETRIES + 1} попыток)` }
}

/**
 * Отправляет в CRM все горячие лиды прогона.
 *
 * НЕ БРОСАЕТ НИКОГДА. Вызывается из воркера перед фиксацией задачи, и исключение здесь стоило бы
 * повторной обработки задачи с повторным списанием кредитов.
 */
export async function syncHotLeadsToCrm(
  leads: Array<Record<string, any>>,
  options: {
    env?: Record<string, string | undefined>
    fetchImpl?: typeof fetch
    sleep?: (ms: number) => Promise<void>
    /** dedupe_key → id строки в sdr_leads, чтобы приёмник мог сослаться обратно. */
    idByKey?: Map<string, string>
  } = {},
): Promise<CrmSyncOutcome> {
  const resolved = resolveCrmConfig(options.env ?? process.env)
  if (!resolved.enabled) {
    return { sent: 0, failed: 0, skipped: resolved.reason, syncedKeys: [], errors: [] }
  }

  const fetchImpl = options.fetchImpl ?? fetch
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const hot = (leads ?? []).filter((lead) => lead?.score?.status === 'HOT')

  const outcome: CrmSyncOutcome = { sent: 0, failed: 0, skipped: null, syncedKeys: [], errors: [] }
  for (const lead of hot) {
    try {
      const payload = toCrmPayload(lead, options.idByKey?.get(lead.dedupe_key) ?? null)
      const result = await postOne(payload, resolved.config, fetchImpl, sleep)
      if (result.ok) { outcome.sent += 1; outcome.syncedKeys.push(lead.dedupe_key) }
      else { outcome.failed += 1; outcome.errors.push(`${lead.name}: ${result.error}`) }
    } catch (error) {
      // postOne по контракту не бросает, но полагаться на это в коде, который защищает фиксацию
      // задачи, нельзя.
      outcome.failed += 1
      outcome.errors.push(`${lead.name}: ${String((error as Error)?.message ?? error)}`)
    }
  }
  return outcome
}
