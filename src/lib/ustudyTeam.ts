import { supabase, isSupabaseEnabled } from './supabase'
import { blankAgent } from '../store/useAgentStore'
import type { PlatformAgent, AgentPrompt } from '../types/platform'

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
export async function createUstudyOperationsTeam(
  addAgent: (a: PlatformAgent) => Promise<{ id?: string; error?: string }>,
  deleteAgent?: DeleteAgent,
): Promise<SeedResult> {
  const lead = OPERATIONS_SUBAGENTS[0]
  const base = blankAgent()
  const agent: PlatformAgent = {
    ...base,
    name: 'Operations Team',
    type: 'workflow',
    role: 'Operations Lead Agent',
    niche: 'IT Academy education operations nemo-workflow:operations nemo-risk:standard',
    riskTier: 'standard',
    purpose: 'Automate routine operations: payment reminders, admin escalation, meeting-to-tasks and manager reports.',
    model: OPS_MODEL,
    status: 'active',
    channels: ['telegram', 'widget'],
    prompt: lead.prompt,
  }

  const res = await addAgent(agent)
  if (res.error || !res.id) return { agentId: '', error: res.error ?? 'could not create team agent' }
  const agentId = res.id

  const cleanupLead = async (cause: string): Promise<SeedResult> => {
    if (!deleteAgent) return { agentId, error: `${cause}; rollback unavailable: deleteAgent callback is required` }
    const cleanupError = (await deleteAgent(agentId)).error
    return cleanupError
      ? { agentId, error: `${cause}; rollback failed: agent cleanup: ${cleanupError}` }
      : { agentId: '', error: cause }
  }

  if (!isSupabaseEnabled || !supabase) return await cleanupLead('could not create Operations Team: live backend is required')
  if (!UUID_RE.test(agentId)) return await cleanupLead('could not create Operations Team: persisted lead id is not a valid UUID')

  const db = supabase
  const rollback = async (cause: string, departmentId?: string): Promise<SeedResult> => {
    const errors: string[] = []
    if (departmentId) {
      const { error } = await db.from('departments').delete().eq('id', departmentId)
      if (error) errors.push(`department cleanup: ${error.message}`)
    }
    if (deleteAgent) {
      const error = (await deleteAgent(agentId)).error
      if (error) errors.push(`agent cleanup: ${error}`)
    } else {
      const { error } = await db.from('agents').delete().eq('id', agentId)
      if (error) errors.push(`agent cleanup: ${error.message}`)
    }
    return errors.length
      ? { agentId, departmentId, error: `${cause}; rollback failed: ${errors.join('; ')}` }
      : { agentId: '', error: cause }
  }

  const { data: dep, error: depErr } = await db
    .from('departments')
    .insert({ main_agent_id: agentId, name: 'Operations', niche: 'IT Academy education operations nemo-workflow:operations nemo-risk:standard' })
    .select('id')
    .single()
  if (depErr || !dep) return await rollback(depErr?.message ?? 'could not create Operations department')

  const rows = OPERATIONS_SUBAGENTS.map((s) => ({
    department_id: dep.id,
    role: s.role,
    name: s.name,
    prompt: s.prompt,
    model: OPS_MODEL,
    status: 'active',
  }))
  const { error: subErr } = await db.from('sub_agents').insert(rows)
  if (subErr) return await rollback(subErr.message, dep.id)

  return { agentId, departmentId: dep.id }
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
  let res: { id?: string; error?: string }
  try {
    res = await addAgent(agent)
  } catch (error) {
    return { agentId: '', error: error instanceof Error ? error.message : 'could not create team agent' }
  }
  if (res.error || !res.id) return { agentId: '', error: res.error ?? 'could not create team agent' }
  const agentId = res.id
  const cleanupLead = async (cause: string): Promise<SeedResult> => {
    if (!deleteAgent) return { agentId, error: `${cause}; rollback unavailable: deleteAgent callback is required` }
    let cleanupError: string | undefined
    try {
      cleanupError = (await deleteAgent(agentId)).error
    } catch (error) {
      cleanupError = error instanceof Error ? error.message : 'unknown agent cleanup error'
    }
    return cleanupError
      ? { agentId, error: `${cause}; rollback failed: agent cleanup: ${cleanupError}` }
      : { agentId: '', error: cause }
  }
  if (!isSupabaseEnabled || !supabase) return await cleanupLead('could not create team: live backend is required')
  if (!UUID_RE.test(agentId)) return await cleanupLead('could not create team: persisted lead id is not a valid UUID')
  const db = supabase
  const rollback = async (departmentId?: string) => {
    const errors: string[] = []
    if (departmentId) {
      const { error } = await db.from('departments').delete().eq('id', departmentId)
      if (error) errors.push(`department cleanup: ${error.message}`)
    }
    if (deleteAgent) {
      try {
        const error = (await deleteAgent(agentId)).error
        if (error) errors.push(`agent cleanup: ${error}`)
      } catch (error) {
        errors.push(`agent cleanup: ${error instanceof Error ? error.message : 'unknown error'}`)
      }
    } else {
      const { error } = await db.from('agents').delete().eq('id', agentId)
      if (error) errors.push(`agent cleanup: ${error.message}`)
    }
    return errors.length ? errors.join('; ') : undefined
  }

  const { data: dep, error: depErr } = await supabase
    .from('departments')
    .insert({
      main_agent_id: agentId,
      name: (opts.name || 'AI Team').slice(0, 60),
      niche: nicheWithMarkers(120),
    })
    .select('id')
    .single()
  if (depErr || !dep) {
    const cause = depErr?.message ?? 'could not create department'
    const rollbackError = await rollback()
    return { agentId: rollbackError ? agentId : '', error: rollbackError ? `${cause}; rollback failed: ${rollbackError}` : cause }
  }

  const rows = opts.specialists.slice(0, 6).map((s) => ({
    department_id: dep.id,
    role: s.role,
    name: s.name,
    prompt: s.prompt,
    skills: Array.isArray(s.skills) ? s.skills.slice(0, 6) : [],
    model: s.model?.trim() || OPS_MODEL,
    status: s.status === 'inactive' ? 'inactive' : 'active',
  }))
  const { error: subErr } = await supabase.from('sub_agents').insert(rows)
  if (subErr) {
    const rollbackError = await rollback(dep.id)
    return { agentId: rollbackError ? agentId : '', departmentId: rollbackError ? dep.id : undefined, error: rollbackError ? `${subErr.message}; rollback failed: ${rollbackError}` : subErr.message }
  }
  return { agentId, departmentId: dep.id }
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
