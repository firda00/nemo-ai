import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { ArrowUp, Loader2, Users, Check, RotateCcw, Save, Sparkles, Image as ImageIcon, Send, Download, X, Paperclip, FileSpreadsheet, AlertTriangle, ExternalLink, Square } from 'lucide-react'
import { supabase, isSupabaseEnabled } from '../../lib/supabase'
import { useAgentStore } from '../../store/useAgentStore'
import { saveDynamicTeam } from '../../lib/dynamicTeams'
import { IMAGE_MODEL_CATALOG, DEFAULT_IMAGE_MODEL } from '../../lib/models'
import { PROVIDERS } from '../../data/platform'
import { INDUSTRY_TEAM_BLUEPRINTS } from '../../lib/industryTeams'
import { useI18n } from '../../i18n'
import { Markdown } from '../ui/Markdown'
import { DocExport } from './DocExport'
import { cn } from '../../lib/cn'
import { extractText, KNOWLEDGE_ACCEPT } from '../../lib/extractText'
import {
  artifactHandoffContext,
  boundedArtifact,
  marketplaceInputMissing,
  MAX_AUTONOMOUS_INPUT_FILES,
  MAX_AUTONOMOUS_TOTAL_CHARS,
  type AutonomousInputArtifact,
} from '../../lib/autonomousInputs'
import { defaultDefinitionOfDone, GoalSchema, type GoalContract, type GoalEvaluation } from '../../types/goal'
import { teamDisplayName } from '../../lib/teamDisplayName'

const live = isSupabaseEnabled
interface Review { approved: boolean; score: number; issues: string[]; fix: string }
interface Spec {
  role: string
  name: string
  skills?: string[]
  prompt: { role: string; tasks: string; tone: string; rules: string }
  output?: string
  review?: Review | null
  reviewedBy?: string
  revised?: boolean
  revisions?: number
  escalated?: boolean
  sources?: string[]
  status: 'pending' | 'running' | 'review' | 'fixing' | 'done'
}
interface CheckpointState {
  goal: string
  orchestratedGoal: string
  inputArtifacts: AutonomousInputArtifact[]
  specs: Spec[]
  nextSpecialist: number
  nextReview: number
  goalContract?: GoalContract
  goalEvaluation?: GoalEvaluation | null
  iterationContext?: string
  result?: string
}
interface RunCheckpoint {
  id: string
  run_ref: string
  phase: 'team' | 'review' | 'synth'
  state: CheckpointState
  status?: 'active' | 'queued' | 'running' | 'completed' | 'failed' | 'cancelled'
  transition?: 'staff' | 'observe_plan' | 'specialist' | 'review' | 'revision' | 'goal_check' | 'synth'
  specialist_cursor?: number
  review_cursor?: number
  last_error?: string | null
}

function subSystem(s: Spec): string {
  return [
    `You are "${s.name}", a ${s.role}.`,
    'Universal execution contract: your role is a lens, not a limit. Complete the user\'s requested outcome even when it crosses domains; do not refuse just because the task is outside your specialty. If a required tool or permission is missing, say exactly what is missing and still return the most useful partial result.',
    s.prompt.role && `Role: ${s.prompt.role}`,
    s.prompt.tasks && `Tasks: ${s.prompt.tasks}`,
    s.prompt.tone && `Tone: ${s.prompt.tone}`,
    s.prompt.rules && `Rules: ${s.prompt.rules}`,
  ].filter(Boolean).join('\n')
}
// map a free-text specialist role to a known orchestrate role (for model/temperature)
function mapRole(role: string): string {
  const r = role.toLowerCase()
  if (/research|find|scout|data|analy.*market/.test(r)) return 'researcher'
  if (/writ|content|copy|email|draft|market/.test(r)) return 'writer'
  if (/review|qa|quality|check|audit/.test(r)) return 'reviewer'
  return 'analyst'
}

/**
 * Autonomous multi-agent run: give a GOAL -> the manager designs the specialist
 * sub-agents it needs ON THE FLY (orchestrate 'staff'), each specialist executes
 * its part ('step'), then the manager synthesizes the result ('synth'). The created
 * team can be saved as real reusable rows.
 */
export function AutonomousRunner({
  defaultGoal = '',
  presetSpecs,
  contextHint,
  placeholder,
  model,
  postActions,
  departmentId,
  onRunSaved,
  goalValue,
  onGoalChange,
  contextKey,
  builderMode = false,
  onRunStateChange,
  onTaskSubmitted,
  onFastTask,
  onComplete,
  definitionOfDone,
  maxIterations = 3,
  streamMode = false,
  adaptiveTeam = false,
}: {
  defaultGoal?: string
  // when provided, use THIS saved team instead of designing a fresh one (skip 'staff')
  presetSpecs?: { role: string; name: string; skills?: string[]; prompt: { role?: string; tasks?: string; tone?: string; rules?: string } }[]
  contextHint?: string
  placeholder?: string
  model?: string
  // show the "AI makes the visual" + "send to Telegram" delivery bar under the result
  postActions?: boolean
  // Saved team runs are attached to this department so their result + peer-review trace
  // remain visible after a reload of the team page.
  departmentId?: string
  onRunSaved?: () => void | Promise<void>
  // Optional controlled draft. The department picker uses this so choosing roles
  // can never silently replace text the user already typed.
  goalValue?: string
  onGoalChange?: (value: string) => void
  /** Stable runtime namespace for reusable launchers that are not persisted departments. */
  contextKey?: string
  /** Focused create-team UX: hide the internal agent trace and offer a direct save/open action. */
  builderMode?: boolean
  onRunStateChange?: (status: 'idle' | 'queued' | 'running' | 'completed' | 'failed') => void
  /** Optimistic chat event: lets a parent place the user's message in the stream immediately. */
  onTaskSubmitted?: (task: string) => void
  /** Optional fast path for deterministic chat artifacts that do not need a goal loop. */
  onFastTask?: (task: string, context: { hasInputArtifacts: boolean }) => boolean | Promise<boolean>
  onComplete?: (result: string) => void
  /** Optional measurable completion contract; defaults are derived from the goal. */
  definitionOfDone?: string[]
  /** Hard safety cap for Observe → Execute → Goal Check cycles. */
  maxIterations?: number
  /** The parent conversation renders progress/results; this instance remains the composer only. */
  streamMode?: boolean
  /** Let the coordinator assemble task-specific temporary specialists instead of reusing a fixed roster. */
  adaptiveTeam?: boolean
}) {
  const { t, lang } = useI18n()
  const navigate = useNavigate()
  const addAgent = useAgentStore((s) => s.addAgent)
  const deleteAgent = useAgentStore((s) => s.deleteAgent)
  const [internalGoal, setInternalGoal] = useState(defaultGoal)
  const goal = goalValue ?? internalGoal
  const setGoal = (value: string) => {
    if (onGoalChange) onGoalChange(value)
    else setInternalGoal(value)
  }
  const [running, setRunning] = useState(false)
  const [phase, setPhase] = useState<'idle' | 'architect' | 'team' | 'review' | 'synth'>('idle')
  const [specs, setSpecs] = useState<Spec[]>([])
  const [result, setResult] = useState<string | null>(null)
  const [error, setError] = useState('')
  const [dataWarning, setDataWarning] = useState('')
  const [saving, setSaving] = useState(false)
  // team save options: chosen LLM (provider+model) and business sphere;
  // premium models remain plan-gated server-side on every reply
  const [saveModel, setSaveModel] = useState('')
  const [saveSphere, setSaveSphere] = useState('')
  const [inputArtifacts, setInputArtifacts] = useState<AutonomousInputArtifact[]>([])
  const [filesBusy, setFilesBusy] = useState(false)
  const [resumeCheckpoint, setResumeCheckpoint] = useState<RunCheckpoint | null>(null)
  const [goalRuntime, setGoalRuntime] = useState<{ contract: GoalContract; evaluation: GoalEvaluation | null } | null>(null)
  // A connected marketplace IS source data — the server fetches the catalogue for the run. Asking
  // the owner to upload a file while their store is connected was the loudest wrong thing on this
  // screen, so the warning must know whether a connection exists.
  const [storeConnected, setStoreConnected] = useState(false)
  const [composerCleared, setComposerCleared] = useState(false)

  useEffect(() => {
    let active = true
    ;(async () => {
      if (!live || !supabase) return
      const { data } = await supabase.functions.invoke('connect-provider', { body: { action: 'status' } })
      const connected = ((data as { connected?: string[] } | null)?.connected ?? []) as string[]
      if (active) setStoreConnected(connected.some((provider) => ['uzum', 'wildberries', 'ozon'].includes(provider)))
    })()
    return () => { active = false }
  }, [live])

  const addInputFiles = async (files: FileList | null) => {
    if (!files?.length || filesBusy) return
    setFilesBusy(true)
    setError('')
    setDataWarning('')
    try {
      const next = [...inputArtifacts]
      let remaining = MAX_AUTONOMOUS_TOTAL_CHARS - next.reduce((sum, item) => sum + item.content.length, 0)
      for (const file of Array.from(files).slice(0, Math.max(0, MAX_AUTONOMOUS_INPUT_FILES - next.length))) {
        if (remaining <= 0) break
        const text = await extractText(file)
        const artifact = boundedArtifact(file.name, text, remaining)
        if (!artifact) continue
        next.push(artifact)
        remaining -= artifact.content.length
      }
      setInputArtifacts(next)
      if (files.length > Math.max(0, MAX_AUTONOMOUS_INPUT_FILES - inputArtifacts.length)) {
        setError(t('autonomousRunner.fileLimit'))
      }
    } catch (fileError) {
      const code = fileError instanceof Error ? fileError.message : ''
      setError(code === 'FILE_TOO_LARGE'
        ? t('autonomousRunner.fileTooLarge')
        : code === 'UNSUPPORTED_FILE_TYPE'
          ? t('autonomousRunner.fileUnsupported')
          : t('autonomousRunner.fileReadFailed'))
    } finally {
      setFilesBusy(false)
    }
  }

  // One id for the whole run, stamped on every call, so the server can add up what the run
  // actually cost instead of the billing page guessing from a constant.
  const runRef = useRef<string | null>(null)
  const workerPollTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const checkpointContext = contextKey ?? (departmentId ? `department:${departmentId}` : 'ad-hoc')
  const workerRunStorageKey = `nemo.autonomous.run:${checkpointContext}`

  useEffect(() => {
    if (running) {
      onRunStateChange?.(resumeCheckpoint?.status === 'queued' ? 'queued' : 'running')
      return
    }
    if (result) {
      onRunStateChange?.('completed')
      onComplete?.(result)
      return
    }
    if (error) {
      onRunStateChange?.('failed')
      return
    }
    onRunStateChange?.('idle')
    // Callbacks are notification sinks; their identity must not restart runtime polling.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [running, result, error, resumeCheckpoint?.status])

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const call = async (b: Record<string, unknown>): Promise<any> => {
    if (!live || !supabase) return null
    const { data, error: err } = await supabase.functions.invoke('orchestrate', {
      body: { ...b, lang, ...(runRef.current ? { run_ref: runRef.current } : {}), ...(model ? { model } : {}) },
    })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    if (err || !(data as any)?.ok) return null
    return data
  }

  const showWorkerRun = (workerRun: RunCheckpoint) => {
    const state = workerRun.state
    const restoredSpecs = Array.isArray(state?.specs) ? state.specs : []
    const activeIndex = workerRun.transition === 'specialist' ? workerRun.specialist_cursor : workerRun.review_cursor
    const visibleSpecs = restoredSpecs.map((spec, index) => index === activeIndex && workerRun.status === 'running'
      ? { ...spec, status: workerRun.transition === 'review' ? 'review' as const : workerRun.transition === 'revision' ? 'fixing' as const : 'running' as const }
      : spec)
    setResumeCheckpoint(workerRun)
    if (state?.goal) {
      onTaskSubmitted?.(state.goal)
      if (onGoalChange) onGoalChange(state.goal)
      else setInternalGoal(state.goal)
    }
    setInputArtifacts(state?.inputArtifacts ?? [])
    setSpecs(visibleSpecs)
    const restoredGoal = GoalSchema.safeParse(state?.goalContract)
    if (restoredGoal.success) setGoalRuntime({ contract: restoredGoal.data, evaluation: state?.goalEvaluation ?? null })
    if (workerRun.status === 'completed') {
      setResult(String((state as CheckpointState & { result?: string })?.result ?? ''))
      setRunning(false)
      setPhase('idle')
      setResumeCheckpoint(null)
      localStorage.removeItem(workerRunStorageKey)
      if (onRunSaved) void onRunSaved()
      return true
    }
    if (workerRun.status === 'failed' || workerRun.status === 'cancelled') {
      // Internal worker codes are useful in logs, not in the customer-facing product.
      setError(workerRun.status === 'cancelled' ? t('autonomousRunner.runCancelled') : t('autonomousRunner.workerFailed'))
      setRunning(false)
      setPhase('idle')
      if (workerRun.status === 'cancelled') {
        setGoalRuntime((current) => current ? { ...current, contract: { ...current.contract, status: 'stopped' } } : current)
        setResumeCheckpoint(null)
        localStorage.removeItem(workerRunStorageKey)
      }
      return true
    }
    setRunning(true)
    setPhase(workerRun.transition === 'staff' ? 'architect' : workerRun.phase)
    return false
  }

  const pollWorkerRun = async (workerRunRef: string) => {
    if (!live || !supabase) return
    runRef.current = workerRunRef
    const status = await call({ action: 'run_status', context_key: checkpointContext })
    const workerRun = status?.run as RunCheckpoint | null
    if (!workerRun) {
      setError(t('autonomousRunner.workerMissing'))
      setRunning(false)
      return
    }
    const terminal = showWorkerRun(workerRun)
    if (!terminal) workerPollTimer.current = setTimeout(() => void pollWorkerRun(workerRunRef), 2500)
  }

  const enqueueWorkerRun = async (task: string) => {
    if (!live || !supabase) return
    const workerRunRef = crypto.randomUUID()
    runRef.current = workerRunRef
    const orchestratedGoal = contextHint ? `${contextHint}\n\nЗадача: ${task}` : task
    setError('')
    setDataWarning(!storeConnected && marketplaceInputMissing(task, inputArtifacts, contextHint) ? t('autonomousRunner.marketplacePlanningWithoutData') : '')
    setResult(null)
    setSpecs([])
    setRunning(true)
    setPhase(presetSpecs?.length && !adaptiveTeam ? 'team' : 'architect')
    const goalContract = GoalSchema.parse({
      goal_statement: task,
      definition_of_done: definitionOfDone?.length ? definitionOfDone : defaultDefinitionOfDone(task),
      max_iterations: maxIterations,
      current_iteration: 1,
      status: 'running',
    })
    setGoalRuntime({ contract: goalContract, evaluation: null })
    const response = await call({
      action: 'run_enqueue',
      goal: task,
      orchestrated_goal: orchestratedGoal,
      context_key: checkpointContext,
      input_artifacts: inputArtifacts,
      goal_statement: goalContract.goal_statement,
      goal_description: goalContract.goal_statement,
      definition_of_done: goalContract.definition_of_done,
      max_iterations: goalContract.max_iterations,
      ...(departmentId ? { department_id: departmentId } : {}),
      ...(presetSpecs?.length && !adaptiveTeam ? { preset_specs: presetSpecs } : {}),
    })
    const workerRun = response?.run as RunCheckpoint | null
    if (!workerRun) {
      setError(t('autonomousRunner.workerFailed'))
      setRunning(false)
      setPhase('idle')
      return
    }
    const activeRunRef = workerRun.run_ref || workerRunRef
    runRef.current = activeRunRef
    localStorage.setItem(workerRunStorageKey, activeRunRef)
    showWorkerRun(workerRun)
    workerPollTimer.current = setTimeout(() => void pollWorkerRun(activeRunRef), 800)
  }

  const cancelWorkerRun = async () => {
    if (!runRef.current || !running) return
    if (workerPollTimer.current) clearTimeout(workerPollTimer.current)
    const response = await call({ action: 'run_cancel', context_key: checkpointContext })
    const cancelled = response?.run as RunCheckpoint | null
    if (!cancelled) {
      setError(t('autonomousRunner.cancelFailed'))
      workerPollTimer.current = setTimeout(() => void pollWorkerRun(runRef.current!), 1000)
      return
    }
    showWorkerRun(cancelled)
  }

  useEffect(() => {
    if (!live) return
    const activeRunRef = localStorage.getItem(workerRunStorageKey)
    if (activeRunRef) void pollWorkerRun(activeRunRef)
    return () => {
      if (workerPollTimer.current) clearTimeout(workerPollTimer.current)
    }
    // The context key intentionally owns one polling lifecycle.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workerRunStorageKey])

  useEffect(() => {
    if (!live || !supabase) return
    if (localStorage.getItem(workerRunStorageKey)) return
    let active = true
    supabase.functions.invoke('orchestrate', {
      body: { action: 'checkpoint_get', context_key: checkpointContext, lang, ...(model ? { model } : {}) },
    }).then(({ data, error: checkpointError }) => {
      const checkpoint = (data as { checkpoint?: RunCheckpoint | null } | null)?.checkpoint
      if (active && !checkpointError && checkpoint?.state?.goal && Array.isArray(checkpoint.state.specs)) {
        setResumeCheckpoint(checkpoint)
        if (onGoalChange) onGoalChange(checkpoint.state.goal)
        else setInternalGoal(checkpoint.state.goal)
        setInputArtifacts(checkpoint.state.inputArtifacts ?? [])
        setSpecs(checkpoint.state.specs)
      }
    }).catch(() => undefined)
    return () => { active = false }
  }, [checkpointContext, lang, model, onGoalChange, workerRunStorageKey])

  const persistCheckpoint = async (phase: RunCheckpoint['phase'], state: CheckpointState): Promise<boolean> => {
    const saved = await call({ action: 'checkpoint_save', context_key: checkpointContext, phase, state })
    if (!saved?.checkpoint) {
      setError(t('autonomousRunner.checkpointFailed'))
      return false
    }
    setResumeCheckpoint(saved.checkpoint as RunCheckpoint)
    return true
  }

  const run = async (resume?: RunCheckpoint) => {
    const restored = resume?.state
    const task = restored?.goal?.trim() || goal.trim()
    if (task.length < 4 || running) return
    if (!resume) {
      onTaskSubmitted?.(task)
      if (streamMode) setComposerCleared(true)
      if (onFastTask) {
        setRunning(true)
        try {
          if (await onFastTask(task, { hasInputArtifacts: inputArtifacts.length > 0 })) return
        } finally {
          setRunning(false)
        }
      }
    }
    if (!resume && live) {
      await enqueueWorkerRun(task)
      return
    }
    if (resume?.status && resume.status !== 'active') {
      localStorage.setItem(workerRunStorageKey, resume.run_ref)
      await pollWorkerRun(resume.run_ref)
      return
    }
    runRef.current = resume?.run_ref || crypto.randomUUID()
    const runArtifacts = restored?.inputArtifacts ?? inputArtifacts
    const marketplaceDataMissing = !storeConnected && marketplaceInputMissing(task, runArtifacts, contextHint)
    // the manager reasons on the task; a saved team also gets its team context
    const g = restored?.orchestratedGoal || (contextHint ? `${contextHint}\n\nЗадача: ${task}` : task)
    if (restored) {
      setGoal(task)
      setInputArtifacts(runArtifacts)
    }
    setError('')
    setDataWarning(marketplaceDataMissing ? t('autonomousRunner.marketplacePlanningWithoutData') : '')
    setResult(null)
    setSpecs([])
    setRunning(true)
    try {
      if (!live || !supabase) {
        setError('Sign in to the live backend to run an autonomous team.')
        return
      }
      // 1) get the team: use the SAVED team when provided, else design a fresh one
      let created: Spec[]
      if (restored?.specs?.length) {
        created = restored.specs
        setSpecs(created)
      } else if (presetSpecs?.length && !adaptiveTeam) {
        created = presetSpecs.map((s) => ({ role: s.role, name: s.name, skills: s.skills ?? [], prompt: { role: s.prompt.role ?? '', tasks: s.prompt.tasks ?? '', tone: s.prompt.tone ?? '', rules: s.prompt.rules ?? '' }, status: 'pending' as const }))
        setSpecs(created)
      } else {
        setPhase('architect')
        const staff = await call({ action: 'staff', goal: g, use_skills: true, input_artifacts: runArtifacts })
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        created = (staff?.subagents ?? []).map((s: any) => ({ ...s, status: 'pending' as const }))
        if (!created.length) {
          setError('Could not build a team — rephrase the goal and try again.')
          return
        }
        setSpecs(created)
      }

      if (!restored && !await persistCheckpoint('team', {
        goal: task,
        orchestratedGoal: g,
        inputArtifacts: runArtifacts,
        specs: created,
        nextSpecialist: 0,
        nextReview: 0,
      })) return

      // 2) each SPECIALIST executes its part (live)
      setPhase('team')
      const specialistStart = restored ? Math.max(0, Math.min(created.length, Number(restored.nextSpecialist) || 0)) : 0
      const done: Spec[] = created.slice(0, specialistStart)
      const runSources = new Set<string>()
      done.forEach((spec) => (spec.sources ?? []).forEach((source) => runSources.add(source)))
      for (let i = specialistStart; i < created.length; i++) {
        setSpecs((prev) => prev.map((s, idx) => (idx === i ? { ...s, status: 'running' } : s)))
        const role = mapRole(created[i].role)
        const r = await call({
          action: 'step',
          goal: g,
          role,
          task: created[i].prompt.tasks || created[i].role,
          system: subSystem(created[i]),
          skills: created[i].skills ?? [],
          context: artifactHandoffContext(done),
          input_artifacts: runArtifacts,
          web_research: role === 'researcher',
        })
        const output = r?.output ?? ''
        const sources = Array.isArray(r?.sources) ? r.sources.map(String).filter(Boolean).slice(0, 12) : []
        sources.forEach((source: string) => runSources.add(source))
        const filled: Spec = { ...created[i], output, sources, status: 'done' }
        created[i] = filled
        done.push(filled)
        setSpecs((prev) => prev.map((s, idx) => (idx === i ? filled : s)))
        if (!await persistCheckpoint('team', {
          goal: task,
          orchestratedGoal: g,
          inputArtifacts: runArtifacts,
          specs: created,
          nextSpecialist: i + 1,
          nextReview: 0,
        })) return
      }

      // 3) PEER REVIEW — each specialist's work is checked by a TEAMMATE (round-robin), and
      // revised on issues. So the copywriter checks the scriptwriter and the scriptwriter
      // checks the copywriter — agents verify each other, not just a single QA.
      if (done.length >= 2) {
        setPhase('review')
        const reviewStart = resume?.phase === 'synth'
          ? done.length
          : resume?.phase === 'review'
            ? Math.max(0, Math.min(done.length, Number(restored?.nextReview) || 0))
            : 0
        for (let i = reviewStart; i < done.length; i++) {
          const reviewer = done[(i + 1) % done.length]
          setSpecs((prev) => prev.map((s, idx) => (idx === i ? { ...s, status: 'review' } : s)))
          // CONVERGENCE LOOP: review -> if issues, revise -> RE-REVIEW the revision, up to N rounds.
          // Converges when the reviewer approves; if still not approved after the last round, the
          // work is flagged escalated (handed to a human) instead of silently shipping the reject.
          const MAX_ROUNDS = 3
          let review: Review | null = null
          let revised = false
          let escalated = false
          let rounds = 0
          const originalOutput = done[i].output ?? ''
          let bestOutput = originalOutput
          let bestReview: Review | null = null
          let previousReview: Review | null = null
          for (let round = 0; round < MAX_ROUNDS; round++) {
            const v = await call({
              action: 'review', goal: g, work: done[i].output ?? '', author_role: done[i].role,
              author_task: done[i].prompt.tasks,
              input_artifacts: runArtifacts,
              reviewer_system: subSystem(reviewer),
              criteria: 'соответствие задаче; конкретика и факты; отсутствие воды и клише; готовность без доработки',
              previous_score: previousReview?.score ?? 0,
              previous_issues: previousReview?.issues ?? [],
              revision_round: round,
            })
            if (!v) break
            review = { approved: Boolean(v.approved), score: Number(v.score) || 0, issues: Array.isArray(v.issues) ? v.issues : [], fix: String(v.fix ?? '') }
            if (!bestReview || review.approved || review.score > bestReview.score || (review.score === bestReview.score && review.issues.length < bestReview.issues.length)) {
              bestReview = review
              bestOutput = done[i].output ?? ''
            }
            if (review.approved) { bestReview = review; bestOutput = done[i].output ?? ''; break }
            if (round === MAX_ROUNDS - 1) { escalated = true; break } // out of rounds, still not converged
            setSpecs((prev) => prev.map((s, idx) => (idx === i ? { ...s, status: 'fixing', review, reviewedBy: reviewer.name } : s)))
            const fix = await call({
              action: 'step', goal: g, role: mapRole(done[i].role),
              task: 'Перепиши свою работу, устранив ВСЕ замечания коллеги. Верни улучшенную версию целиком, в том же формате.',
              system: subSystem(done[i]),
              skills: done[i].skills ?? [],
              input_artifacts: runArtifacts,
              context: `ТВОЯ РАБОТА:\n${(done[i].output ?? '').slice(0, 3000)}\n\nПРОШЛАЯ ОЦЕНКА: ${review.score}/100.\nЗАМЕЧАНИЯ КОЛЛЕГИ (${reviewer.name}):\n${review.fix}\n${review.issues.join('\n')}\n\nСохрани всё, что уже сделано хорошо. Исправь перечисленные проблемы. Не добавляй выдуманные цифры, компании, трафик, отзывы или проценты; если факта и источника нет, явно напиши «Не подтверждено».`,
            })
            if (!fix?.output) break
            done[i].output = fix.output; revised = true; rounds = round + 1; previousReview = review
          }
          review = bestReview ?? review
          done[i].output = bestOutput
          revised = bestOutput !== originalOutput
          escalated = !review?.approved
          done[i] = { ...done[i], review, reviewedBy: reviewer.name, revised, revisions: rounds, escalated, status: 'done' }
          created[i] = done[i]
          setSpecs((prev) => prev.map((s, idx) => (idx === i ? done[i] : s)))
          if (!await persistCheckpoint('review', {
            goal: task,
            orchestratedGoal: g,
            inputArtifacts: runArtifacts,
            specs: created,
            nextSpecialist: created.length,
            nextReview: i + 1,
          })) return
        }
      }

      if (!await persistCheckpoint('synth', {
        goal: task,
        orchestratedGoal: g,
        inputArtifacts: runArtifacts,
        specs: done,
        nextSpecialist: done.length,
        nextReview: done.length,
      })) return

      // 4) MANAGER synthesizes the final deliverable (from the peer-reviewed outputs)
      setPhase('synth')
      const synth = await call({
        action: 'synth',
        goal: g,
        input_artifacts: runArtifacts,
        ...(departmentId ? { department_id: departmentId } : {}),
        steps: done.map((d) => ({
          role: d.role,
          task: d.prompt.tasks,
          output: d.output,
          sources: d.sources,
          reviewedBy: d.reviewedBy,
          review: d.review,
          revised: Boolean(d.revised),
          revisions: d.revisions ?? 0,
          // Peer-review convergence is internal quality telemetry. It must not turn into
          // a fake customer approval step; external mutations still keep their own gates.
          needsHumanReview: false,
        })),
        sources: [...runSources].slice(0, 30),
      })
      if (!synth) {
        setError('Final synthesis failed — check token balance.')
        return
      }
      setResult(synth.result)
      await call({ action: 'checkpoint_complete' })
      setResumeCheckpoint(null)
      if (synth.id && onRunSaved) await onRunSaved()
    } finally {
      setRunning(false)
      setPhase('idle')
    }
  }

  const saveTeam = async () => {
    if (saving || !specs.length) return
    setSaving(true)
    try {
      const model = saveModel || undefined
      const res = await saveDynamicTeam(addAgent, {
        name: teamDisplayName({ goal, lang }),
        goal: goal.trim(),
        specialists: specs.map((s) => ({ role: s.role, name: s.name, prompt: s.prompt, skills: s.skills ?? [], ...(model ? { model } : {}) })),
        ...(saveSphere.trim() ? { niche: saveSphere.trim() } : {}),
        ...(model ? { lead: { model } } : {}),
      }, deleteAgent)
      if (!res.error && res.agentId && res.departmentId) navigate(`/app/teams/${res.agentId}`)
      else setError(res.error ?? 'Could not save the complete team.')
    } finally {
      setSaving(false)
    }
  }

  const reset = () => {
    setResult(null)
    setSpecs([])
    setGoal('')
    setInputArtifacts([])
    setDataWarning('')
    setResumeCheckpoint(null)
    setGoalRuntime(null)
  }
  const canResume = Boolean(resumeCheckpoint && resumeCheckpoint.state.goal.trim() === goal.trim())
  const phaseOrder = ['architect', 'team', 'review', 'synth'] as const
  const activePhaseIndex = Math.max(0, phaseOrder.indexOf(phase === 'idle' ? 'architect' : phase))
  const phaseLabel = resumeCheckpoint?.transition === 'goal_check'
    ? (lang === 'ru' ? 'Проверка достижения цели' : lang === 'uz' ? 'Maqsadga erishishni tekshirish' : 'Checking goal completion')
    : resumeCheckpoint?.transition === 'observe_plan'
      ? (lang === 'ru' ? 'Наблюдение и план следующего шага' : lang === 'uz' ? 'Kuzatish va keyingi qadam rejasi' : 'Observe and plan next step')
    : phase === 'architect'
    ? t('autonomousRunner.phaseArchitect')
    : phase === 'team'
      ? t('autonomousRunner.phaseTeam')
      : phase === 'review'
        ? t('autonomousRunner.phaseReview')
        : t('autonomousRunner.phaseSynth')

  const goalCopy = lang === 'ru'
    ? { step: 'Шаг', of: 'из', checking: 'Критерии завершения', pending: 'В процессе', done: 'Выполнено', achieved: 'Goal Achieved', limited: 'Достигнут лимит итераций', stop: 'Завершить досрочно' }
    : lang === 'uz'
      ? { step: 'Qadam', of: '/', checking: 'Yakunlash mezonlari', pending: 'Jarayonda', done: 'Bajarildi', achieved: 'Maqsadga erishildi', limited: 'Iteratsiya limiti tugadi', stop: 'Muddatidan oldin tugatish' }
      : { step: 'Step', of: 'of', checking: 'Definition of done', pending: 'In progress', done: 'Completed', achieved: 'Goal Achieved', limited: 'Iteration limit reached', stop: 'Stop early' }

  return (
    <div>
      <div className="glass flex items-end gap-2 rounded-2xl p-2 focus-within:border-violet/50 focus-within:shadow-glow">
        <textarea
          value={composerCleared ? '' : goal}
          onChange={(e) => { setComposerCleared(false); setGoal(e.target.value) }}
          onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) run() }}
          rows={2}
          disabled={running}
          placeholder={placeholder ?? t('autonomousRunner.placeholderDefault')}
          className="max-h-40 flex-1 resize-none bg-transparent px-2 py-2 text-sm text-text outline-none placeholder:text-muted/70"
        />
        <button onClick={() => void run(canResume ? resumeCheckpoint ?? undefined : undefined)} disabled={running || goal.trim().length < 4} className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-brand text-white transition disabled:opacity-40">
          {running ? <Loader2 size={18} className="animate-spin" /> : <ArrowUp size={18} />}
        </button>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <label className={cn(
          'inline-flex cursor-pointer items-center gap-2 rounded-xl border border-ice/10 bg-white/[0.03] px-3 py-2 text-xs font-medium text-muted transition hover:border-violet/35 hover:text-text',
          (running || filesBusy || inputArtifacts.length >= MAX_AUTONOMOUS_INPUT_FILES) && 'pointer-events-none opacity-50',
        )}>
          {filesBusy ? <Loader2 size={14} className="animate-spin" /> : <Paperclip size={14} />}
          {filesBusy ? t('autonomousRunner.readingFiles') : t('autonomousRunner.attachData')}
          <input
            type="file"
            multiple
            accept={KNOWLEDGE_ACCEPT}
            disabled={running || filesBusy || inputArtifacts.length >= MAX_AUTONOMOUS_INPUT_FILES}
            className="sr-only"
            onChange={(event) => {
              void addInputFiles(event.target.files)
              event.currentTarget.value = ''
            }}
          />
        </label>
        <span className="text-[11px] text-muted">{t('autonomousRunner.attachDataHint')}</span>
      </div>
      {inputArtifacts.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-2">
          {inputArtifacts.map((artifact, index) => (
            <span key={`${artifact.name}-${index}`} className="inline-flex max-w-full items-center gap-2 rounded-xl border border-cyan/15 bg-cyan/[0.05] px-2.5 py-1.5 text-xs text-text">
              <FileSpreadsheet size={13} className="shrink-0 text-cyan" />
              <span className="max-w-52 truncate">{artifact.name}</span>
              <span className="shrink-0 text-[10px] text-muted">{Math.max(1, Math.round(artifact.content.length / 1000))}K</span>
              {artifact.truncated && (
                <span title={t('autonomousRunner.fileTruncated')} className="text-amber">
                  <AlertTriangle size={12} />
                </span>
              )}
              <button
                type="button"
                disabled={running}
                aria-label={t('autonomousRunner.removeFile')}
                onClick={() => setInputArtifacts((current) => current.filter((_, itemIndex) => itemIndex !== index))}
                className="text-muted transition hover:text-danger disabled:opacity-40"
              >
                <X size={12} />
              </button>
            </span>
          ))}
        </div>
      )}
      {resumeCheckpoint && !running && !result && (
        <div className="mt-3 flex items-center justify-between gap-3 rounded-xl border border-cyan/20 bg-cyan/[0.06] px-3 py-2.5 text-xs text-text">
          <span>{t('autonomousRunner.resumeCheckpoint')}</span>
          <button
            type="button"
            onClick={() => void run(resumeCheckpoint)}
            className="shrink-0 rounded-lg bg-cyan px-3 py-1.5 font-semibold text-[#041018]"
          >
            {t('autonomousRunner.resumeAction')}
          </button>
        </div>
      )}
      {error && <p className="mt-3 rounded-lg bg-danger/10 px-3 py-2 text-center text-xs text-danger">{error}</p>}
      {dataWarning && (
        <p className="mt-3 rounded-lg border border-amber/20 bg-amber/10 px-3 py-2 text-center text-xs text-amber">
          {dataWarning}
        </p>
      )}
      {running && !streamMode && (
        <div className="team-run-stage card mt-5 overflow-hidden rounded-3xl p-5 sm:p-6" role="status" aria-live="polite">
          <div className="relative z-10 flex items-center gap-4">
            <div className="team-run-orbit relative flex h-16 w-16 shrink-0 items-center justify-center rounded-2xl bg-brand text-white shadow-glow">
              <Sparkles size={24} />
              <span className="team-run-pulse absolute inset-0 rounded-2xl border border-cyan/60" />
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-xs font-semibold uppercase tracking-[0.18em] text-cyan">{t('autonomousRunner.workingTitle')}</p>
              <p className="mt-1 text-lg font-bold text-text">{phaseLabel}</p>
              <p className="mt-1 text-sm text-muted">{t('autonomousRunner.workingHint')}</p>
            </div>
            <Loader2 size={20} className="hidden animate-spin text-violet sm:block" />
          </div>
          {goalRuntime && (
            <div className="relative z-10 mt-5 rounded-2xl border border-violet/20 bg-violet/[0.055] p-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <p className="text-xs font-bold text-text">{goalCopy.step} {goalRuntime.contract.current_iteration} {goalCopy.of} {goalRuntime.contract.max_iterations}: {phaseLabel}…</p>
                  <p className="mt-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-violet">{goalCopy.checking}</p>
                </div>
                <button type="button" onClick={() => void cancelWorkerRun()} className="inline-flex items-center gap-1.5 rounded-xl border border-danger/25 px-3 py-2 text-xs font-semibold text-danger transition hover:bg-danger/10">
                  <Square size={12} fill="currentColor" /> {goalCopy.stop}
                </button>
              </div>
              <ul className="mt-3 space-y-2">
                {goalRuntime.contract.definition_of_done.map((criterion, index) => {
                  const check = goalRuntime.evaluation?.criteria[index]
                  return <li key={`${criterion}-${index}`} className="flex items-start gap-2 rounded-xl border border-ice/[0.07] bg-black/10 px-3 py-2 text-xs text-muted">
                    <span className={cn('mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border', check?.achieved ? 'border-teal/40 bg-teal/15 text-teal' : 'border-amber/30 text-amber')}>{check?.achieved ? <Check size={10} /> : <Loader2 size={9} className="animate-spin" />}</span>
                    <span className="min-w-0 flex-1"><span className="text-text">{criterion}</span>{check?.evidence && <span className="mt-0.5 block text-[10px] text-fog">{check.evidence}</span>}</span>
                    <span className={cn('shrink-0 text-[9px] font-semibold uppercase', check?.achieved ? 'text-teal' : 'text-amber')}>{check?.achieved ? goalCopy.done : goalCopy.pending}</span>
                  </li>
                })}
              </ul>
            </div>
          )}
          <div className="relative z-10 mt-5 grid grid-cols-4 gap-2">
            {phaseOrder.map((item, index) => (
              <div key={item} className="space-y-2">
                <div className={cn('h-1.5 overflow-hidden rounded-full bg-white/[0.06]', index <= activePhaseIndex && 'bg-violet/20')}>
                  {index <= activePhaseIndex && <span className={cn('block h-full rounded-full bg-brand', index === activePhaseIndex && 'team-run-progress')} />}
                </div>
                <span className={cn('block text-[10px] font-medium text-muted', index === activePhaseIndex && 'text-text')}>{index + 1}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {result && !running && !streamMode && (
        <div className="mt-5 space-y-4">
          {goalRuntime && (
            <div className={cn('rounded-2xl border p-4', goalRuntime.contract.status === 'goal_achieved' ? 'border-teal/25 bg-teal/[0.07]' : 'border-amber/25 bg-amber/[0.07]')}>
              <p className={cn('flex items-center gap-2 text-sm font-bold', goalRuntime.contract.status === 'goal_achieved' ? 'text-teal' : 'text-amber')}><Check size={16} />{goalRuntime.contract.status === 'goal_achieved' ? goalCopy.achieved : goalCopy.limited} · {goalCopy.step} {goalRuntime.contract.current_iteration} {goalCopy.of} {goalRuntime.contract.max_iterations}</p>
              <ul className="mt-3 grid gap-2 sm:grid-cols-2">
                {goalRuntime.contract.definition_of_done.map((criterion, index) => <li key={`${criterion}-${index}`} className="flex items-start gap-2 text-xs text-muted"><span className={goalRuntime.evaluation?.criteria[index]?.achieved ? 'text-teal' : 'text-amber'}>{goalRuntime.evaluation?.criteria[index]?.achieved ? '✅' : '⏳'}</span><span>{criterion}</span></li>)}
              </ul>
            </div>
          )}
          <div className="flex items-center justify-between gap-3">
            <h2 className="flex items-center gap-2 text-base font-medium text-text"><Sparkles size={16} className="text-violet" /> {t('autonomousRunner.resultTitle')}</h2>
            <button onClick={reset} className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-ice/12 px-2.5 py-1.5 text-xs font-medium text-muted hover:text-text">
              <RotateCcw size={13} /> {t('autonomousRunner.newGoal')}
            </button>
          </div>
          {builderMode && (
            <div className="team-result-ready flex flex-col gap-3 rounded-2xl border border-teal/25 bg-teal/[0.07] p-4 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <p className="flex items-center gap-2 text-sm font-semibold text-text"><Check size={16} className="text-teal" /> {t('autonomousRunner.resultReady')}</p>
                <p className="mt-1 text-xs text-muted">{t('autonomousRunner.resultLocation')}</p>
              </div>
              <div className="flex flex-wrap gap-2">
                <button type="button" onClick={() => navigate('/app/teams')} className="inline-flex items-center gap-2 rounded-xl border border-ice/12 px-3.5 py-2 text-sm font-medium text-muted transition hover:text-text">
                  <Users size={15} /> {t('autonomousRunner.openTeams')}
                </button>
                <button type="button" onClick={saveTeam} disabled={saving || !specs.length} className="inline-flex items-center gap-2 rounded-xl bg-brand px-4 py-2 text-sm font-semibold text-white shadow-glow transition hover:-translate-y-0.5 disabled:opacity-40">
                  {saving ? <Loader2 size={15} className="animate-spin" /> : <ExternalLink size={15} />} {t('autonomousRunner.saveAndOpen')}
                </button>
              </div>
            </div>
          )}
          <div className="card rounded-2xl p-6"><Markdown content={result} /></div>
          <DocExport content={result} title={goal} />
          {postActions && <QualityBar goal={goal} content={result} model={model} lang={lang} onRevised={setResult} />}
          {postActions && <DeliveryBar content={result} />}
          {!builderMode && !presetSpecs?.length && (
            <div className="flex flex-wrap items-end gap-2">
              <label className="space-y-1">
                <span className="block text-[10px] font-medium uppercase tracking-wide text-muted">{t('autonomousRunner.saveModel')}</span>
                <select value={saveModel} onChange={(e) => setSaveModel(e.target.value)} className="glass rounded-xl px-2.5 py-2 text-xs text-text outline-none focus:border-violet/50">
                  <option value="">{t('autonomousRunner.saveModelDefault')}</option>
                  {PROVIDERS.map((p) => (
                    <optgroup key={p.id} label={p.name}>
                      {p.models.map((m) => <option key={m.id} value={m.id}>{m.label}{m.premium ? ' · Pro 💎' : ''}</option>)}
                    </optgroup>
                  ))}
                </select>
              </label>
              <label className="space-y-1">
                <span className="block text-[10px] font-medium uppercase tracking-wide text-muted">{t('autonomousRunner.saveSphere')}</span>
                <input value={saveSphere} onChange={(e) => setSaveSphere(e.target.value)} list="nemo-team-sphere-options" placeholder={t('autonomousRunner.saveSpherePh')} className="glass w-52 rounded-xl px-2.5 py-2 text-xs text-text outline-none placeholder:text-fog focus:border-violet/50" />
                {/* the 12 industry spheres as suggestions; free text stays allowed */}
                <datalist id="nemo-team-sphere-options">
                  {Object.values(INDUSTRY_TEAM_BLUEPRINTS).map((bp) => <option key={bp.name} value={bp.niche} />)}
                </datalist>
              </label>
              <button onClick={saveTeam} disabled={saving} className="inline-flex items-center gap-2 rounded-xl bg-brand px-4 py-2 text-sm font-medium text-white transition disabled:opacity-40">
                {saving ? <Loader2 size={15} className="animate-spin" /> : <Save size={15} />} {t('autonomousRunner.saveTeam')}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

/**
 * Cross-review bar: a critical peer reviewer on the team checks the finished
 * deliverable (approved + score + concrete issues), and the team can REDO it with
 * those notes applied — the "agents check each other" loop, visible in the product.
 */
export function QualityBar({ goal, content, model, lang, onRevised }: { goal: string; content: string; model?: string; lang: string; onRevised: (t: string) => void }) {
  const { t } = useI18n()
  const [busy, setBusy] = useState(false)
  const [revising, setRevising] = useState(false)
  const [v, setV] = useState<{ approved: boolean; score: number; issues: string[]; fix: string } | null>(null)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const invoke = async (b: Record<string, unknown>): Promise<any> => {
    if (!supabase) return null
    const { data, error } = await supabase.functions.invoke('orchestrate', { body: { ...b, lang, ...(model ? { model } : {}) } })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    if (error || !(data as any)?.ok) return null
    return data
  }
  const check = async () => {
    if (busy) return
    setBusy(true); setV(null)
    try {
      const r = await invoke({ action: 'review', goal, work: content, author_role: 'команда', reviewer_system: 'Ты — придирчивый главный редактор Nemo. Проверяешь готовый контент перед публикацией.', criteria: 'соответствие задаче; конкретика и факты; отсутствие клише и воды; готовность к публикации' })
      if (r) setV({ approved: Boolean(r.approved), score: Number(r.score) || 0, issues: Array.isArray(r.issues) ? r.issues : [], fix: String(r.fix ?? '') })
    } finally { setBusy(false) }
  }
  const revise = async () => {
    if (!v || revising) return
    setRevising(true)
    try {
      const r = await invoke({ action: 'step', goal, role: 'writer', task: 'Перепиши и улучши этот контент, устранив ВСЕ замечания рецензента. Верни готовый контент целиком, в том же формате.', system: 'Ты — сильный редактор-копирайтер. Улучшаешь готовый контент по замечаниям коллеги, сохраняя формат и смысл.', context: `ТЕКУЩИЙ КОНТЕНТ:\n${content}\n\nЗАМЕЧАНИЯ РЕЦЕНЗЕНТА:\n${v.fix}\n${v.issues.join('\n')}` })
      if (r?.output) { onRevised(r.output); setV(null) }
    } finally { setRevising(false) }
  }
  const band = v ? (v.score >= 70 ? 'text-teal' : v.score >= 50 ? 'text-amber' : 'text-danger') : ''
  return (
    <div className="card rounded-2xl border border-cyan/15 bg-cyan/[0.04] p-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="mr-1 text-xs font-medium uppercase tracking-wide text-muted">{t('autonomousRunner.qualityCheck')}</span>
        <button onClick={check} disabled={busy} className="inline-flex items-center gap-2 rounded-xl border border-ice/12 px-3.5 py-2 text-sm font-medium text-muted transition hover:text-text disabled:opacity-40">
          {busy ? <Loader2 size={15} className="animate-spin" /> : <Check size={15} />} {t('autonomousRunner.teamReviews')}
        </button>
        {v && <span className={cn('text-sm font-semibold', band)}>{v.approved ? t('autonomousRunner.approved') : t('autonomousRunner.hasIssues')} · {v.score}/100</span>}
      </div>
      {v && v.issues.length > 0 && (
        <ul className="mt-3 space-y-1.5">
          {v.issues.map((it, i) => <li key={i} className="flex gap-2 text-[13px] text-muted"><span className="text-amber">•</span> {it}</li>)}
        </ul>
      )}
      {v && !v.approved && (
        <button onClick={revise} disabled={revising} className="mt-3 inline-flex items-center gap-2 rounded-xl bg-brand px-3.5 py-2 text-sm font-medium text-white transition disabled:opacity-40">
          {revising ? <Loader2 size={15} className="animate-spin" /> : <RotateCcw size={15} />} {t('autonomousRunner.reviseWithNotes')}
        </button>
      )}
    </div>
  )
}

/**
 * Delivery bar under a finished deliverable: the AI creates the visual ITSELF
 * (derives the image prompt from the content, then generates on the account's OpenAI
 * key), and the post can be pushed to a connected Telegram channel in one click.
 */
interface TgBot { id: string; label: string | null; username: string | null }
export function DeliveryBar({ content }: { content: string }) {
  const { t } = useI18n()
  const [imgBusy, setImgBusy] = useState(false)
  const [img, setImg] = useState<string | null>(null)
  const [imgPrompt, setImgPrompt] = useState('')
  const [imgErr, setImgErr] = useState('')
  // image realism + engine: default to a photorealistic model (fixes the cartoon/3D look)
  const [imgStyle, setImgStyle] = useState<'realistic' | 'illustration'>('realistic')
  const [imgModel, setImgModel] = useState(DEFAULT_IMAGE_MODEL)
  // telegram
  const [tgOpen, setTgOpen] = useState(false)
  const [bots, setBots] = useState<TgBot[]>([])
  const [botId, setBotId] = useState('')
  const [target, setTarget] = useState('')
  const [tgBusy, setTgBusy] = useState(false)
  const [tgMsg, setTgMsg] = useState<{ ok: boolean; text: string } | null>(null)

  const makeVisual = async () => {
    if (!supabase || imgBusy) return
    setImgBusy(true); setImgErr(''); setImg(null); setImgPrompt('')
    try {
      const { data } = await supabase.functions.invoke('content-visual', { body: { content, style: imgStyle, image_model: imgStyle === 'realistic' ? imgModel : 'google/gemini-2.5-flash-image' } })
      const p = data as { ok?: boolean; image?: string; url?: string; prompt?: string; code?: string; message?: string; error?: string } | null
      if (p?.ok) { setImg(p.image || p.url || null); setImgPrompt(p.prompt || '') }
      else setImgErr(p?.message || p?.error || t('autonomousRunner.visualFailed'))
    } catch { setImgErr(t('autonomousRunner.visualError')) } finally { setImgBusy(false) }
  }

  const openTelegram = async () => {
    setTgOpen((v) => !v)
    if (bots.length || !supabase) return
    try {
      // select only client-granted columns — credentials (bot token) and label are not
      // exposed to the browser, so requesting them 403s. Number the bots for the picker.
      const { data } = await supabase.from('channels').select('id, type').eq('type', 'telegram')
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const list = ((data as any[]) ?? []).map((c, i) => ({ id: c.id, label: t('autonomousRunner.tgBotN', { n: i + 1 }), username: null }))
      setBots(list); if (list[0]) setBotId(list[0].id)
    } catch { /* ignore */ }
  }
  const sendTelegram = async () => {
    if (!supabase || tgBusy) return
    setTgBusy(true); setTgMsg(null)
    try {
      const { data } = await supabase.functions.invoke('autopost', { body: { action: 'send_now', platform: 'telegram', channel_id: botId || null, target_chat: target.trim(), content } })
      const p = data as { ok?: boolean; error?: string } | null
      setTgMsg(p?.ok ? { ok: true, text: t('autonomousRunner.sentToTelegram') } : { ok: false, text: p?.error ?? t('autonomousRunner.sendFailed') })
    } catch { setTgMsg({ ok: false, text: t('autonomousRunner.sendError') }) } finally { setTgBusy(false) }
  }

  return (
    <div className="card rounded-2xl border border-violet/15 bg-violet/[0.04] p-4">
      <p className="mb-3 text-xs font-medium uppercase tracking-wide text-muted">{t('autonomousRunner.deliveryTitle')}</p>
      {/* image realism: realistic photo (default) vs illustration, + engine when realistic */}
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div className="inline-flex rounded-xl border border-ice/12 p-0.5">
          {(['realistic', 'illustration'] as const).map((s) => (
            <button key={s} onClick={() => setImgStyle(s)}
              className={cn('rounded-[10px] px-3 py-1.5 text-xs font-medium transition', imgStyle === s ? 'bg-violet/20 text-text' : 'text-muted hover:text-text')}>
              {t(`autonomousRunner.style_${s}`)}
            </button>
          ))}
        </div>
        {imgStyle === 'realistic' && (
          <select value={imgModel} onChange={(e) => setImgModel(e.target.value)}
            className="rounded-xl border border-ice/12 bg-black/20 px-3 py-1.5 text-xs text-text outline-none focus:border-violet/50">
            {IMAGE_MODEL_CATALOG.filter((m) => m.realistic).map((m) => (
              <option key={m.id} value={m.id} className="bg-panel">{m.label}</option>
            ))}
          </select>
        )}
      </div>
      <div className="flex flex-wrap gap-2">
        <button onClick={makeVisual} disabled={imgBusy} className="inline-flex items-center gap-2 rounded-xl bg-brand px-3.5 py-2 text-sm font-medium text-white transition disabled:opacity-40">
          {imgBusy ? <Loader2 size={15} className="animate-spin" /> : <ImageIcon size={15} />} {t('autonomousRunner.aiMakesVisual')}
        </button>
        <button onClick={openTelegram} className={cn('inline-flex items-center gap-2 rounded-xl border px-3.5 py-2 text-sm font-medium transition', tgOpen ? 'border-violet/60 bg-violet/10 text-text' : 'border-ice/12 text-muted hover:text-text')}>
          <Send size={15} /> {t('autonomousRunner.sendToTelegram')}
        </button>
      </div>

      {imgErr && <p className="mt-3 rounded-lg bg-danger/10 px-3 py-2 text-xs text-danger">{imgErr}</p>}
      {img && (
        <div className="mt-3">
          {imgPrompt && <p className="mb-2 text-[11px] text-fog">{t('autonomousRunner.aiVisualLabel')} <span className="text-muted">{imgPrompt}</span></p>}
          <img src={img} alt={t('autonomousRunner.aiVisualAlt')} className="max-h-96 rounded-2xl border border-ice/10" />
          <a href={img} download="nemo-visual.png" className="mt-2 inline-flex items-center gap-1.5 text-xs text-violet hover:underline"><Download size={13} /> {t('autonomousRunner.download')}</a>
        </div>
      )}

      {tgOpen && (
        <div className="mt-3 rounded-xl border border-ice/10 bg-black/20 p-3">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-muted">{t('autonomousRunner.sendPostToChannel')}</span>
            <button onClick={() => setTgOpen(false)} className="text-muted hover:text-text"><X size={14} /></button>
          </div>
          {bots.length ? (
            <div className="mt-2 grid gap-2 sm:grid-cols-2">
              <select value={botId} onChange={(e) => setBotId(e.target.value)} className="glass rounded-xl px-3 py-2 text-sm text-text outline-none focus:border-violet/50">
                {bots.map((b) => <option key={b.id} value={b.id} className="bg-panel">{b.label || (b.username ? '@' + b.username : t('autonomousRunner.bot'))}</option>)}
              </select>
              <input value={target} onChange={(e) => setTarget(e.target.value)} placeholder={t('autonomousRunner.channelTargetPh')} className="glass rounded-xl px-3 py-2 text-sm text-text outline-none placeholder:text-fog focus:border-violet/50" />
            </div>
          ) : (
            <p className="mt-2 text-[12px] text-amber">{t('autonomousRunner.connectBotHint')}</p>
          )}
          <button onClick={sendTelegram} disabled={tgBusy || !bots.length || target.trim().length < 2} className="mt-2 inline-flex items-center gap-2 rounded-xl bg-brand px-3.5 py-2 text-sm font-medium text-white transition disabled:opacity-40">
            {tgBusy ? <Loader2 size={15} className="animate-spin" /> : <Send size={15} />} {t('autonomousRunner.sendNow')}
          </button>
          {tgMsg && <p className={cn('mt-2 rounded-lg px-3 py-1.5 text-xs', tgMsg.ok ? 'bg-teal/10 text-teal' : 'bg-danger/10 text-danger')}>{tgMsg.text}</p>}
        </div>
      )}
    </div>
  )
}
