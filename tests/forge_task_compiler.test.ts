import assert from 'node:assert/strict'
import { ProviderCapabilitySchema, ProjectExecutionPlanSchema } from '../src/types/forge-contracts.ts'
import { TaskCompiler, compileTask } from '../agent-hub/forge/task-compiler.ts'

const projectId = '01917b12-3a5c-7d9e-bf33-9118c7e7b901'
const prompt = 'Следи за конкурентами, создай контент-план и три видео, затем опубликуй после проверки.'
const plan = new TaskCompiler().compile(prompt, { projectId, totalBudgetCapUsd: 2 })

ProjectExecutionPlanSchema.parse(plan)
assert.deepEqual(plan.steps.map((step) => step.type), [
  'research', 'documents', 'media', 'quality_check', 'approval', 'publish',
])
assert.deepEqual(plan.steps.map((step) => step.computeProfile), [
  'PROFILE_A_WASI', 'PROFILE_B_DOCS', 'PROFILE_C_BROWSER',
  'PROFILE_A_WASI', 'PROFILE_A_WASI', 'PROFILE_A_WASI',
])
assert.equal(plan.steps.at(-1)?.dependsOn[0], plan.steps.at(-2)?.stepId)
assert.equal(plan.steps.at(-2)?.status, 'waiting_approval')
assert.equal(plan.steps.at(-2)?.requiresApproval, true)
assert.ok(plan.estimatedCostUsd <= plan.totalBudgetCapUsd)

const repeat = compileTask(prompt, { projectId, totalBudgetCapUsd: 2 })
assert.deepEqual(repeat, plan, 'the same prompt and project must compile to the same DAG')
assert.notEqual(
  compileTask('Проведи анализ рынка').projectId,
  compileTask('Проведи анализ рынка').projectId,
  'separate projects must not collide merely because their prompts match',
)

const mediaOnly = compileTask('Создай рекламное видео и изображение товара', { totalBudgetCapUsd: 1 })
assert.deepEqual(mediaOnly.steps.map((step) => step.type), ['media', 'quality_check'])
assert.equal(mediaOnly.steps.some((step) => step.type === 'approval'), false)

const crmAction = compileTask('Исследуй заявку и обнови CRM после проверки', { totalBudgetCapUsd: 1 })
assert.deepEqual(crmAction.steps.map((step) => step.type), ['research', 'quality_check', 'approval', 'publish'])

const generic = compileTask('Проверь эту задачу', { totalBudgetCapUsd: 1 })
assert.deepEqual(generic.steps.map((step) => step.type), ['research', 'quality_check'])

// Explicit editable-format requests route to documents, never fall to research — the five
// fixtures root reproduced against the compiled bundle (5 Sep 2026), plus the PDF control.
for (const request of ['Сделай Word', 'Создай DOCX', 'Сделай PPTX', 'Word fayl yarat', 'PPTX tayyorla', 'Сделай PDF']) {
  assert.deepEqual(
    compileTask(request, { totalBudgetCapUsd: 1 }).steps.map((step) => step.type),
    ['documents', 'quality_check'],
    `${request} must compile to a documents step`,
  )
}

assert.throws(() => compileTask('  '), /FORGE_PROMPT_TOO_SHORT/)
assert.throws(() => compileTask('x'.repeat(16_385)), /FORGE_PROMPT_TOO_LONG/)
assert.throws(
  () => compileTask('Создай видео', { totalBudgetCapUsd: 0.01 }),
  /estimated cost exceeds budget cap/,
)

ProviderCapabilitySchema.parse({
  provider: 'higgsfield',
  operations: ['image', 'video', 'avatar'],
  connection: 'mcp',
  verified: true,
  models: [],
  maxDurationSeconds: 30,
})
assert.throws(() => ProviderCapabilitySchema.parse({
  provider: 'fake-provider',
  operations: ['image'],
  connection: 'api_key',
  verified: false,
  models: [],
  maxDurationSeconds: 30,
}), /only valid for video providers/)

const unsafePublish = structuredClone(plan)
unsafePublish.steps = unsafePublish.steps.filter((step) => step.type !== 'approval')
unsafePublish.steps.at(-1)!.dependsOn = [unsafePublish.steps.at(-2)!.stepId]
assert.throws(() => ProjectExecutionPlanSchema.parse(unsafePublish), /publish must depend on a preceding approval step/)

const cyclic = structuredClone(generic)
cyclic.steps[0].dependsOn = [cyclic.steps[1].stepId]
assert.throws(() => ProjectExecutionPlanSchema.parse(cyclic), /must be acyclic/)

console.log('Nemo Forge Stage 0 passed: strict contracts, deterministic DAG compilation, budgets, and approval gate.')
