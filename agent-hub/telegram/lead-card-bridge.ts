// Найденный SDR-лид → карточка LeadCardNotification для Telegram.
//
// НАТЯЖЕНИЕ В ТЗ, которое здесь разрешается явно, а не замазывается.
//
// `LeadCardNotification` (§4.1 V5) описывает СОСТОЯВШИЙСЯ ЗВОНОК: у неё есть `callId`, `outcome`
// («заинтересован в демо», «отказ»), `rapportScore` — оценка отношений, сложившихся в разговоре, и
// `recordingUrl`. Лид из SDR-прогона — это компания, найденная в справочнике, которой ЕЩЁ НИ РАЗУ НЕ
// ЗВОНИЛИ. Три поля из четырёх описывают событие, которого не было.
//
// Соблазн заполнить их «похоже на правду» велик и вреден. `outcome: 'INTERESTED_DEMO'` для лида без
// звонка — прямая ложь менеджеру: он прочитает «заинтересован в демо» и построит на этом разговор,
// которого не было. Поэтому:
//
//   outcome      → 'CALL_LATER'. Это не компромисс, а буквальное состояние дел: лид найден, стоит
//                  звонка, звонка ещё не было. Единственное значение из четырёх, которое не врёт.
//   rapportScore → балл соответствия ICP. Это ДРУГАЯ величина (пригодность, а не отношения), поэтому
//                  в тексте карточки прямо сказано, что звонка не было и что означает число.
//   callId       → детерминированный UUID из ключа дедупликации лида. Не выдуманный звонок, а
//                  устойчивый идентификатор: повторный прогон даёт тот же id, и нажатие кнопки
//                  находит того же лида, а не создаёт второй.
//   recordingUrl → отсутствует. Кнопки «слушать запись» не будет, потому что записи не существует.
//
// Если однажды по этому лиду ПОЗВОНЯТ, карточку соберёт разбор звонка через CallAnalyticsSchema, и все
// четыре поля станут настоящими. Эта функция — про состояние «нашли, но не звонили», и она называет его
// своим именем.

import { createHash } from 'node:crypto'
import { LeadCardNotificationSchema, parseContract } from '../contracts/v5.ts'
import type { LeadCardNotification } from '../contracts/v5.ts'

/** Порог горячего лида. Держится в согласии с schemas.ts:HOT_SCORE и lead-report.mjs. */
const HOT_SCORE = 70

/**
 * Устойчивый UUID из произвольной строки.
 *
 * Нужен ровно одно свойство: одинаковый вход даёт одинаковый выход. Случайный UUID здесь означал бы,
 * что повторный прогон присылает карточку с новым id, и нажатие «Отправить оффер» ссылается на
 * идентификатор, которого нет ни в одной таблице.
 *
 * Форма — UUID версии 5 по разметке битов (вариант RFC 4122). Пространство имён не используется:
 * уникальности внутри одного аккаунта достаточно, а совместимость с чужими генераторами не нужна.
 */
export function deterministicUuid(seed: string): string {
  const hex = createHash('sha1').update(String(seed), 'utf8').digest('hex')
  const version = `5${hex.slice(13, 16)}`
  // Старшие два бита варианта обязаны быть 10 — иначе строка не пройдёт как UUID ни в Zod, ни в Postgres.
  const variant = ((parseInt(hex.slice(16, 18), 16) & 0x3f) | 0x80).toString(16).padStart(2, '0')
  return [hex.slice(0, 8), hex.slice(8, 12), version, variant + hex.slice(18, 20), hex.slice(20, 32)].join('-')
}

/** Лид в том виде, в каком его отдаёт пайплайн SDR. Описано узко: нужны только эти поля. */
export interface SdrLeadLike {
  name?: string | null
  phone?: string | null
  website?: string | null
  city?: string | null
  dedupe_key?: string | null
  score?: {
    score?: number | null
    status?: string | null
    reason?: string | null
    icebreaker_pitch?: string | null
    key_decision_maker?: string | null
  } | null
  enrichment?: {
    emails?: string[]
    booking_widgets?: string[]
    socials?: { whatsapp?: string | null; telegram?: string | null; instagram?: string | null }
  } | null
}

/** Горячий ли лид: статус или порог. Тот же критерий, что в отчёте CLI. */
export function isHotLead(lead: SdrLeadLike): boolean {
  const score = lead.score
  if (!score) return false
  return score.status === 'HOT' || Number(score.score ?? 0) >= HOT_SCORE
}

/**
 * Резюме для карточки найденного лида.
 *
 * Начинается с прямого указания, что звонка не было. Это первое, что должен понять менеджер: он читает
 * шаблон, придуманный для пост-звонковой карточки, и без этой строки решит, что разговор состоялся.
 */
function summaryForFoundLead(lead: SdrLeadLike): string {
  const parts: string[] = ['Звонка ещё не было — лид найден SDR-прогоном.']

  const contacts: string[] = []
  if (lead.phone) contacts.push(`тел. ${lead.phone}`)
  if (lead.website) contacts.push(lead.website)
  const socials = lead.enrichment?.socials ?? {}
  if (socials.whatsapp) contacts.push('WhatsApp')
  else if (socials.telegram) contacts.push('Telegram')
  const email = (lead.enrichment?.emails ?? [])[0]
  if (email) contacts.push(email)
  if (contacts.length) parts.push(`Связь: ${contacts.join(', ')}.`)

  const widgets = lead.enrichment?.booking_widgets ?? []
  // Виджет записи — сильный признак: компания уже платит за приём заявок, и разговор начинается не с
  // объяснения, зачем это нужно.
  if (widgets.length) parts.push(`Уже платят за приём заявок: ${widgets.join(', ')}.`)

  if (lead.score?.reason) parts.push(`Почему подходит: ${lead.score.reason}`)
  return parts.join(' ')
}

/**
 * Лид → карточка.
 *
 * `null` для не-горячего лида: карточка с кнопками — это требование действия от человека, и присылать
 * её по холодному лиду значит приучить менеджера пролистывать такие сообщения, а вместе с ними и
 * настоящие.
 */
export function leadToCardNotification(lead: SdrLeadLike): LeadCardNotification | null {
  if (!isHotLead(lead)) return null
  if (!lead.phone && !lead.website) return null

  const seed = lead.dedupe_key || `${lead.name ?? ''}|${lead.city ?? ''}|${lead.phone ?? lead.website ?? ''}`
  const pains: string[] = []
  if (!lead.website) pains.push('нет сайта — заявки принимать негде')
  if (!lead.enrichment?.booking_widgets?.length) pains.push('нет онлайн-записи на сайте')
  if (!(lead.enrichment?.emails ?? []).length) pains.push('почта не указана — писать некуда')
  const socials = lead.enrichment?.socials ?? {}
  if (!socials.whatsapp && !socials.telegram) pains.push('нет мессенджера для быстрой связи')

  const candidate = {
    callId: deterministicUuid(seed),
    // Телефона может не быть — тогда в поле уезжает сайт: карточка без единого способа связи
    // бесполезна, а это поле в схеме обязательное.
    customerPhone: lead.phone || lead.website || 'не указан',
    leadName: lead.name || undefined,
    // См. заголовок файла: единственное значение, которое не врёт о несостоявшемся звонке.
    outcome: 'CALL_LATER' as const,
    // Балл ICP, а не отношений. Что это за число — сказано в резюме.
    rapportScore: Math.max(0, Math.min(100, Math.round(Number(lead.score?.score ?? 0)))),
    keyPains: pains.slice(0, 5),
    summaryText: summaryForFoundLead(lead),
    // recordingUrl отсутствует намеренно: записи нет, и кнопка «Слушать запись» не появится.
    recommendedAction: lead.score?.icebreaker_pitch
      ? `Позвонить и начать так: «${lead.score.icebreaker_pitch}»`
      : 'Позвонить и уточнить, как сейчас принимают заявки вечером и в выходные',
  }

  // Проверка схемой ЗДЕСЬ, а не у вызывающего: собранная вручную структура — такой же ненадёжный вход,
  // как ответ модели, и опечатка в поле должна остановиться на этой строке, а не в Telegram.
  const checked = parseContract(LeadCardNotificationSchema, candidate)
  return checked.ok ? checked.data : null
}

/**
 * Оформление карточки найденного лида.
 *
 * Заголовок из ТЗ («⚡ Завершен AI-звонок») здесь ЗАПРЕЩЁН: он противоречит следующей же строке
 * карточки, где сказано, что звонка не было, — и менеджер поверит заголовку, а не резюме. Подпись балла
 * тоже своя: 88/100 здесь означает соответствие профилю клиента, а не доверие, сложившееся в разговоре.
 */
export const FOUND_LEAD_STYLE = {
  headline: '🎯 Новый горячий лид — звонка ещё не было',
  scoreLabel: 'Соответствие ICP',
} as const

/** Итог рассылки карточек. Ошибки — значением: недоставленная карточка не повод уронить прогон. */
export interface CardDeliveryReport {
  sent: number
  skipped: number
  errors: string[]
}

/**
 * Разослать карточки по горячим лидам.
 *
 * Отправка ПОСЛЕДОВАТЕЛЬНАЯ. Telegram ограничивает частоту (около 30 сообщений в секунду на бота, но
 * заметно меньше в один чат), и пачка из двадцати параллельных вызовов даёт 429 с ожиданием, после
 * которого половина карточек теряется. Прогон и так не быстрый — секунда на карточку не заметна.
 */
export async function sendLeadCards(
  service: {
    sendLeadCardToManager: (
      chatId: string | number,
      payload: LeadCardNotification,
      style?: { headline?: string; scoreLabel?: string },
    ) => Promise<{ ok: boolean; error?: string }>
  },
  chatId: string | number,
  leads: readonly SdrLeadLike[],
): Promise<CardDeliveryReport> {
  const report: CardDeliveryReport = { sent: 0, skipped: 0, errors: [] }
  for (const lead of leads) {
    const card = leadToCardNotification(lead)
    if (!card) { report.skipped += 1; continue }
    const outcome = await service.sendLeadCardToManager(chatId, card, FOUND_LEAD_STYLE)
    if (outcome.ok) report.sent += 1
    else report.errors.push(`${lead.name ?? 'без названия'}: ${outcome.error ?? 'причина не указана'}`)
  }
  return report
}

/**
 * Настройки рассылки карточек из окружения.
 *
 * ВЫКЛЮЧЕНО по умолчанию, и это не осторожность ради осторожности: обычные уведомления о горячих лидах
 * уже отправляет notifier.ts внутри пайплайна. Включить карточки, не выключив те, значит присылать по
 * два сообщения на каждый лид. Флаг SDR_LEAD_CARDS=1 переводит CLI на карточки с кнопками ВМЕСТО
 * обычных уведомлений.
 */
export function resolveLeadCardConfig(env: Record<string, string | undefined> = process.env):
  { enabled: false; reason: string } | { enabled: true; token: string; chatId: string } {
  const flag = (env.SDR_LEAD_CARDS ?? '').trim().toLowerCase()
  if (!['1', 'true', 'on', 'yes'].includes(flag)) {
    return { enabled: false, reason: 'SDR_LEAD_CARDS не включён — уведомления идут обычным сообщением' }
  }
  const token = env.SDR_TELEGRAM_BOT_TOKEN
  const chatId = env.SDR_LEAD_CARD_CHAT_ID ?? env.SDR_TELEGRAM_CHAT_ID
  if (!token) return { enabled: false, reason: 'SDR_LEAD_CARDS включён, но нет SDR_TELEGRAM_BOT_TOKEN' }
  if (!chatId) return { enabled: false, reason: 'SDR_LEAD_CARDS включён, но нет SDR_TELEGRAM_CHAT_ID' }
  return { enabled: true, token, chatId }
}

export { HOT_SCORE }
