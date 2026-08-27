import {
  BusinessIntentSchema,
  type BusinessIntent,
  type BusinessIntentGoal,
  type BusinessIntentSource,
  type BusinessIntentMetadata,
} from '../types/business-intent.ts'

export const BUSINESS_INTENT_STORAGE_KEY = 'nemo.forge.incoming-intent'

const GOAL_SIGNALS: ReadonlyArray<[BusinessIntentGoal, RegExp]> = [
  ['competitor_audit', /конкурент|raqobatch|competitor|сравн.*цен|анализ.*отзыв/i],
  ['morning_brief', /утренн|сводк|отч[её]т.*день|ertalab|morning\s+brief|daily\s+(brief|report)/i],
  ['qualify_lead', /лид|квалифиц|заявк|mijoz|lead|crm/i],
  ['launch_campaign', /акци|скидк|рассылк|кампани|chegirma|reklama|campaign/i],
  ['create_content', /контент|ролик|reels|видео|пост|сценари|video|content/i],
]

const CHANNEL_SIGNALS = [
  ['telegram', /telegram|телеграм/i],
  ['instagram', /instagram|инстаграм|reels/i],
  ['youtube', /youtube|ютуб/i],
  ['whatsapp', /whatsapp|ватсап|вотсап/i],
  ['crm', /crm|amocrm|амо\s?crm/i],
  ['phone', /звон|телефон|qo'ng'iroq|phone/i],
] as const

function detectLocale(text: string): BusinessIntent['locale'] {
  const hasLatin = /[a-z]/i.test(text)
  const hasCyrillic = /[а-яё]/i.test(text)
  if (hasLatin && hasCyrillic) return 'mixed'
  if (hasCyrillic) return 'ru'
  if (/\b(salom|mijoz|uchun|kerak|qiling|chegirma|hisobot)\b/i.test(text)) return 'uz'
  return 'en'
}

function detectGoal(text: string): BusinessIntentGoal {
  return GOAL_SIGNALS.find(([, pattern]) => pattern.test(text))?.[0] ?? 'generic_business_task'
}

function detectChannels(text: string): BusinessIntent['channels'] {
  return CHANNEL_SIGNALS.filter(([, pattern]) => pattern.test(text)).map(([channel]) => channel)
}

function extractUrl(text: string): string | undefined {
  const candidate = text.match(/https?:\/\/[^\s<>'\"]+/i)?.[0]
  if (!candidate) return undefined
  try { return new URL(candidate).toString() } catch { return undefined }
}

function buildQuestions(goal: BusinessIntentGoal, channels: BusinessIntent['channels'], text: string): string[] {
  const questions: string[] = []
  if (goal === 'generic_business_task') questions.push('Какой конкретный бизнес-результат вы хотите получить?')
  if ((goal === 'launch_campaign' || goal === 'create_content') && channels.length === 0) {
    questions.push('В каком канале нужен результат: Telegram, Instagram, YouTube или другом?')
  }
  if ((goal === 'launch_campaign' || goal === 'create_content') && !/клиент|аудитор|mijoz|b2b|b2c/i.test(text)) {
    questions.push('Для какой аудитории готовим материал или предложение?')
  }
  return questions.slice(0, 3)
}

export function createBusinessIntent(rawText: string, options: {
  source?: BusinessIntentSource
  actor?: BusinessIntent['actor']
  budgetCapUsd?: number
  now?: Date
  intentId?: string
  userId?: string
  metadata?: BusinessIntentMetadata
} = {}): BusinessIntent {
  const text = rawText.trim().replace(/\s+/g, ' ')
  const goal = detectGoal(text)
  const channels = detectChannels(text)
  const questions = buildQuestions(goal, channels, text)
  const discountMatch = text.match(/(?:скидк\S*|chegirma|discount)\D{0,12}(\d{1,3})(?:\s*%)/i)
  const requestedTime = text.match(/(?:сегодня|завтра|в пятниц\S*|на выходн\S*|bugun|ertaga|today|tomorrow|friday|weekend)/i)?.[0]
  const competitorUrl = goal === 'competitor_audit' ? extractUrl(text) : undefined

  return BusinessIntentSchema.parse({
    schemaVersion: '1.0',
    intentId: options.intentId ?? globalThis.crypto.randomUUID(),
    source: options.source ?? 'web_text',
    actor: options.actor ?? 'owner',
    locale: detectLocale(text),
    goal,
    rawText: text,
    channels,
    extractedFacts: {
      discountPercent: discountMatch ? Number(discountMatch[1]) : undefined,
      competitorUrl,
      requestedTime,
    },
    confidence: goal === 'generic_business_task' ? 0.45 : 0.9,
    clarificationRequired: questions.length > 0,
    clarificationQuestions: questions,
    approvalRequired: goal === 'launch_campaign' || goal === 'create_content',
    metadata: {
      ...options.metadata,
      userId: options.userId ?? options.metadata?.userId,
    },
    safety: {
      evidenceRequired: true,
      externalEffectsRequireApproval: true,
      budgetCapUsd: options.budgetCapUsd ?? 5,
    },
    createdAt: (options.now ?? new Date()).toISOString(),
  })
}

/** Public router name used by voice and webhook adapters. Kept as an alias so existing callers
 * of createBusinessIntent remain source-compatible. */
export const parseBusinessIntent = createBusinessIntent

export function businessIntentToForgePrompt(intent: BusinessIntent): string {
  const channelLine = intent.channels.length ? intent.channels.join(', ') : 'не указан'
  return [
    intent.rawText,
    '',
    `[Контракт Nemo: цель=${intent.goal}; канал=${channelLine}; evidence_required=true; external_effects=approval_required]`,
  ].join('\n')
}
