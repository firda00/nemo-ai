import { businessIntentToForgePrompt, parseBusinessIntent } from '../../lib/business-intent.ts'
import type { BusinessIntent } from '../../types/business-intent.ts'
import type { MorningBriefSummary } from '../../lib/voice/morning-brief.ts'

export interface TelegramVoiceContext {
  userId: string
  workspaceId: string
  chatId: string
  messageId: number
  messageThreadId?: number
  channelId?: string
}

export interface ForgeVoicePayload {
  intent: BusinessIntent
  prompt: string
  workspaceId: string
  idempotencyKey: string
}

export type TelegramVoiceIntentResult =
  | { status: 'clarification_required'; intent: BusinessIntent; replyText: string }
  | { status: 'approval_required'; intent: BusinessIntent; replyText: string; keyboard: Record<string, unknown>; forgePayload: ForgeVoicePayload }
  | { status: 'morning_brief'; intent: BusinessIntent; replyText: string; summary: MorningBriefSummary }
  | { status: 'forge_queued'; intent: BusinessIntent; replyText: string; forgePayload: ForgeVoicePayload; executionId: string }

export interface TelegramVoiceDependencies {
  confidenceThreshold?: number
  approved?: boolean
  executeForge(payload: ForgeVoicePayload): Promise<{ executionId: string }>
  generateMorningBrief?(workspaceId: string): Promise<MorningBriefSummary>
}

function forgePayload(intent: BusinessIntent, context: TelegramVoiceContext): ForgeVoicePayload {
  return {
    intent,
    prompt: businessIntentToForgePrompt(intent),
    workspaceId: context.workspaceId,
    idempotencyKey: `telegram-voice:${context.channelId ?? 'channel'}:${context.chatId}:${context.messageId}`,
  }
}

export async function handleTelegramVoiceTranscription(
  transcription: string,
  context: TelegramVoiceContext,
  dependencies: TelegramVoiceDependencies,
): Promise<TelegramVoiceIntentResult> {
  const intent = parseBusinessIntent(transcription, {
    source: 'telegram_voice',
    userId: context.userId,
    metadata: {
      userId: context.userId,
      workspaceId: context.workspaceId,
      telegram: {
        chatId: context.chatId,
        messageId: context.messageId,
        messageThreadId: context.messageThreadId,
        channelId: context.channelId,
      },
    },
  })
  const threshold = dependencies.confidenceThreshold ?? 0.75
  if (intent.confidence < threshold || intent.clarificationRequired) {
    const questions = intent.clarificationQuestions.length
      ? intent.clarificationQuestions
      : ['Уточните, какой результат должен получить бизнес?']
    return {
      status: 'clarification_required', intent,
      replyText: `Чтобы выполнить задачу безопасно, уточните:\n${questions.map((question, index) => `${index + 1}. ${question}`).join('\n')}`,
    }
  }

  if (intent.goal === 'morning_brief' || intent.goal === 'daily_briefing') {
    if (!dependencies.generateMorningBrief) throw new Error('MORNING_BRIEF_SERVICE_UNAVAILABLE')
    const summary = await dependencies.generateMorningBrief(context.workspaceId)
    return { status: 'morning_brief', intent, summary, replyText: summary.text }
  }

  const payload = forgePayload(intent, context)
  if (intent.approvalRequired && !dependencies.approved) {
    return {
      status: 'approval_required', intent, forgePayload: payload,
      replyText: `Подтвердите запуск: ${intent.rawText}`,
      keyboard: {
        inline_keyboard: [[
          { text: '✅ Подтвердить', callback_data: `forge_voice:approve:${intent.intentId}` },
          { text: '❌ Отменить', callback_data: `forge_voice:reject:${intent.intentId}` },
        ]],
      },
    }
  }

  const execution = await dependencies.executeForge(payload)
  return { status: 'forge_queued', intent, forgePayload: payload, executionId: execution.executionId, replyText: 'Задача принята в Nemo Forge.' }
}
