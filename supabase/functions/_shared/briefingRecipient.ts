// Telegram-side briefing logic — the NARROW webhook branch, testable offline.
// Handles exactly three shapes and nothing else (everything falls through untouched):
//   1. /start brf_<token>  — recipient verification. Shape rules live HERE (private chat only,
//      from.id must equal chat.id); every database decision lives in briefing_consume_claim,
//      which consumes the claim and verifies the settings in ONE transaction.
//   2. a private self-authored reply to the bot — offered to briefing_capture_outcome, which
//      accepts it ONLY when the replied-to message id matches a sent evening run's own dispatch
//      snapshot. Anything else returns no_match and the message falls through untouched.
//   3. /day_result <text> — explicit outcome for today, verified-recipient-only.
// This branch sits in FRONT of all ordinary reply traffic, so every database and reply wait is
// bounded by one deadline — a hung DB delays a message by at most the bound, never forever.
// No task completion is ever inferred from an outcome; the text is stored bounded, as data.
export interface BriefingUpdateDeps {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Supabase service-role client shape
  db: any
  sendReply: (chatId: string, text: string) => Promise<void>
  timeoutMs?: number
}

interface TelegramMessage {
  text?: unknown
  chat?: { id?: unknown; type?: unknown }
  from?: { id?: unknown }
  reply_to_message?: { message_id?: unknown }
}

const START_RE = /^\/start\s+brf_([0-9a-f]{48})$/i
const DAY_RESULT_RE = /^\/day_result\b([\s\S]*)$/i
const DEFAULT_TIMEOUT_MS = 10_000

const REPLIES = {
  verified: '✅ Получатель подтверждён. Ежедневный брифинг будет приходить в этот чат.',
  invalid: '⚠️ Ссылка подтверждения недействительна или истекла. Откройте Nemo → Настройки → Ежедневный брифинг и выпустите новую.',
  stale: '⚠️ Настройки брифинга изменились после выпуска ссылки. Выпустите новую в Nemo → Настройки → Ежедневный брифинг.',
  privateOnly: '⚠️ Подтверждение работает только в личном чате с ботом.',
  failed: '⚠️ Не удалось подтвердить получателя. Попробуйте ещё раз.',
  outcomeSaved: '📝 Итог дня записан.',
  outcomeDuplicate: '📝 Итог этого дня уже записан — первая версия сохранена.',
  outcomeFailed: '⚠️ Не удалось записать итог. Попробуйте ещё раз.',
  dayResultUsage: 'Напишите итог после команды: /day_result что удалось и что переносим.',
  dayResultRefused: '⚠️ Итог не записан: этот чат не подтверждён как получатель брифинга.',
} as const

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

function isPrivateFromSelf(message: TelegramMessage): boolean {
  return message.chat?.type === 'private'
    && message.chat?.id !== undefined
    && String(message.from?.id ?? '') === String(message.chat.id)
}

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max ? value : fallback
}

export async function handleBriefingTelegramUpdate(
  deps: BriefingUpdateDeps,
  input: { channelId: string; message: TelegramMessage; updateId: number },
): Promise<{ handled: boolean }> {
  const message = input.message
  const text = typeof message?.text === 'string' ? message.text : ''
  const chatId = message?.chat?.id === undefined ? '' : String(message.chat.id)
  if (!chatId) return { handled: false }

  const isStart = START_RE.exec(text.trim())
  const isDayResult = DAY_RESULT_RE.exec(text.trim())
  const replyId = message?.reply_to_message?.message_id
  const isCandidateReply = typeof replyId === 'number' && text.trim() !== '' && isPrivateFromSelf(message)
  if (!isStart && !isDayResult && !isCandidateReply) return { handled: false }

  // one deadline for everything this branch does — it must never stall unrelated traffic.
  // Racing alone would still EVALUATE a new call after expiry, so both helpers check the
  // expired flag before dispatching anything.
  let expiredFlag = false
  let expire: (error: Error) => void = () => {}
  const expired = new Promise<never>((_resolve, reject) => { expire = reject })
  expired.catch(() => {})
  const timer = setTimeout(() => { expiredFlag = true; expire(new Error('BRIEFING_UPDATE_TIMEOUT')) }, clampInt(deps.timeoutMs, DEFAULT_TIMEOUT_MS, 1, 30_000))
  const boundedRpc = async (name: string, args: Record<string, unknown>): Promise<{ data: unknown; error: unknown }> => {
    if (expiredFlag) return { data: null, error: new Error('BRIEFING_UPDATE_TIMEOUT') }
    try { return await Promise.race([deps.db.rpc(name, args), expired]) } catch (error) { return { data: null, error } }
  }
  const boundedReply = async (replyText: string): Promise<void> => {
    if (expiredFlag) return
    await Promise.race([deps.sendReply(chatId, replyText), expired]).catch(() => {})
  }

  try {
    if (isStart) {
      // shape rules first: verification is meaningful only in the owner's own private chat
      if (!isPrivateFromSelf(message)) {
        await boundedReply(REPLIES.privateOnly)
        return { handled: true }
      }
      const tokenHash = await sha256Hex(isStart[1].toLowerCase())
      const { data, error } = await boundedRpc('briefing_consume_claim', {
        p_token_hash: tokenHash, p_chat_id: chatId, p_channel_id: input.channelId,
      })
      if (error) {
        await boundedReply(REPLIES.failed)
        return { handled: true }
      }
      const result = data as { ok?: boolean; reason?: string } | null
      const reply = result?.ok === true ? REPLIES.verified
        : result?.reason === 'stale' || result?.reason === 'superseded' || result?.reason === 'wrong_channel' ? REPLIES.stale
        : REPLIES.invalid
      await boundedReply(reply)
      return { handled: true }
    }

    if (isDayResult) {
      if (!isPrivateFromSelf(message)) {
        await boundedReply(REPLIES.privateOnly)
        return { handled: true }
      }
      const body = isDayResult[1].trim().slice(0, 2000)
      if (!body) {
        await boundedReply(REPLIES.dayResultUsage)
        return { handled: true }
      }
      const { data, error } = await boundedRpc('briefing_capture_outcome', {
        p_channel_id: input.channelId, p_chat_id: chatId, p_reply_message_id: null,
        p_update_id: input.updateId, p_text: body, p_via: 'command',
      })
      if (error) {
        await boundedReply(REPLIES.outcomeFailed)
        return { handled: true }
      }
      const result = data as { ok?: boolean; duplicate?: boolean } | null
      await boundedReply(result?.ok === true
        ? (result.duplicate ? REPLIES.outcomeDuplicate : REPLIES.outcomeSaved)
        : REPLIES.dayResultRefused)
      return { handled: true } // an explicit command never falls through to the chat agent
    }

    // candidate reply: only a match against a sent evening run's dispatch snapshot is an
    // outcome; no_match, an error or a timeout means ordinary chat — fall through untouched
    const { data, error } = await boundedRpc('briefing_capture_outcome', {
      p_channel_id: input.channelId, p_chat_id: chatId, p_reply_message_id: replyId,
      p_update_id: input.updateId, p_text: text.trim().slice(0, 2000), p_via: 'reply',
    })
    if (error) return { handled: false }
    const result = data as { ok?: boolean; duplicate?: boolean } | null
    if (result?.ok === true) {
      await boundedReply(result.duplicate ? REPLIES.outcomeDuplicate : REPLIES.outcomeSaved)
      return { handled: true }
    }
    return { handled: false }
  } finally {
    clearTimeout(timer)
  }
}
