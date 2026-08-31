import { blankAgent } from '../store/useAgentStore'
import type { PlatformAgent, AgentPrompt } from '../types/platform'
import { isSupabaseEnabled } from './supabase'
import { saveDynamicTeam } from './dynamicTeams'

export type ChatEntityKind = 'team' | 'agent'

export interface ChatEntityMember {
  name: string
  role: string
  prompt: AgentPrompt
  skills: string[]
}

export interface ChatCreatedEntity {
  kind: ChatEntityKind
  id: string
  departmentId?: string
  name: string
  goal: string
  members: ChatEntityMember[]
}

type AgentWriter = (agent: PlatformAgent) => Promise<{ id?: string; error?: string }>
type AgentDeleter = (id: string) => Promise<{ error?: string }>

const teamIntent = /(?:созда(?:й|йте|ть)|собер(?:и|ите|ать)|create|build|yarat).{0,40}(?:команд|отдел|team|jamoa)/i
const soloIntent = /(?:созда(?:й|йте|ть)|сдела(?:й|йте|ть)|create|build|yarat).{0,40}(?:одиночн\w*\s+)?(?:агент|ассистент|бот|agent|assistant|bot)/i

export function classifyChatEntityIntent(prompt: string): ChatEntityKind | null {
  if (teamIntent.test(prompt)) return 'team'
  if (soloIntent.test(prompt)) return 'agent'
  return null
}

const prompt = (role: string, tasks: string): AgentPrompt => ({
  role,
  tasks,
  tone: 'Concise, evidence-based and action-oriented.',
  rules: 'Use only confirmed data. Never claim an external action succeeded without a tool result. Payments, publication, CRM writes and irreversible actions require human approval.',
})

const blueprints: Array<{ test: RegExp; name: string; members: ChatEntityMember[] }> = [
  {
    test: /маркет(?!плейс)|контент|reels|smm|marketing/i,
    name: 'Marketing Growth Team',
    members: [
      { name: 'Nemo Insight', role: 'Market Researcher', skills: ['research', 'grounding'], prompt: prompt('Market researcher', 'Find customer pains, competitors and evidence-backed content angles.') },
      { name: 'Nemo Story', role: 'Content Strategist', skills: ['copywriting', 'storyboard'], prompt: prompt('Content strategist', 'Turn approved insights into hooks, scripts, storyboards and calls to action.') },
      { name: 'Nemo Editorial', role: 'Editorial Reviewer', skills: ['qa', 'brand'], prompt: prompt('Editorial reviewer', 'Check claims, brand voice, clarity and publishing readiness.') },
    ],
  },
  {
    test: /бухгалтер|финанс|cash|cfo|finance|account/i,
    name: 'Finance & CFO Team',
    members: [
      { name: 'Nemo Ledger', role: 'Cash Flow Analyst', skills: ['cash-flow', 'grounding'], prompt: prompt('Cash flow analyst', 'Categorize inflow and outflow and cite the exact transaction source.') },
      { name: 'Nemo Impact', role: 'Expense & ROI Auditor', skills: ['roi', 'risk'], prompt: prompt('Expense and ROI auditor', 'Assess business impact, anomalies and inefficient costs without inventing attribution.') },
      { name: 'Nemo CFO', role: 'CFO Reviewer', skills: ['forecast', 'approval'], prompt: prompt('CFO reviewer', 'Prepare decision-ready summaries and route consequential actions for owner approval.') },
    ],
  },
  {
    test: /uzum|marketplace|маркетплейс|магазин|e-?commerce/i,
    name: 'Marketplace Growth Team',
    members: [
      { name: 'Nemo Assortment', role: 'Assortment Analyst', skills: ['sku', 'inventory'], prompt: prompt('Assortment analyst', 'Analyze sales, stock, returns and assortment gaps from marketplace exports.') },
      { name: 'Nemo Pricing', role: 'Pricing Researcher', skills: ['pricing', 'competitors'], prompt: prompt('Pricing researcher', 'Compare prices and competitors using traceable sources.') },
      { name: 'Nemo Marketplace Ops', role: 'Marketplace Operations Reviewer', skills: ['operations', 'qa'], prompt: prompt('Marketplace operations reviewer', 'Turn findings into prioritized actions and flag all store mutations for approval.') },
    ],
  },
  {
    test: /разработ|код|приложен|сайт|development|software|app/i,
    name: 'Product Development Team',
    members: [
      { name: 'Nemo Architect', role: 'Product Architect', skills: ['architecture', 'spec'], prompt: prompt('Product architect', 'Convert goals into data contracts, flows and implementation boundaries.') },
      { name: 'Nemo Builder', role: 'Software Engineer', skills: ['typescript', 'frontend'], prompt: prompt('Software engineer', 'Implement scoped, maintainable changes that preserve existing behavior.') },
      { name: 'Nemo Gate', role: 'QA & Security Reviewer', skills: ['testing', 'security'], prompt: prompt('QA and security reviewer', 'Validate tests, authorization, secret handling and release readiness.') },
    ],
  },
]

const genericMembers: ChatEntityMember[] = [
  { name: 'Nemo Research', role: 'Research Specialist', skills: ['research'], prompt: prompt('Research specialist', 'Collect and verify the facts required for the goal.') },
  { name: 'Nemo Operator', role: 'Execution Specialist', skills: ['execution'], prompt: prompt('Execution specialist', 'Produce the requested deliverable from verified inputs.') },
  { name: 'Nemo Review', role: 'Quality Reviewer', skills: ['qa'], prompt: prompt('Quality reviewer', 'Check completeness, safety and evidence before delivery.') },
]

function selectBlueprint(text: string) {
  return blueprints.find((item) => item.test.test(text)) ?? { name: 'AI Project Team', members: genericMembers }
}

function soloRole(text: string) {
  if (/копирай|content|writer|контент/i.test(text)) return { name: 'Nemo Copywriter', role: 'Copywriter', type: 'content' as const }
  if (/перевод|translate/i.test(text)) return { name: 'Nemo Translator', role: 'Personal Translator', type: 'chat' as const }
  if (/поддерж|support/i.test(text)) return { name: 'Nemo Support', role: 'Support Manager', type: 'support' as const }
  if (/код|разработ|developer/i.test(text)) return { name: 'Nemo Developer', role: 'Software Developer', type: 'coder' as const }
  return { name: 'Nemo Assistant', role: 'Personal AI Assistant', type: 'chat' as const }
}

export async function createEntityFromChat(text: string, addAgent: AgentWriter, deleteAgent?: AgentDeleter): Promise<ChatCreatedEntity> {
  const kind = classifyChatEntityIntent(text)
  if (!kind) throw new Error('creation intent not found')
  const goal = text.trim().slice(0, 500)

  if (kind === 'agent') {
    const solo = soloRole(text)
    const member: ChatEntityMember = { name: solo.name, role: solo.role, skills: ['focused-assistance'], prompt: prompt(solo.role, goal) }
    const result = await addAgent({ ...blankAgent(), name: solo.name, role: solo.role, type: solo.type, purpose: goal, niche: goal, status: 'active', skills: member.skills, actionPolicy: 'approval_required', prompt: member.prompt })
    if (!result.id) throw new Error(result.error || 'agent creation failed')
    return { kind, id: result.id, name: solo.name, goal, members: [member] }
  }

  const blueprint = selectBlueprint(text)
  if (isSupabaseEnabled) {
    const saved = await saveDynamicTeam(addAgent, {
      name: blueprint.name,
      goal,
      workflowMode: 'generic',
      specialists: blueprint.members.map((member) => ({ ...member, status: 'active' as const })),
    }, deleteAgent)
    if (!saved.agentId || !saved.departmentId) throw new Error(saved.error || 'team creation failed')
    return { kind, id: saved.agentId, departmentId: saved.departmentId, name: blueprint.name, goal, members: blueprint.members }
  }

  const leadResult = await addAgent({ ...blankAgent(), name: blueprint.name, role: 'Team Coordinator', type: 'workflow', purpose: goal, niche: goal, status: 'active', actionPolicy: 'approval_required', skills: blueprint.members.flatMap((member) => member.skills).slice(0, 6), prompt: prompt('Team coordinator', goal) })
  if (!leadResult.id) throw new Error(leadResult.error || 'team creation failed')
  const departmentId = `demo-${leadResult.id}`
  const entity = { kind, id: leadResult.id, departmentId, name: blueprint.name, goal, members: blueprint.members } satisfies ChatCreatedEntity
  if (typeof window !== 'undefined') window.localStorage.setItem(`nemo-team-blueprint:${leadResult.id}`, JSON.stringify(entity))
  return entity
}
