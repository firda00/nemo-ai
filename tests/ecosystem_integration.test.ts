import assert from 'node:assert/strict'
import { compressContext } from '../agent-hub/llm/token-optimizer.ts'
import { CodebaseKnowledgeGraph } from '../agent-hub/memory/codebase-graph.ts'
import { AGENCY_ROLES, AgencyRoleSchema, canRoleUseProfile } from '../agent-hub/skills/agency-roles.ts'
import { SubagentSupervisor, type SubagentExecutor } from '../agent-hub/orchestration/subagent-supervisor.ts'
import { createStoryboardManifest } from '../agent-hub/media/storyboard-engine.ts'
import { MediaJobPayloadSchema } from '../agent-hub/media/ffmpeg-pipeline.ts'

const compressed = compressContext([
  { role: 'system', content: '  CRITICAL   POLICY: never expose secrets. ' },
  { role: 'system', content: 'CRITICAL POLICY: never expose secrets.' },
  { role: 'user', content: 'old context '.repeat(40) },
  { role: 'assistant', content: ' old answer   with spaces ' },
  { role: 'user', content: 'current request' },
], { maxMessages: 3, maxEstimatedTokens: 100 })
assert.equal(compressed.messages[0].role, 'system')
assert.equal(compressed.messages[0].content, 'CRITICAL   POLICY: never expose secrets.')
assert.equal(compressed.messages.filter((message) => message.role === 'system').length, 1)
assert.equal(compressed.messages.at(-1)?.content, 'current request')
assert.ok(compressed.metrics.savedEstimatedTokens > 0)
assert.ok(compressed.metrics.estimationRatio > 0 && compressed.metrics.estimationRatio <= 1)
assert.equal(compressed.metrics.budgetExceeded, false)

const formatted = compressContext([
  { role: 'system', content: 'critical' },
  { role: 'user', content: '```ts\nconst value = 1\n```\n\n| a | b |\n| - | - |' },
])
assert.match(formatted.messages[1].content, /```ts\nconst value = 1\n```/)
const overBudget = compressContext([
  { role: 'system', content: 'x'.repeat(1_024) },
], { maxEstimatedTokens: 64 })
assert.equal(overBudget.metrics.budgetExceeded, true)

const graph = new CodebaseKnowledgeGraph([
  { id: 'file:runtime', type: 'File', name: 'runtime client', summary: 'typed durable runtime RPC client', path: 'agent-hub/runtime.ts', tags: ['runtime'] },
  { id: 'rpc:claim', type: 'RPC', name: 'runtime_claim_compute_jobs', summary: 'fenced compute claim', tags: ['lease'] },
  { id: 'table:jobs', type: 'Table', name: 'runtime.compute_jobs', summary: 'durable compute queue', tags: ['sandbox'] },
  { id: 'contract:media', type: 'Contract', name: 'MediaJobPayloadSchema', summary: 'safe ffmpeg payload', tags: ['media'] },
  { id: 'file:unrelated', type: 'File', name: 'BillingPage', summary: 'subscription interface', tags: ['billing'] },
], [
  { source: 'file:runtime', target: 'rpc:claim', type: 'depends_on' },
  { source: 'rpc:claim', target: 'table:jobs', type: 'queries' },
  { source: 'contract:media', target: 'table:jobs', type: 'depends_on' },
])
const relevant = graph.findRelevantContext('fenced compute claim runtime jobs', 4)
assert.ok(relevant.nodes.some((node) => node.id === 'rpc:claim'))
assert.ok(relevant.nodes.some((node) => node.id === 'table:jobs'))
assert.equal(relevant.nodes.some((node) => node.id === 'file:unrelated'), false)
assert.ok(relevant.nodes.length <= 4)

for (const role of Object.values(AGENCY_ROLES)) AgencyRoleSchema.parse(role)
assert.equal(canRoleUseProfile('MARKETER', 'PROFILE_C_BROWSER'), true)
assert.equal(canRoleUseProfile('MARKETER', 'PROFILE_A_WASI'), false)
assert.equal(canRoleUseProfile('FINANCE_ANALYST', 'PROFILE_A_WASI'), true)
assert.equal(canRoleUseProfile('LEGAL_AUDITOR', 'PROFILE_C_BROWSER'), false)
assert.deepEqual(AGENCY_ROLES.PYTHON_ENGINEER.allowedComputeProfiles, ['PROFILE_A_WASI'])
assert.throws(() => (AGENCY_ROLES.MARKETER.allowedComputeProfiles as string[]).push('PROFILE_A_WASI'), /read only|extensible|object is not extensible/i)

function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms)
    signal.addEventListener('abort', () => {
      clearTimeout(timer)
      reject(new Error('aborted'))
    }, { once: true })
  })
}

const executor: SubagentExecutor = async (task, signal) => {
  const delay = Number(task.input.delay)
  await wait(delay, signal)
  return { shared: task.input.value, [task.id]: true }
}
const supervised = await new SubagentSupervisor(executor).run([
  { id: 'slow', role: 'FINANCE_ANALYST', input: { delay: 30, value: 'first-by-order' }, timeoutMs: 200 },
  { id: 'fast', role: 'MARKETER', input: { delay: 5, value: 'second-by-order' }, timeoutMs: 200 },
  { id: 'timeout', role: 'SUPPORT_OPERATOR', input: { delay: 100, value: 'never-merged' }, timeoutMs: 10 },
])
assert.equal(supervised.branches[0].status, 'completed')
assert.equal(supervised.branches[1].status, 'completed')
assert.equal(supervised.branches[2].status, 'timed_out')
assert.equal(supervised.merged.shared, 'second-by-order')
assert.equal(supervised.merged.timeout, undefined)

const defensiveExecutor: SubagentExecutor = async (task) => {
  if (task.id === 'oversized') return { value: 'x'.repeat(65 * 1024) }
  if (task.id === 'forbidden') return JSON.parse('{"constructor":"blocked"}') as Record<string, unknown>
  if (task.id === 'array') return [] as unknown as Record<string, unknown>
  return { ok: true }
}
const defensive = await new SubagentSupervisor(defensiveExecutor).run([
  { id: 'oversized', role: 'PYTHON_ENGINEER', input: {}, timeoutMs: 100 },
  { id: 'forbidden', role: 'PYTHON_ENGINEER', input: {}, timeoutMs: 100 },
  { id: 'array', role: 'PYTHON_ENGINEER', input: {}, timeoutMs: 100 },
])
assert.deepEqual(defensive.branches.map((branch) => branch.errorCode), [
  'SUBAGENT_RESULT_INVALID', 'SUBAGENT_RESULT_INVALID', 'SUBAGENT_RESULT_INVALID',
])
await assert.rejects(() => new SubagentSupervisor(defensiveExecutor).run([
  { id: 'duplicate', role: 'PYTHON_ENGINEER', input: {}, timeoutMs: 100 },
  { id: 'duplicate', role: 'PYTHON_ENGINEER', input: {}, timeoutMs: 100 },
]), /SUBAGENT_TASK_ID_DUPLICATE/)

const accountId = '01917b12-3a5c-7d9e-bf33-9118c7e7b801'
const asset = (id: string, name: string) => ({
  id,
  download_url: `https://storage.example.test/tenants/${accountId}/assets/${name}.png`,
  mime_type: 'image/png' as const,
  size_bytes: 1_024,
  sha256: 'a'.repeat(64),
})
const storyboardTemplate = {
  account_id: accountId,
  output_name: 'campaign.mp4',
  upload_url: `https://storage.example.test/tenants/${accountId}/artifacts/2026/08/25/campaign.mp4`,
  expires_at: new Date(Date.now() + 240_000).toISOString(),
  date_path: '2026/08/25',
  assets: [asset('scene_1', 'one'), asset('scene_2', 'two')],
  width: 1920,
  height: 1080,
  fps: 30,
  seconds_per_scene: 4,
} as const
const storyboard = createStoryboardManifest('Opening problem\n\nNemo solves it', storyboardTemplate)
MediaJobPayloadSchema.parse(storyboard)
assert.equal(storyboard.kind, 'ffmpeg_assembly')
assert.equal(storyboard.clips.length, 2)
assert.equal(storyboard.clips.reduce((sum, clip) => sum + clip.duration_seconds, 0), 8)
assert.equal(storyboard.width, 1920)
assert.equal(storyboard.height, 1080)
assert.ok(storyboard.output.storage_path.startsWith(`tenants/${accountId}/artifacts/`))

assert.throws(() => createStoryboardManifest({
  title: 'Too long',
  scenes: [
    { asset_id: 'scene_1', duration_seconds: 61 },
    { asset_id: 'scene_2', duration_seconds: 60 },
  ],
}, storyboardTemplate), /120 seconds/)
assert.throws(() => createStoryboardManifest('Unsafe', {
  ...storyboardTemplate,
  assets: [{ ...asset('scene_1', 'one'), download_url: 'https://storage.example.test/assets/%2e%2e/secret.png' }],
}), /STORYBOARD_ASSET_PATH_INVALID/)
assert.throws(() => createStoryboardManifest('Double encoded unsafe', {
  ...storyboardTemplate,
  assets: [{ ...asset('scene_1', 'one'), download_url: 'https://storage.example.test/assets/%252e%252e/secret.png' }],
}), /STORYBOARD_ASSET_PATH_INVALID/)
assert.throws(() => createStoryboardManifest('Wrong upload target', {
  ...storyboardTemplate,
  assets: [asset('scene_1', 'one')],
  upload_url: `https://storage.example.test/tenants/${accountId}/artifacts/2026/08/25/other.mp4`,
}), /STORYBOARD_UPLOAD_PATH_MISMATCH/)

const offsetStoryboard = createStoryboardManifest('Offset timestamp', {
  ...storyboardTemplate,
  account_id: accountId.toUpperCase(),
  assets: [asset('scene_1', 'one')],
  expires_at: '2026-08-25T17:00:00+05:00',
})
assert.equal(offsetStoryboard.output.expires_at, '2026-08-25T12:00:00.000Z')
assert.ok(offsetStoryboard.output.storage_path.startsWith(`tenants/${accountId}/`))
assert.throws(() => createStoryboardManifest('Invalid resolution', {
  ...storyboardTemplate,
  assets: [asset('scene_1', 'one')],
  width: 1920,
  height: 1920,
}), /resolution exceeds 1080p/)

console.log('Ecosystem integration passed: optimizer, graph, role grants, deterministic supervisor, and storyboard manifest.')
