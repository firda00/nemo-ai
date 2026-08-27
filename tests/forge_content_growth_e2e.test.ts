import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { TaskCompiler } from '../src/lib/forge-task-compiler.ts'
import {
  assertContentGrowthPublishable,
  completeContentGrowthAudit,
  createContentGrowthRun,
  createContentGrowthWorkflow,
  decideContentGrowthApproval,
  recordContentGrowthArtifact,
} from '../agent-hub/forge/templates/content-growth-workflow.ts'
import { renderForgeDocument } from '../agent-hub/forge/document-renderer.ts'
import { compileMultiClipEditPlan, sha256MediaArtifact } from '../agent-hub/media/multi-clip-editor.ts'

const ACCOUNT_ID = '01917b12-3a5c-7d9e-bf33-9118c7e7c101'
const PROJECT_ID = '01917b12-3a5c-7d9e-bf33-9118c7e7c102'
const WORKFLOW_ID = '01917b12-3a5c-7d9e-bf33-9118c7e7c103'
const EXECUTION_ID = '01917b12-3a5c-7d9e-bf33-9118c7e7c104'

let compilerCalls = 0
const compiler = {
  compile(prompt: string, options: Parameters<TaskCompiler['compile']>[1]) {
    compilerCalls += 1
    return new TaskCompiler().compile(prompt, options)
  },
}

const plan = createContentGrowthWorkflow({ projectId: PROJECT_ID, compiler })
assert.equal(compilerCalls, 1, 'the template must compile through TaskCompiler')
assert.equal(plan.steps.length, 6)
assert.deepEqual(plan.steps.map((step) => step.computeProfile), [
  'PROFILE_A_WASI', 'PROFILE_B_DOCS', 'PROFILE_B_DOCS',
  'PROFILE_C_BROWSER', 'PROFILE_A_WASI', 'PROFILE_A_WASI',
])
assert.deepEqual(plan.steps.map((step) => step.type), [
  'research', 'documents', 'documents', 'media', 'quality_check', 'approval',
])
assert.equal(plan.steps[3].dependsOn[0], plan.steps[1].stepId, 'video can run in parallel with PDF after scripts')
assert.deepEqual(plan.steps[4].dependsOn.sort(), [plan.steps[2].stepId, plan.steps[3].stepId].sort())
assert.equal(plan.steps[5].status, 'waiting_approval')
assert.equal(plan.steps[5].requiresApproval, true)

let run = createContentGrowthRun(ACCOUNT_ID, EXECUTION_ID, plan)
assert.throws(() => assertContentGrowthPublishable(run), /CONTENT_GROWTH_APPROVAL_REQUIRED/)

const documentStep = plan.steps.find((step) => step.title.includes('PDF'))!
const pdfBytes = new TextEncoder().encode('%PDF-1.7\nNemo Content Growth report\n%%EOF')
const pdf = await renderForgeDocument({
  accountId: ACCOUNT_ID,
  workflowId: WORKFLOW_ID,
  executionId: EXECUTION_ID,
  stepId: documentStep.stepId,
  computeProfile: 'PROFILE_B_DOCS',
  input: {
    kind: 'typst_document', template: 'report', output_name: 'ustadi-content-plan.pdf',
    title: 'Ustadi Content Growth', sections: [{ heading: 'План', body: '14 дней, UZ/RU, 3 сценария.' }],
    line_items: [], seed: 27,
  },
}, {
  render: async () => ({
    bytes: pdfBytes, outputName: 'ustadi-content-plan.pdf', mimeType: 'application/pdf', seed: 27, executionTimeMs: 5,
  }),
  artifacts: {
    async register() {
      return { storagePath: `tenants/${ACCOUNT_ID}/artifacts/2026/08/27/ustadi-content-plan.pdf` }
    },
  },
})

run = recordContentGrowthArtifact(run, { accountId: ACCOUNT_ID, kind: 'pdf', ...pdf })
assert.ok(run.plan.steps.find((step) => step.stepId === documentStep.stepId)?.artifactRefs.includes(pdf.storagePath))

const videoStep = plan.steps.find((step) => step.type === 'media')!
const clipHashes = ['1', '2', '3'].map((value) => value.repeat(64))
const clips = clipHashes.map((sha256, index) => {
  const clipId = `01917b12-3a5c-7d9e-bf33-9118c7e7c11${index}`
  return {
    clipId,
    stagedPath: `tenants/${ACCOUNT_ID}/uploads/content-growth/clip-${index}.mp4`,
    downloadUrl: `https://storage.example.test/tenants/${ACCOUNT_ID}/uploads/content-growth/clip-${index}.mp4?signature=test`,
    mimeType: 'video/mp4' as const,
    sizeBytes: 1_000_000,
    sha256,
    durationSeconds: 4,
    width: 1080,
    height: 1920,
    fps: 30,
    speechSegments: [{
      startMs: 500, endMs: 2_000, text: `Ustadi ${index + 1}`,
      words: [
        { text: 'Ustadi', startMs: 500, endMs: 1_100, confidence: 0.99 },
        { text: String(index + 1), startMs: 1_200, endMs: 2_000, confidence: 0.99 },
      ],
    }],
    rightsManifest: {
      assetId: clipId, sha256, licenseType: 'owned' as const, licenseIdentifier: 'OWNER-UPLOAD-v1',
      owner: 'Ustadi', proofRef: `rights://${ACCOUNT_ID}/${clipId}`,
      verifiedAt: '2026-08-27T12:00:00+05:00', commercialAllowed: true as const, derivativesAllowed: true as const,
    },
  }
})
const videoPlan = compileMultiClipEditPlan({
  accountId: ACCOUNT_ID, projectId: PROJECT_ID, workflowId: WORKFLOW_ID, executionId: EXECUTION_ID,
  stepId: videoStep.stepId, clips, targetPreset: 'cinematic_short', targetRatio: '9:16',
  maxDurationSeconds: 15, language: 'uz', subtitleStyle: 'dynamic_karaoke',
  brand: { colors: ['#00F0FF', '#FFFFFF'], fontFamily: 'Inter' },
  output: {
    name: 'ustadi-growth.mp4',
    storagePath: `tenants/${ACCOUNT_ID}/artifacts/2026/08/27/ustadi-growth.mp4`,
    uploadUrl: `https://storage.example.test/tenants/${ACCOUNT_ID}/artifacts/2026/08/27/ustadi-growth.mp4?signature=test`,
    expiresAt: new Date(Date.now() + 240_000).toISOString(),
  },
  seed: 27,
})
assert.equal(videoPlan.mediaJob.clips.length, 3)
assert.equal(videoPlan.analysis.rightsVerifiedAssets, 3)
const videoBytes = new TextEncoder().encode('deterministic mp4 render')
const videoPath = `tenants/${ACCOUNT_ID}/artifacts/2026/08/27/ustadi-growth.mp4`
run = recordContentGrowthArtifact(run, {
  accountId: ACCOUNT_ID, executionId: EXECUTION_ID, stepId: videoStep.stepId, kind: 'video',
  name: 'ustadi-growth.mp4', storagePath: videoPath, mimeType: 'video/mp4', sizeBytes: videoBytes.byteLength,
  sha256: sha256MediaArtifact(videoBytes),
})
assert.ok(run.plan.steps.find((step) => step.stepId === videoStep.stepId)?.artifactRefs.includes(videoPath))
assert.equal(createHash('sha256').update(videoBytes).digest('hex'), sha256MediaArtifact(videoBytes))

assert.throws(
  () => decideContentGrowthApproval(run, 'approve'),
  /CONTENT_GROWTH_AUDIT_INCOMPLETE/,
  'operator cannot approve before brand and rights audit',
)
run = completeContentGrowthAudit(run, ['rights://manifest/ustadi', 'brand://ustadi/v1'])
assert.throws(() => assertContentGrowthPublishable(run), /CONTENT_GROWTH_APPROVAL_REQUIRED/)
run = decideContentGrowthApproval(run, 'approve')
assert.equal(assertContentGrowthPublishable(run), true)

assert.throws(() => recordContentGrowthArtifact(run, {
  accountId: ACCOUNT_ID,
  executionId: EXECUTION_ID,
  stepId: videoStep.stepId,
  kind: 'video',
  name: 'foreign.mp4',
  storagePath: 'tenants/01917b12-3a5c-7d9e-bf33-9118c7e7999/artifacts/2026/08/27/foreign.mp4',
  mimeType: 'video/mp4', sizeBytes: 12, sha256: 'f'.repeat(64),
}), /another tenant/)

console.log('Forge Content Growth E2E passed: deterministic DAG, PDF/MP4 handoff, rights audit, tenant scope, and fail-closed approval.')
