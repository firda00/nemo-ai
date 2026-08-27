import { z } from 'zod'
import { TaskCompiler } from './forge-task-compiler.ts'
import {
  ProjectExecutionPlanSchema,
  type ExecutionStep,
  type ProjectExecutionPlan,
} from '../types/forge-contracts.ts'

export const CONTENT_GROWTH_USTADI_PROMPT = [
  'Изучи конкурентов и актуальные тренды образовательного рынка Узбекистана.',
  'Подготовь 14-дневный контент-план и три сценария на узбекском и русском языках.',
  'Собери PDF-отчёт, смонтируй ролики из подтверждённых исходников и передай пакет на согласование.',
].join(' ')

export const CONTENT_GROWTH_STEP_KEYS = [
  'step_1_research',
  'step_2_scriptwriting',
  'step_3_document_render',
  'step_4_video_generation',
  'step_5_brand_rights_audit',
  'step_6_approval_gate',
] as const

export type ContentGrowthStepKey = typeof CONTENT_GROWTH_STEP_KEYS[number]

export interface ContentGrowthWorkflowOptions {
  projectId?: string
  title?: string
  totalBudgetCapUsd?: number
  compiler?: Pick<TaskCompiler, 'compile'>
}

function hash32(value: string, seed: number): number {
  let hash = (2166136261 ^ seed) >>> 0
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return hash >>> 0
}

function deterministicUuid(seed: string): string {
  const hex = [0, 1, 2, 3]
    .map((salt) => hash32(seed, salt * 0x9e3779b1).toString(16).padStart(8, '0'))
    .join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`
}

function makeStep(
  projectId: string,
  key: ContentGrowthStepKey,
  input: Omit<ExecutionStep, 'stepId' | 'dependsOn'> & { dependsOn: ContentGrowthStepKey[] },
): ExecutionStep {
  return {
    ...input,
    stepId: deterministicUuid(`${projectId}:content-growth:${key}`),
    dependsOn: input.dependsOn.map((dependency) => deterministicUuid(`${projectId}:content-growth:${dependency}`)),
  }
}

/**
 * Compiles the fixed Content Growth topology through the standard TaskCompiler,
 * then replaces only its inferred topology with the reviewed six-step template.
 * This keeps prompt, project identity and budget validation on the shared path.
 */
export function createContentGrowthWorkflow(options: ContentGrowthWorkflowOptions = {}): ProjectExecutionPlan {
  const compiler = options.compiler ?? new TaskCompiler()
  const base = compiler.compile(CONTENT_GROWTH_USTADI_PROMPT, {
    projectId: options.projectId,
    title: options.title ?? 'Пилот: Content Growth (Ustadi)',
    totalBudgetCapUsd: options.totalBudgetCapUsd ?? 5,
  })
  const steps: ExecutionStep[] = [
    makeStep(base.projectId, 'step_1_research', {
      title: 'Исследовать конкурентов и тренды',
      type: 'research', status: 'pending', assignedSkillId: 'evidence-research',
      computeProfile: 'PROFILE_A_WASI', dependsOn: [], evidenceRefs: [], artifactRefs: [],
      costTokens: 0, estimatedCostUsd: 0.02, requiresApproval: false,
    }),
    makeStep(base.projectId, 'step_2_scriptwriting', {
      title: 'Собрать 14-дневный план и 3 сценария UZ/RU',
      type: 'documents', status: 'pending', assignedSkillId: 'document-authoring',
      computeProfile: 'PROFILE_B_DOCS', dependsOn: ['step_1_research'], evidenceRefs: [], artifactRefs: [],
      costTokens: 0, estimatedCostUsd: 0.03, requiresApproval: false,
    }),
    makeStep(base.projectId, 'step_3_document_render', {
      title: 'Отрендерить контент-план и отчёт в PDF',
      type: 'documents', status: 'pending', assignedSkillId: 'document-authoring',
      computeProfile: 'PROFILE_B_DOCS', dependsOn: ['step_2_scriptwriting'], evidenceRefs: [], artifactRefs: [],
      costTokens: 0, estimatedCostUsd: 0.03, requiresApproval: false,
    }),
    makeStep(base.projectId, 'step_4_video_generation', {
      title: 'Транскрибировать и смонтировать исходники',
      type: 'media', status: 'pending', assignedSkillId: 'media-generation',
      computeProfile: 'PROFILE_C_BROWSER', dependsOn: ['step_2_scriptwriting'], evidenceRefs: [], artifactRefs: [],
      costTokens: 0, estimatedCostUsd: 0.25, requiresApproval: false,
    }),
    makeStep(base.projectId, 'step_5_brand_rights_audit', {
      title: 'Проверить бренд и права на ассеты',
      type: 'quality_check', status: 'pending', assignedSkillId: 'grounding-quality-gate',
      computeProfile: 'PROFILE_A_WASI', dependsOn: ['step_3_document_render', 'step_4_video_generation'],
      evidenceRefs: [], artifactRefs: [], costTokens: 0, estimatedCostUsd: 0.01, requiresApproval: false,
    }),
    makeStep(base.projectId, 'step_6_approval_gate', {
      title: 'Получить подтверждение оператора',
      type: 'approval', status: 'waiting_approval', assignedSkillId: 'human-approval',
      computeProfile: 'PROFILE_A_WASI', dependsOn: ['step_5_brand_rights_audit'], evidenceRefs: [], artifactRefs: [],
      costTokens: 0, estimatedCostUsd: 0, requiresApproval: true,
    }),
  ]

  return ProjectExecutionPlanSchema.parse({
    ...base,
    steps,
    currentStageIndex: 0,
    estimatedCostUsd: Number(steps.reduce((sum, step) => sum + step.estimatedCostUsd, 0).toFixed(4)),
  })
}

export const ContentGrowthArtifactSchema = z.object({
  accountId: z.string().uuid(),
  executionId: z.string().uuid(),
  stepId: z.string().uuid(),
  kind: z.enum(['pdf', 'video']),
  name: z.string().min(1).max(160).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/),
  storagePath: z.string().min(1).max(512),
  mimeType: z.enum(['application/pdf', 'video/mp4']),
  sizeBytes: z.number().int().positive(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  engineVersion: z.string().min(1).max(128).optional(),
  seed: z.union([z.number().int(), z.string().max(128)]).optional(),
}).strict().superRefine((artifact, context) => {
  const tenantPrefix = `tenants/${artifact.accountId.toLowerCase()}/`
  if (!artifact.storagePath.toLowerCase().startsWith(tenantPrefix)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['storagePath'], message: 'artifact path belongs to another tenant' })
  }
  if ((artifact.kind === 'pdf') !== (artifact.mimeType === 'application/pdf')) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['mimeType'], message: 'artifact kind and MIME type must match' })
  }
})

export type ContentGrowthArtifact = z.infer<typeof ContentGrowthArtifactSchema>

export interface ContentGrowthRunState {
  accountId: string
  executionId: string
  plan: ProjectExecutionPlan
  artifacts: ContentGrowthArtifact[]
  approvalDecision: 'approve' | 'reject' | null
}

export function createContentGrowthRun(accountId: string, executionId: string, plan: ProjectExecutionPlan): ContentGrowthRunState {
  return {
    accountId: z.string().uuid().parse(accountId),
    executionId: z.string().uuid().parse(executionId),
    plan: ProjectExecutionPlanSchema.parse(plan),
    artifacts: [],
    approvalDecision: null,
  }
}

export function recordContentGrowthArtifact(state: ContentGrowthRunState, rawArtifact: unknown): ContentGrowthRunState {
  const artifact = ContentGrowthArtifactSchema.parse(rawArtifact)
  if (artifact.accountId !== state.accountId || artifact.executionId !== state.executionId) {
    throw new Error('CONTENT_GROWTH_ARTIFACT_SCOPE_MISMATCH')
  }
  const step = state.plan.steps.find((candidate) => candidate.stepId === artifact.stepId)
  const expectedStep = state.plan.steps[artifact.kind === 'pdf' ? 2 : 3]
  if (!step || step.stepId !== expectedStep?.stepId) throw new Error('CONTENT_GROWTH_ARTIFACT_STEP_MISMATCH')
  const artifacts = [...state.artifacts.filter((candidate) => candidate.storagePath !== artifact.storagePath), artifact]
  const plan = ProjectExecutionPlanSchema.parse({
    ...state.plan,
    steps: state.plan.steps.map((candidate) => candidate.stepId === artifact.stepId
      ? { ...candidate, status: 'completed', artifactRefs: [...new Set([...candidate.artifactRefs, artifact.storagePath])] }
      : candidate),
  })
  return { ...state, plan, artifacts }
}

export function completeContentGrowthAudit(state: ContentGrowthRunState, evidenceRefs: string[]): ContentGrowthRunState {
  if (!state.artifacts.some((artifact) => artifact.kind === 'pdf') || !state.artifacts.some((artifact) => artifact.kind === 'video')) {
    throw new Error('CONTENT_GROWTH_REQUIRED_ARTIFACTS_MISSING')
  }
  const validatedEvidence = z.array(z.string().min(1).max(512)).min(2).max(64).parse(evidenceRefs)
  const plan = ProjectExecutionPlanSchema.parse({
    ...state.plan,
    steps: state.plan.steps.map((step) => step.type === 'quality_check'
      ? { ...step, status: 'completed', evidenceRefs: [...new Set(validatedEvidence)] }
      : step),
  })
  return { ...state, plan }
}

export function decideContentGrowthApproval(
  state: ContentGrowthRunState,
  decision: 'approve' | 'reject',
): ContentGrowthRunState {
  const audit = state.plan.steps.find((step) => step.type === 'quality_check')
  if (!audit || audit.status !== 'completed') throw new Error('CONTENT_GROWTH_AUDIT_INCOMPLETE')
  const plan = ProjectExecutionPlanSchema.parse({
    ...state.plan,
    currentStageIndex: state.plan.steps.length - 1,
  })
  return { ...state, plan, approvalDecision: decision }
}

export function assertContentGrowthPublishable(state: ContentGrowthRunState): true {
  if (state.approvalDecision !== 'approve') throw new Error('CONTENT_GROWTH_APPROVAL_REQUIRED')
  return true
}
