export interface MorningBriefMetrics {
  leadsToday: number
  activeCampaigns: number
  completedAgentTasks: number
  pendingAgentTasks: number
  approvalsWaiting: number
}

export interface MorningBriefSummary {
  workspaceId: string
  generatedAt: string
  metrics: MorningBriefMetrics
  text: string
  ssml: string
}

export interface MorningBriefDataSource {
  getDailyMetrics(workspaceId: string): Promise<MorningBriefMetrics>
}

export interface MorningBriefVoiceService {
  synthesize(input: { text: string; ssml: string; workspaceId: string }): Promise<{
    audioUrl: string
    mimeType: 'audio/mpeg' | 'audio/ogg'
  }>
}

export interface MorningBriefDelivery {
  postAudio(input: {
    workspaceId: string
    audioUrl: string
    mimeType: 'audio/mpeg' | 'audio/ogg'
    caption: string
  }): Promise<void>
}

function nonNegativeInteger(value: number): number {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0
}

function escapeSsml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
}

export async function generateMorningBriefSummary(
  workspaceId: string,
  dataSource: MorningBriefDataSource,
  options: { now?: Date } = {},
): Promise<MorningBriefSummary> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(workspaceId)) {
    throw new Error('MORNING_BRIEF_INVALID_WORKSPACE')
  }
  const raw = await dataSource.getDailyMetrics(workspaceId)
  const metrics: MorningBriefMetrics = {
    leadsToday: nonNegativeInteger(raw.leadsToday),
    activeCampaigns: nonNegativeInteger(raw.activeCampaigns),
    completedAgentTasks: nonNegativeInteger(raw.completedAgentTasks),
    pendingAgentTasks: nonNegativeInteger(raw.pendingAgentTasks),
    approvalsWaiting: nonNegativeInteger(raw.approvalsWaiting),
  }
  const text = [
    'Доброе утро. Короткая сводка Nemo.',
    `Новых лидов: ${metrics.leadsToday}. Активных кампаний: ${metrics.activeCampaigns}.`,
    `Агенты завершили ${metrics.completedAgentTasks} задач, в работе осталось ${metrics.pendingAgentTasks}.`,
    metrics.approvalsWaiting > 0
      ? `Вашего подтверждения ожидают ${metrics.approvalsWaiting} действий.`
      : 'Действий, ожидающих подтверждения, нет.',
  ].join(' ')
  const ssml = `<speak>${escapeSsml(text)}<break time="400ms"/>Хорошего рабочего дня.</speak>`
  return { workspaceId, generatedAt: (options.now ?? new Date()).toISOString(), metrics, text, ssml }
}

export async function synthesizeAndDeliverMorningBrief(
  workspaceId: string,
  dependencies: {
    dataSource: MorningBriefDataSource
    voiceService: MorningBriefVoiceService
    delivery: MorningBriefDelivery
    now?: Date
  },
): Promise<MorningBriefSummary & { audioUrl: string }> {
  const summary = await generateMorningBriefSummary(workspaceId, dependencies.dataSource, { now: dependencies.now })
  const audio = await dependencies.voiceService.synthesize({
    text: summary.text,
    ssml: summary.ssml,
    workspaceId,
  })
  if (!/^https:\/\//i.test(audio.audioUrl)) throw new Error('MORNING_BRIEF_TTS_FAILED')
  await dependencies.delivery.postAudio({
    workspaceId,
    audioUrl: audio.audioUrl,
    mimeType: audio.mimeType,
    caption: 'Утренняя бизнес-сводка Nemo',
  })
  return { ...summary, audioUrl: audio.audioUrl }
}
