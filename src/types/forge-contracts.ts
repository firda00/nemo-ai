import { z } from 'zod'

export const ForgeComputeProfileSchema = z.enum([
  'PROFILE_A_WASI',
  'PROFILE_B_DOCS',
  'PROFILE_C_BROWSER',
  'PROFILE_D_GPU',
])

export const ProviderOperationSchema = z.enum([
  'image',
  'video',
  'voice',
  'avatar',
  'document',
  'research',
])

export const ProviderCapabilitySchema = z.object({
  provider: z.string().min(1).max(80).regex(/^[a-z0-9][a-z0-9_-]*$/),
  operations: z.array(ProviderOperationSchema).min(1).max(6)
    .refine((operations) => new Set(operations).size === operations.length, 'operations must be unique'),
  connection: z.enum(['api_key', 'oauth', 'mcp', 'local']),
  verified: z.boolean(),
  models: z.array(z.string().min(1).max(160)).max(100),
  maxDurationSeconds: z.number().int().positive().max(3_600).optional(),
}).strict().superRefine((capability, context) => {
  if (capability.maxDurationSeconds !== undefined && !capability.operations.includes('video')) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['maxDurationSeconds'],
      message: 'maxDurationSeconds is only valid for video providers',
    })
  }
})

export const ForgeStepTypeSchema = z.enum([
  'research',
  'documents',
  'media',
  'quality_check',
  'approval',
  'publish',
])

export const ForgeStepStatusSchema = z.enum([
  'pending',
  'running',
  'completed',
  'waiting_approval',
  'failed',
  'cancelled',
  'skipped',
])

export const ExecutionStepSchema = z.object({
  stepId: z.string().uuid(),
  title: z.string().min(1).max(160),
  type: ForgeStepTypeSchema,
  status: ForgeStepStatusSchema,
  assignedSkillId: z.string().min(1).max(120).regex(/^[a-z0-9][a-z0-9_-]*$/),
  computeProfile: ForgeComputeProfileSchema,
  dependsOn: z.array(z.string().uuid()).max(32).default([]),
  evidenceRefs: z.array(z.string().min(1).max(512)).max(64).default([]),
  artifactRefs: z.array(z.string().min(1).max(512)).max(64).default([]),
  costTokens: z.number().int().nonnegative().default(0),
  estimatedCostUsd: z.number().finite().nonnegative().default(0),
  requiresApproval: z.boolean().default(false),
}).strict().superRefine((step, context) => {
  if (new Set(step.dependsOn).size !== step.dependsOn.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['dependsOn'], message: 'dependencies must be unique' })
  }
  if (step.dependsOn.includes(step.stepId)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['dependsOn'], message: 'step cannot depend on itself' })
  }
  if (step.type === 'approval' && (!step.requiresApproval || step.status !== 'waiting_approval')) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['requiresApproval'],
      message: 'approval steps must wait for approval',
    })
  }
})

export const ProjectExecutionPlanSchema = z.object({
  schemaVersion: z.literal('1.0'),
  projectId: z.string().uuid(),
  title: z.string().min(1).max(160),
  rawUserPrompt: z.string().min(3).max(16_384),
  steps: z.array(ExecutionStepSchema).min(1).max(32),
  totalBudgetCapUsd: z.number().finite().nonnegative().max(1_000_000),
  estimatedCostUsd: z.number().finite().nonnegative(),
  currentStageIndex: z.number().int().nonnegative(),
}).strict().superRefine((plan, context) => {
  const ids = new Set(plan.steps.map((step) => step.stepId))
  if (ids.size !== plan.steps.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['steps'], message: 'stepId values must be unique' })
  }
  for (const [index, step] of plan.steps.entries()) {
    if (step.dependsOn.some((dependency) => !ids.has(dependency))) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['steps', index, 'dependsOn'], message: 'unknown dependency' })
    }
  }
  const dependenciesById = new Map(plan.steps.map((step) => [step.stepId, step.dependsOn]))
  const visiting = new Set<string>()
  const visited = new Set<string>()
  const hasCycle = (stepId: string): boolean => {
    if (visiting.has(stepId)) return true
    if (visited.has(stepId)) return false
    visiting.add(stepId)
    for (const dependency of dependenciesById.get(stepId) ?? []) {
      if (dependenciesById.has(dependency) && hasCycle(dependency)) return true
    }
    visiting.delete(stepId)
    visited.add(stepId)
    return false
  }
  if (plan.steps.some((step) => hasCycle(step.stepId))) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['steps'], message: 'execution plan must be acyclic' })
  }
  if (plan.currentStageIndex >= plan.steps.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['currentStageIndex'], message: 'currentStageIndex is out of range' })
  }
  if (plan.estimatedCostUsd > plan.totalBudgetCapUsd) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['estimatedCostUsd'], message: 'estimated cost exceeds budget cap' })
  }
  const publishIndex = plan.steps.findIndex((step) => step.type === 'publish')
  if (publishIndex >= 0) {
    const approval = plan.steps.slice(0, publishIndex).findLast((step) => step.type === 'approval')
    if (!approval || !plan.steps[publishIndex].dependsOn.includes(approval.stepId)) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['steps', publishIndex], message: 'publish must depend on a preceding approval step' })
    }
  }
})

export type ForgeComputeProfile = z.infer<typeof ForgeComputeProfileSchema>
export type ProviderOperation = z.infer<typeof ProviderOperationSchema>
export type ProviderCapability = z.infer<typeof ProviderCapabilitySchema>
export type ForgeStepType = z.infer<typeof ForgeStepTypeSchema>
export type ExecutionStep = z.infer<typeof ExecutionStepSchema>
export type ProjectExecutionPlan = z.infer<typeof ProjectExecutionPlanSchema>
