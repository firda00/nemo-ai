import { useEffect, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { AlertCircle, CheckCircle2, Copy, Download, Loader2, Play, Plus, Save, Table2 } from 'lucide-react'
import { Button } from '../../components/ui/Button'
import { useAgentStore } from '../../store/useAgentStore'
import { supabase } from '../../lib/supabase'
import { useBackendStatus } from '../../hooks/useBackendStatus'
import { createLegacyMarketplaceTeam, LEGACY_MARKETPLACE_TEAM_BLUEPRINTS, teamTypeToLegacyMarketplaceKind } from '../../lib/legacyMarketplaceTeams'

type LeadStatus = 'hot' | 'warm' | 'cold'
type TeamType = 'sales' | 'support' | 'content' | 'education-admin' | 'custom'
type RunStepState = 'pending' | 'running' | 'done' | 'error'
type RunSource = 'live' | 'local'
type WorkflowType = 'lead-qualification' | 'payment-control' | 'meeting-to-tasks' | 'weekly-follow-up' | 'manager-report'
type ResultTab = 'table' | 'followups' | 'crm' | 'report' | 'trace' | 'payments' | 'escalations' | 'tasks' | 'decisions' | 'weekly'
type ExecutionMode = 'not_run' | 'live_success' | 'live_failed' | 'local_simulation'

interface LeadResult {
  name: string
  phone: string
  interest: string
  budget: string
  status: LeadStatus
  course: string
  nextStep: string
  followUp: string
}

interface WorkflowResult {
  source: RunSource
  leads: LeadResult[]
  crmRows: Array<Record<string, string>>
  nextActions: string[]
  dailyReport: string
  followUps: string[]
  paymentReminders?: string[]
  adminEscalations?: string[]
  meetingTasks?: Array<{ task: string; owner: string; deadline: string; priority: string; status: string }>
  keyDecisions?: string[]
  agentTrace?: string[]
  savedAt: string
}

interface AgentDef { name: string; role: string; desc: string }
interface RunStep { label: string; desc: string; state: RunStepState }
interface TeamAgentDraft extends AgentDef { prompt: string; model: string; status: 'active' | 'inactive' }
interface OrchestrateResponse { ok?: boolean; plan?: string; steps?: Array<{ role: string; task: string }>; output?: string; sources?: string[]; result?: string; error?: string; detail?: string }

const fieldCls = 'w-full rounded-xl border border-white/10 bg-black/20 px-3 py-2 text-sm text-text outline-none placeholder:text-muted focus:border-violet/50'
const resultKey = 'nemo-workflow-result-v2'
const sampleLeads = `Aziza, +998901112233, wants IELTS course, asked price, ready this week
Javohir, +998931234567, interested in Frontend bootcamp, no budget yet, wants evening group
Madina, +998977778899, asked about kids robotics, parent, wants Saturday schedule
Sardor, +998909998877, asked once about Python, not replying, budget unknown
Nilufar, +998946661122, wants SMM course for job, asked installment plan`

const samplePayment = `Aziza Karimova, IELTS, 1 200 000 UZS, due 2026-07-05, unpaid, admin: Dilshod
Javohir Tursunov, Frontend Bootcamp, 2 400 000 UZS, due 2026-07-03, unpaid, admin: Madina
Nilufar Saidova, SMM, 900 000 UZS, due 2026-07-10, partial, admin: Dilshod`

const sampleMeeting = `Meeting transcript: July operations sync. Decisions: launch IELTS evening group next Monday. Madina owns parent follow-up by July 4. Dilshod must call unpaid Frontend students by July 5. Content team prepares Telegram post for SMM by July 6. Mentor quality report is overdue and should be reviewed by Akmal this week.`

const workflowOptions: { id: WorkflowType; label: string; desc: string }[] = [
  { id: 'lead-qualification', label: 'Lead qualification', desc: 'Qualify student leads, create follow-ups, CRM rows and manager report.' },
  { id: 'payment-control', label: 'Payment control', desc: 'Generate student payment reminders and admin escalations.' },
  { id: 'meeting-to-tasks', label: 'Meeting to tasks', desc: 'Convert meeting transcript into decisions, owners, deadlines and task table.' },
  { id: 'weekly-follow-up', label: 'Weekly task follow-up', desc: 'Summarize overdue and in-progress tasks for managers.' },
  { id: 'manager-report', label: 'Manager report', desc: 'Create daily/weekly operations report from structured inputs.' },
]

const teamTypes: { id: TeamType; title: string; desc: string }[] = [
  { id: 'sales', title: 'Sales Team', desc: 'Qualify leads, write follow-ups, prepare CRM rows and manager reports.' },
  { id: 'support', title: 'Support Team', desc: 'Answer FAQs, triage issues, escalate hard cases and summarize tickets.' },
  { id: 'content', title: 'Content Team', desc: 'Research topics, write content, create briefs and publishing plans.' },
  { id: 'education-admin', title: 'Education Admin Team', desc: 'Handle admissions, schedules, course matching and parent/student questions.' },
  { id: 'custom', title: 'Custom Team', desc: 'Describe any workflow and let Nemo suggest specialist agents.' },
]

const runStepsTemplate: RunStep[] = [
  { label: 'Team Lead routing task', desc: 'Reads the input and assigns work to Specialist Agents.', state: 'pending' },
  { label: 'Lead Qualifier analyzing leads', desc: 'Extracts intent, urgency, budget, course fit and readiness.', state: 'pending' },
  { label: 'Follow-up Agent writing replies', desc: 'Creates personalized next messages for each lead.', state: 'pending' },
  { label: 'CRM Agent preparing rows', desc: 'Formats CRM-ready rows and manager next actions.', state: 'pending' },
  { label: 'Report Agent creating summary', desc: 'Creates the final daily manager report.', state: 'pending' },
]

const operationsSteps: RunStep[] = [
  { label: 'Operations Lead analyzing request', desc: 'Routes the operations task to the right Specialist Agents.', state: 'pending' },
  { label: 'Payment Reminder checking payment status', desc: 'Finds unpaid students and prepares reminder messages.', state: 'pending' },
  { label: 'Admin Control preparing escalation', desc: 'Creates admin escalation note for overdue or no-response cases.', state: 'pending' },
  { label: 'Meeting Analyst extracting tasks', desc: 'Extracts decisions, tasks, owners and deadlines from meeting text.', state: 'pending' },
  { label: 'Task Manager building task table', desc: 'Builds a task table with status, priority and ownership.', state: 'pending' },
  { label: 'Report Agent creating summary', desc: 'Creates manager report and follow-up priorities.', state: 'pending' },
]

function suggestAgents(type: TeamType, goal: string): AgentDef[] {
  const lead = { name: 'Team Lead Agent', role: 'Team Lead Agent', desc: `Routes work, checks quality, and owns the goal: ${goal || 'business workflow automation'}.` }
  const blueprint = LEGACY_MARKETPLACE_TEAM_BLUEPRINTS[teamTypeToLegacyMarketplaceKind(type)]
  return [lead, ...blueprint.specialists.map((item) => ({
    name: item.name,
    role: item.role,
    desc: item.prompt.tasks,
  }))]
}

function toTeamAgentDraft(agent: AgentDef): TeamAgentDraft {
  return { ...agent, prompt: agent.desc, model: 'google/gemma-4-31b-it:free', status: 'active' }
}

function operationsAgents(): TeamAgentDraft[] {
  return [
    { name: 'Operations Lead Agent', role: 'Team Lead Agent', desc: 'Coordinates operations workflow and routes work to Specialist Agents.', prompt: 'Coordinate payment control, admin escalation, meeting analysis, task management and reports. Escalate important issues to humans.', model: 'google/gemma-4-31b-it:free', status: 'active' },
    { name: 'Payment Reminder Agent', role: 'Specialist Agent', desc: 'Checks unpaid students, generates payment reminders and marks payment risk.', prompt: 'Find unpaid/partial payment cases, write respectful reminders, assign risk level and next action.', model: 'google/gemma-4-31b-it:free', status: 'active' },
    { name: 'Admin Control Agent', role: 'Specialist Agent', desc: 'Alerts admin if payment is overdue or no student response.', prompt: 'Create escalation note for responsible admin when payment is overdue, student does not respond, or risk is high.', model: 'google/gemma-4-31b-it:free', status: 'active' },
    { name: 'Meeting Analyst Agent', role: 'Specialist Agent', desc: 'Analyzes meeting transcript and extracts decisions, tasks, owners and deadlines.', prompt: 'Turn meeting or voice transcript into key decisions, action items, owners, deadlines and risks.', model: 'google/gemma-4-31b-it:free', status: 'active' },
    { name: 'Task Manager Agent', role: 'Specialist Agent', desc: 'Turns decisions into task table and tracks status.', prompt: 'Create task table with owner, deadline, priority and status: not started, in progress, done, overdue.', model: 'google/gemma-4-31b-it:free', status: 'active' },
    { name: 'Report Agent', role: 'Specialist Agent', desc: 'Creates daily/weekly manager report.', prompt: 'Summarize who did what, what is late, what needs attention, and what should be escalated to humans.', model: 'google/gemma-4-31b-it:free', status: 'active' },
  ]
}

function parseLead(line: string, index: number): LeadResult {
  const parts = line.split(',').map((x) => x.trim()).filter(Boolean)
  const raw = line.toLowerCase()
  const name = parts[0] || `Lead ${index + 1}`
  const phone = parts.find((p) => /\+?\d{7,}/.test(p)) || '+998 -- --- -- --'
  const interest = parts.find((p) => /course|bootcamp|ielts|robotics|python|frontend|smm|курс|english|kids/i.test(p)) || parts[2] || 'Education program'
  const budget = /installment|рассроч|budget|price|цена|asked price/.test(raw) ? 'Needs pricing/installment' : /no budget|unknown/.test(raw) ? 'Unknown' : 'Likely available'
  const status: LeadStatus = /ready|this week|asked price|installment|parent|schedule/.test(raw) ? 'hot' : /interested|wants|evening|asked/.test(raw) ? 'warm' : 'cold'
  const course = /ielts/.test(raw) ? 'IELTS preparation' : /frontend/.test(raw) ? 'Frontend Bootcamp' : /robotics/.test(raw) ? 'Kids Robotics' : /python/.test(raw) ? 'Python Foundation' : /smm/.test(raw) ? 'SMM Career Course' : 'Best-fit course'
  const nextStep = status === 'hot' ? 'Manager should call today and offer available group.' : status === 'warm' ? 'Send course details and ask one qualification question.' : 'Add to nurture sequence and retry in 3 days.'
  const followUp = status === 'hot' ? `Hi ${name}, good news: we can help you start ${course}. Can our manager call you today to confirm schedule and payment options?` : status === 'warm' ? `Hi ${name}, thanks for your interest in ${course}. What schedule works best for you: weekday evening or weekend?` : `Hi ${name}, just checking if ${course} is still relevant. I can send a short program overview if useful.`
  return { name, phone, interest, budget, status, course, nextStep, followUp }
}

function buildWorkflowResult(leads: LeadResult[], source: RunSource): WorkflowResult {
  const hot = leads.filter((x) => x.status === 'hot')
  const warm = leads.filter((x) => x.status === 'warm')
  const cold = leads.filter((x) => x.status === 'cold')
  const nextActions = [
    hot.length ? `Call hot leads today: ${hot.map((x) => x.name).join(', ')}.` : 'No hot leads need an immediate call.',
    warm.length ? `Send schedule/pricing follow-up to warm leads: ${warm.map((x) => x.name).join(', ')}.` : 'No warm leads require follow-up.',
    cold.length ? `Put cold leads into a 3-day nurture sequence: ${cold.map((x) => x.name).join(', ')}.` : 'No cold leads to nurture.',
  ]
  return {
    source,
    leads,
    crmRows: leads.map((r) => ({ name: r.name, phone: r.phone, interest: r.interest, course: r.course, status: r.status, next_action: r.nextStep })),
    nextActions,
    followUps: leads.map((r) => `${r.name}: ${r.followUp}`),
    dailyReport: `Daily report: ${leads.length} leads processed. ${hot.length} hot, ${warm.length} warm, ${cold.length} cold. ${nextActions.join(' ')}`,
    agentTrace: runStepsTemplate.map((step) => step.label),
    savedAt: new Date().toISOString(),
  }
}

function buildPaymentResult(input: string, source: RunSource): WorkflowResult {
  const rows = input.split('\n').map((line) => line.trim()).filter(Boolean).map((line, index) => {
    const [name = `Student ${index + 1}`, course = 'Course', amount = '0 UZS', due = 'unknown due date', status = 'unpaid', admin = 'admin: Admin'] = line.split(',').map((x) => x.trim())
    const overdue = /2026-07-0[1-5]|overdue|unpaid/i.test(`${due} ${status}`)
    const risk = overdue ? 'high' : /partial/i.test(status) ? 'medium' : 'low'
    const adminName = admin.replace(/admin:/i, '').trim() || 'Admin'
    return { name, course, amount, due, status, adminName, risk }
  })
  return {
    source,
    leads: [],
    crmRows: rows.map((r) => ({ student: r.name, course: r.course, amount: r.amount, due_date: r.due, payment_status: r.status, risk: r.risk, admin: r.adminName })),
    paymentReminders: rows.map((r) => `${r.name}: Reminder for ${r.course}. Amount due: ${r.amount}. Due date: ${r.due}. Please confirm payment or contact your admin if you need help.`),
    adminEscalations: rows.filter((r) => r.risk !== 'low').map((r) => `${r.adminName}: ${r.name} has ${r.risk} payment risk for ${r.course}. Status: ${r.status}. Next action: call student today and update payment tracker.`),
    nextActions: rows.map((r) => `${r.name}: ${r.risk === 'high' ? 'Admin call today' : r.risk === 'medium' ? 'Send reminder and check tomorrow' : 'Monitor'}.`),
    followUps: [],
    dailyReport: `Payment control report: ${rows.length} students checked. High risk: ${rows.filter((r) => r.risk === 'high').length}. Medium risk: ${rows.filter((r) => r.risk === 'medium').length}. Admins should focus on overdue and no-response cases.`,
    agentTrace: operationsSteps.map((step) => step.label),
    savedAt: new Date().toISOString(),
  }
}

function buildMeetingResult(input: string, source: RunSource): WorkflowResult {
  const tasks = [
    { task: 'Launch IELTS evening group', owner: 'Education Admin', deadline: '2026-07-08', priority: 'high', status: 'not started' },
    { task: 'Parent follow-up for new group', owner: 'Madina', deadline: '2026-07-04', priority: 'high', status: 'in progress' },
    { task: 'Call unpaid Frontend students', owner: 'Dilshod', deadline: '2026-07-05', priority: 'high', status: 'overdue' },
    { task: 'Prepare Telegram post for SMM course', owner: 'Content team', deadline: '2026-07-06', priority: 'medium', status: 'not started' },
    { task: 'Review mentor quality report', owner: 'Akmal', deadline: '2026-07-07', priority: 'medium', status: 'overdue' },
  ]
  return {
    source,
    leads: [],
    crmRows: tasks.map((t) => ({ task: t.task, owner: t.owner, deadline: t.deadline, priority: t.priority, status: t.status })),
    keyDecisions: ['Launch IELTS evening group next Monday.', 'Prioritize unpaid Frontend students.', 'Prepare SMM marketing content this week.', 'Review mentor quality report before weekly review.'],
    meetingTasks: tasks,
    nextActions: tasks.filter((t) => t.status === 'overdue' || t.priority === 'high').map((t) => `${t.owner}: ${t.task} by ${t.deadline} (${t.status}).`),
    followUps: tasks.map((t) => `${t.owner}: please update status for “${t.task}” before ${t.deadline}.`),
    dailyReport: `Meeting to tasks report: ${tasks.length} tasks extracted from transcript. ${tasks.filter((t) => t.status === 'overdue').length} overdue items need manager attention. Source: ${input.slice(0, 90)}...`,
    agentTrace: operationsSteps.map((step) => step.label),
    savedAt: new Date().toISOString(),
  }
}

function loadSavedResult(): WorkflowResult | null {
  try {
    const v2 = localStorage.getItem(resultKey)
    if (v2) return JSON.parse(v2) as WorkflowResult
    const legacy = JSON.parse(localStorage.getItem('nemo-workflow-results') || '[]') as LeadResult[]
    return legacy.length ? buildWorkflowResult(legacy, 'local') : null
  } catch {
    return null
  }
}

function saveWorkflowResult(result: WorkflowResult) {
  localStorage.setItem(resultKey, JSON.stringify(result))
  localStorage.setItem('nemo-workflow-results', JSON.stringify(result.leads))
}

export default function EducationSalesWorkflowPage() {
  const navigate = useNavigate()
  const location = useLocation()
  const addAgent = useAgentStore((s) => s.addAgent)
  const deleteAgent = useAgentStore((s) => s.deleteAgent)
  const backend = useBackendStatus()
  const [wizardStep, setWizardStep] = useState(1)
  const [teamType, setTeamType] = useState<TeamType>('sales')
  const [goal, setGoal] = useState(() => localStorage.getItem('nemo-team-goal') || 'Qualify student leads, write follow-up messages, prepare CRM rows, and create a daily manager report.')
  const [teamName, setTeamName] = useState(() => localStorage.getItem('nemo-team-name') || 'AI Sales Team')
  const [createdId, setCreatedId] = useState(() => localStorage.getItem('nemo-current-team-id') || '')
  const [leads, setLeads] = useState(() => localStorage.getItem('nemo-workflow-input') || sampleLeads)
  const [runSteps, setRunSteps] = useState<RunStep[]>([])
  const [running, setRunning] = useState(false)
  const [creatingTeam, setCreatingTeam] = useState(false)
  const [createTeamError, setCreateTeamError] = useState('')
  const [backendError, setBackendError] = useState('')
  const [savedReport, setSavedReport] = useState(false)
  const [crmClicked, setCrmClicked] = useState(false)
  const [workflowResult, setWorkflowResult] = useState<WorkflowResult | null>(() => loadSavedResult())
  const [teamAgents, setTeamAgents] = useState<TeamAgentDraft[]>(() => suggestAgents('sales', localStorage.getItem('nemo-team-goal') || 'Qualify student leads, write follow-up messages, prepare CRM rows, and create a daily manager report.').map(toTeamAgentDraft))
  const [teamTestTask, setTeamTestTask] = useState('A student asks which course fits them: they want a tech job, can study evenings, and need a practical path in 3 months.')
  const [teamTestTrace, setTeamTestTrace] = useState<string[]>([])
  const [teamTestRunning, setTeamTestRunning] = useState(false)
  const [resultTab, setResultTab] = useState<ResultTab>('table')
  const [workflowType, setWorkflowType] = useState<WorkflowType>('lead-qualification')
  const [executionMode, setExecutionMode] = useState<ExecutionMode>(() => workflowResult?.source === 'live' ? 'live_success' : workflowResult ? 'local_simulation' : 'not_run')

  const page = location.pathname.includes('results') ? 'results' : location.pathname.includes('run-workflow') ? 'run' : 'create'
  const liveReady = backend.liveWorkflowReady
  const llmConfigured = backend.llmReady
  const modeClass = executionMode === 'live_success' ? 'border-teal/20 bg-teal/10 text-teal' : executionMode === 'live_failed' ? 'border-danger/25 bg-danger/10 text-danger' : liveReady ? 'border-teal/20 bg-teal/10 text-teal' : 'border-amber/25 bg-amber/10 text-amber'
  const modeLabel = executionMode === 'live_success' ? 'Backend execution completed' : executionMode === 'live_failed' ? 'Backend execution failed · fallback available' : liveReady ? 'Backend ready' : 'Local simulation mode'
  const results = workflowResult?.leads ?? []
  const runCompleted = page === 'run' && !!workflowResult && runSteps.length > 0 && runSteps.every((step) => step.state === 'done')
  const hot = results.filter((lead) => lead.status === 'hot').length
  const warm = results.filter((lead) => lead.status === 'warm').length
  const cold = results.filter((lead) => lead.status === 'cold').length

  useEffect(() => {
    if (page !== 'create') return
    try {
      const selected = JSON.parse(localStorage.getItem('nemo-selected-template') || 'null') as null | { teamName?: string; teamType?: TeamType; goal?: string }
      if (!selected) return
      window.setTimeout(() => {
        if (selected.teamName) setTeamName(selected.teamName)
        if (selected.teamType) setTeamType(selected.teamType)
        if (selected.goal) setGoal(selected.goal)
        if (/operations/i.test(selected.teamName || selected.goal || '')) setTeamAgents(operationsAgents())
        setWizardStep(2)
      }, 0)
      localStorage.removeItem('nemo-selected-template')
    } catch {
      localStorage.removeItem('nemo-selected-template')
    }
  }, [page])

  useEffect(() => {
    if (/operations/i.test(teamName)) return
    window.setTimeout(() => setTeamAgents(suggestAgents(teamType, goal).map(toTeamAgentDraft)), 0)
  }, [goal, teamName, teamType])

  useEffect(() => {
    window.setTimeout(() => {
      if (workflowType === 'payment-control') setLeads(samplePayment)
      if (workflowType === 'meeting-to-tasks') setLeads(sampleMeeting)
      if (workflowType === 'lead-qualification') setLeads(localStorage.getItem('nemo-workflow-input') || sampleLeads)
    }, 0)
  }, [workflowType])

  const updateTeamAgent = (index: number, patch: Partial<TeamAgentDraft>) => setTeamAgents((items) => items.map((agent, i) => i === index ? { ...agent, ...patch } : agent))
  const addSpecialistAgent = () => setTeamAgents((items) => items.length >= 7 ? items : [...items, toTeamAgentDraft({ name: `Specialist Agent ${items.length}`, role: 'Specialist Agent', desc: 'Describe this specialist agent task.' })])
  const removeSpecialistAgent = (index: number) => setTeamAgents((items) => index === 0 ? items : items.filter((_, i) => i !== index))
  const testTeam = () => {
    setTeamTestRunning(true)
    setTeamTestTrace([])
    const active = teamAgents.filter((agent) => agent.status === 'active')
    const trace = [
      `Team Lead analyzed task: ${teamTestTask}`,
      ...active.slice(1, 3).map((agent) => `${agent.name} processed: ${agent.prompt.slice(0, 86)}${agent.prompt.length > 86 ? '…' : ''}`),
      'Reviewer Agent checked quality, risk and handoff rules.',
      `Final response generated: recommend ${teamType === 'content' ? 'a content plan' : teamType === 'support' ? 'a support answer with human handoff if needed' : 'Frontend or Python path, collect phone number, and schedule consultation'}.`,
    ]
    trace.forEach((item, index) => window.setTimeout(() => setTeamTestTrace((items) => [...items, item]), 420 * (index + 1)))
    window.setTimeout(() => setTeamTestRunning(false), 420 * (trace.length + 1))
  }

  const createTeam = async () => {
    if (creatingTeam) return
    const lead = teamAgents[0]
    const activeSpecialists = teamAgents.slice(1).filter((agent) => agent.status === 'active')
    if (!teamName.trim() || !goal.trim()) {
      setCreateTeamError('Team name and goal are required')
      return
    }
    if (!lead || lead.status !== 'active') {
      setCreateTeamError('The Team Lead must stay active')
      return
    }
    if (!activeSpecialists.length) {
      setCreateTeamError('Keep at least one active specialist in addition to the Team Lead')
      return
    }

    setCreatingTeam(true)
    setCreateTeamError('')
    try {
      const res = await createLegacyMarketplaceTeam(
        teamTypeToLegacyMarketplaceKind(teamType),
        addAgent,
        deleteAgent,
        {
          name: teamName,
          goal,
          lead: {
            role: lead.role,
            model: lead.model,
            prompt: {
              role: lead.role.trim() || `Team Lead Agent for ${teamName}`,
              tasks: `${lead.prompt.trim()}\n\nGoal: ${goal}\n\nCoordinate these specialists:\n${activeSpecialists.map((agent) => `${agent.name}: ${agent.prompt}`).join('\n')}`,
              tone: 'Clear, practical, business-focused.',
              rules: 'Delegate work, verify every output, and never fake integrations or external actions. Require human approval for irreversible or consequential actions.',
            },
          },
          specialists: activeSpecialists.map((agent) => ({
            name: agent.name,
            role: agent.role,
            model: agent.model,
            status: agent.status,
            prompt: {
              role: agent.role,
              tasks: agent.prompt,
              tone: 'Professional, concise, helpful.',
              rules: 'Use only supplied or tool-confirmed facts. Never claim an external action succeeded without a confirmed tool result. Escalate uncertainty and consequential decisions to a human.',
            },
          })),
        },
      )
      if (res.error || !res.agentId || !res.departmentId) {
        setCreateTeamError(res.error ?? 'Could not create the complete team')
        return
      }

      localStorage.setItem('nemo-current-team-id', res.agentId)
      localStorage.setItem('nemo-team-name', teamName)
      localStorage.setItem('nemo-team-goal', goal)
      localStorage.setItem(`nemo-team-blueprint:${res.agentId}`, JSON.stringify({ teamName, teamType, goal, agents: teamAgents, departmentId: res.departmentId, savedAt: new Date().toISOString() }))
      setCreatedId(res.agentId)
      navigate(`/app/teams/${res.agentId}`)
    } catch (error) {
      setCreateTeamError(error instanceof Error ? error.message : 'Could not create the complete team')
    } finally {
      setCreatingTeam(false)
    }
  }

  const activeRunSteps = workflowType === 'lead-qualification' ? runStepsTemplate : operationsSteps
  const updateActiveStep = (index: number, state: RunStepState) => setRunSteps(activeRunSteps.map((s, i) => i < index ? { ...s, state: 'done' } : i === index ? { ...s, state } : s))

  const runLocalSimulationFor = (type: WorkflowType, input: string) => {
    const result = type === 'payment-control'
      ? buildPaymentResult(input, 'local')
      : type === 'meeting-to-tasks' || type === 'weekly-follow-up' || type === 'manager-report'
        ? buildMeetingResult(input, 'local')
        : buildWorkflowResult(input.split('\n').map((line) => line.trim()).filter(Boolean).map(parseLead), 'local')
    saveWorkflowResult(result)
    setWorkflowResult(result)
    setExecutionMode('local_simulation')
    setBackendError('')
    setRunSteps((items) => (items.length ? items : (type === 'lead-qualification' ? runStepsTemplate : operationsSteps)).map((s) => ({ ...s, state: 'done' })))
    setResultTab(type === 'payment-control' ? 'payments' : type === 'meeting-to-tasks' ? 'tasks' : 'table')
    return result
  }

  const runLocalSimulation = () => {
    runLocalSimulationFor(workflowType, leads)
  }

  const runDemoSimulation = (type: WorkflowType) => {
    const input = type === 'payment-control' ? samplePayment : type === 'meeting-to-tasks' ? sampleMeeting : sampleLeads
    setWorkflowType(type)
    setLeads(input)
    runLocalSimulationFor(type, input)
  }

  useEffect(() => {
    if (page !== 'run') return
    const requested = localStorage.getItem('nemo-demo-workflow-request') as WorkflowType | null
    if (requested !== 'payment-control' && requested !== 'meeting-to-tasks') return
    localStorage.removeItem('nemo-demo-workflow-request')
    const input = requested === 'payment-control' ? samplePayment : sampleMeeting
    window.setTimeout(() => {
      setWorkflowType(requested)
      setLeads(input)
      runLocalSimulationFor(requested, input)
    }, 0)
  }, [page])

  const callOrchestrate = async (body: Record<string, unknown>) => {
    if (!supabase) throw new Error('Supabase client is not configured')
    const { data, error } = await supabase.functions.invoke('orchestrate', { body })
    const payload = data as OrchestrateResponse | null
    if (error) throw new Error(error.message || 'orchestrate returned non-2xx response')
    if (!payload?.ok) throw new Error(payload?.detail || payload?.error || 'orchestrate returned an invalid response')
    return payload
  }

  const runLiveOrchestrate = async () => {
    const activeAgents = teamAgents.filter((agent) => agent.status === 'active')
    const team = activeAgents.length ? activeAgents : operationsAgents()
    const goalText = `${workflowOptions.find((option) => option.id === workflowType)?.label}: ${goal}\n\nInput:\n${leads}`
    await callOrchestrate({ action: 'plan', goal: goalText, niche: 'IT Academy operations', purpose: 'Internal operations workflow execution', lang: 'en' })

    const completed: Array<{ role: string; task: string; output: string; sources: string[] }> = []
    const trace: string[] = []
    const stepAgents = team.slice(0, activeRunSteps.length)
    for (let i = 0; i < activeRunSteps.length; i += 1) {
      updateActiveStep(i, 'running')
      const agent = stepAgents[i] ?? team[0]
      const task = `${activeRunSteps[i].label}. ${activeRunSteps[i].desc}\nWorkflow type: ${workflowType}\nInput:\n${leads}`
      const context = completed.map((step) => `[${step.role}] ${step.output}`).join('\n\n').slice(0, 4000)
      const response = await callOrchestrate({ action: 'step', goal: goalText, role: 'analyst', task, system: agent?.prompt || activeRunSteps[i].desc, context })
      const output = response.output || ''
      completed.push({ role: agent?.name || activeRunSteps[i].label, task, output, sources: response.sources ?? [] })
      trace.push(`${agent?.name || activeRunSteps[i].label}: ${output.slice(0, 260)}${output.length > 260 ? '...' : ''}`)
      setRunSteps((items) => items.map((step, index) => index <= i ? { ...step, state: 'done' } : step))
    }

    const synth = await callOrchestrate({ action: 'synth', goal: goalText, steps: completed, sources: completed.flatMap((step) => step.sources) })
    trace.push(`Report Agent synthesis: ${(synth.result || '').slice(0, 320)}${(synth.result || '').length > 320 ? '...' : ''}`)
    const structured = workflowType === 'payment-control'
      ? buildPaymentResult(leads, 'local')
      : workflowType === 'meeting-to-tasks' || workflowType === 'weekly-follow-up' || workflowType === 'manager-report'
        ? buildMeetingResult(leads, 'local')
        : buildWorkflowResult(leads.split('\n').map((line) => line.trim()).filter(Boolean).map(parseLead), 'local')
    const result: WorkflowResult = { ...structured, source: 'live', agentTrace: trace, dailyReport: synth.result || structured.dailyReport, savedAt: new Date().toISOString() }
    saveWorkflowResult(result)
    setWorkflowResult(result)
    setExecutionMode('live_success')
    setBackendError('')
  }

  const runWorkflow = async () => {
    setBackendError('')
    setRunning(true)
    setExecutionMode('not_run')
    setRunSteps(activeRunSteps)
    localStorage.setItem('nemo-workflow-input', leads)

    if (!liveReady || !supabase) {
      setBackendError(backend.reason)
      runLocalSimulation()
      setRunning(false)
      return
    }

    try {
      await runLiveOrchestrate()
      setRunSteps((items) => items.map((s) => ({ ...s, state: 'done' })))
    } catch (error) {
      setExecutionMode('live_failed')
      setBackendError(error instanceof Error ? error.message : 'Backend workflow failed')
      setRunSteps((items) => items.map((s) => s.state === 'running' ? { ...s, state: 'error' } : s))
    } finally {
      setRunning(false)
    }
  }

  const copyText = (text: string) => navigator.clipboard?.writeText(text)
  const copyResults = () => copyText((workflowResult?.dailyReport || '') + '\n\n' + (workflowResult?.crmRows ?? []).map((row) => Object.entries(row).map(([k, v]) => `${k}: ${v}`).join(' | ')).join('\n'))
  const exportCsv = () => {
    const rows: Array<Record<string, string>> = workflowResult?.crmRows?.length ? workflowResult.crmRows : results.map((r) => ({ name: r.name, phone: r.phone, course: r.course, status: r.status, follow_up: r.followUp, next_step: r.nextStep }))
    const headers = Array.from(new Set(rows.flatMap((row) => Object.keys(row))))
    const csv = [headers.join(','), ...rows.map((row) => headers.map((key) => `"${String(row[key] ?? '').replace(/"/g, '""')}"`).join(','))].join('\n')
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }))
    const a = document.createElement('a')
    a.href = url
    a.download = 'nemo-workflow-results.csv'
    a.click()
    URL.revokeObjectURL(url)
  }
  const saveReport = () => { if (workflowResult) localStorage.setItem('nemo-saved-report', JSON.stringify(workflowResult)); setSavedReport(true) }

  return (
    <div className="container-page max-w-7xl py-8">
      <div className="flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
        <div>
          <p className="mono-label">AI Team Builder</p>
          <h1 className="mt-2 text-3xl font-extrabold tracking-tight text-text">Create and run AI teams for business workflows</h1>
          <p className="mt-2 max-w-2xl text-sm leading-relaxed text-muted">Build a Team Lead Agent with Specialist Agents, run a workflow on your data, and save structured results.</p>
          <span className={`mt-3 inline-flex rounded-pill border px-3 py-1 text-xs font-medium ${modeClass}`}>{modeLabel}</span>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button to="/app/create-team" variant={page === 'create' ? 'primary' : 'secondary'}>Create Team</Button>
          <Button to="/app/run-workflow" variant={page === 'run' ? 'primary' : 'secondary'}>Run Workflow</Button>
          <Button to="/app/activity" variant={page === 'results' ? 'primary' : 'secondary'}>Activity</Button>
        </div>
      </div>

      <div className="mt-5 flex flex-wrap gap-2 rounded-2xl border border-white/10 bg-white/[0.03] p-2">
        <Button to="/app/results" size="sm" variant={page === 'results' ? 'primary' : 'ghost'}>All results</Button>
        <Button to="/app/dialogues" size="sm" variant="ghost">Dialogues</Button>
        <Button to="/app/lead-forms" size="sm" variant="ghost">Lead forms</Button>
        <Button to="/app/analytics" size="sm" variant="ghost">Analytics</Button>
      </div>

      {page === 'create' && (
        <div className="mt-8 grid gap-6 lg:grid-cols-[0.8fr_1.2fr]">
          <div className="card rounded-3xl p-5">
            <p className="text-sm font-semibold text-text">Create Team Wizard</p>
            <div className="mt-4 space-y-2">{['Choose team type', 'Describe goal', 'Review suggested agents', 'Confirm and create'].map((s, i) => <button key={s} onClick={() => setWizardStep(i + 1)} className={`flex w-full items-center gap-3 rounded-2xl border p-3 text-left text-sm ${wizardStep === i + 1 ? 'border-violet/60 bg-violet/10 text-text' : 'border-white/10 text-muted hover:text-text'}`}><span className="flex h-7 w-7 items-center justify-center rounded-full bg-white/10 text-xs">{i + 1}</span>{s}</button>)}</div>
          </div>
          <div className="card rounded-3xl p-6">
            {wizardStep === 1 && <div><h2 className="text-xl font-bold text-text">Choose team type</h2><div className="mt-5 grid gap-3 sm:grid-cols-2">{teamTypes.map((type) => <button key={type.id} onClick={() => { setTeamType(type.id); setWizardStep(2) }} className={`rounded-2xl border p-4 text-left ${teamType === type.id ? 'border-cyan/50 bg-cyan/10' : 'border-white/10 bg-white/[0.03] hover:border-white/25'}`}><p className="font-semibold text-text">{type.title}</p><p className="mt-1 text-xs leading-relaxed text-muted">{type.desc}</p></button>)}</div></div>}
            {wizardStep === 2 && <div><h2 className="text-xl font-bold text-text">Describe the team goal</h2><div className="mt-5 grid gap-3 sm:grid-cols-2"><label className="block space-y-1.5"><span className="text-xs text-muted">Team name</span><input value={teamName} onChange={(e) => setTeamName(e.target.value)} className={fieldCls} /></label><label className="block space-y-1.5"><span className="text-xs text-muted">Type</span><input value={teamTypes.find((t) => t.id === teamType)?.title} readOnly className={fieldCls} /></label></div><textarea value={goal} onChange={(e) => setGoal(e.target.value)} rows={6} className={`${fieldCls} mt-3 resize-y leading-relaxed`} /><Button onClick={() => setWizardStep(3)} disabled={goal.trim().length < 12} className="mt-4">Generate suggested agents</Button></div>}
            {wizardStep === 3 && (
              <div>
                <div className="flex items-center justify-between gap-3">
                  <div><h2 className="text-xl font-bold text-text">Configure Team Lead and Specialist Agents</h2><p className="mt-1 text-sm text-muted">Edit sub-agent role, tasks, prompt, model and status before saving the AI Team.</p></div>
                  <Button onClick={addSpecialistAgent} size="sm" variant="outline" disabled={teamAgents.length >= 7}>Add sub-agent</Button>
                </div>
                <div className="mt-5 rounded-2xl border border-white/10 bg-white/[0.03] p-3 text-xs text-muted">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="rounded-pill border border-cyan/25 bg-cyan/10 px-3 py-1.5 text-cyan">{teamAgents[0]?.name || 'Team Lead Agent'}</span>
                    <span>→</span>
                    {teamAgents.slice(1).map((agent) => <span key={agent.name} className="rounded-pill border border-violet/25 bg-violet/10 px-3 py-1.5 text-violet">{agent.name}</span>)}
                    <span>→</span>
                    <span className="rounded-pill border border-teal/25 bg-teal/10 px-3 py-1.5 text-teal">Workflow Output</span>
                  </div>
                </div>
                <div className="mt-5 grid gap-3">
                  {teamAgents.map((agent, i) => (
                    <div key={`${agent.name}-${i}`} className="rounded-2xl border border-white/10 bg-white/[0.04] p-4">
                      <div className="flex items-center justify-between gap-3">
                        <span className="rounded-pill border border-cyan/20 bg-cyan/10 px-3 py-1 text-xs text-cyan">{i === 0 ? 'Team Lead Agent' : 'Specialist Agent / Sub-agent'}</span>
                        {i > 0 && <button onClick={() => removeSpecialistAgent(i)} className="text-xs text-danger hover:underline">Remove</button>}
                      </div>
                      <div className="mt-3 grid gap-3 md:grid-cols-2">
                        <label className="space-y-1.5"><span className="text-xs text-muted">Name</span><input value={agent.name} onChange={(e) => updateTeamAgent(i, { name: e.target.value })} className={fieldCls} /></label>
                        <label className="space-y-1.5"><span className="text-xs text-muted">Role</span><input value={agent.role} onChange={(e) => updateTeamAgent(i, { role: e.target.value })} className={fieldCls} /></label>
                        <label className="space-y-1.5"><span className="text-xs text-muted">Model</span><input value={agent.model} onChange={(e) => updateTeamAgent(i, { model: e.target.value })} className={fieldCls} /></label>
                        <label className="space-y-1.5"><span className="text-xs text-muted">Status</span><select value={agent.status} onChange={(e) => updateTeamAgent(i, { status: e.target.value as TeamAgentDraft['status'] })} className={fieldCls}><option value="active">Active</option><option value="inactive">Inactive</option></select></label>
                      </div>
                      <label className="mt-3 block space-y-1.5"><span className="text-xs text-muted">Tasks / prompt</span><textarea value={agent.prompt} onChange={(e) => updateTeamAgent(i, { prompt: e.target.value, desc: e.target.value })} rows={3} className={`${fieldCls} resize-y`} /></label>
                    </div>
                  ))}
                </div>
                <div className="mt-5 rounded-2xl border border-cyan/20 bg-cyan/10 p-4">
                  <div className="flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
                    <label className="flex-1 space-y-1.5"><span className="text-xs text-muted">Test team task</span><textarea value={teamTestTask} onChange={(e) => setTeamTestTask(e.target.value)} rows={3} className={`${fieldCls} resize-y`} /></label>
                    <Button onClick={testTeam} disabled={teamTestRunning || teamTestTask.trim().length < 8} variant="outline">{teamTestRunning ? 'Testing...' : 'Test AI Team'}</Button>
                  </div>
                  <div className="mt-4 space-y-2">
                    {(teamTestTrace.length ? teamTestTrace : ['Team test trace will appear here.']).map((item, i) => <div key={`${item}-${i}`} className="rounded-xl border border-white/10 bg-bg/50 p-3 text-xs text-muted">{item}</div>)}
                  </div>
                  <p className="mt-3 text-xs text-amber">Local simulation. Run Workflow uses live backend if configured.</p>
                </div>
                <Button onClick={() => setWizardStep(4)} className="mt-5">Continue</Button>
              </div>
            )}
            {wizardStep === 4 && (
              <div>
                <h2 className="text-xl font-bold text-text">Confirm and create</h2>
                <div className="mt-5 rounded-2xl border border-white/10 bg-white/[0.04] p-4">
                  <p className="font-semibold text-text">{teamName}</p>
                  <p className="mt-1 text-sm text-muted">{goal}</p>
                  <p className="mt-3 text-xs text-muted">{teamAgents.filter((a) => a.status === 'active').length} active AI employees: Team Lead Agent + Specialist Agents</p>
                </div>
                {createTeamError && (
                  <div className="mt-4 rounded-2xl border border-danger/25 bg-danger/10 p-4">
                    <p className="flex items-center gap-2 text-sm font-semibold text-danger"><AlertCircle size={16} /> Team was not saved</p>
                    <p className="mt-1 text-xs text-muted">{createTeamError}</p>
                  </div>
                )}
                <Button onClick={createTeam} disabled={creatingTeam} fullWidth className="mt-5">
                  {creatingTeam ? <Loader2 size={16} className="animate-spin" /> : <Plus size={16} />}
                  {creatingTeam ? 'Creating complete team...' : 'Create Team'}
                </Button>
                {createdId && <p className="mt-3 flex items-center gap-2 text-xs text-teal"><CheckCircle2 size={14} /> Team saved. You can run a workflow now.</p>}
              </div>
            )}
          </div>
        </div>
      )}

      {page === 'run' && (
        <div className="mt-8 grid gap-6 lg:grid-cols-[1fr_0.85fr]">
          <div className="card rounded-3xl p-6">
            <div className="flex items-center justify-between gap-3">
              <div><h2 className="text-xl font-bold text-text">Run workflow</h2><p className="mt-1 text-sm text-muted">Choose workflow type and paste input data. {liveReady ? 'Nemo will try live orchestrate: plan → specialist steps → synth.' : 'Live prerequisites are missing, so this run will use Local simulation and will not call orchestrate.'}</p></div>
              {createdId ? <span className="rounded-pill border border-teal/20 bg-teal/10 px-3 py-1 text-xs text-teal">Team saved</span> : <Button to="/app/create-team" size="sm">Create team first</Button>}
            </div>
            <div className="mt-4 grid gap-2 rounded-2xl border border-white/10 bg-white/[0.04] p-4 text-xs text-muted sm:grid-cols-4">
              <StatusPill label="Auth" ok={backend.authReady} okText="connected" badText="missing" />
              <StatusPill label="Account" ok={backend.accountReady} okText="ready" badText="missing" />
              <StatusPill label="Supabase" ok={backend.supabaseReady} okText="connected" badText="demo" />
              <StatusPill label="LLM provider" ok={llmConfigured && liveReady} okText="server-side" badText="missing/unknown" />
              <StatusPill label="Mode" ok={liveReady} okText="live" badText={backend.mode === 'not_configured' ? 'not configured' : 'local simulation'} />
            </div>
            {!liveReady && <div className="mt-3 flex flex-wrap gap-2"><Button to="/app/integrations" size="sm" variant="outline">Configure integrations</Button><Button onClick={runLocalSimulation} size="sm">Continue in local simulation</Button></div>}
            <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {workflowOptions.map((option) => <button key={option.id} onClick={() => setWorkflowType(option.id)} className={`rounded-2xl border p-3 text-left ${workflowType === option.id ? 'border-cyan/50 bg-cyan/10' : 'border-white/10 bg-white/[0.03] hover:border-white/25'}`}><p className="text-sm font-semibold text-text">{option.label}</p><p className="mt-1 text-xs text-muted">{option.desc}</p></button>)}
            </div>
            <textarea value={leads} onChange={(e) => setLeads(e.target.value)} rows={13} className={`${fieldCls} mt-4 resize-y leading-relaxed`} />
            {backendError && <div className="mt-4 rounded-2xl border border-danger/25 bg-danger/10 p-4"><p className="flex items-center gap-2 text-sm font-semibold text-danger"><AlertCircle size={16} /> {executionMode === 'local_simulation' ? 'Live workflow disabled' : 'Backend workflow failed'}</p><p className="mt-1 text-xs text-muted">{backendError}</p><div className="mt-3 flex flex-wrap gap-2"><Button onClick={runLocalSimulation} size="sm" variant="outline">Run local simulation instead</Button><Button to="/app/integrations" size="sm" variant="outline">Configure integrations</Button></div></div>}
            <Button onClick={runWorkflow} disabled={running || leads.trim().length < 10} fullWidth className="mt-4"><Play size={16} /> {running ? 'Running agents...' : 'Run workflow'}</Button>
            {runCompleted && <div className="mt-4 rounded-2xl border border-teal/20 bg-teal/10 p-4"><p className="flex items-center gap-2 text-sm font-semibold text-teal"><CheckCircle2 size={16} /> Completed</p><p className="mt-1 text-xs text-muted">Agent execution finished and structured output was saved.</p><Button to="/app/activity" size="sm" className="mt-3">View activity</Button></div>}
          </div>
          <div className="card rounded-3xl p-6">
            <div className="flex items-center justify-between gap-3"><h2 className="text-xl font-bold text-text">Agent execution</h2><span className={`rounded-pill border px-3 py-1 text-xs ${modeClass}`}>{executionMode === 'live_success' ? 'Live orchestrate' : executionMode === 'live_failed' ? 'Live failed' : 'Local simulation'}</span></div>
            <div className="mt-5 space-y-3">{(runSteps.length ? runSteps : runStepsTemplate).map((s) => <ExecutionStep key={s.label} step={s} />)}</div>
          </div>
        </div>
      )}

      {page === 'results' && (
        <div className="mt-8 space-y-6">
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
            <SummaryCard label="Leads processed" value={String(results.length)} />
            <SummaryCard label="Hot leads" value={String(hot)} />
            <SummaryCard label="Warm leads" value={String(warm)} />
            <SummaryCard label="Cold leads" value={String(cold)} />
            <SummaryCard label="Mode" value={!workflowResult ? 'No run' : workflowResult.source === 'live' ? 'Live orchestrate' : 'Local simulation'} />
          </div>

          {!workflowResult && (
            <div className="card rounded-3xl border-dashed p-6 text-center">
              <p className="text-xl font-bold text-text">Run a workflow to generate results</p>
              <p className="mx-auto mt-2 max-w-xl text-sm leading-relaxed text-muted">For the July 6 pilot, start with one of the Operations Team demos. Demo simulation is generated only after you click a button.</p>
              <div className="mt-5 flex flex-wrap justify-center gap-3">
                <Button onClick={() => runDemoSimulation('payment-control')}>Run Payment Control Demo</Button>
                <Button onClick={() => runDemoSimulation('meeting-to-tasks')} variant="outline">Run Meeting to Tasks Demo</Button>
              </div>
            </div>
          )}

          <div className="grid gap-6 xl:grid-cols-[1fr_0.36fr]">
            <div className="card rounded-3xl p-6">
              <div className="flex flex-wrap items-center justify-between gap-3"><div className="flex items-center gap-2"><Table2 className="text-cyan" /><h2 className="text-xl font-bold text-text">Workflow results</h2><span className={`rounded-pill border px-3 py-1 text-xs ${workflowResult?.source === 'live' ? 'border-teal/20 bg-teal/10 text-teal' : 'border-amber/25 bg-amber/10 text-amber'}`}>{workflowResult?.source === 'live' ? 'Live orchestrate result' : workflowResult ? 'Local simulation' : 'No result yet'}</span></div><div className="flex flex-wrap gap-2"><Button size="sm" variant="outline" onClick={copyResults} disabled={!workflowResult}><Copy size={14} /> Copy all</Button><Button size="sm" variant="outline" onClick={exportCsv} disabled={!workflowResult}><Download size={14} /> CSV</Button></div></div>
              <div className="mt-5 flex flex-wrap gap-2">{(['table', 'payments', 'escalations', 'decisions', 'tasks', 'followups', 'crm', 'weekly', 'report', 'trace'] as const).map((tab) => <button key={tab} onClick={() => setResultTab(tab)} className={`rounded-pill border px-3 py-1.5 text-xs ${resultTab === tab ? 'border-cyan/40 bg-cyan/10 text-cyan' : 'border-white/10 bg-white/[0.03] text-muted hover:text-text'}`}>{tab === 'table' ? 'Lead table' : tab === 'payments' ? 'Payment reminders' : tab === 'escalations' ? 'Admin escalations' : tab === 'decisions' ? 'Key decisions' : tab === 'tasks' ? 'Meeting tasks' : tab === 'followups' ? 'Follow-up messages' : tab === 'crm' ? 'CRM-ready rows' : tab === 'weekly' ? 'Weekly report' : tab === 'report' ? 'Manager report' : 'Agent trace'}</button>)}</div>
              <div className="mt-5 min-h-[320px]">{renderResultTab(resultTab, results, workflowResult, runSteps)}</div>
            </div>
            <aside className="card rounded-3xl p-6"><h2 className="text-xl font-bold text-text">Manager report</h2><p className="mt-3 text-sm leading-relaxed text-muted">{workflowResult?.dailyReport || 'Run a workflow to create a manager report.'}</p><div className="mt-5 space-y-2">{(workflowResult?.nextActions ?? []).map((item) => <p key={item} className="rounded-xl border border-white/10 bg-white/[0.04] p-3 text-xs text-muted">{item}</p>)}</div><div className="mt-4 flex flex-wrap gap-2"><Button size="sm" onClick={saveReport} disabled={!workflowResult}><Save size={14} /> {savedReport ? 'Saved' : 'Save report'}</Button><Button size="sm" variant="outline" onClick={() => copyText(workflowResult?.dailyReport || '')} disabled={!workflowResult}><Copy size={14} /> Copy report</Button><Button size="sm" variant="outline" onClick={() => setCrmClicked(true)} disabled={!workflowResult}>Send to CRM</Button></div>{crmClicked && <p className="mt-3 text-xs text-amber">CRM sync is coming soon. Use CSV export or copy results for now.</p>}</aside>
          </div>
        </div>
      )}
    </div>
  )
}

function ExecutionStep({ step }: { step: RunStep }) {
  const cls = step.state === 'done' ? 'bg-teal/15 text-teal' : step.state === 'running' ? 'bg-violet/15 text-violet' : step.state === 'error' ? 'bg-danger/15 text-danger' : 'bg-white/10 text-muted'
  return <div className="flex gap-3 rounded-2xl border border-white/10 bg-white/[0.04] p-4"><span className={`mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full ${cls}`}>{step.state === 'running' ? <Loader2 size={14} className="animate-spin" /> : step.state === 'done' ? <CheckCircle2 size={14} /> : step.state === 'error' ? <AlertCircle size={14} /> : <span className="h-2 w-2 rounded-full bg-current" />}</span><div><p className="font-semibold text-text">{step.label}</p><p className="mt-1 text-xs text-muted">{step.desc}</p></div></div>
}

function SummaryCard({ label, value }: { label: string; value: string }) {
  return <div className="card rounded-2xl p-4"><p className="text-2xl font-extrabold text-text">{value}</p><p className="mt-1 text-xs text-muted">{label}</p></div>
}

function StatusPill({ label, ok, okText, badText }: { label: string; ok: boolean; okText: string; badText: string }) {
  return <div><p className="font-semibold text-text">{label}</p><p className={ok ? 'text-teal' : 'text-amber'}>{ok ? okText : badText}</p></div>
}

function renderResultTab(tab: ResultTab, results: LeadResult[], workflowResult: WorkflowResult | null, runSteps: RunStep[]) {
  if (!workflowResult) return <p className="rounded-2xl border border-dashed border-white/10 py-12 text-center text-sm text-muted">Run a workflow to generate results.</p>
  if (tab === 'payments') return <ListItems items={workflowResult.paymentReminders ?? []} copyLabel="Copy reminders" />
  if (tab === 'escalations') return <ListItems items={workflowResult.adminEscalations ?? []} copyLabel="Copy escalations" />
  if (tab === 'decisions') return <ListItems items={workflowResult.keyDecisions ?? []} copyLabel="Copy decisions" />
  if (tab === 'tasks') return <TaskTable tasks={workflowResult.meetingTasks ?? []} />
  if (tab === 'weekly') return <ListItems items={[workflowResult.dailyReport, ...(workflowResult.nextActions ?? [])].filter(Boolean)} copyLabel="Copy weekly report" />
  if (tab === 'followups') return <ListItems items={workflowResult.followUps} copyLabel="Copy follow-ups" />
  if (tab === 'crm') return <ListItems items={workflowResult.crmRows.map((row) => Object.entries(row).map(([k, v]) => `${k}: ${v}`).join(' · '))} copyLabel="Copy rows" />
  if (tab === 'report') return <p className="rounded-2xl border border-white/10 bg-white/[0.04] p-4 text-sm leading-relaxed text-muted">{workflowResult.dailyReport}</p>
  if (tab === 'trace') return <ListItems items={workflowResult.agentTrace?.length ? workflowResult.agentTrace : (runSteps.length ? runSteps : runStepsTemplate).map((step) => step.label)} />
  if (!results.length && workflowResult.crmRows.length) return <ListItems items={workflowResult.crmRows.map((row) => Object.entries(row).map(([k, v]) => `${k}: ${v}`).join(' · '))} copyLabel="Copy structured rows" />
  return <div className="overflow-x-auto"><table className="w-full min-w-[860px] text-left text-sm"><thead className="text-xs uppercase tracking-wide text-muted"><tr>{['Lead', 'Course', 'Status', 'Follow-up message', 'Manager next step'].map((h) => <th key={h} className="border-b border-white/10 px-3 py-2">{h}</th>)}</tr></thead><tbody>{results.map((r) => <tr key={`${r.name}-${r.phone}`} className="border-b border-white/5"><td className="px-3 py-3"><p className="font-medium text-text">{r.name}</p><p className="text-xs text-muted">{r.phone}</p></td><td className="px-3 py-3 text-muted">{r.course}</td><td className="px-3 py-3"><span className={`rounded-pill px-2.5 py-1 text-xs font-medium ${r.status === 'hot' ? 'bg-danger/15 text-danger' : r.status === 'warm' ? 'bg-amber/15 text-amber' : 'bg-white/10 text-muted'}`}>{r.status}</span></td><td className="max-w-xs px-3 py-3 text-muted">{r.followUp}</td><td className="px-3 py-3 text-muted">{r.nextStep}</td></tr>)}</tbody></table></div>
}

function ListItems({ items, copyLabel = 'Copy' }: { items: string[]; copyLabel?: string }) {
  return <div><button onClick={() => navigator.clipboard?.writeText(items.join('\n'))} disabled={!items.length} className="mb-3 inline-flex items-center gap-1.5 rounded-xl border border-white/10 px-3 py-1.5 text-xs text-muted hover:text-text disabled:opacity-40"><Copy size={13} /> {copyLabel}</button><div className="space-y-2">{items.length ? items.map((item) => <div key={item} className="rounded-2xl border border-white/10 bg-white/[0.04] p-3 text-sm leading-relaxed text-muted">{item}</div>) : <p className="text-sm text-muted">No items yet.</p>}</div></div>
}

function TaskTable({ tasks }: { tasks: Array<{ task: string; owner: string; deadline: string; priority: string; status: string }> }) {
  if (!tasks.length) return <p className="text-sm text-muted">No meeting tasks yet.</p>
  const text = tasks.map((task) => `${task.task} | ${task.owner} | ${task.deadline} | ${task.priority} | ${task.status}`).join('\n')
  return <div><button onClick={() => navigator.clipboard?.writeText(text)} className="mb-3 inline-flex items-center gap-1.5 rounded-xl border border-white/10 px-3 py-1.5 text-xs text-muted hover:text-text"><Copy size={13} /> Copy task table</button><div className="overflow-x-auto"><table className="w-full min-w-[760px] text-left text-sm"><thead className="text-xs uppercase tracking-wide text-muted"><tr>{['Task', 'Owner', 'Deadline', 'Priority', 'Status'].map((h) => <th key={h} className="border-b border-white/10 px-3 py-2">{h}</th>)}</tr></thead><tbody>{tasks.map((task) => <tr key={`${task.task}-${task.owner}`} className="border-b border-white/5"><td className="px-3 py-3 text-text">{task.task}</td><td className="px-3 py-3 text-muted">{task.owner}</td><td className="px-3 py-3 text-muted">{task.deadline}</td><td className="px-3 py-3 text-muted">{task.priority}</td><td className="px-3 py-3"><span className="rounded-pill bg-white/10 px-2.5 py-1 text-xs text-muted">{task.status}</span></td></tr>)}</tbody></table></div></div>
}
