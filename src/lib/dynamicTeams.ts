import { supabase, isSupabaseEnabled } from './supabase'
import { blankAgent, useAgentStore } from '../store/useAgentStore'
import type { PlatformAgent, AgentPrompt } from '../types/platform'
import { notifyTeamRegistryChanged } from './teamRegistrySync'

const OPS_MODEL = 'openai/gpt-4o-mini'
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

type DeleteAgent = (id: string) => Promise<{ error?: string }>

interface SeedSub {
  name: string // must contain the specialist keyword ops-workflow matches on
  role: string
  prompt: AgentPrompt
}

// The 6 real specialist sub-agents of the Operations Team. `name` keywords
// (Payment Reminder / Admin Control / Meeting Analyst / Task Manager / Report) are
// what the `ops-workflow` edge function matches on to use each saved prompt.
export const OPERATIONS_SUBAGENTS: SeedSub[] = [
  {
    name: 'Operations Lead Agent',
    role: 'Operations Lead',
    prompt: {
      role: 'Operations lead coordinating an education-business back office.',
      tasks: 'Coordinate payment control, admin escalation, meeting analysis, task management and reports. Route work to the right specialist and escalate important issues to humans.',
      tone: 'Professional, concise, trustworthy.',
      rules: 'Delegate to specialists, verify quality, escalate real risks. Never invent facts.',
    },
  },
  {
    name: 'Payment Reminder Agent',
    role: 'Payment reminder specialist',
    prompt: {
      role: 'Payment reminder specialist for IT Academy.',
      tasks: 'Find unpaid or partial payment cases, write short respectful reminder messages, and assign a payment risk level and next action.',
      tone: 'Respectful, clear, helpful.',
      rules: 'Never be aggressive. Always give the student a concrete next step and deadline.',
    },
  },
  {
    name: 'Admin Control Agent',
    role: 'Admin escalation specialist',
    prompt: {
      role: 'Admin-control escalation specialist.',
      tasks: 'Create an escalation note for the responsible admin when a payment is overdue, the student does not respond, or risk is high.',
      tone: 'Direct, actionable.',
      rules: 'Escalate only real risks. Always name the responsible admin and the exact action.',
    },
  },
  {
    name: 'Meeting Analyst Agent',
    role: 'Meeting analyst',
    prompt: {
      role: 'Meeting analyst.',
      tasks: 'Turn a meeting or voice transcript into key decisions, action items, owners, deadlines and risks.',
      tone: 'Structured, precise.',
      rules: 'Extract only what is stated in the transcript. Do not invent owners or dates.',
    },
  },
  {
    name: 'Task Manager Agent',
    role: 'Task manager',
    prompt: {
      role: 'Task manager.',
      tasks: 'Turn action items into a clean task table with owner, deadline, priority and status (todo / in_progress / done / overdue).',
      tone: 'Organized, brief.',
      rules: 'Mark a task overdue when its deadline is before today.',
    },
  },
  {
    name: 'Report Agent',
    role: 'Manager report specialist',
    prompt: {
      role: 'Manager-report specialist.',
      tasks: 'Summarize who did what, what is late, what needs attention, and what should be escalated to humans.',
      tone: 'Executive, decision-ready.',
      rules: 'Be concise. Lead with the most important item.',
    },
  },
]

export interface SeedResult {
  agentId: string
  departmentId?: string
  error?: string
}

/**
 * Create the Operations Team as REAL rows: a workflow lead agent (in
 * `agents`) plus a department (`departments`) with the 6 specialist `sub_agents`.
 * Returns the ids so the caller can open the team hub at /app/teams/<agentId>.
 */
export async function createOperationsTeam(
  addAgent: (a: PlatformAgent) => Promise<{ id?: string; error?: string }>,
  deleteAgent?: DeleteAgent,
): Promise<SeedResult> {
  const lead = OPERATIONS_SUBAGENTS[0]
  return await saveDynamicTeam(addAgent, {
    name: 'Operations Team',
    niche: 'IT Academy education operations nemo-workflow:operations nemo-risk:standard',
    riskTier: 'standard',
    workflowMode: 'operations',
    goal: 'Automate routine operations: payment reminders, admin escalation, meeting-to-tasks and manager reports.',
    specialists: OPERATIONS_SUBAGENTS.map((specialist) => ({ ...specialist, model: OPS_MODEL, status: 'active' })),
    lead: { role: 'Operations Lead Agent', prompt: lead.prompt, model: OPS_MODEL },
  }, deleteAgent)
}

// Persist a team the manager created ON THE FLY for a goal: a workflow lead agent
// + a department + the dynamically-designed specialist sub-agents, so the created
// team becomes real, reusable rows.
export async function saveDynamicTeam(
  addAgent: (a: PlatformAgent) => Promise<{ id?: string; error?: string }>,
  opts: {
    name: string
    goal: string
    specialists: { role: string; name: string; prompt: AgentPrompt; skills?: string[]; model?: string; status?: 'active' | 'inactive' }[]
    workflowMode?: 'generic' | 'operations' | 'logistics'
    niche?: string
    riskTier?: 'standard' | 'regulated'
    actionPolicy?: PlatformAgent['actionPolicy']
    country?: string
    templateKey?: string
    lead?: { role?: string; prompt?: AgentPrompt; model?: string }
    leadForm?: PlatformAgent['leadForm']
  },
  deleteAgent?: DeleteAgent,
): Promise<SeedResult> {
  const base = blankAgent()
  const realNiche = opts.niche?.trim() || opts.goal.trim() || opts.name.trim() || 'AI Team'
  const nicheWithMarkers = (maxLength: number) => {
    const markers = [opts.workflowMode ? `nemo-workflow:${opts.workflowMode}` : '', `nemo-risk:${opts.riskTier ?? 'standard'}`].filter(Boolean).join(' ')
    const available = Math.max(1, maxLength - markers.length - 1)
    return `${realNiche.slice(0, available)} ${markers}`.trim()
  }
  const agent: PlatformAgent = {
    ...base,
    name: (opts.name || 'AI Team').slice(0, 60),
    type: 'workflow',
    role: opts.lead?.role?.trim() || 'Team lead',
    niche: nicheWithMarkers(120),
    riskTier: opts.riskTier ?? 'standard',
    actionPolicy: opts.actionPolicy ?? 'approval_required',
    country: opts.country,
    templateKey: opts.templateKey,
    purpose: opts.goal.slice(0, 500),
    model: opts.lead?.model?.trim() || OPS_MODEL,
    status: 'active',
    channels: [],
    skills: [...new Set(opts.specialists.flatMap((specialist) => specialist.skills ?? []))].slice(0, 6),
    prompt: opts.lead?.prompt ?? {
      role: 'Team lead coordinating specialists to achieve the goal.',
      tasks: opts.goal.slice(0, 700),
      tone: 'Professional, concise.',
      rules: 'Delegate to specialists, verify quality, and follow every safety limit in the goal. Never invent facts or claim an external action succeeded without a confirmed tool result. Payments, refunds, contracts, bookings, consequential decisions, and irreversible changes require human approval.',
    },
    leadForm: opts.leadForm ?? base.leadForm,
  }
  void addAgent
  void deleteAgent
  if (!isSupabaseEnabled || !supabase) return { agentId: '', error: 'could not create team: live backend is required' }
  if (opts.specialists.length < 2 || opts.specialists.length > 6) return { agentId: '', error: 'a team requires 2 to 6 specialists' }

  const { data, error } = await supabase.rpc('create_agent_team', {
    p_manager: {
      name: agent.name,
      avatar_color: agent.avatarColor,
      prompt: agent.prompt,
      model: agent.model,
      temperature: agent.temperature,
      timezone: agent.timezone,
      schedule: agent.schedule,
      work_start: agent.workStart,
      work_end: agent.workEnd,
      default_lang: agent.language,
      country: agent.country,
      purpose: agent.purpose,
      niche: agent.niche,
      risk_tier: agent.riskTier,
      action_policy: agent.actionPolicy,
      template_key: agent.templateKey,
      lead_form: agent.leadForm,
      skills: agent.skills ?? [],
    },
    p_department: { name: agent.name, niche: agent.niche },
    p_specialists: opts.specialists.slice(0, 6).map((specialist) => ({
      role: specialist.role,
      name: specialist.name,
      prompt: specialist.prompt,
      skills: Array.isArray(specialist.skills) ? specialist.skills.slice(0, 6) : [],
      model: specialist.model?.trim() || OPS_MODEL,
      status: specialist.status === 'inactive' ? 'paused' : 'active',
    })),
  })
  const result = data as { agent_id?: string; department_id?: string } | null
  if (error || !result?.agent_id || !result.department_id || !UUID_RE.test(result.agent_id) || !UUID_RE.test(result.department_id)) {
    return { agentId: '', error: error?.message ?? 'atomic team creation failed' }
  }
  await useAgentStore.getState().hydrate({ forceProfile: true })
  notifyTeamRegistryChanged({ agentId: result.agent_id, departmentId: result.department_id })
  return { agentId: result.agent_id, departmentId: result.department_id }
}

// Sample inputs so the demo runs with realistic data out of the box.
export const SAMPLE_PAYMENT = `Aziza Karimova, IELTS, 1 200 000 UZS, due 2026-07-05, unpaid, admin: Dilshod
Javohir Tursunov, Frontend Bootcamp, 2 400 000 UZS, due 2026-07-03, unpaid, admin: Madina
Nilufar Saidova, SMM, 900 000 UZS, due 2026-07-10, partial, admin: Dilshod`

export const SAMPLE_MEETING = `Meeting transcript: July operations sync. Decisions: launch IELTS evening group next Monday. Madina owns parent follow-up by 2026-07-04. Dilshod must call unpaid Frontend students by 2026-07-05. Content team prepares Telegram post for SMM by 2026-07-06. Mentor quality report is overdue and should be reviewed by Akmal this week.`

export const SAMPLE_RETENTION = `Ученики (курс IELTS), на сегодня:
Азиз Каримов, @aziz_k — последнее занятие 15 июня, июль НЕ оплатил.
Мадина Юсупова, @madina_y — ходит регулярно, июль оплачен.
Ботир Алиев, @botir — пропустил 2 недели подряд, оплата до 30 июня.
Нигора Саидова, +998901112233 — последнее занятие 20 мая, с июня не оплачивала.
Камола Исмоилова, @kamola_i — была 3 дня назад, но написала что думает уходить, июль не оплатила.`
