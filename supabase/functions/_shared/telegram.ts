// Telegram Bot API helpers.

export async function tgSend(botToken: string, chatId: number | string, text: string): Promise<boolean> {
  const res = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text }),
  })
  return res.ok
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
