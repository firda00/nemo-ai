import type { TelegramVoiceForgeInput } from './telegramVoiceForge.ts'

type OwnerChat = { accountId: string; channelId: string; chatId: string }

type PendingVoiceIntent = {
  id: string
  account_id: string
  channel_id: string
  chat_id: string
  status: string
  expires_at: string
  intent: unknown
  forge_payload: TelegramVoiceForgeInput
}

type TransitionPatch = Record<string, unknown>

export interface TelegramVoiceCallbackDependencies {
  findOwner: (db: unknown, channelId: string, chatId: string) => Promise<OwnerChat | null>
  answer: (botToken: string, callbackId: string, text?: string) => Promise<void>
  edit: (botToken: string, chatId: string, messageId: number, text: string) => Promise<void>
  enqueue: (
    db: unknown,
    accountId: string,
    input: TelegramVoiceForgeInput,
  ) => Promise<{ executionId: string; workflowId: string; status: 'created' | 'duplicate' }>
  loadPending?: (db: unknown, id: string) => Promise<PendingVoiceIntent | null>
  transition?: (
    db: unknown,
    pending: PendingVoiceIntent,
    expectedStatus: string,
    nextStatus: string,
    patch?: TransitionPatch,
  ) => Promise<boolean>
  now?: () => Date
}

async function loadPending(db: any, id: string): Promise<PendingVoiceIntent | null> {
  const { data } = await db.from('telegram_voice_intents')
    .select('id, account_id, channel_id, chat_id, status, expires_at, intent, forge_payload')
    .eq('id', id).maybeSingle()
  return data ?? null
}

async function transition(
  db: any,
  pending: PendingVoiceIntent,
  expectedStatus: string,
  nextStatus: string,
  patch: TransitionPatch = {},
): Promise<boolean> {
  const { data, error } = await db.from('telegram_voice_intents')
    .update({ ...patch, status: nextStatus })
    .eq('id', pending.id)
    .eq('account_id', pending.account_id)
    .eq('status', expectedStatus)
    .select('id')
    .maybeSingle()
  if (error) throw error
  return Boolean(data)
}

/**
 * Executes the approval half of Telegram voice -> Forge. The state transition is a CAS:
 * only one callback can claim a pending row, while tenant/channel/chat checks prevent a
 * forwarded inline keyboard from crossing account boundaries.
 */
export async function handleForgeVoiceCallback(
  db: unknown,
  channelId: string,
  botToken: string | undefined,
  cb: any,
  dependencies: TelegramVoiceCallbackDependencies,
): Promise<void> {
  const match = /^forge_voice:(approve|reject):([0-9a-f-]{36})$/i.exec(String(cb?.data ?? ''))
  if (!match || !botToken) return

  const findOwner = dependencies.findOwner
  const getPending = dependencies.loadPending ?? loadPending
  const move = dependencies.transition ?? transition
  const enqueue = dependencies.enqueue
  const now = dependencies.now?.() ?? new Date()
  const chatId = String(cb?.message?.chat?.id ?? '')
  const messageId = Number(cb?.message?.message_id)
  const owner = await findOwner(db, channelId, chatId)
  const pending = await getPending(db, match[2])

  if (!owner || !pending || pending.account_id !== owner.accountId || pending.channel_id !== channelId || pending.chat_id !== chatId) {
    await dependencies.answer(botToken, cb.id, 'Это подтверждение недоступно.')
    return
  }
  if (pending.status !== 'pending') {
    await dependencies.answer(botToken, cb.id, 'Уже обработано.')
    return
  }
  if (Date.parse(pending.expires_at) <= now.getTime()) {
    await move(db, pending, 'pending', 'expired', { decided_at: now.toISOString() })
    await dependencies.answer(botToken, cb.id, 'Срок подтверждения истёк.')
    return
  }
  if (match[1] === 'reject') {
    const rejected = await move(db, pending, 'pending', 'rejected', { decided_at: now.toISOString() })
    await dependencies.answer(botToken, cb.id, rejected ? 'Отменено' : 'Уже обработано.')
    if (rejected) await dependencies.edit(botToken, chatId, messageId, '❌ <b>Запуск отменён.</b>')
    return
  }

  const claimed = await move(db, pending, 'pending', 'processing')
  if (!claimed) {
    await dependencies.answer(botToken, cb.id, 'Уже обрабатывается.')
    return
  }

  try {
    // The Forge bridge independently deduplicates by Telegram message identity. Together with
    // the CAS claim this prevents duplicate compute spend on simultaneous button presses.
    const execution = await enqueue(db, owner.accountId, pending.forge_payload)
    await move(db, pending, 'processing', 'approved', {
      execution_id: execution.executionId,
      decided_at: now.toISOString(),
    })
    await dependencies.answer(botToken, cb.id, 'Задача запущена')
    await dependencies.edit(botToken, chatId, messageId, '✅ <b>Подтверждено.</b> Задача передана в Nemo Forge.')
  } catch (error) {
    console.error('forge voice approval failed:', error)
    await move(db, pending, 'processing', 'pending')
    await dependencies.answer(botToken, cb.id, 'Не удалось запустить. Проверьте лимит и подключение Forge.')
  }
}
