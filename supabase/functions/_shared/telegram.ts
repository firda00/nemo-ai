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

export async function tgSetWebhook(botToken: string, url: string, secret: string): Promise<TelegramResponse> {
  const res = await fetch(`https://api.telegram.org/bot${botToken}/setWebhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url, secret_token: secret, allowed_updates: ['message'] }),
  })
  return await res.json()
}

export async function tgGetMe(botToken: string): Promise<TelegramResponse> {
  const res = await fetch(`https://api.telegram.org/bot${botToken}/getMe`)
  return await res.json()
}
