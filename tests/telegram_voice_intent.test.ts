import assert from 'node:assert/strict'
import { handleTelegramVoiceTranscription } from '../src/server/telegram/voice-handler.ts'
import { generateMorningBriefSummary } from '../src/lib/voice/morning-brief.ts'

const context = {
  userId: 'telegram-user-42',
  workspaceId: '018ff6a0-32f4-7a11-8b30-92ab59e79a40',
  channelId: '018ff6a0-32f4-7a11-8b30-92ab59e79a41',
  chatId: '99887766',
  messageId: 314,
}

let executions = 0
const executeForge = async () => {
  executions += 1
  return { executionId: '018ff6a0-32f4-7a11-8b30-92ab59e79a42' }
}

// A read-only, fully specified voice request routes end-to-end without changing the
// useForgeExecution payload contract.
const audit = await handleTelegramVoiceTranscription(
  'Проанализируй конкурента https://example.com/product и подготовь отчет',
  context,
  { executeForge },
)
assert.equal(audit.status, 'forge_queued')
assert.equal(audit.intent.source, 'telegram_voice')
assert.equal(audit.intent.metadata.telegram?.chatId, context.chatId)
assert.equal(audit.intent.metadata.telegram?.messageId, context.messageId)
assert.equal(audit.intent.metadata.workspaceId, context.workspaceId)
assert.equal(executions, 1)
if (audit.status === 'forge_queued') {
  assert.match(audit.forgePayload.prompt, /цель=competitor_audit/)
  assert.equal(audit.forgePayload.idempotencyKey, 'telegram-voice:018ff6a0-32f4-7a11-8b30-92ab59e79a41:99887766:314')
}

// Missing slots never reach Forge: Telegram receives deterministic questions instead.
const ambiguous = await handleTelegramVoiceTranscription('Помоги улучшить бизнес', context, { executeForge })
assert.equal(ambiguous.status, 'clarification_required')
assert.match(ambiguous.replyText, /уточните/i)
assert.equal(executions, 1)

// Side effects require an explicit button press. Initial handling only returns the keyboard.
const campaign = await handleTelegramVoiceTranscription(
  'Запусти скидку 20% для постоянных клиентов в Telegram в пятницу',
  context,
  { executeForge },
)
assert.equal(campaign.status, 'approval_required')
assert.equal(executions, 1)
if (campaign.status === 'approval_required') {
  const rows = campaign.keyboard.inline_keyboard as Array<Array<{ callback_data: string }>>
  assert.match(rows[0][0].callback_data, /^forge_voice:approve:/)
  assert.match(rows[0][1].callback_data, /^forge_voice:reject:/)
}

const approvedCampaign = await handleTelegramVoiceTranscription(
  'Запусти скидку 20% для постоянных клиентов в Telegram в пятницу',
  context,
  { executeForge, approved: true },
)
assert.equal(approvedCampaign.status, 'forge_queued')
assert.equal(executions, 2)

let briefs = 0
const brief = await handleTelegramVoiceTranscription('Пришли утреннюю сводку', context, {
  executeForge,
  generateMorningBrief: async (workspaceId) => {
    briefs += 1
    return generateMorningBriefSummary(workspaceId, {
      getDailyMetrics: async () => ({
        leadsToday: 7,
        activeCampaigns: 2,
        completedAgentTasks: 11,
        pendingAgentTasks: 3,
        approvalsWaiting: 1,
      }),
    }, { now: new Date('2026-08-27T09:00:00+05:00') })
  },
})
assert.equal(brief.status, 'morning_brief')
assert.equal(briefs, 1)
assert.equal(executions, 2)
if (brief.status === 'morning_brief') {
  assert.match(brief.summary.text, /Новых лидов: 7/)
  assert.match(brief.summary.ssml, /^<speak>/)
}

console.log('telegram voice intent tests: ok')
