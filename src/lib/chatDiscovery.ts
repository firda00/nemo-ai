// Intake captures only explicitly supplied information. It does not grant tools,
// connect channels, or turn a draft into an approved operation.
export type DiscoveryKind = 'team' | 'agent'
export type DiscoveryState = {
  step: 'goal' | 'channels' | 'format'
  initialRequest: string
  requestedKind: DiscoveryKind | null
  goal?: string
  channels?: string
}

export function isExplicitCreation(text: string): boolean {
  // Starting an explanation or quoting an instruction never authorizes a write.
  return /^(?:(?:пожалуйста|please|iltimos)[,\s]+)?(?:(?:можешь|можете|can\s+you|could\s+you)\s+)?(?:созда(?:й|йте|ть)|собер(?:и|ите)|собрать|сдела(?:й|йте|ть)|create|build|yarat|tuz)\s+(?:(?:мне|нам|одного|один|новую|нового|новый|a|an|new|single)\s+)*(?:ai[-\s])?(?:команду|отдел|агента|бота|ассистента|team|agent|assistant|bot|jamoa)(?:\s|[,.:!?]|$)/iu.test(text.trim())
    && !/(?:не\s+(?:надо|нужно|создавать)|don't|do\s+not|bekor)/iu.test(text)
}

export function isDiscoveryCancellation(text: string): boolean {
  return /^(?:отмена|отмени(?:ть)?|стоп|не\s+(?:надо|нужно)|передумал(?:а)?|cancel|stop|never\s*mind|bekor\s+qil|to['‘’ʻʼ]xta)[.!\s]*$/iu.test(text.trim())
}

export function isCapabilityQuestion(value: string): boolean {
  const text = value.trim().replace(/[?!.,…]+$/u, '').trim()
    .replace(/^(?:привет|здравствуй(?:те)?|hello|hi|salom)[,!\s]+/iu, '')
    .replace(/^(?:пожалуйста|скажи(?:те)?|расскажи(?:те)?|please|iltimos)[,:\s]+/iu, '')
  return /^(?:что\s+(?:ты|вы|nemo|немо|система)\s+(?:умеешь|умешь|умеете|умеет|можешь|можете|может)|что\s+умеет\s+(?:nemo|немо)|какие\s+у\s+(?:тебя|вас|nemo|немо)\s+возможности|(?:о\s+)?(?:твоих|ваших)\s+возможностях|чем\s+(?:ты\s+)?можешь\s+помочь|what\s+can\s+(?:you|nemo)\s+do|what\s+are\s+you\s+capable\s+of|how\s+can\s+you\s+help|nima(?:lar)?\s+qila\s+olasan|nimalarga\s+qodirsan)$/iu.test(text)
}

function suppliedChannels(text: string): string | undefined {
  // Keep the original wording (including negation), never infer granted access.
  if (/(?:telegram|телеграм|google\s+drive|crm|instagram|инстаграм|whatsapp|csv|xlsx|pdf|сайт|website|sayt|без\s+(?:каналов|интеграций)|no\s+(?:channels|integrations)|integratsiyasiz)/iu.test(text)) return text
  return undefined
}

function concreteGoal(text: string): string | undefined {
  const remainder = text.replace(/(?:созда(?:й|йте|ть)|собер(?:и|ите|ать)|сдела(?:й|йте|ть)|create|build|yarat|tuz)/giu, '')
    .replace(/(?:команд[а-я]*|отдел[а-я]*|агент[а-я]*|ассистент[а-я]*|бот[а-я]*|специалист[а-я]*|team|agent|assistant|bot|jamoa|mutaxassislar)/giu, '')
    .replace(/(?:пожалуйста|мне|для меня|please|for me|iltimos|menga)/giu, '')
    .replace(/(?:telegram|телеграм[а-я]*|google\s+drive|crm|instagram|инстаграм[а-я]*|whatsapp)/giu, '')
    .replace(/(?:без\s+интеграций|без\s+каналов|no\s+integrations|no\s+channels|integratsiyasiz|csv|xlsx|pdf|сайт[а-я]*|файл[а-я]*|website|files?)/giu, '')
    .replace(/(?:^|\s)(?:в|для|на|через|с|и|только|a|an|the|for|in|on|via|and|with|only)(?=\s|$)/giu, '')
    .replace(/[^\p{L}\p{N}]/gu, '')
  return remainder.length >= 4 ? text : undefined
}

export function nextDiscoveryStep(state: DiscoveryState): DiscoveryState['step'] | null {
  if (!state.goal) return 'goal'
  if (!state.channels) return 'channels'
  if (!state.requestedKind) return 'format'
  return null
}

export function startChatDiscovery(kind: DiscoveryKind | null, text: string): DiscoveryState {
  const state: DiscoveryState = { step: 'goal', requestedKind: kind, initialRequest: text, goal: concreteGoal(text), channels: suppliedChannels(text) }
  return { ...state, step: nextDiscoveryStep(state) ?? 'format' }
}

export function advanceChatDiscovery(state: DiscoveryState, text: string): DiscoveryState {
  if (isCapabilityQuestion(text) || isDiscoveryCancellation(text)) return state
  const next = { ...state }
  if (state.step === 'goal') {
    next.goal = text.trim() || undefined
    next.channels = suppliedChannels(text) ?? next.channels
  } else if (state.step === 'channels') {
    // Questions and cancellation are not a source selection. Keep the pending step.
    if (!/[?？]/u.test(text) && !/^(?:что|как|зачем|почему|какие|объясни|what|how|why|explain|nima|qanday)(?:\s|$)/iu.test(text)) next.channels = text.trim() || undefined
  } else {
    const solo = /(?:^|[^\p{L}])(?:один|одного|соло|агент|solo|single|bitta|agent)(?:$|[^\p{L}])/iu.test(text)
    const team = /команд|team|jamoa|специалист/iu.test(text)
    // Ambiguous or unrecognised format is a question, never a silent default.
    if (solo !== team) next.requestedKind = solo ? 'agent' : 'team'
  }
  next.step = nextDiscoveryStep(next) ?? next.step
  return next
}

export function discoveryPrompt(state: DiscoveryState): string {
  if (nextDiscoveryStep(state)) throw new Error('DISCOVERY_INCOMPLETE')
  return `${state.requestedKind === 'team' ? 'Создай команду' : 'Создай агента'}. Цель: ${state.goal}. Каналы и источники: ${state.channels}. Исходный запрос: ${state.initialRequest}`
}
