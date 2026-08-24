import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { ArtifactManifest, ComputeJob } from '../agent-hub/contracts/sandbox.ts'
import {
  DocumentRenderError,
  LocalArtifactSink,
  processDocumentJob,
  renderProfileBDocument,
  type DocumentComputeClient,
} from '../agent-hub/workers/document-worker.ts'

const ACCOUNT_ID = '01917b12-3a5c-7d9e-bf33-9118c7e7b801'
const JOB_ID = '01917b12-3a5c-7d9e-bf33-9118c7e7b802'
const WORKFLOW_ID = '01917b12-3a5c-7d9e-bf33-9118c7e7b800'

const reportPayload = {
  kind: 'typst_document',
  template: 'report',
  output_name: 'nemo-report.pdf',
  title: 'Nemo Operations Report',
  recipient: 'Example Tenant',
  currency: 'USD',
  sections: [{ heading: 'Summary', body: 'All durable runtime checks passed.' }],
  line_items: [{ description: 'Operations audit', quantity: 2, unit_price: 125 }],
  seed: 17,
} as const

const pdf = await renderProfileBDocument(reportPayload)
assert.equal(new TextDecoder().decode(pdf.bytes.subarray(0, 5)), '%PDF-')
assert.equal(pdf.mimeType, 'application/pdf')
assert.equal(pdf.outputName, 'nemo-report.pdf')

const slides = await renderProfileBDocument({
  kind: 'marp_presentation',
  output_name: 'nemo-slides.html',
  title: 'Nemo Runtime',
  markdown: '---\nmarp: true\n---\n# Nemo Runtime\n\nSelf-contained slides\n\n---\n\n## Audit-ready',
  seed: 19,
})
const slideHtml = new TextDecoder().decode(slides.bytes)
assert.equal(slides.mimeType, 'text/html')
assert.match(slideHtml, /<style>[\s\S]+<\/style>/)
assert.match(slideHtml, /<section/)
assert.doesNotMatch(slideHtml, /<script[^>]+src=|<link[^>]+href=/i)

await assert.rejects(
  renderProfileBDocument({ ...reportPayload, output_name: '../../secrets.pdf' }),
  /Invalid string|invalid/i,
)
await assert.rejects(
  renderProfileBDocument({
    kind: 'marp_presentation', output_name: 'bad.html', title: 'Bad', seed: 0,
    markdown: '# External\n\n![image](https://example.invalid/tracker.png)',
  }),
  /external|inline/i,
)
await assert.rejects(
  renderProfileBDocument({ ...reportPayload, sections: [{ heading: 'Overload', body: 'x'.repeat(11_000) }] }, { timeoutMs: 10 }),
  (error: unknown) => error instanceof DocumentRenderError && error.code === 'DOCUMENT_TIMEOUT',
)

const root = await mkdtemp(path.join(tmpdir(), 'nemo-document-test-'))
try {
  const finished: Array<{
    status: 'completed' | 'failed' | 'dead_letter'
    manifest: ArtifactManifest | null
    errorCode: string | null
  }> = []
  const compute: DocumentComputeClient = {
    async claim() { return [] },
    async finish(_job, status, manifest, errorCode) { finished.push({ status, manifest, errorCode }) },
  }
  const job: ComputeJob = {
    account_id: ACCOUNT_ID,
    job_id: JOB_ID,
    workflow_id: WORKFLOW_ID,
    profile: 'PROFILE_B_DOCS',
    claim_token: randomUUID(),
    lease_epoch: 1,
    lease_until: new Date(Date.now() + 60_000).toISOString(),
    attempt_count: 1,
    max_attempts: 3,
    input_payload: reportPayload,
  }
  const result = await processDocumentJob(job, {
    compute,
    sink: new LocalArtifactSink(root),
    render: async () => pdf,
  })
  assert.equal(result, 'completed')
  assert.equal(finished.length, 1)
  assert.equal(finished[0].status, 'completed')
  assert.equal(finished[0].errorCode, null)
  const artifact = finished[0].manifest?.artifacts[0]
  assert.ok(artifact)
  assert.equal(artifact.sha256, createHash('sha256').update(pdf.bytes).digest('hex'))
  assert.equal(finished[0].manifest?.provenance.seed, 17)
  const persisted = await readFile(path.join(root, ...artifact.storage_path.split('/')))
  assert.deepEqual(new Uint8Array(persisted), pdf.bytes)

  await assert.rejects(
    new LocalArtifactSink(root).store({
      accountId: ACCOUNT_ID,
      jobId: JOB_ID,
      outputName: '../escape.pdf',
      bytes: pdf.bytes,
      sha256: artifact.sha256,
    }),
    /ARTIFACT_NAME_INVALID/,
  )
} finally {
  await rm(root, { recursive: true, force: true })
}

console.log('ADR 002 Stage 1B document worker passed: PDF, slides, fencing manifest, traversal, and timeout.')
