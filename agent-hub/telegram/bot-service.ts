// Карточка лида в Telegram и кнопки под ней. §4.1 спецификации V5, на grammY.
//
// ЧТО ЗДЕСЬ САМОЕ ОПАСНОЕ. Всё содержимое карточки — чужой текст: имя лида из справочника, боли и
// резюме от модели, расшифровавшей звонок. Отправляется он с `parse_mode: 'HTML'`, то есть Telegram
// будет разбирать его как разметку. Компания «Мебель < 5 дней» без экранирования превращается в
// незакрытый тег, и Telegram отвечает 400 — карточка о горячем лиде не приходит ВООБЩЕ. Хуже другое:
// текст от модели может содержать `<a href="...">`, и тогда в сообщении менеджеру появится ссылка,
// которую туда никто не ставил. Поэтому экранируется КАЖДАЯ вставка, без исключений, а разметку задаёт
// только этот файл.
//
// ПОЧЕМУ ЭТО НЕ ЗАМЕНА notifier.ts. Тот отправляет карточку НАЙДЕННОГО лида (SDR-прогон, ещё до
// контакта) через прямой вызов Bot API без зависимостей — он живёт и в Deno. Этот отправляет карточку
// СОСТОЯВШЕГОСЯ ЗВОНКА с кнопками действий, ради которых и нужен grammY: обработка нажатий требует
// диспетчера обновлений, а не одного HTTP-вызова. Два разных события, два разных сообщения; сводить их
// в один модуль значило бы получить один компромиссный формат, плохой для обоих.
//
// ОТСТУПЛЕНИЕ ОТ ТЗ, СДЕЛАННОЕ СОЗНАТЕЛЬНО. В спецификации кнопка записи выглядит так:
//   .url('🎧 Слушать запись', payload.recordingUrl || 'https://nemo.ai')
// То есть при отсутствии записи менеджеру всё равно показывают кнопку «Слушать запись», ведущую на
// главную страницу. Это обещание, которого система не выполняет: человек нажимает, попадает не туда и
// перестаёт доверять кнопкам вообще. Здесь кнопка добавляется ТОЛЬКО когда запись есть.

import { createRequire } from 'node:module'
import { z } from 'zod'
import { LeadCardNotificationSchema, parseContract } from '../contracts/v5.ts'
import type { LeadCardNotification } from '../contracts/v5.ts'

/**
 * Экранирование для parse_mode: 'HTML'.
 *
 * Telegram требует ровно три сущности — `&`, `<`, `>`. Амперсанд ПЕРВЫМ, иначе `&lt;`, полученный из
 * `<`, сам станет `&amp;lt;` и в сообщении появится видимый текст вместо символа.
 *
 * Кавычки НЕ экранируются намеренно: в HTML-режиме Telegram они значимы только внутри атрибутов, а
 * атрибуты здесь формирует исключительно этот файл — в чужой текст они не попадают.
 */
export function escapeHtml(text: unknown): string {
  return String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

/**
 * Экранирование для parse_mode: 'MarkdownV2'.
 *
 * Не используется в карточке (она на HTML), но нужна тем, кто пошлёт этим ботом обычное сообщение:
 * MarkdownV2 требует экранировать восемнадцать знаков, и забытая точка в конце предложения даёт
 * ошибку 400 на пустом месте. Список знаков — из документации Bot API, целиком.
 */
export function escapeMarkdownV2(text: unknown): string {
  return String(text ?? '').replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, (match) => `\\${match}`)
}

/** Подписи итогов звонка — как в §4.1 спецификации, слово в слово. */
export const OUTCOME_LABELS: Record<LeadCardNotification['outcome'], string> = {
  INTERESTED_DEMO: '🔥 Горячий (Демо)',
  FRIENDLY_CHAT_FOLLOWUP: '🤝 Дружеский контакт (Фоллоу-ап)',
  CALL_LATER: '⏳ Перезвонить позже',
  REJECTED: '❌ Отказ',
}

/** Приставки к данным обратного вызова. Кнопки разбираются по ним, а не по подписи. */
export const CALLBACK_SEND_OFFER = 'send_offer'
export const CALLBACK_MANUAL_CALL = 'manual_call'

/**
 * Предел Telegram на длину сообщения — 4096 знаков.
 *
 * Резюме звонка от модели легко выходит за него на десятиминутном разговоре, и тогда карточка не
 * приходит совсем. Обрезается ИМЕННО резюме — самая длинная и наименее критичная часть: телефон, балл и
 * рекомендованный шаг должны доехать при любой длине разговора.
 */
const TELEGRAM_MESSAGE_LIMIT = 4096
const SUMMARY_LIMIT = 1500

/**
 * Заголовок и подпись балла.
 *
 * Значения по умолчанию — буквально из §4.1 ТЗ, и путь пост-звонковой карточки их не меняет.
 * Переопределение нужно ОДНОМУ случаю: карточке лида, найденного SDR-прогоном, по которому ещё не
 * звонили. Заголовок «⚡ Завершен AI-звонок» над таким лидом — прямое противоречие содержимому
 * карточки, где следующей же строкой сказано, что звонка не было. Менеджер верит заголовку.
 */
export interface CardStyle {
  headline?: string
  scoreLabel?: string
}

/**
 * Текст карточки.
 *
 * Вынесен из отправки отдельной функцией, чтобы проверяться без сети: именно здесь живёт экранирование,
 * и проверять его через мок HTTP-клиента значило бы проверять два механизма одним утверждением.
 */
export function renderLeadCard(payload: LeadCardNotification, style: CardStyle = {}): string {
  const outcome = OUTCOME_LABELS[payload.outcome]
  // Заголовок и подпись задаёт НАШ код, поэтому не экранируются: разметку в них ставим сами. Всё, что
  // приходит извне, экранируется ниже без исключений.
  const headline = style.headline ?? '⚡ Завершен AI-звонок'
  const scoreLabel = style.scoreLabel ?? 'Trust Score'
  const pains = payload.keyPains.length
    ? payload.keyPains.map((pain) => `• ${escapeHtml(pain)}`).join('\n')
    : 'Не зафиксированы'
  const summary = payload.summaryText.length > SUMMARY_LIMIT
    ? `${payload.summaryText.slice(0, SUMMARY_LIMIT)}…`
    : payload.summaryText

  const message = [
    `<b>${headline}</b>`,
    '',
    // Имя может отсутствовать — и это нормально: холодный звонок часто идёт по номеру из справочника.
    `👤 <b>Лид:</b> ${escapeHtml(payload.leadName || 'Не указано')} (${escapeHtml(payload.customerPhone)})`,
    `📊 <b>Итог:</b> ${outcome}`,
    `❤ <b>${scoreLabel}:</b> ${payload.rapportScore}/100`,
    '',
    '<b>📌 Выявленные боли:</b>',
    pains,
    '',
    '<b>📝 Краткое резюме:</b>',
    escapeHtml(summary),
    '',
    `💡 <b>Рекомендованный шаг:</b> ${escapeHtml(payload.recommendedAction)}`,
  ].join('\n')

  // Последняя защита от 400 по длине. Обрезка по границе сообщения может рассечь тег, поэтому режем и
  // закрываем: незакрытый <b> ломает разбор всего сообщения, а не только последней строки.
  return message.length <= TELEGRAM_MESSAGE_LIMIT
    ? message
    : `${message.slice(0, TELEGRAM_MESSAGE_LIMIT - 20).replace(/<[^>]*$/, '')}…`
}

/** Строки кнопок в том виде, в каком их ждёт Bot API. Проверяется без grammY. */
export function buildLeadCardButtons(payload: LeadCardNotification): Array<Array<Record<string, string>>> {
  const rows: Array<Array<Record<string, string>>> = [[
    { text: '🚀 Отправить спец-оффер', callback_data: `${CALLBACK_SEND_OFFER}:${payload.callId}` },
    { text: '📞 Перезвонить лично', callback_data: `${CALLBACK_MANUAL_CALL}:${payload.callId}` },
  ]]
  // Кнопка записи — только при настоящей записи. См. отступление от ТЗ в заголовке файла.
  if (payload.recordingUrl) {
    rows.push([{ text: '🎧 Слушать запись', url: payload.recordingUrl }])
  }
  return rows
}

/**
 * Разбор данных обратного вызова.
 *
 * Возвращает null на всём, чего не узнал. Это НЕ формальность: `callback_data` приходит от клиента
 * Telegram и подделывается тривиально — кто угодно с ботом может послать `send_offer:<любой uuid>`.
 * Поэтому здесь проверяется и приставка, и то, что вторая часть действительно UUID, а право на действие
 * проверяет вызывающий код по своей базе.
 */
export function parseCallbackData(
  data: unknown,
): { action: 'send_offer' | 'manual_call'; callId: string } | null {
  const text = String(data ?? '')
  const separator = text.indexOf(':')
  // Только «двоеточия нет вовсе». Пустую приставку отдельно проверять незачем: она всё равно не совпадёт
  // ни с одним разрешённым действием ниже. Раньше здесь стояло `<= 0`, и мутационный прогон показал, что
  // ноль недостижим как отдельный случай — проверка лишь создавала впечатление защиты.
  if (separator < 0) return null
  const action = text.slice(0, separator)
  const callId = text.slice(separator + 1)
  if (action !== CALLBACK_SEND_OFFER && action !== CALLBACK_MANUAL_CALL) return null
  if (!z.string().uuid().safeParse(callId).success) return null
  return { action, callId }
}

/** Что делать по нажатию. Возвращает текст всплывающего ответа менеджеру. */
export type CallbackHandler = (
  input: { action: 'send_offer' | 'manual_call'; callId: string; managerChatId: number | string },
) => Promise<string> | string

/** То, что сервису нужно от Bot API. Интерфейс — ради проверок без сети и без токена. */
export interface TelegramApi {
  sendMessage(
    chatId: string | number,
    text: string,
    options: { parse_mode: string; reply_markup: { inline_keyboard: Array<Array<Record<string, string>>> }; disable_web_page_preview?: boolean },
  ): Promise<{ message_id: number }>
}

export type SendResult =
  | { ok: true; messageId: number }
  | { ok: false; error: string; code: 'invalid_payload' | 'telegram_error' }

/**
 * Отправка карточек лида менеджеру и обработка нажатий.
 *
 * НИ ОДИН метод не выбрасывает исключение наружу. Причина та же, что в воркере SDR: недоставленная
 * карточка — потеря одного уведомления, а исключение посреди пост-звонкового цикла оставит звонок
 * незафиксированным и запустит повторную обработку, то есть второй звонок тому же человеку. Цена
 * ошибок различается на порядок.
 */
export class TelegramNotificationService {
  private readonly api: TelegramApi
  private readonly bot: unknown

  /**
   * @param tokenOrApi Токен бота — либо готовый API (для проверок).
   *
   * Токен и подменный API в одном параметре, а не два конструктора: два пути создания расходятся при
   * первой же правке, и проверяться будет не то, что работает в production.
   */
  constructor(tokenOrApi: string | TelegramApi) {
    if (typeof tokenOrApi === 'string') {
      if (!tokenOrApi.trim()) throw new Error('нужен токен бота Telegram')
      // Ленивое создание: grammy тянет за собой разбор обновлений, и прогону, который только шлёт
      // сообщения, платить за него незачем. Здесь же держим и сам Bot — он нужен для callbackQuery.
      const created = createBot(tokenOrApi)
      this.bot = created.bot
      this.api = created.api
    } else {
      this.bot = null
      this.api = tokenOrApi
    }
  }

  /** Живой экземпляр grammY Bot. null, когда сервис создан с подменным API. */
  get instance(): unknown { return this.bot }

  /**
   * Отправить карточку лида менеджеру.
   *
   * Полезная нагрузка проверяется схемой ЗДЕСЬ, а не у вызывающего: разбор звонка приходит от модели, и
   * `rapportScore: 240` доехал бы до экрана менеджера, если бы проверку можно было пропустить.
   */
  async sendLeadCardToManager(
    chatId: string | number,
    payload: LeadCardNotification,
    style: CardStyle = {},
  ): Promise<SendResult> {
    const checked = parseContract(LeadCardNotificationSchema, payload)
    if (!checked.ok) return { ok: false, code: 'invalid_payload', error: checked.error }

    try {
      const sent = await this.api.sendMessage(chatId, renderLeadCard(checked.data, style), {
        parse_mode: 'HTML',
        reply_markup: { inline_keyboard: buildLeadCardButtons(checked.data) },
        // Предпросмотр ссылки на запись занял бы половину экрана картинкой плеера и оттеснил бы вниз
        // сами боли и рекомендацию — то, ради чего карточку и читают.
        disable_web_page_preview: true,
      })
      return { ok: true, messageId: sent.message_id }
    } catch (error) {
      return { ok: false, code: 'telegram_error', error: error instanceof Error ? error.message : String(error) }
    }
  }

  /**
   * Подключить обработку нажатий.
   *
   * `answerCallbackQuery` вызывается ВСЕГДА и первым делом, включая ветку отказа. Без него клиент
   * Telegram двадцать секунд крутит часики на кнопке, и менеджер жмёт её второй раз — то есть оффер
   * уходит дважды. Это не косметика, а защита от двойного действия.
   */
  registerCallbacks(handler: CallbackHandler): void {
    const bot = this.bot as {
      on?: (filter: string, fn: (ctx: unknown) => Promise<void>) => void
    } | null
    if (!bot?.on) throw new Error('обработка нажатий требует живого бота: сервис создан с подменным API')

    bot.on('callback_query:data', async (rawCtx) => {
      const ctx = rawCtx as {
        callbackQuery?: { data?: string; from?: { id?: number } }
        chat?: { id?: number }
        answerCallbackQuery: (options?: { text?: string; show_alert?: boolean }) => Promise<unknown>
      }
      const parsed = parseCallbackData(ctx.callbackQuery?.data)
      if (!parsed) {
        await ctx.answerCallbackQuery({ text: 'Кнопка не распознана' }).catch(() => {})
        return
      }
      try {
        const reply = await handler({
          action: parsed.action,
          callId: parsed.callId,
          managerChatId: ctx.chat?.id ?? ctx.callbackQuery?.from?.id ?? 0,
        })
        await ctx.answerCallbackQuery({ text: reply.slice(0, 200) })
      } catch (error) {
        // Отказ обработчика тоже подтверждается: иначе менеджер не узнает, что действие не выполнено, и
        // будет считать оффер отправленным.
        const message = error instanceof Error ? error.message : String(error)
        await ctx.answerCallbackQuery({ text: `Не выполнено: ${message.slice(0, 150)}`, show_alert: true })
          .catch(() => {})
      }
    })
  }
}

/**
 * Создание бота grammY.
 *
 * Через createRequire, а не через `await import`: конструктор сервиса синхронный, и делать его async
 * значило бы обязать каждого вызывающего писать `await` на создании — включая те места, где бот вообще
 * не нужен, потому что подставлен подменный API.
 *
 * Отсутствие библиотеки называется вслух. `Cannot find module 'grammy'` из глубины стека выглядит как
 * поломка сборки, а не как «зависимость не установлена», и разбираться в этом будут долго.
 */
function createBot(token: string): { bot: unknown; api: TelegramApi } {
  let Bot: new (token: string) => { api: TelegramApi }
  try {
    const require = createRequire(import.meta.url)
    Bot = (require('grammy') as { Bot: new (token: string) => { api: TelegramApi } }).Bot
  } catch (error) {
    throw new Error(
      `grammY не доступен (${error instanceof Error ? error.message : String(error)}). `
      + 'Установите его: npm install grammy — или создайте сервис с подменным API.',
    )
  }
  const bot = new Bot(token)
  return { bot, api: bot.api }
}
