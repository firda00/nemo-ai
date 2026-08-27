// Runtime-facing entrypoint. The implementation is shared with the browser preview so
// both surfaces compile the exact same reviewed topology without duplicating rules.
export {
  CONTENT_GROWTH_STEP_KEYS,
  CONTENT_GROWTH_USTADI_PROMPT,
  ContentGrowthArtifactSchema,
  assertContentGrowthPublishable,
  completeContentGrowthAudit,
  createContentGrowthRun,
  createContentGrowthWorkflow,
  decideContentGrowthApproval,
  recordContentGrowthArtifact,
} from '../../../src/lib/content-growth-workflow.ts'

export type {
  ContentGrowthArtifact,
  ContentGrowthRunState,
  ContentGrowthStepKey,
  ContentGrowthWorkflowOptions,
} from '../../../src/lib/content-growth-workflow.ts'
