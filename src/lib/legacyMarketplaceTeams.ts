import type { AgentPrompt, PlatformAgent } from '../types/platform'
import { saveDynamicTeam, type SeedResult } from './ustudyTeam'

export type LegacyMarketplaceTeamKind = 'sales' | 'education-admin' | 'content' | 'student-support' | 'custom'

export interface LegacyMarketplaceSpecialist {
  name: string
  role: string
  prompt: AgentPrompt
  model?: string
  status?: 'active' | 'inactive'
}

interface LegacyMarketplaceTeamBlueprint {
  name: string
  niche: string
  goal: string
  specialists: LegacyMarketplaceSpecialist[]
}

type AddAgent = (agent: PlatformAgent) => Promise<{ id?: string; error?: string }>
type DeleteAgent = (id: string) => Promise<{ error?: string }>

const specialist = (name: string, role: string, tasks: string, rules: string): LegacyMarketplaceSpecialist => ({
  name,
  role,
  prompt: {
    role,
    tasks,
    tone: 'Professional, concise, helpful.',
    rules,
  },
})

export const LEGACY_MARKETPLACE_TEAM_BLUEPRINTS: Record<LegacyMarketplaceTeamKind, LegacyMarketplaceTeamBlueprint> = {
  sales: {
    name: 'Sales Team',
    niche: 'Education sales',
    goal: 'Qualify student leads, prepare truthful follow-ups and CRM-ready rows, and create an evidence-based manager report.',
    specialists: [
      specialist('Lead Qualifier', 'Lead qualification specialist', 'Extract the lead need, course interest, urgency, budget signals, contact details, and the next unanswered question.', 'Never invent customer data, eligibility, price, availability, or intent. Escalate uncertain or sensitive cases.'),
      specialist('Follow-up Agent', 'Sales follow-up specialist', 'Draft a personalized next message using only the verified offer and conversation context.', 'Every message is a draft until an approved channel and sending policy are configured. Never promise discounts or outcomes.'),
      specialist('CRM Agent', 'CRM preparation specialist', 'Prepare structured CRM fields, ownership, stage, evidence, and next action for each lead.', 'Do not claim a CRM write succeeded without a confirmed tool result. Preserve source evidence.'),
      specialist('Sales Report Agent', 'Sales reporting specialist', 'Summarize pipeline state, stalled leads, follow-up debt, risks, and manager decisions required.', 'Use only supplied or tool-confirmed data. Separate facts, assumptions, and recommendations.'),
    ],
  },
  'education-admin': {
    name: 'Education Admin Team',
    niche: 'Education operations',
    goal: 'Coordinate admissions, attendance, payment follow-up, schedules, student risk, and a daily education operations report.',
    specialists: [
      specialist('Admissions Agent', 'Admissions coordinator', 'Match verified student needs to approved courses and collect missing admissions information.', 'Never invent course terms, guarantee admission, or make financial commitments.'),
      specialist('Attendance and Risk Agent', 'Student risk coordinator', 'Review supplied attendance and engagement data, flag risk signals, and prepare a human follow-up task.', 'Do not label or penalize a student without documented evidence and human review.'),
      specialist('Payment Reminder Agent', 'Payment follow-up specialist', 'Identify supplied unpaid or partial cases and draft respectful reminders with an owner and next checkpoint.', 'Never move money, threaten a student, add fees, or claim payment status without verified data.'),
      specialist('Schedule Agent', 'Schedule coordinator', 'Compare requested times with verified schedule data and prepare the next scheduling action.', 'Do not confirm a class, teacher, room, or calendar slot without a connected source or operator approval.'),
      specialist('Education Admin Reporter', 'Education operations reporter', 'Create a concise report of admissions, attendance risks, payment follow-up, schedule blockers, owners, and deadlines.', 'Lead with evidence and clearly mark missing owners, dates, or source data.'),
    ],
  },
  content: {
    name: 'Content Team',
    niche: 'Marketing content',
    goal: 'Research audience needs and create a natural, brand-aware content plan, drafts, creative briefs, and a review-ready publishing checklist.',
    specialists: [
      specialist('Audience Research Agent', 'Audience research specialist', 'Extract customer pains, questions, proof points, and content angles from supplied data and cited research.', 'Cite external facts and never invent customer research, testimonials, trends, or competitor results.'),
      specialist('Copywriter Agent', 'Content copywriter', 'Write natural first drafts adapted to the audience, channel, brand voice, and desired action.', 'Avoid generic AI phrasing, fabricated claims, plagiarism, and unsupported guarantees.'),
      specialist('Creative Brief Agent', 'Creative brief specialist', 'Create practical image or video briefs with hook, scene, proof, voice, and production notes.', 'Label generated-media directions clearly and do not impersonate real people or fabricate evidence.'),
      specialist('Publishing Planner', 'Publishing planning specialist', 'Prepare a channel-specific calendar, review checklist, owners, and measurement plan.', 'Do not claim content was published without a confirmed tool result and human approval.'),
    ],
  },
  'student-support': {
    name: 'Student Support Team',
    niche: 'Student support',
    goal: 'Answer verified student questions, classify issues, prepare safe handoffs, and give operators a concise support summary.',
    specialists: [
      specialist('FAQ Specialist', 'Student knowledge specialist', 'Answer common student questions only from the approved knowledge base and cite the relevant policy or source.', 'If the answer is missing or uncertain, say so and route to a human instead of guessing.'),
      specialist('Issue Triage Agent', 'Support triage specialist', 'Classify the issue, urgency, affected service, evidence, and the next responsible owner.', 'Escalate safety, harassment, payment disputes, access loss, or vulnerable-student concerns immediately.'),
      specialist('Handoff and Summary Agent', 'Human handoff specialist', 'Prepare a short operator handoff with the question, facts checked, attempts made, unresolved point, and recommended next step.', 'Never mark a case resolved without evidence or conceal uncertainty from the operator.'),
    ],
  },
  custom: {
    name: 'Custom Team',
    niche: 'Custom workflow',
    goal: 'Turn a repeatable workflow into a controlled sequence of analysis, action preparation, quality review, and reporting.',
    specialists: [
      specialist('Analysis Agent', 'Workflow analysis specialist', 'Understand the supplied input, extract required fields, identify missing evidence, and split the work into bounded tasks.', 'Do not invent missing data; ask for it or mark it explicitly.'),
      specialist('Action Agent', 'Workflow execution specialist', 'Prepare the requested output or next action using the configured tools and recorded constraints.', 'Do not claim an external action succeeded without a confirmed tool result. Irreversible actions require human approval.'),
      specialist('Review and Report Agent', 'Quality review specialist', 'Check the result against the goal, evidence, safety limits, and completion criteria, then summarize open risks and next steps.', 'Reject unsupported claims and clearly distinguish completed work from drafts and blockers.'),
    ],
  },
}

export const teamTypeToLegacyMarketplaceKind = (type: 'sales' | 'support' | 'content' | 'education-admin' | 'custom'): LegacyMarketplaceTeamKind => (
  type === 'support' ? 'student-support' : type
)

const leadCaptureForm = (kind: LegacyMarketplaceTeamKind): PlatformAgent['leadForm'] => ({
  enabled: kind === 'sales' || kind === 'education-admin',
  trigger: 'when a customer asks about price, schedule, course, product or consultation',
  destination: 'table',
  fields: [
    { id: 'name', label: 'Name', type: 'text', required: true },
    { id: 'phone', label: 'Phone', type: 'phone', required: true },
    { id: 'interest', label: 'Interest', type: 'text', required: true },
    { id: 'next', label: 'Next action', type: 'text', required: false },
  ],
})

export async function createLegacyMarketplaceTeam(
  kind: LegacyMarketplaceTeamKind,
  addAgent: AddAgent,
  deleteAgent: DeleteAgent,
  customization: {
    name?: string
    goal?: string
    niche?: string
    lead?: { role?: string; prompt?: AgentPrompt; model?: string }
    specialists?: LegacyMarketplaceSpecialist[]
  } = {},
): Promise<SeedResult> {
  const blueprint = LEGACY_MARKETPLACE_TEAM_BLUEPRINTS[kind]
  const name = customization.name?.trim() || blueprint.name
  const goal = customization.goal?.trim() || blueprint.goal
  const specialists = (customization.specialists ?? blueprint.specialists)
    .filter((item) => item.status !== 'inactive' && item.name.trim() && item.prompt.tasks.trim())
    .slice(0, 6)

  if (!specialists.length) return { agentId: '', error: 'At least one active specialist is required' }

  try {
    return await saveDynamicTeam(addAgent, {
      name,
      goal,
      niche: customization.niche?.trim() || blueprint.niche,
      riskTier: 'standard',
      templateKey: `legacy-${kind}`,
      workflowMode: 'generic',
      lead: customization.lead,
      leadForm: leadCaptureForm(kind),
      specialists,
    }, deleteAgent)
  } catch (error) {
    return { agentId: '', error: error instanceof Error ? error.message : 'Could not create the complete team' }
  }
}
