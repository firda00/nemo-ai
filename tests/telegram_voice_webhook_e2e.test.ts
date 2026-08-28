import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { handleTelegramVoiceTranscription } from '../src/server/telegram/voice-handler.ts'
import { handleForgeVoiceCallback } from '../supabase/functions/_shared/telegramVoiceCallback.ts'

const BOT_TOKEN = 'mock-bot-token'
const CHANNEL_ID = '018ff6a0-32f4-7a11-8b30-92ab59e79a41'
const ACCOUNT_ID = '018ff6a0-32f4-7a11-8b30-92ab59e79a42'
const WORKSPACE_ID = '018ff6a0-32f4-7a11-8b30-92ab59e79a43'
const CHAT_ID = '99887766'
const telegramCalls: Array<{ method: string; body: Record<string, unknown> }> = []

const originalFetch = globalThis.fetch
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input)
  assert.match(url, /^https:\/\/api\.telegram\.org\/botmock-bot-token\//)
  telegramCalls.push({
    method: url.slice(url.lastIndexOf('/') + 1),
    body: init?.body ? JSON.parse(String(init.body)) : {},
  })
  return new Response(JSON.stringify({ ok: true, result: { message_id: 700 } }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}) as typeof fetch

async function telegramRequest(method: string, body: Record<string, unknown>): Promise<void> {
  const response = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  assert.equal(response.ok, true)
}

try {
  let forgeExecutions = 0
  const context = {
    userId: 'telegram-user-42',
    workspaceId: WORKSPACE_ID,
    channelId: CHANNEL_ID,
    chatId: CHAT_ID,
    messageId: 314,
  }

  // A Telegram voice transcription is routed deterministically, but the external campaign is
  // not enqueued until the owner presses the inline approval button.
  const routed = await handleTelegramVoiceTranscription(
    'Запусти скидку 20% для постоянных клиентов в Telegram в пятницу',
    context,
    {
      executeForge: async () => {
        forgeExecutions += 1
        return { executionId: '018ff6a0-32f4-7a11-8b30-92ab59e79a44' }
      },
    },
  )
  assert.equal(routed.status, 'approval_required')
  assert.equal(forgeExecutions, 0)
  if (routed.status !== 'approval_required') throw new Error('approval route expected')

  await telegramRequest('sendMessage', {
    chat_id: CHAT_ID,
    text: routed.replyText,
    reply_markup: routed.keyboard,
  })
  assert.equal(telegramCalls.at(-1)?.method, 'sendMessage')

  const pending = {
    id: routed.intent.intentId,
    account_id: ACCOUNT_ID,
    channel_id: CHANNEL_ID,
    chat_id: CHAT_ID,
    status: 'pending',
    expires_at: '2026-08-27T06:00:00.000Z',
    intent: routed.intent,
    forge_payload: routed.forgePayload,
    execution_id: null as string | null,
  }

  const dependencies = {
    now: () => new Date('2026-08-27T05:00:00.000Z'),
    findOwner: async (_db: unknown, channelId: string, chatId: string) =>
      channelId === CHANNEL_ID && chatId === CHAT_ID
        ? { accountId: ACCOUNT_ID, channelId, chatId }
        : null,
    loadPending: async (_db: unknown, id: string) => id === pending.id ? pending : null,
    transition: async (
      _db: unknown,
      row: typeof pending,
      expectedStatus: string,
      nextStatus: string,
      patch: Record<string, unknown> = {},
    ) => {
      if (row.id !== pending.id || pending.status !== expectedStatus) return false
      Object.assign(pending, patch, { status: nextStatus })
      return true
    },
    enqueue: async (_db: unknown, accountId: string, payload: typeof routed.forgePayload) => {
      assert.equal(accountId, ACCOUNT_ID)
      assert.equal(payload.idempotencyKey, `telegram-voice:${CHANNEL_ID}:${CHAT_ID}:314`)
      assert.equal(payload.intent.source, 'telegram_voice')
      forgeExecutions += 1
      return {
        executionId: '018ff6a0-32f4-7a11-8b30-92ab59e79a45',
        workflowId: '018ff6a0-32f4-7a11-8b30-92ab59e79a46',
        status: 'created' as const,
      }
    },
    answer: async (token: string, callbackId: string, text = '') => {
      assert.equal(token, BOT_TOKEN)
      await telegramRequest('answerCallbackQuery', { callback_query_id: callbackId, text })
    },
    edit: async (token: string, chatId: string, messageId: number, text: string) => {
      assert.equal(token, BOT_TOKEN)
      await telegramRequest('editMessageText', { chat_id: chatId, message_id: messageId, text })
    },
  }

  const callback = {
    id: 'callback-1',
    data: `forge_voice:approve:${pending.id}`,
    message: { message_id: 700, chat: { id: CHAT_ID } },
  }
  await handleForgeVoiceCallback({}, CHANNEL_ID, BOT_TOKEN, callback, dependencies)
  assert.equal(pending.status, 'approved')
  assert.equal(forgeExecutions, 1)
  assert.deepEqual(telegramCalls.slice(-2).map((call) => call.method), ['answerCallbackQuery', 'editMessageText'])

  // Telegram retries and double-clicks are idempotent: an approved row cannot spend twice.
  await handleForgeVoiceCallback({}, CHANNEL_ID, BOT_TOKEN, { ...callback, id: 'callback-2' }, dependencies)
  assert.equal(forgeExecutions, 1)
  assert.equal(telegramCalls.at(-1)?.method, 'answerCallbackQuery')
  assert.match(String(telegramCalls.at(-1)?.body.text), /обработано/i)

  // Incomplete voice input produces a clarification in Telegram and never enters Forge.
  const clarification = await handleTelegramVoiceTranscription('Помоги улучшить бизнес', {
    ...context,
    messageId: 315,
  }, { executeForge: async () => { throw new Error('must not execute') } })
  assert.equal(clarification.status, 'clarification_required')
  await telegramRequest('sendMessage', { chat_id: CHAT_ID, text: clarification.replyText })
  assert.match(String(telegramCalls.at(-1)?.body.text), /уточните/i)

  // The migration owns the schedule because Supabase config.toml does not accept a schedule key.
  const cronSql = await readFile(
    new URL('../supabase/migrations/20260827180000_morning_brief_cron.sql', import.meta.url),
    'utf8',
  )
  assert.match(cronSql, /cron\.schedule\([\s\S]*'0 3 \* \* \*'/)
  assert.match(cronSql, /vault\.decrypted_secrets/)
  assert.doesNotMatch(cronSql, /https:\/\/[^<\s]+\.supabase\.co/)

  console.log('telegram voice webhook E2E tests: ok')
} finally {
  globalThis.fetch = originalFetch
}
