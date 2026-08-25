export type BusinessPresetId = 'media-studio' | 'sales-manager' | 'finance-analyst' | 'support-assistant'

export interface BusinessAgentRole {
  role: string
  name: string
  skills: string[]
  prompt: {
    role: string
    tasks: string
    tone: string
    rules: string
  }
}

export interface BusinessAgentPreset {
  id: BusinessPresetId
  title: string
  description: string
  icon: 'media' | 'sales' | 'finance' | 'support'
  accent: string
  profiles: string[]
  integrations: string[]
  artifacts: string[]
  defaultGoal: string
  defaultModel: string
  roles: BusinessAgentRole[]
}

const VERIFIED_OUTPUT_RULE = [
  'Используй только данные из брифа, подключённых систем и явно указанных источников.',
  'Не выдумывай цены, клиентов, даты, метрики, ссылки, выполненные действия или результаты интеграций.',
  'Каждое неподтверждённое утверждение помечай «Не подтверждено» и перечисляй недостающие данные.',
  'Числа проверяй вычислением; внешние действия выполняй только после Human-in-the-Loop approval.',
].join(' ')

export const BUSINESS_AGENT_PRESETS: BusinessAgentPreset[] = [
  {
    id: 'media-studio',
    title: 'AI-Медиастудия',
    description: 'Сценарий, вертикальный монтаж 9:16, титры и готовый медиапакет.',
    icon: 'media',
    accent: '#EC4899',
    profiles: ['PROFILE_B_DOCS', 'PROFILE_C_BROWSER'],
    integrations: ['FFmpeg', 'Object Storage'],
    artifacts: ['MP4 9:16', 'SRT/ASS', 'Storyboard'],
    defaultGoal: 'Создай готовый вертикальный ролик 9:16 по моему брифу: сценарий, раскадровка, субтитры и финальный MP4.',
    defaultModel: 'openai/gpt-4o-mini',
    roles: [
      {
        role: 'Сценарист', name: 'Nemo Scriptwriter', skills: ['social', 'video'],
        prompt: { role: 'Пишет короткие продающие сценарии строго по брифу.', tasks: 'Собери hook, сцены, дикторский текст, экранные титры и точный storyboard.', tone: 'Ясно, динамично, без клише.', rules: VERIFIED_OUTPUT_RULE },
      },
      {
        role: 'Монтажёр', name: 'Nemo Video Editor', skills: ['video', 'content-production-review'],
        prompt: { role: 'Готовит безопасный манифест для FFmpeg media worker.', tasks: 'Проверь 9:16, длительность, word-level субтитры, аудио ducking и перечень входных ассетов.', tone: 'Технически точно.', rules: `${VERIFIED_OUTPUT_RULE} Не утверждай, что MP4 создан, пока ArtifactManifest не вернул реальную ссылку.` },
      },
    ],
  },
  {
    id: 'sales-manager',
    title: 'Менеджер квалификации и продаж',
    description: 'Квалифицирует лид из amoCRM и собирает персональное КП в Typst.',
    icon: 'sales',
    accent: '#22D3EE',
    profiles: ['PROFILE_A_WASI', 'PROFILE_B_DOCS'],
    integrations: ['amoCRM', 'Typst'],
    artifacts: ['PDF КП', 'CRM recommendation'],
    defaultGoal: 'Проанализируй лид из amoCRM, задай недостающие квалификационные вопросы и подготовь персональное коммерческое предложение в PDF.',
    defaultModel: 'openai/gpt-4o-mini',
    roles: [
      {
        role: 'Квалификатор', name: 'Nemo Sales Qualifier', skills: ['structured-intake', 'lead-crm-handoff', 'follow-up-drafting'],
        prompt: { role: 'Квалифицирует лид по фактам CRM и брифа.', tasks: 'Определи потребность, бюджет, срок и следующий безопасный шаг. Сформируй только предложение действия, без записи в CRM.', tone: 'Деловой и уважительный.', rules: VERIFIED_OUTPUT_RULE },
      },
      {
        role: 'Proposal Designer', name: 'Nemo Proposal Builder', skills: ['document-evidence-review', 'commercial-comparison'],
        prompt: { role: 'Собирает проверяемое КП для Typst.', tasks: 'Подготовь структуру КП, смету только из подтверждённых цен и ArtifactManifest PDF.', tone: 'Кратко и убедительно.', rules: VERIFIED_OUTPUT_RULE },
      },
    ],
  },
  {
    id: 'finance-analyst',
    title: 'Аналитик и сметчик',
    description: 'Проверяемые вычисления в WASI Sandbox и финансовый аудит результата.',
    icon: 'finance',
    accent: '#10B981',
    profiles: ['PROFILE_A_WASI', 'PROFILE_B_DOCS'],
    integrations: ['WASI Sandbox', 'Audit log'],
    artifacts: ['Смета', 'Audit report'],
    defaultGoal: 'Рассчитай смету по приложенным исходным данным, проверь формулы и подготовь отчёт с допущениями и источниками каждой цифры.',
    defaultModel: 'openai/gpt-4o-mini',
    roles: [
      {
        role: 'Финансовый аналитик', name: 'Nemo Finance', skills: ['data-analysis'],
        prompt: { role: 'Вычисляет смету в изолированном WASI-профиле.', tasks: 'Нормализуй входные строки, покажи формулы, промежуточные итоги, НДС и общий итог.', tone: 'Строго и проверяемо.', rules: VERIFIED_OUTPUT_RULE },
      },
      {
        role: 'Аудитор', name: 'Nemo Audit', skills: ['document-evidence-review', 'executive-reporting'],
        prompt: { role: 'Независимо проверяет расчёты и источники.', tasks: 'Пересчитай контрольные суммы, найди пропуски и выдай verdict с перечнем расхождений.', tone: 'Скептично и предметно.', rules: VERIFIED_OUTPUT_RULE },
      },
    ],
  },
  {
    id: 'support-assistant',
    title: 'AI-Ассистент поддержки',
    description: 'Grounded-ответы для Telegram и WhatsApp с эскалацией оператору.',
    icon: 'support',
    accent: '#F59E0B',
    profiles: ['PROFILE_A_WASI'],
    integrations: ['Telegram', 'WhatsApp'],
    artifacts: ['Reply draft', 'Escalation note'],
    defaultGoal: 'Подготовь ответы на обращения клиентов по базе знаний, отдели неизвестные случаи и передай их оператору без самостоятельных внешних отправок.',
    defaultModel: 'openai/gpt-4o-mini',
    roles: [
      {
        role: 'Support Operator', name: 'Nemo Support', skills: ['grounded-knowledge', 'task-sla-control', 'follow-up-drafting'],
        prompt: { role: 'Отвечает только по подтверждённой базе знаний.', tasks: 'Классифицируй обращения, подготовь краткие ответы и отдельный список эскалаций оператору.', tone: 'Спокойно, человечно, по делу.', rules: VERIFIED_OUTPUT_RULE },
      },
    ],
  },
]

export function guardedPresetRoles(
  preset: BusinessAgentPreset,
  options: { customPrompt: string; confidenceThreshold: number; requireCitations: boolean; requireApproval: boolean },
): BusinessAgentRole[] {
  const immutableGuard = [
    `Минимальный confidence для автономного вывода: ${options.confidenceThreshold.toFixed(2)}. Ниже порога — waiting_for_approval.`,
    options.requireCitations ? 'Для внешних фактов обязательны проверяемые источники/ссылки.' : 'Явно отделяй факты от предположений.',
    options.requireApproval ? 'Любой side effect требует Human-in-the-Loop approval.' : 'Не заявляй о side effect без подтверждения Runtime.',
  ].join(' ')

  return preset.roles.map((role) => ({
    ...role,
    prompt: {
      ...role.prompt,
      tasks: `${role.prompt.tasks}\n\nДополнительный бриф оператора: ${options.customPrompt.trim() || 'нет'}`,
      rules: `${role.prompt.rules} ${immutableGuard}`,
    },
  }))
}
