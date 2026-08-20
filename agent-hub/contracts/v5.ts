// Контракты V5: телефония, карточка лида в Telegram, двусторонняя связь с CRM.
//
// Соответствуют §3.1, §4.1 и §4.2 спецификации «Nemo AI V5 (Full Production Edition)». Имена полей
// сохранены буквально, включая смешение snake_case (телефония) и camelCase (Telegram и CRM): это не
// небрежность спецификации, а граница систем. Телефонные схемы описывают строки таблиц Postgres, где
// принят snake_case; схемы Telegram и CRM описывают полезную нагрузку JSON между сервисами, где принят
// camelCase. Привести всё к одному стилю значило бы завести переходник между схемой и таблицей — и
// первое же расхождение в нём стоило бы потерянного звонка.
//
// ЗАЧЕМ ЗДЕСЬ ZOD, А НЕ ПРОСТО ТИПЫ. Всё описанное ниже приходит извне и в четырёх случаях из пяти —
// от того, кто может ошибиться или соврать: расшифровка звонка от модели, вебхук от amoCRM, ответ
// HubSpot, тело запроса от нашего же воркера после обновления. Тип TypeScript исчезает при сборке и не
// ловит ничего; Zod проверяет на границе, до записи в базу и до отправки человеку.
//
// ГРАНИЦА, О КОТОРОЙ НАДО ЗНАТЬ. `CallAnalyticsSchema` содержит оценку живого человека: настроение,
// боли, «trust score», а также разбор работы менеджера. Это персональные данные обеих сторон разговора,
// и в ряде юрисдикций запись звонка требует уведомления или согласия. Схема — не разрешение; она лишь
// описывает форму того, что уже собрано законным способом.

import { createHash } from 'node:crypto'
import { z } from 'zod'

/** E.164 — тот же регексп, что в CHECK-ограничениях миграции V5. Расхождение здесь означало бы, что
 * запись проходит проверку схемы и падает на вставке. */
export const E164 = /^\+?[1-9]\d{1,14}$/

// ── §3.1. Управление транками ────────────────────────────────────────────────────────────────────

/**
 * Настройка SIP-транка.
 *
 * `auth_password` здесь — ЧИСТЫЙ пароль: схема описывает то, что вводит человек в форме подключения.
 * В базу он попадает уже как `auth_password_encrypted`, и это разные вещи. Путать их нельзя: пароль
 * SIP-регистрации даёт возможность звонить за счёт владельца.
 */
export const SIPTrunkConfigSchema = z.object({
  id: z.string().uuid(),
  tenant_id: z.string().uuid(),
  trunk_type: z.enum(['CUSTOM_SIP', 'NEMO_RENTED']),
  name: z.string().min(2).max(64),
  sip_host: z.string(),
  sip_port: z.number().int().default(5060),
  auth_username: z.string(),
  auth_password: z.string(),
  outbound_caller_id: z.string().regex(E164),
  codecs: z.array(z.enum(['PCMU', 'PCMA', 'OPUS', 'G722'])).default(['PCMU', 'PCMA', 'OPUS']),
  max_concurrent_channels: z.number().int().positive().default(5),
  status: z.enum(['ACTIVE', 'REGISTRATION_FAILED', 'DISABLED']).default('ACTIVE'),
})
export type SIPTrunkConfig = z.infer<typeof SIPTrunkConfigSchema>

/**
 * Разбор состоявшегося звонка.
 *
 * Приходит от модели после расшифровки, то есть это САМЫЕ НЕНАДЁЖНЫЕ данные во всей системе: модель
 * охотно придумывает поля, выходит за границы шкал и возвращает текст там, где ждали число. Пределы
 * `min/max` здесь не украшение — на них ломается ответ, который иначе доехал бы до карточки лида и
 * показал менеджеру «Trust Score: 240/100».
 */
export const CallAnalyticsSchema = z.object({
  call_id: z.string().uuid(),
  caller_phone: z.string(),
  duration_seconds: z.number().int(),
  call_outcome: z.enum([
    'INTERESTED_DEMO',
    'FRIENDLY_CHAT_FOLLOWUP',
    'CALL_LATER',
    'REJECTED',
    'WRONG_NUMBER',
  ]),
  overall_sentiment: z.enum(['VERY_POSITIVE', 'NEUTRAL', 'SKEPTICAL', 'HOSTILE']),
  relationship_health_score: z.number().min(0).max(100),
  lead_pain_points: z.array(z.string()),
  manager_coaching_feedback: z.object({
    talk_to_listen_ratio: z.number(),
    objection_handling_score: z.number().min(0).max(10),
    actionable_advice: z.string(),
  }),
  next_step: z.object({
    action: z.enum(['SEND_TELEGRAM_NOTIFICATION', 'SEND_SMS_OFFER', 'SCHEDULE_CALL', 'DO_NOT_DISTURB']),
    // nullable, а не optional: «перезвонить, но время не назначено» и «поле забыли» — разные случаи,
    // и первый законен для действий без расписания.
    scheduled_at: z.string().datetime().nullable(),
    notification_payload: z.string(),
  }),
})
export type CallAnalytics = z.infer<typeof CallAnalyticsSchema>

// ── §4.1. Карточка лида для Telegram ─────────────────────────────────────────────────────────────

/**
 * То, что менеджер увидит в Telegram после звонка.
 *
 * `outcome` здесь УЖЕ. `CallAnalyticsSchema.call_outcome` знает пять значений, включая WRONG_NUMBER;
 * здесь их четыре. Так в спецификации, и это осмысленно: по ошибочному номеру карточку присылать
 * незачем — это не лид, а опечатка в справочнике. Разница между наборами намеренная, и функция
 * `leadCardOutcome` ниже превращает одно в другое, честно возвращая null для непригодного случая.
 */
export const LeadCardNotificationSchema = z.object({
  callId: z.string().uuid(),
  customerPhone: z.string(),
  leadName: z.string().optional(),
  outcome: z.enum(['INTERESTED_DEMO', 'FRIENDLY_CHAT_FOLLOWUP', 'CALL_LATER', 'REJECTED']),
  rapportScore: z.number().min(0).max(100),
  keyPains: z.array(z.string()),
  summaryText: z.string(),
  recordingUrl: z.string().url().optional(),
  recommendedAction: z.string(),
})
export type LeadCardNotification = z.infer<typeof LeadCardNotificationSchema>

/**
 * Итог звонка → итог для карточки.
 *
 * WRONG_NUMBER возвращает null: карточка по ошибочному номеру — это шум, который менеджер приучится
 * пролистывать, а вместе с ним начнёт пролистывать и настоящие. Молча подставить сюда REJECTED было бы
 * ложью в отчётности: «отказался» и «не тот человек» ведут к разным выводам о качестве базы.
 */
export function leadCardOutcome(outcome: CallAnalytics['call_outcome']): LeadCardNotification['outcome'] | null {
  return outcome === 'WRONG_NUMBER' ? null : outcome
}

// ── §4.2. Двусторонняя синхронизация с CRM ───────────────────────────────────────────────────────

/**
 * Событие ОТ CRM (amoCRM или HubSpot) в едином виде.
 *
 * `customFields: z.record(z.any())` — единственное место во всех контрактах, где допущено `any`, и это
 * вынужденно: пользовательские поля в CRM создаёт сам владелец, их состав неизвестен заранее и меняется
 * без предупреждения. Ограничение здесь дало бы отказ приёма вебхука из-за поля, до которого нам нет
 * дела. Всё, что мы из них РЕАЛЬНО читаем, обязано разбираться отдельной схемой в месте чтения.
 */
export const UnifiedCRMEventSchema = z.object({
  tenantId: z.string().uuid(),
  provider: z.enum(['AMOCRM', 'HUBSPOT']),
  eventType: z.enum(['DEAL_STAGE_CHANGED', 'NEW_CONTACT_CREATED', 'TASK_COMPLETED']),
  externalDealId: z.string(),
  contactPhone: z.string().regex(E164),
  contactName: z.string().optional(),
  pipelineId: z.string(),
  statusId: z.string(),
  customFields: z.record(z.any()).default({}),
  occurredAt: z.string().datetime(),
})
export type UnifiedCRMEvent = z.infer<typeof UnifiedCRMEventSchema>

/**
 * Что мы отправляем В CRM.
 *
 * `callData` необязателен: сделку создают и без звонка — например, по лиду из SDR-прогона, до первого
 * контакта. Обязательным его сделать нельзя, иначе выгрузка найденных лидов в CRM потребовала бы
 * выдумать звонок, которого не было.
 *
 * Обратите внимание: `leadPhone` здесь БЕЗ проверки E.164, в отличие от `contactPhone` входящего
 * события. Так в спецификации, и это защитимо: во входящем событии номер уже прошёл через CRM и обязан
 * быть годным, а исходящий может нести то, что нашлось в справочнике, — и отказ отправки из-за формата
 * номера потерял бы лид целиком. Приводить номер к E.164 — задача места, где он попадает в звонок.
 */
export const CRMOutboundPushPayloadSchema = z.object({
  tenantId: z.string().uuid(),
  provider: z.enum(['AMOCRM', 'HUBSPOT']),
  leadPhone: z.string(),
  leadName: z.string().optional(),
  dealTitle: z.string(),
  pipelineId: z.string().optional(),
  targetStatusId: z.string().optional(),
  callData: z.object({
    durationSec: z.number().int(),
    callOutcome: z.enum(['INTERESTED_DEMO', 'FRIENDLY_CHAT_FOLLOWUP', 'CALL_LATER', 'REJECTED']),
    recordingUrl: z.string().url().optional(),
    transcriptSummary: z.string(),
    rapportScore: z.number().min(0).max(100),
    detectedPains: z.array(z.string()),
  }).optional(),
  tagsToAdd: z.array(z.string()).default([]),
})
export type CRMOutboundPushPayload = z.infer<typeof CRMOutboundPushPayloadSchema>

/** Направление и состояние записи аудита — те же значения, что в CHECK-ограничениях миграции V5. */
export const CrmSyncDirectionSchema = z.enum(['INBOUND', 'OUTBOUND'])
export const CrmSyncStatusSchema = z.enum(['PROCESSED', 'FAILED', 'RETRYING'])
export type CrmSyncDirection = z.infer<typeof CrmSyncDirectionSchema>
export type CrmSyncStatus = z.infer<typeof CrmSyncStatusSchema>

/** Предел колонки `crm_sync_logs.idempotency_key`. */
const IDEMPOTENCY_KEY_LIMIT = 128

/**
 * Ключ идемпотентности для записи в `crm_sync_logs`.
 *
 * Собирается ДЕТЕРМИНИРОВАННО из смысла события, а не из времени и не из случайного числа. Это и есть
 * весь смысл: повторная доставка того же вебхука обязана дать ТОТ ЖЕ ключ, иначе уникальный индекс её
 * не остановит и по одному звонку появятся две сделки.
 *
 * ОБРЕЗАТЬ ДЛИННЫЙ КЛЮЧ НЕЛЬЗЯ, и это выяснилось проверкой, а не рассуждением. Приставка
 * «AMOCRM:INBOUND:DEAL_STAGE_CHANGED:» занимает 34 знака, значит от внешнего идентификатора остаётся 94.
 * Два РАЗНЫХ события с идентификаторами длиннее этого давали ОДИН ключ — и второе, настоящее, молча
 * отвергалось базой как дубль. Потерянное обновление сделки хуже дубликата: дубль видно, потерю нет.
 *
 * Поэтому длинный ключ не режется, а СВЁРТЫВАЕТСЯ: читаемая приставка плюс хеш полного ключа. Хеш
 * сохраняет различие там, где обрезка его теряла, а приставка оставляет запись понятной глазами при
 * разборе журнала — ради этого короткие ключи и остаются как есть.
 */
export function crmIdempotencyKey(input: {
  provider: string
  direction: CrmSyncDirection
  eventType: string
  externalId: string
  occurredAt?: string
}): string {
  const parts = [
    input.provider,
    input.direction,
    input.eventType,
    input.externalId,
    input.occurredAt ?? '',
  ].map((part) => String(part).replace(/[:\s]+/g, '_'))
  const full = parts.join(':')
  if (full.length <= IDEMPOTENCY_KEY_LIMIT) return full

  const digest = createHash('sha256').update(full, 'utf8').digest('hex')
  // Хвост хеша (64 знака) плюс разделитель: под читаемую приставку остаётся 63 знака.
  const prefix = full.slice(0, IDEMPOTENCY_KEY_LIMIT - digest.length - 1)
  return `${prefix}~${digest}`
}

// ── Проверка на границе ──────────────────────────────────────────────────────────────────────────

/**
 * Разбор с внятной причиной отказа.
 *
 * Zod по умолчанию выбрасывает исключение с деревом ошибок, которое нечитаемо в журнале. Здесь отказ —
 * это ЗНАЧЕНИЕ с перечислением полей и причин: вебхук CRM, отвергнутый с текстом «contactPhone: неверный
 * формат», чинится за минуту, а тот же отказ с текстом «ZodError» — за час.
 */
export function parseContract<TSchema extends z.ZodTypeAny>(
  schema: TSchema,
  value: unknown,
): { ok: true; data: z.infer<TSchema> } | { ok: false; error: string; issues: string[] } {
  const parsed = schema.safeParse(value)
  if (parsed.success) return { ok: true, data: parsed.data }
  const issues = parsed.error.issues.map((issue) => `${issue.path.join('.') || '(корень)'}: ${issue.message}`)
  return { ok: false, error: issues.join('; '), issues }
}
