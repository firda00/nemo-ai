import type { BusinessAgentRole } from './businessAgentPresets'

export type DurableTeamTemplateId = 'sales-department' | 'content-marketing' | 'customer-support'
export type TemplateLanguage = 'ru' | 'uz' | 'en'

export interface DurableTeamTemplate {
  id: DurableTeamTemplateId
  version: '1.0'
  title: Record<TemplateLanguage, string>
  description: Record<TemplateLanguage, string>
  goal: Record<TemplateLanguage, string>
  routingProtocol: 'sequential' | 'hierarchical' | 'conditional'
  roles: BusinessAgentRole[]
}

const VERIFIED_RULES = [
  'Use only tenant-approved evidence and connected tools.',
  'Never invent prices, customers, dates, metrics, links, tool results, or completed actions.',
  'Return evidence references for external facts; when evidence is missing, ask or escalate.',
  'Never expose secrets, credentials, private scratchpads, or chain-of-thought.',
  'External side effects require Runtime policy and Human-in-the-Loop approval.',
].join(' ')

const role = (value: Omit<BusinessAgentRole, 'prompt'> & { task: string; tone: string }): BusinessAgentRole => ({
  role: value.role,
  name: value.name,
  skills: value.skills,
  prompt: { role: value.role, tasks: value.task, tone: value.tone, rules: VERIFIED_RULES },
})

export const DURABLE_TEAM_TEMPLATES: readonly DurableTeamTemplate[] = Object.freeze([
  {
    id: 'sales-department', version: '1.0', routingProtocol: 'sequential',
    title: { ru: 'Отдел продаж', uz: 'Sotuv bo‘limi', en: 'Sales department' },
    description: { ru: 'Квалификация → предложение → CRM handoff.', uz: 'Saralash → taklif → CRM handoff.', en: 'Qualification → proposal → CRM handoff.' },
    goal: {
      ru: 'Создай отдел продаж: квалифицируй лидов по подтверждённым данным, подготовь предложение и передай запись в CRM только после согласования.',
      uz: 'Tasdiqlangan maʼlumotlar asosida leadlarni saralash, taklif tayyorlash va tasdiqdan keyin CRMga uzatish uchun sotuv bo‘limini yarat.',
      en: 'Create a sales department that qualifies leads from verified data, prepares proposals, and hands off to CRM only after approval.',
    },
    roles: [
      role({ role: 'Lead Qualifier', name: 'Nemo Qualifier', skills: ['structured-intake', 'grounded-knowledge'], task: 'Extract need, budget, timing and missing facts without guessing.', tone: 'Concise and respectful.' }),
      role({ role: 'Proposal Specialist', name: 'Nemo Proposal', skills: ['commercial-comparison', 'document-evidence-review'], task: 'Prepare an evidence-backed offer using approved prices and terms.', tone: 'Clear business language.' }),
      role({ role: 'CRM Handoff Reviewer', name: 'Nemo CRM Review', skills: ['lead-crm-handoff', 'content-production-review'], task: 'Validate the lead record and request approval before any CRM write.', tone: 'Strict and auditable.' }),
    ],
  },
  {
    id: 'content-marketing', version: '1.0', routingProtocol: 'hierarchical',
    title: { ru: 'Контент-маркетинг', uz: 'Kontent marketing', en: 'Content marketing' },
    description: { ru: 'Исследование → контент → редактура и approval.', uz: 'Tadqiqot → kontent → tahrir va approval.', en: 'Research → content → editorial approval.' },
    goal: {
      ru: 'Создай контент-команду: исследуй подтверждённые источники, подготовь контент-план и черновики, затем отправь результат редактору на согласование.',
      uz: 'Tasdiqlangan manbalarni o‘rganish, kontent-reja va qoralamalar tayyorlash, so‘ng tahrirchiga tasdiqlash uchun yuboradigan jamoa yarat.',
      en: 'Create a content team that researches verified sources, prepares a plan and drafts, then routes them to an editor for approval.',
    },
    roles: [
      role({ role: 'Research Analyst', name: 'Nemo Research', skills: ['research', 'document-evidence-review'], task: 'Produce a compact evidence pack with source references and uncertainty.', tone: 'Analytical and precise.' }),
      role({ role: 'Content Writer', name: 'Nemo Writer', skills: ['social', 'content'], task: 'Create drafts only from the approved brief and evidence pack.', tone: 'Friendly, specific, and free of generic AI phrasing.' }),
      role({ role: 'Editorial Reviewer', name: 'Nemo Editor', skills: ['content-production-review'], task: 'Reject unsupported claims and send publishable work to human approval.', tone: 'Direct and constructive.' }),
    ],
  },
  {
    id: 'customer-support', version: '1.0', routingProtocol: 'conditional',
    title: { ru: 'Клиентский сервис', uz: 'Mijozlar yordami', en: 'Customer support' },
    description: { ru: 'Triage → база знаний → оператор.', uz: 'Triage → bilim bazasi → operator.', en: 'Triage → knowledge → human operator.' },
    goal: {
      ru: 'Создай службу поддержки: классифицируй обращения, отвечай только по подтверждённой базе знаний и передавай неизвестные или рискованные случаи оператору.',
      uz: 'Murojaatlarni tasniflash, faqat tasdiqlangan bilim bazasidan javob berish va nomaʼlum holatlarni operatorga uzatish uchun yordam jamoasi yarat.',
      en: 'Create a support team that classifies requests, answers only from approved knowledge, and escalates unknown or risky cases to a human.',
    },
    roles: [
      role({ role: 'Support Triage', name: 'Nemo Triage', skills: ['structured-intake', 'task-sla-control'], task: 'Classify intent, urgency and SLA without proposing unsupported answers.', tone: 'Calm and concise.' }),
      role({ role: 'Knowledge Specialist', name: 'Nemo Knowledge', skills: ['grounded-knowledge'], task: 'Answer only when approved knowledge contains sufficient evidence.', tone: 'Helpful and transparent.' }),
      role({ role: 'Escalation Coordinator', name: 'Nemo Escalation', skills: ['follow-up-drafting'], task: 'Prepare a compact human handoff with facts, evidence and unresolved questions.', tone: 'Operational and precise.' }),
    ],
  },
])

export function getDurableTeamTemplate(id: DurableTeamTemplateId): DurableTeamTemplate {
  const template = DURABLE_TEAM_TEMPLATES.find((item) => item.id === id)
  if (!template) throw new Error('TEAM_TEMPLATE_NOT_FOUND')
  return template
}
