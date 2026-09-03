import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.108.2'
import { json } from '../_shared/cors.ts'
import { blockedByFailedDependencies, dependenciesFor, readyNodeIndexes } from '../_shared/executionDag.ts'
import { evaluateGoalConditions, GoalSchema, type GoalEvaluation } from '../_shared/goal.ts'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const CRON_SECRET = Deno.env.get('CRON_SECRET') ?? ''
const LEASE_SECONDS = 600
const ACTION_TIMEOUT_MS = 45_000
const MAX_REVISIONS = 1
const MAX_PARALLEL_SPECIALISTS = 3
const MAX_SPECIALIST_ATTEMPTS = 2

type Spec = {
  role: string
  name: string
  skills?: string[]
  prompt: { role: string; tasks: string; tone: string; rules: string }
  output?: string
  sources?: string[]
  review?: { approved: boolean; score: number; issues: string[]; fix: string } | null
  reviewedBy?: string
  revised?: boolean
  revisions?: number
  depends_on?: number[]
  attempts?: number
  lastError?: string
  blockedBy?: number[]
  escalated?: boolean
  bestOutput?: string
  bestReview?: { approved: boolean; score: number; issues: string[]; fix: string } | null
  status: 'pending' | 'running' | 'review' | 'fixing' | 'done' | 'failed' | 'blocked'
}

type Run = {
  id: string
  account_id: string
  user_id: string
  run_ref: string
  phase: 'team' | 'review' | 'synth'
  transition: 'staff' | 'observe_plan' | 'specialist' | 'review' | 'revision' | 'goal_check' | 'synth'
  specialist_cursor: number
  review_cursor: number
  revision_round: number
  claim_token: string
  attempt_count: number
  immutable_input: Record<string, unknown>
  state: Record<string, unknown>
}

function mapRole(role: string): string {
  const value = role.toLowerCase()
  if (/research|find|scout/.test(value)) return 'researcher'
  if (/writ|content|copy|email|draft|market/.test(value)) return 'writer'
  if (/review|qa|quality|check|audit/.test(value)) return 'reviewer'
  return 'analyst'
}

function subSystem(spec: Spec): string {
  return [
    `You are "${spec.name}", a ${spec.role}.`,
    'Universal execution contract: your role is a lens, not a limit. Complete the user requested outcome; if a tool or permission is missing, name it and return the best useful partial result.',
    spec.prompt.role && `Role: ${spec.prompt.role}`,
    spec.prompt.tasks && `Tasks: ${spec.prompt.tasks}`,
    spec.prompt.tone && `Tone: ${spec.prompt.tone}`,
    spec.prompt.rules && `Rules: ${spec.prompt.rules}`,
  ].filter(Boolean).join('\n')
}

function handoff(specs: Spec[]): string {
  return specs.filter((spec) => spec.output).map((spec) => `## ${spec.name} (${spec.role})\n${spec.output}`).join('\n\n').slice(-18_000)
}

Deno.serve(async (req) => {
  const auth = req.headers.get('Authorization') ?? ''
  const cron = req.headers.get('x-cron-secret') ?? ''
  if (auth !== `Bearer ${SERVICE_ROLE}` && (!CRON_SECRET || cron !== CRON_SECRET)) return json({ error: 'forbidden' }, 403)

  const db = createClient(SUPABASE_URL, SERVICE_ROLE)
  const { data: rows, error: claimError } = await db.rpc('claim_autonomous_run', { p_lease_seconds: LEASE_SECONDS })
  const run = (rows?.[0] ?? null) as Run | null
  if (claimError) return json({ error: 'claim_failed' }, 500)
  if (!run) return json({ ok: true, claimed: false })

  const input = run.immutable_input ?? {}
  const executionPlan = (input.executionPlan ?? {}) as { path?: string; maxLogicalLlmCalls?: number; maxSpecialists?: number; maxReviewRounds?: number }
  const quickPath = executionPlan.path === 'quick'
  const state = { ...(run.state ?? {}) } as Record<string, unknown> & { specs?: Spec[]; goalContract?: unknown; goalEvaluation?: GoalEvaluation | null; iterationContext?: string }
  const specialistLimit = Math.max(1, Math.min(MAX_PARALLEL_SPECIALISTS, Number(executionPlan.maxSpecialists) || MAX_PARALLEL_SPECIALISTS))
  const reviewLimit = Math.max(0, Math.min(MAX_REVISIONS, Number(executionPlan.maxReviewRounds) || 0))
  const specs = (Array.isArray(state.specs) ? state.specs : []).slice(0, specialistLimit)
  state.specs = specs
  const common = {
    _worker: true,
    run_id: run.id,
    claim_token: run.claim_token,
    account_id: run.account_id,
    user_id: run.user_id,
    run_ref: run.run_ref,
    lang: input.lang,
    // Один снимок памяти на весь прогон, снятый при постановке в очередь. Раздаётся всем узлам
    // DAG, потому что параллельные исполнители, читающие каждый сам, разошлись бы в фактах — и
    // синтезу пришлось бы сводить показания вместо результатов. Приходит из immutable_input,
    // поэтому возобновлённый завтра прогон стоит на тех же убеждениях, что начатый вчера.
    ...(Array.isArray((input as { orgMemory?: unknown }).orgMemory) ? { org_memory: (input as { orgMemory: unknown[] }).orgMemory } : {}),
    ...(input.model ? { model: input.model } : {}),
  }
  const invoke = async (body: Record<string, unknown>) => {
    const response = await fetch(`${SUPABASE_URL}/functions/v1/orchestrate`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${SERVICE_ROLE}`, apikey: SERVICE_ROLE, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...common, ...body }),
      signal: AbortSignal.timeout(ACTION_TIMEOUT_MS),
    })
    const payload = await response.json().catch(() => ({}))
    if (!response.ok || !payload?.ok) throw new Error(String(payload?.detail ?? payload?.error ?? `orchestrate_${response.status}`))
    return payload
  }
  const finish = async (next: {
    state: Record<string, unknown>; phase: string; transition: string; specialist: number; review: number; revision: number; status?: string; error?: string; nextAt?: string
  }) => {
    const { data, error } = await db.rpc('finish_autonomous_transition', {
      p_run_id: run.id,
      p_claim_token: run.claim_token,
      p_state: next.state,
      p_phase: next.phase,
      p_transition: next.transition,
      p_specialist_cursor: next.specialist,
      p_review_cursor: next.review,
      p_revision_round: next.revision,
      p_status: next.status ?? 'queued',
      p_last_error: next.error ?? null,
      p_next_attempt_at: next.nextAt ?? new Date().toISOString(),
    })
    if (error || data !== true) throw new Error('claim_lost')
  }

  let terminal = false
  try {
    if (quickPath && run.transition !== 'synth') throw new Error('invalid_quick_transition')
    if (quickPath && executionPlan.maxLogicalLlmCalls !== 1) throw new Error('invalid_quick_budget')
    const goal = String(input.orchestratedGoal ?? input.goal ?? '')
    const activeGoal = GoalSchema.safeParse(state.goalContract ?? input.goalContract)
    const activeGoalContract = activeGoal.success ? { ...activeGoal.data, max_iterations: Math.min(3, activeGoal.data.max_iterations) } : null
    if (activeGoalContract) state.goalContract = activeGoalContract
    const currentIteration = activeGoalContract?.current_iteration ?? 1
    const webResearchAllowed = !/(?:do not|don't|dont|never)\s+(?:use|browse|search)(?:\s+the)?\s+(?:web|internet|online)|(?:without|no)\s+(?:web(?:\s+research)?|internet)|\boffline\b|без\s+(?:поиска\s+в\s+)?интернет\S*|не\s+(?:использ\S*|ищ\S*)\s+(?:в\s+)?интернет\S*/i.test(goal)
    const artifacts = Array.isArray(input.inputArtifacts) ? input.inputArtifacts : []
    if (run.transition === 'staff') {
      const result = await invoke({ action: 'staff', billing_key: `${run.id}:staff`, goal, use_skills: true, input_artifacts: artifacts })
      const created: Spec[] = (Array.isArray(result.subagents) ? result.subagents : []).slice(0, specialistLimit).map((spec: Spec) => ({ ...spec, status: 'pending' }))
      if (!created.length) throw new Error('empty_team')
      state.specs = created
      await finish({ state, phase: 'team', transition: 'observe_plan', specialist: 0, review: 0, revision: 0 })
    } else if (run.transition === 'observe_plan') {
      const goalContract = activeGoalContract
      if (!goalContract) throw new Error('invalid_goal_contract')
      const remaining = state.goalEvaluation?.criteria.filter((criterion) => !criterion.achieved).map((criterion) => criterion.criterion) ?? goalContract.definition_of_done
      const planned = await invoke({
        action: 'step',
        billing_key: `${run.id}:iteration:${currentIteration}:observe-plan`,
        goal,
        role: 'analyst',
        task: 'Observe the current goal state and produce a concise execution plan for this iteration. Map each remaining definition-of-done criterion to a concrete specialist action or available tool. Do not produce the final deliverable.',
        system: 'You are the goal-conditioned runtime planner. Return only the bounded plan for the current iteration. Never claim actions are already complete.',
        context: `ITERATION ${currentIteration}/${goalContract.max_iterations}\nREMAINING CONDITIONS:\n${remaining.map((criterion) => `- ${criterion}`).join('\n')}\n\n${String(state.iterationContext ?? '')}`.slice(-18_000),
        input_artifacts: artifacts,
      })
      state.iterationContext = `${String(state.iterationContext ?? '')}\n\nITERATION ${currentIteration} OBSERVE & PLAN:\n${String(planned.output ?? '').slice(0, 5_000)}`.slice(-18_000)
      await finish({ state, phase: 'team', transition: 'specialist', specialist: 0, review: 0, revision: 0 })
    } else if (run.transition === 'specialist') {
      const ready = readyNodeIndexes(specs, specialistLimit)
      if (!ready.length) {
        const allDone = specs.length > 0 && specs.every((spec) => spec.status === 'done')
        if (!allDone) {
          await finish({ state, phase: 'team', transition: 'specialist', specialist: specs.findIndex((spec) => spec.status === 'pending'), review: 0, revision: 0, status: 'failed', error: 'invalid_or_blocked_dependency_graph' })
          terminal = true
        } else {
          await finish({ state, phase: specs.length >= 2 ? 'review' : 'team', transition: specs.length >= 2 ? 'review' : 'goal_check', specialist: specs.length, review: 0, revision: 0 })
        }
      } else {
        const outcomes = await Promise.allSettled(ready.map(async (index) => {
          const spec = specs[index]
          const role = mapRole(spec.role)
          const dependencyIndexes = dependenciesFor(spec, index)
          const result = await invoke({
            action: 'step', billing_key: `${run.id}:iteration:${currentIteration}:specialist:${index}`, goal, role, task: spec.prompt.tasks || spec.role, system: subSystem(spec),
            skills: spec.skills ?? [], context: [String(state.iterationContext ?? ''), handoff(dependencyIndexes.map((dependency) => specs[dependency]))].filter(Boolean).join('\n\n'), input_artifacts: artifacts, web_research: role === 'researcher' && webResearchAllowed,
          })
          return { index, result }
        }))
        outcomes.forEach((outcome, position) => {
          const index = ready[position]
          const spec = specs[index]
          if (outcome.status === 'fulfilled') {
            const result = outcome.value.result
            specs[index] = { ...spec, output: String(result.output ?? '').slice(0, 12_000), sources: Array.isArray(result.sources) ? result.sources.map(String).slice(0, 12) : [], status: 'done', lastError: undefined }
          } else {
            const message = String(outcome.reason instanceof Error ? outcome.reason.message : outcome.reason).slice(0, 500)
            const attempts = (spec.attempts ?? 0) + (message.includes('usage_reservation_in_progress') ? 0 : 1)
            specs[index] = { ...spec, attempts, lastError: message, status: attempts >= MAX_SPECIALIST_ATTEMPTS ? 'failed' : 'pending' }
          }
        })
        const blocked = blockedByFailedDependencies(specs)
        blocked.forEach((causes, index) => { specs[index] = { ...specs[index], status: 'blocked', blockedBy: causes } })
        state.specs = specs
        if (specs.some((spec) => spec.status === 'failed' || spec.status === 'blocked')) {
          await finish({ state, phase: 'team', transition: 'specialist', specialist: Math.max(0, specs.findIndex((spec) => spec.status === 'failed' || spec.status === 'blocked')), review: 0, revision: 0, status: 'failed', error: 'specialist_dependency_failed' })
          terminal = true
        } else if (specs.every((spec) => spec.status === 'done')) {
          await finish({ state, phase: specs.length >= 2 ? 'review' : 'team', transition: specs.length >= 2 ? 'review' : 'goal_check', specialist: specs.length, review: 0, revision: 0 })
        } else {
          const cursor = specs.findIndex((spec) => spec.status === 'pending')
          const hadFailure = outcomes.some((outcome) => outcome.status === 'rejected')
          await finish({ state, phase: 'team', transition: 'specialist', specialist: Math.max(0, cursor), review: 0, revision: 0, nextAt: new Date(Date.now() + (hadFailure ? 5000 : 0)).toISOString() })
        }
      }
    } else if (run.transition === 'review') {
      const index = run.review_cursor
      const spec = specs[index]
      const reviewer = specs[(index + 1) % specs.length]
      if (!spec || !reviewer) throw new Error('invalid_review_cursor')
      const result = await invoke({
        action: 'review', billing_key: `${run.id}:iteration:${currentIteration}:review:${index}:${run.revision_round}`, goal, work: spec.output ?? '', author_role: spec.role, author_task: spec.prompt.tasks,
        input_artifacts: artifacts, reviewer_system: subSystem(reviewer),
        criteria: 'соответствие задаче; конкретика и факты; отсутствие воды и клише; готовность без доработки',
        previous_score: spec.review?.score ?? 0, previous_issues: spec.review?.issues ?? [], revision_round: run.revision_round,
      })
      const review = { approved: Boolean(result.approved), score: Number(result.score) || 0, issues: Array.isArray(result.issues) ? result.issues.map(String) : [], fix: String(result.fix ?? '') }
      const previousBest = spec.bestReview
      const better = !previousBest || review.approved || review.score > previousBest.score || (review.score === previousBest.score && review.issues.length < previousBest.issues.length)
      const bestReview = better ? review : previousBest
      const bestOutput = better ? spec.output : spec.bestOutput ?? spec.output
      const exhausted = run.revision_round >= reviewLimit
      specs[index] = {
        ...spec,
        output: review.approved || exhausted ? bestOutput : spec.output,
        review: review.approved || exhausted ? bestReview : review,
        bestOutput,
        bestReview,
        reviewedBy: reviewer.name,
        escalated: !review.approved && exhausted,
        status: review.approved || exhausted ? 'done' : 'fixing',
      }
      state.specs = specs
      if (!review.approved && !exhausted) {
        await finish({ state, phase: 'review', transition: 'revision', specialist: run.specialist_cursor, review: index, revision: run.revision_round })
      } else {
        const cursor = index + 1
        await finish({ state, phase: 'review', transition: cursor < specs.length ? 'review' : 'goal_check', specialist: run.specialist_cursor, review: cursor, revision: 0 })
      }
    } else if (run.transition === 'revision') {
      const index = run.review_cursor
      const spec = specs[index]
      if (!spec?.review) throw new Error('invalid_revision_cursor')
      const result = await invoke({
        action: 'step', billing_key: `${run.id}:iteration:${currentIteration}:revision:${index}:${run.revision_round}`, goal, role: mapRole(spec.role),
        task: 'Перепиши свою работу, устранив ВСЕ замечания коллеги. Верни улучшенную версию целиком, в том же формате.',
        system: subSystem(spec), skills: spec.skills ?? [], input_artifacts: artifacts,
        context: `ТВОЯ РАБОТА:\n${(spec.output ?? '').slice(0, 3000)}\n\nПРОШЛАЯ ОЦЕНКА: ${spec.review.score}/100.\nЗАМЕЧАНИЯ:\n${spec.review.fix}\n${spec.review.issues.join('\n')}\n\nСохрани всё сделанное хорошо. Не добавляй неподтвержденные факты.`,
      })
      specs[index] = { ...spec, output: String(result.output ?? spec.output ?? ''), revised: true, revisions: run.revision_round + 1, status: 'review' }
      state.specs = specs
      await finish({ state, phase: 'review', transition: 'review', specialist: run.specialist_cursor, review: index, revision: run.revision_round + 1 })
    } else if (run.transition === 'goal_check') {
      const parsedGoal = GoalSchema.safeParse(state.goalContract ?? input.goalContract)
      if (!parsedGoal.success) throw new Error('invalid_goal_contract')
      const goalContract = parsedGoal.data
      const combinedOutput = specs.map((spec) => `${spec.name}: ${spec.output ?? ''}`).join('\n\n')
      const sources = [...new Set(specs.flatMap((spec) => spec.sources ?? []))]
      const evaluation = evaluateGoalConditions(goalContract, combinedOutput, sources)
      state.goalEvaluation = evaluation

      if (evaluation.achieved) {
        state.goalContract = { ...goalContract, status: 'goal_achieved' }
        await finish({ state, phase: 'synth', transition: 'synth', specialist: specs.length, review: specs.length, revision: 0 })
      } else if (goalContract.current_iteration >= goalContract.max_iterations) {
        state.goalContract = { ...goalContract, status: 'max_iterations' }
        await finish({ state, phase: 'synth', transition: 'synth', specialist: specs.length, review: specs.length, revision: 0 })
      } else {
        const unmet = evaluation.criteria.filter((criterion) => !criterion.achieved).map((criterion) => `- ${criterion.criterion}: ${criterion.evidence}`).join('\n')
        state.iterationContext = `PREVIOUS ITERATION ${goalContract.current_iteration} DID NOT COMPLETE THE GOAL. Preserve useful work, then close these exact gaps:\n${unmet}\n\nPREVIOUS WORK:\n${combinedOutput.slice(-14_000)}`
        state.goalContract = { ...goalContract, current_iteration: goalContract.current_iteration + 1, status: 'running' }
        state.specs = specs.map((spec) => ({
          ...spec,
          output: undefined,
          sources: [],
          review: null,
          reviewedBy: undefined,
          revised: false,
          revisions: 0,
          escalated: false,
          attempts: 0,
          lastError: undefined,
          blockedBy: undefined,
          bestOutput: undefined,
          bestReview: null,
          status: 'pending' as const,
        }))
        await finish({ state, phase: 'team', transition: 'observe_plan', specialist: 0, review: 0, revision: 0 })
      }
    } else {
      const sources = [...new Set(specs.flatMap((spec) => spec.sources ?? []))].slice(0, 30)
      const result = await invoke({
        action: 'synth', billing_key: `${run.id}:synth`, execution_mode: quickPath ? 'quick' : 'team', goal, input_artifacts: artifacts, ...(input.departmentId ? { department_id: input.departmentId } : {}),
        goal_contract: state.goalContract,
        goal_evaluation: state.goalEvaluation,
        // A failed internal peer-review convergence is quality telemetry, not a new
        // customer approval gate. Real external effects keep their dedicated policies.
        steps: quickPath ? [] : specs.map((spec) => ({ role: spec.role, task: spec.prompt.tasks, output: spec.output, sources: spec.sources, reviewedBy: spec.reviewedBy, review: spec.review, revised: Boolean(spec.revised), revisions: spec.revisions ?? 0, needsHumanReview: false })),
        sources,
      })
      state.result = String(result.result ?? '')
      state.resultId = result.id ?? null
      state.executionPlan = executionPlan
      state.escalatedCount = specs.filter((spec) => spec.escalated).length
      // Synthesis persistence atomically marks the checkpoint completed under this claim.
      terminal = true
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (message !== 'claim_lost') {
      const terminalFailure = run.attempt_count >= 8
      const delaySeconds = Math.min(300, 5 * 2 ** Math.min(run.attempt_count, 6))
      await finish({ state, phase: run.phase, transition: run.transition, specialist: run.specialist_cursor, review: run.review_cursor, revision: run.revision_round, status: terminalFailure ? 'failed' : 'queued', error: message, nextAt: new Date(Date.now() + delaySeconds * 1000).toISOString() }).catch(() => undefined)
    }
    return json({ ok: false, run_ref: run.run_ref, error: message }, message === 'claim_lost' ? 409 : 500)
  }

  if (!terminal) {
    const dispatch = fetch(`${SUPABASE_URL}/functions/v1/autonomous-worker`, {
      method: 'POST', headers: { Authorization: `Bearer ${SERVICE_ROLE}`, 'Content-Type': 'application/json' }, body: '{}',
    }).then(() => undefined).catch(() => undefined)
    const runtime = (globalThis as { EdgeRuntime?: { waitUntil(promise: Promise<unknown>): void } }).EdgeRuntime
    if (runtime) runtime.waitUntil(dispatch)
  }
  return json({ ok: true, claimed: true, run_ref: run.run_ref, transition: run.transition, terminal })
})
