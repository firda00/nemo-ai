// Telegram Bot API helpers.
import { encodeBase64 } from 'https://deno.land/std@0.224.0/encoding/base64.ts'
import { formatTelegramHtml, splitTelegramText } from './telegramFormat.ts'

// Download a Telegram file (photo/document) by file_id and return it base64-encoded (for the
// vision model to inspect a submitted proof). Returns '' on any failure.
export async function tgDownloadFileB64(botToken: string, fileId: string): Promise<string> {
  try {
    const gf = await fetch(`https://api.telegram.org/bot${botToken}/getFile?file_id=${encodeURIComponent(fileId)}`).then((r) => r.json())
    const path = gf?.result?.file_path
    if (!path) return ''
    const buf = await fetch(`https://api.telegram.org/file/bot${botToken}/${path}`).then((r) => r.arrayBuffer())
    return encodeBase64(new Uint8Array(buf))
  } catch { return '' }
}

export async function tgSend(botToken: string, chatId: number | string, text: string): Promise<boolean> {
  for (const chunk of splitTelegramText(text)) {
    const res = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: formatTelegramHtml(chunk),
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      }),
    })
    if (!res.ok) return false
  }
  return true
}

// Send a message we authored ourselves as Telegram HTML. tgSend() runs agent output through
// formatTelegramHtml, which ESCAPES tags — correct for untrusted model text, but it turned our
// own <b> into visible "<b>". Use this for hand-written copy and escape interpolated values
// with escapeHtml() at the call site.
export async function tgSendHtml(botToken: string, chatId: number | string, html: string): Promise<boolean> {
  for (const chunk of splitTelegramText(html)) {
    const res = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: chunk, parse_mode: 'HTML', disable_web_page_preview: true }),
    })
    if (!res.ok) return false
  }
  return true
}

// Send a single message carrying an inline keyboard. Not chunked: an approval prompt must stay
// one message so the buttons cannot end up detached from the numbers they approve.
export async function tgSendKeyboard(
  botToken: string,
  chatId: number | string,
  text: string,
  replyMarkup: Record<string, unknown>,
): Promise<boolean> {
  try {
    const res = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: text.slice(0, 4000),
        parse_mode: 'HTML',
        disable_web_page_preview: true,
        reply_markup: replyMarkup,
      }),
    })
    return res.ok
  } catch { return false }
}

// Acknowledge a button press so Telegram stops showing the spinner on the client.
export async function tgAnswerCallback(botToken: string, callbackId: string, text = ''): Promise<void> {
  try {
    await fetch(`https://api.telegram.org/bot${botToken}/answerCallbackQuery`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ callback_query_id: callbackId, text: text.slice(0, 200) }),
    })
  } catch { /* the visible reply is what matters */ }
}

// Replace a prompt's text and drop its keyboard, so a decided proposal cannot be pressed twice.
export async function tgEditMessage(botToken: string, chatId: number | string, messageId: number, text: string): Promise<void> {
  try {
    await fetch(`https://api.telegram.org/bot${botToken}/editMessageText`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, message_id: messageId, text: text.slice(0, 4000), parse_mode: 'HTML' }),
    })
  } catch { /* best effort */ }
}

// Same as tgSend but returns Telegram's real error text (for surfacing to the user).
export async function tgSendDetailed(botToken: string, chatId: number | string, text: string): Promise<{ ok: boolean; error?: string }> {
  try {
    for (const chunk of splitTelegramText(text)) {
      const res = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          text: formatTelegramHtml(chunk),
          parse_mode: 'HTML',
          disable_web_page_preview: true,
        }),
      })
      const data = await res.json().catch(() => ({}))
      if (!data?.ok) return { ok: false, error: String(data?.description ?? `HTTP ${res.status}`) }
    }
    return { ok: true }
  } catch (e) { return { ok: false, error: String(e).slice(0, 160) } }
}

type TelegramResponse<T = unknown> = { ok?: boolean; result?: T; description?: string }

/*
 * allowed_updates — БЕЛЫЙ СПИСОК, а не подсказка. Здесь стояло только ["message"], и это делало
 * все инлайн-кнопки бота мёртвыми: обработчик разбирает callback_query четырьмя ветками
 * (экономика, карточка товара, партия себестоимости, цена), но Telegram эти обновления просто
 * не присылал. Человек жал «✅ Да, сохранить» — и не происходило ничего, без ошибки в журналах.
 *
 * Список обязан совпадать с тем, что код действительно разбирает: message и callback_query.
 * Шире — лишний трафик и оплаченные впустую вызовы, уже — снова немые кнопки.
 */
export const TG_ALLOWED_UPDATES = ['message', 'callback_query']
export async function tgSetWebhook(botToken: string, url: string, secret: string): Promise<TelegramResponse> {
  const res = await fetch(`https://api.telegram.org/bot${botToken}/setWebhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url, secret_token: secret, allowed_updates: TG_ALLOWED_UPDATES }),
  })
  return await res.json()
}

export async function tgGetMe(botToken: string): Promise<TelegramResponse> {
  const res = await fetch(`https://api.telegram.org/bot${botToken}/getMe`)
  return await res.json()
}
