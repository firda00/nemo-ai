// Пост-звонковый разбор: транскрипт → аналитика → база → карточка менеджеру → CRM.
//
// ЗАЧЕМ ОТДЕЛЬНЫЙ МОДУЛЬ. Во время звонка всё подчинено задержке: ответ должен начаться за
// полсекунды, и на разбор разговора там времени нет. После HANGUP спешить некуда — зато есть весь
// транскрипт целиком, и можно позволить себе структурированный вызов модели, который во время
// разговора стоил бы потерянной реплики.
//
// ПОРЯДОК ЗАПИСИ ЗДЕСЬ ТОЖЕ СТОИТ ДЕНЕГ. Сначала звонок сохраняется в базу, и только потом уходит
// карточка менеджеру и событие в CRM. Наоборот нельзя: менеджер, нажавший «перезвонить» в карточке,
// пойдёт искать звонок по идентификатору, а его в базе ещё нет. Тот же принцип, что у воркера SDR с
// лидами и алертами.
//
// НИ ОДИН ОТКАЗ НЕ ТЕРЯЕТ ЗВОНОК. Модель может не ответить, Telegram — отказать, CRM — лежать. Каждая
// из этих неудач обрабатывается отдельно, и ни одна не мешает остальным: звонок в базе важнее
// уведомления, уведомление важнее записи в CRM.

import { CallAnalyticsSchema, parseContract } from '../contracts/v5.ts'
import type { CallAnalytics, LeadCardNotification } from '../contracts/v5.ts'
import type { DialogueState, DialogueTurn, CallOutcome } from './dialogue.ts'
import type { LlmProvider } from './providers.ts'

/** Что известно о состоявшемся звонке к моменту разбора. */
export interface CompletedCall {
  callId: string
  tenantId: string
  trunkId: string
  direction: 'INBOUND' | 'OUTBOUND'
  customerPhone: string
  callerId: string
  durationSeconds: number
  sipHangupCause: string | null
  recordingUrl: string | null
  transcript: DialogueTurn[]
  /** Итог, определённый правилами во время разговора. Модель может его уточнить, но не отменить. */
  detectedOutcome: CallOutcome | null
  talkToListenRatio: number
  companyName?: string | null
}

const ANALYTICS_PROMPT = [
  'Ты разбираешь состоявшийся телефонный разговор ИИ-ассистента с представителем компании.',
  'Верни СТРОГО один JSON-объект без пояснений и без обрамления markdown.',
  '',
  'Поля:',
  '  call_outcome: INTERESTED_DEMO | FRIENDLY_CHAT_FOLLOWUP | CALL_LATER | REJECTED | WRONG_NUMBER',
  '  overall_sentiment: VERY_POSITIVE | NEUTRAL | SKEPTICAL | HOSTILE',
  '  relationship_health_score: число 0..100 — насколько тёплым вышел контакт',
  '  lead_pain_points: массив строк — проблемы бизнеса, ПРОЗВУЧАВШИЕ в разговоре',
  '  manager_coaching_feedback: { talk_to_listen_ratio: число, objection_handling_score: 0..10,',
  '    actionable_advice: строка — один конкретный совет ассистенту }',
  '  next_step: { action: SEND_TELEGRAM_NOTIFICATION | SEND_SMS_OFFER | SCHEDULE_CALL | DO_NOT_DISTURB,',
  '    scheduled_at: строка ISO8601 или null, notification_payload: строка }',
  '',
  'ВАЖНО: боли перечисляй ТОЛЬКО те, что собеседник назвал сам. Не додумывай типичные проблемы отрасли —',
  'этот список уедет менеджеру как факты о клиенте, и он будет говорить, опираясь на них.',
].join('\n')

/** Транскрипт в вид, пригодный для модели. */
export function formatTranscript(turns: readonly DialogueTurn[]): string {
  return turns
    .map((turn) => `${turn.role === 'bot' ? 'АССИСТЕНТ' : 'КЛИЕНТ'}: ${turn.text}`)
    .join('\n')
}

/**
 * Запасная аналитика без модели.
 *
 * Нужна не «на всякий случай»: OpenRouter может ответить отказом, а звонок уже состоялся и его надо
 * сохранить. Пустая аналитика лучше отсутствующей записи — по ней видно хотя бы итог, длительность и
 * транскрипт, а разобрать разговор можно потом руками.
 *
 * Все ЧИСЛОВЫЕ оценки здесь нейтральные, а не выдуманные: балл 50 означает «не оценивали», и это
 * честнее, чем поставить 80 и создать впечатление тёплого контакта.
 */
export function fallbackAnalytics(call: CompletedCall): CallAnalytics {
  return {
    call_id: call.callId,
    caller_phone: call.customerPhone,
    duration_seconds: call.durationSeconds,
    call_outcome: call.detectedOutcome ?? 'FRIENDLY_CHAT_FOLLOWUP',
    overall_sentiment: 'NEUTRAL',
    relationship_health_score: 50,
    lead_pain_points: [],
    manager_coaching_feedback: {
      talk_to_listen_ratio: call.talkToListenRatio,
      objection_handling_score: 5,
      actionable_advice: 'Разбор моделью не выполнен — оценить разговор вручную по транскрипту.',
    },
    next_step: {
      action: call.detectedOutcome === 'REJECTED' || call.detectedOutcome === 'WRONG_NUMBER'
        ? 'DO_NOT_DISTURB'
        : 'SEND_TELEGRAM_NOTIFICATION',
      scheduled_at: null,
      notification_payload: 'Автоматический разбор недоступен',
    },
  }
}

/**
 * Разбор разговора моделью.
 *
 * ИТОГ, ОПРЕДЕЛЁННЫЙ ПРАВИЛАМИ, ИМЕЕТ ПРИОРИТЕТ над мнением модели в двух случаях: отказ и не тот
 * номер. Причина в цене ошибки: модель, увидев вежливое «спасибо, до свидания» после «нам не нужно»,
 * охотно ставит FRIENDLY_CHAT_FOLLOWUP — и человек, сказавший нет, попадает в список для повторного
 * звонка. Правило сработало на явной фразе, модель обобщает по настроению; в этом конкретном месте
 * правило надёжнее.
 */
export async function analyzeCall(
  call: CompletedCall,
  llm: LlmProvider | null,
  signal?: AbortSignal,
): Promise<{ analytics: CallAnalytics; source: 'llm' | 'fallback'; error: string | null }> {
  if (!llm) return { analytics: fallbackAnalytics(call), source: 'fallback', error: 'модель не настроена' }

  try {
    const raw = await llm.complete(
      ANALYTICS_PROMPT,
      [
        `Длительность: ${call.durationSeconds} с.`,
        call.companyName ? `Компания: ${call.companyName}.` : '',
        call.detectedOutcome ? `Итог по явным фразам: ${call.detectedOutcome}.` : '',
        '',
        formatTranscript(call.transcript),
      ].filter(Boolean).join('\n'),
      signal,
    )

    const parsed = JSON.parse(stripCodeFence(raw)) as Record<string, unknown>
    // Поля, которые знаем ТОЧНО, подставляем сами и не спрашиваем у модели: идентификатор звонка,
    // номер и длительность она может переписать «похожими», и запись перестанет сходиться с базой.
    const candidate = {
      ...parsed,
      call_id: call.callId,
      caller_phone: call.customerPhone,
      duration_seconds: call.durationSeconds,
    }
    const checked = parseContract(CallAnalyticsSchema, candidate)
    if (!checked.ok) {
      return { analytics: fallbackAnalytics(call), source: 'fallback', error: checked.error }
    }

    const analytics = checked.data
    if (call.detectedOutcome === 'REJECTED' || call.detectedOutcome === 'WRONG_NUMBER') {
      analytics.call_outcome = call.detectedOutcome
      if (analytics.next_step.action !== 'DO_NOT_DISTURB') {
        analytics.next_step = { ...analytics.next_step, action: 'DO_NOT_DISTURB', scheduled_at: null }
      }
    }
    return { analytics, source: 'llm', error: null }
  } catch (error) {
    return {
      analytics: fallbackAnalytics(call),
      source: 'fallback',
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

/** Модель регулярно оборачивает JSON в ```json … ``` вопреки прямой просьбе этого не делать. */
export function stripCodeFence(text: string): string {
  const trimmed = String(text ?? '').trim()
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i)
  return (fenced ? fenced[1] : trimmed).trim()
}

/** Аналитика → карточка менеджеру. null означает, что карточку слать не нужно. */
export function analyticsToLeadCard(
  call: CompletedCall,
  analytics: CallAnalytics,
): LeadCardNotification | null {
  // Ошибочный номер карточки не порождает: это не лид, а опечатка в справочнике, и менеджер,
  // приучившийся пролистывать такие карточки, начнёт пролистывать и настоящие.
  if (analytics.call_outcome === 'WRONG_NUMBER') return null

  const summary = analytics.manager_coaching_feedback.actionable_advice
  return {
    callId: call.callId,
    customerPhone: call.customerPhone,
    leadName: call.companyName ?? undefined,
    outcome: analytics.call_outcome,
    rapportScore: analytics.relationship_health_score,
    keyPains: analytics.lead_pain_points.slice(0, 5),
    summaryText: buildSummary(call, analytics),
    recordingUrl: call.recordingUrl ?? undefined,
    recommendedAction: summary,
  }
}

function buildSummary(call: CompletedCall, analytics: CallAnalytics): string {
  const minutes = Math.floor(call.durationSeconds / 60)
  const seconds = call.durationSeconds % 60
  const length = minutes ? `${minutes} мин ${seconds} с` : `${seconds} с`
  const customerLines = call.transcript.filter((one) => one.role === 'customer').length
  return [
    `Разговор ${length}, реплик клиента: ${customerLines}.`,
    `Настроение: ${SENTIMENT_LABELS[analytics.overall_sentiment]}.`,
    analytics.next_step.scheduled_at ? `Договорились на ${analytics.next_step.scheduled_at}.` : '',
  ].filter(Boolean).join(' ')
}

const SENTIMENT_LABELS: Record<CallAnalytics['overall_sentiment'], string> = {
  VERY_POSITIVE: 'очень доброжелательное',
  NEUTRAL: 'нейтральное',
  SKEPTICAL: 'скептическое',
  HOSTILE: 'враждебное',
}

// ── Сохранение и рассылка ─────────────────────────────────────────────────────────────────────────

export interface PersistDeps {
  admin: {
    from(table: string): {
      insert: (values: Record<string, unknown>) => Promise<{ error: { message?: string; code?: string } | null }>
    }
  }
  /** Отправка карточки. Отсутствует — карточки не шлём, но звонок всё равно сохраняем. */
  sendCard?: (card: LeadCardNotification) => Promise<{ ok: boolean; error?: string }>
  /** Пуш события в CRM. Так же необязателен. */
  pushToCrm?: (call: CompletedCall, analytics: CallAnalytics) => Promise<{ ok: boolean; error?: string }>
}

export interface PersistReport {
  saved: boolean
  cardSent: boolean
  crmPushed: boolean
  errors: string[]
}

/**
 * Сохранить звонок и разослать последствия.
 *
 * ПОРЯДОК: база → карточка → CRM. Карточка содержит идентификатор звонка, и менеджер, нажавший в ней
 * кнопку, пойдёт искать звонок в базе; отправить её раньше записи значит гарантированно получить
 * «звонок не найден» на первое же нажатие.
 *
 * Отказ записи в базу ОТМЕНЯЕТ рассылку — по той же причине. Отказ карточки не отменяет CRM: это
 * независимые получатели, и потеря одного не повод терять второго.
 */
export async function persistCall(
  call: CompletedCall,
  analytics: CallAnalytics,
  deps: PersistDeps,
): Promise<PersistReport> {
  const report: PersistReport = { saved: false, cardSent: false, crmPushed: false, errors: [] }

  const { error } = await deps.admin.from('telephony_calls').insert({
    id: call.callId,
    tenant_id: call.tenantId,
    trunk_id: call.trunkId,
    direction: call.direction,
    customer_phone: call.customerPhone,
    caller_id: call.callerId,
    duration_seconds: call.durationSeconds,
    sip_hangup_cause: call.sipHangupCause,
    recording_url: call.recordingUrl,
    full_transcript: call.transcript,
    analytics,
  })
  if (error) {
    report.errors.push(`запись звонка: ${error.message ?? 'причина не указана'}`)
    return report
  }
  report.saved = true

  const card = analyticsToLeadCard(call, analytics)
  if (card && deps.sendCard) {
    try {
      const sent = await deps.sendCard(card)
      report.cardSent = sent.ok
      if (!sent.ok) report.errors.push(`карточка: ${sent.error ?? 'причина не указана'}`)
    } catch (cause) {
      report.errors.push(`карточка: ${cause instanceof Error ? cause.message : String(cause)}`)
    }
  }

  if (deps.pushToCrm) {
    try {
      const pushed = await deps.pushToCrm(call, analytics)
      report.crmPushed = pushed.ok
      if (!pushed.ok) report.errors.push(`CRM: ${pushed.error ?? 'причина не указана'}`)
    } catch (cause) {
      report.errors.push(`CRM: ${cause instanceof Error ? cause.message : String(cause)}`)
    }
  }

  return report
}

export { ANALYTICS_PROMPT, SENTIMENT_LABELS }
