import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { ArtifactManifest, ComputeJob } from '../agent-hub/contracts/sandbox.ts'
import {
  DocumentRenderError,
  KindRoutingArtifactSink,
  LocalArtifactSink,
  processDocumentJob,
  renderProfileBDocument,
  resolveDocumentWorkerConfig,
  StorageArtifactSink,
  SupabaseDocumentComputeClient,
  sweepUnfinalizedWorkflows,
  type ArtifactSinkInput,
  type DocumentComputeClient,
  type DocumentFinalizeOutcome,
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
    status: 'pending' | 'completed' | 'failed' | 'dead_letter'
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
      claimToken: randomUUID(),
      leaseEpoch: 1,
      outputName: '../escape.pdf',
      mimeType: 'application/pdf',
      bytes: pdf.bytes,
      sha256: artifact.sha256,
    }),
    /ARTIFACT_NAME_INVALID/,
  )

  const transientJob = { ...job, job_id: randomUUID(), claim_token: randomUUID() }
  assert.equal(await processDocumentJob(transientJob, {
    compute,
    sink: new LocalArtifactSink(root),
    render: async () => { throw new DocumentRenderError('DOCUMENT_RENDER_FAILED', 'temporary renderer failure') },
  }), 'pending')
  assert.equal(finished.at(-1)?.status, 'pending')

  const exhaustedJob = { ...transientJob, job_id: randomUUID(), claim_token: randomUUID(), attempt_count: 3 }
  assert.equal(await processDocumentJob(exhaustedJob, {
    compute,
    sink: new LocalArtifactSink(root),
    render: async () => { throw new DocumentRenderError('DOCUMENT_TIMEOUT', 'renderer timeout') },
  }), 'dead_letter')
  assert.equal(finished.at(-1)?.status, 'dead_letter')
} finally {
  await rm(root, { recursive: true, force: true })
}

// ── D2 lifecycle: inline finalize after every TERMINAL finish, never on retry ─────────────────
{
  const finalized: Array<{ accountId: string; workflowId: string }> = []
  const makeCompute = (outcome: () => Promise<DocumentFinalizeOutcome>): DocumentComputeClient => ({
    async claim() { return [] },
    async finish() {},
    async finalizeWorkflow(accountId, workflowId) {
      finalized.push({ accountId, workflowId })
      return outcome()
    },
    async listUnfinalized() { return [] },
  })
  const okOutcome = async (): Promise<DocumentFinalizeOutcome> => ({ kind: 'finalized', status: 'completed', already: false })
  const lifecycleRoot = await mkdtemp(path.join(tmpdir(), 'nemo-document-lifecycle-'))
  try {
    const baseJob: ComputeJob = {
      account_id: ACCOUNT_ID,
      job_id: randomUUID(),
      workflow_id: WORKFLOW_ID,
      profile: 'PROFILE_B_DOCS',
      claim_token: randomUUID(),
      lease_epoch: 1,
      lease_until: new Date(Date.now() + 60_000).toISOString(),
      attempt_count: 1,
      max_attempts: 3,
      input_payload: reportPayload,
    }
    // completed → finalize called with the job's own parent
    assert.equal(await processDocumentJob(baseJob, {
      compute: makeCompute(okOutcome),
      sink: new LocalArtifactSink(lifecycleRoot),
      render: async () => pdf,
    }), 'completed')
    assert.equal(finalized.length, 1)
    assert.deepEqual(finalized[0], { accountId: ACCOUNT_ID, workflowId: WORKFLOW_ID })

    // failed (non-retryable output-limit error) → finalize called
    assert.equal(await processDocumentJob({ ...baseJob, job_id: randomUUID() }, {
      compute: makeCompute(okOutcome),
      sink: new LocalArtifactSink(lifecycleRoot),
      render: async () => { throw new DocumentRenderError('DOCUMENT_OUTPUT_LIMIT', 'artifact too large') },
    }), 'failed')
    assert.equal(finalized.length, 2)

    // dead_letter (retryable, attempts exhausted) → finalize called
    assert.equal(await processDocumentJob({ ...baseJob, job_id: randomUUID(), attempt_count: 3 }, {
      compute: makeCompute(okOutcome),
      sink: new LocalArtifactSink(lifecycleRoot),
      render: async () => { throw new DocumentRenderError('DOCUMENT_TIMEOUT', 'renderer timeout') },
    }), 'dead_letter')
    assert.equal(finalized.length, 3)

    // pending = retry: the job is NOT terminal → parent must stay waiting_compute, no finalize
    assert.equal(await processDocumentJob({ ...baseJob, job_id: randomUUID() }, {
      compute: makeCompute(okOutcome),
      sink: new LocalArtifactSink(lifecycleRoot),
      render: async () => { throw new DocumentRenderError('DOCUMENT_RENDER_FAILED', 'transient') },
    }), 'pending')
    assert.equal(finalized.length, 3)

    // finalize failure must NOT retry finish or reclassify an honestly finished compute job
    const finishCalls: string[] = []
    const flakyCompute: DocumentComputeClient = {
      async claim() { return [] },
      async finish(_job, status) { finishCalls.push(status) },
      async finalizeWorkflow() { throw new Error('DOCUMENT_FINALIZE_FAILED:NETWORK') },
      async listUnfinalized() { return [] },
    }
    assert.equal(await processDocumentJob({ ...baseJob, job_id: randomUUID() }, {
      compute: flakyCompute,
      sink: new LocalArtifactSink(lifecycleRoot),
      render: async () => pdf,
    }), 'completed')
    assert.deepEqual(finishCalls, ['completed'])

    // a client without the optional lifecycle methods keeps working (backward compatible)
    assert.equal(await processDocumentJob({ ...baseJob, job_id: randomUUID() }, {
      compute: { async claim() { return [] }, async finish() {} },
      sink: new LocalArtifactSink(lifecycleRoot),
      render: async () => pdf,
    }), 'completed')
  } finally {
    await rm(lifecycleRoot, { recursive: true, force: true })
  }
}

// ── D2 client: RPC replies are VALIDATED, never trusted ───────────────────────────────────────
{
  const makeClient = (reply: unknown, error: { code?: string } | null = null) =>
    new SupabaseDocumentComputeClient({
      async rpc() { return { data: reply, error } },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any)

  assert.deepEqual(
    await makeClient({ ok: true, status: 'completed', already: false }).finalizeWorkflow(ACCOUNT_ID, WORKFLOW_ID),
    { kind: 'finalized', status: 'completed', already: false },
  )
  assert.deepEqual(
    await makeClient({ ok: true, status: 'failed', already: true }).finalizeWorkflow(ACCOUNT_ID, WORKFLOW_ID),
    { kind: 'finalized', status: 'failed', already: true },
  )
  assert.deepEqual(
    await makeClient({ ok: false, reason: 'compute_not_terminal' }).finalizeWorkflow(ACCOUNT_ID, WORKFLOW_ID),
    { kind: 'skipped', reason: 'compute_not_terminal' },
  )
  assert.deepEqual(
    await makeClient({ ok: false, reason: 'not_found' }).finalizeWorkflow(ACCOUNT_ID, WORKFLOW_ID),
    { kind: 'skipped', reason: 'not_found' },
  )
  // null, {}, and truncated ok:true replies are malformed — loud, never a success or a skip
  await assert.rejects(makeClient(null).finalizeWorkflow(ACCOUNT_ID, WORKFLOW_ID), /DOCUMENT_FINALIZE_MALFORMED_REPLY/)
  await assert.rejects(makeClient({}).finalizeWorkflow(ACCOUNT_ID, WORKFLOW_ID), /DOCUMENT_FINALIZE_MALFORMED_REPLY/)
  await assert.rejects(makeClient({ ok: true }).finalizeWorkflow(ACCOUNT_ID, WORKFLOW_ID), /DOCUMENT_FINALIZE_MALFORMED_REPLY/)
  await assert.rejects(makeClient({ ok: false, reason: '' }).finalizeWorkflow(ACCOUNT_ID, WORKFLOW_ID), /DOCUMENT_FINALIZE_MALFORMED_REPLY/)
  // unknown refusals and corrupted links are failures, not skips
  await assert.rejects(makeClient({ ok: false, reason: 'quota_exceeded' }).finalizeWorkflow(ACCOUNT_ID, WORKFLOW_ID), /DOCUMENT_FINALIZE_REFUSED:quota_exceeded/)
  await assert.rejects(makeClient({ ok: false, reason: 'finalize_conflict' }).finalizeWorkflow(ACCOUNT_ID, WORKFLOW_ID), /DOCUMENT_FINALIZE_REFUSED:finalize_conflict/)
  await assert.rejects(makeClient(null, { code: 'PGRST301' }).finalizeWorkflow(ACCOUNT_ID, WORKFLOW_ID), /DOCUMENT_FINALIZE_FAILED:PGRST301/)
  // sweep listing is validated too
  await assert.rejects(makeClient([{ account_id: 'not-a-uuid', workflow_id: WORKFLOW_ID }]).listUnfinalized(25), /DOCUMENT_SWEEP_MALFORMED_REPLY/)
  await assert.rejects(makeClient('nonsense').listUnfinalized(25), /DOCUMENT_SWEEP_MALFORMED_REPLY/)
  assert.deepEqual(await makeClient(null).listUnfinalized(25), [])
}

// ── D2 sweep: counts ONLY genuine finalizations ───────────────────────────────────────────────
{
  const rows = [
    { account_id: ACCOUNT_ID, workflow_id: '01917b12-3a5c-7d9e-bf33-9118c7e7b810' },
    { account_id: ACCOUNT_ID, workflow_id: '01917b12-3a5c-7d9e-bf33-9118c7e7b811' },
    { account_id: ACCOUNT_ID, workflow_id: '01917b12-3a5c-7d9e-bf33-9118c7e7b812' },
    { account_id: ACCOUNT_ID, workflow_id: '01917b12-3a5c-7d9e-bf33-9118c7e7b813' },
  ]
  const outcomes = new Map<string, () => Promise<DocumentFinalizeOutcome>>([
    [rows[0].workflow_id, async () => ({ kind: 'finalized', status: 'completed', already: false })],
    [rows[1].workflow_id, async () => ({ kind: 'skipped', reason: 'compute_not_terminal' })],
    [rows[2].workflow_id, async () => { throw new Error('DOCUMENT_FINALIZE_MALFORMED_REPLY') }],
    [rows[3].workflow_id, async () => ({ kind: 'skipped', reason: 'not_waiting' })],
  ])
  const requestedLimits: number[] = []
  const compute: DocumentComputeClient = {
    async claim() { return [] },
    async finish() {},
    async finalizeWorkflow(_accountId, workflowId) { return outcomes.get(workflowId)!() },
    async listUnfinalized(limit) { requestedLimits.push(limit); return rows },
  }
  assert.equal(await sweepUnfinalizedWorkflows(compute), 1)
  assert.deepEqual(requestedLimits, [25])
  // clients without the optional methods sweep nothing instead of crashing
  assert.equal(await sweepUnfinalizedWorkflows({ async claim() { return [] }, async finish() {} }), 0)
}

// ── StorageArtifactSink: lease identity travels with the bytes, registered path comes back ────
{
  const claimToken = randomUUID()
  const captured: Array<{ url: string; headers: Record<string, string>; bodyBytes: number }> = []
  const registeredPath = `tenants/${ACCOUNT_ID}/artifacts/${JOB_ID}/1/${'a'.repeat(64)}-report.docx`
  const fakeFetch = (async (url: unknown, init: RequestInit | undefined) => {
    captured.push({
      url: String(url),
      headers: Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>)),
      bodyBytes: (init?.body as Uint8Array).byteLength,
    })
    return new Response(JSON.stringify({ ok: true, storage_path: registeredPath, already: true }), { status: 200 })
  }) as typeof fetch
  const sink = new StorageArtifactSink('https://edge.local/document-artifact-upload', 'worker-token', fakeFetch)
  const input = {
    accountId: ACCOUNT_ID,
    jobId: JOB_ID,
    claimToken,
    leaseEpoch: 4,
    outputName: 'report.docx',
    mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    bytes: new Uint8Array([1, 2, 3, 4]),
    sha256: 'b'.repeat(64),
  }
  assert.equal(await sink.store(input), registeredPath)
  assert.equal(captured.length, 1)
  assert.equal(captured[0].headers['x-claim-token'], claimToken)
  assert.equal(captured[0].headers['x-lease-epoch'], '4')
  assert.equal(captured[0].headers['x-artifact-sha256'], 'b'.repeat(64))
  assert.equal(captured[0].headers['x-artifact-size'], '4')
  assert.equal(captured[0].headers.authorization, 'Bearer worker-token')
  assert.equal(captured[0].bodyBytes, 4)

  const refusingFetch = (async () =>
    new Response(JSON.stringify({ error: { code: 'REGISTRATION_REFUSED', reason: 'stale_lease' } }), { status: 409 })
  ) as typeof fetch
  await assert.rejects(
    new StorageArtifactSink('https://edge.local/u', 't', refusingFetch).store(input),
    /ARTIFACT_UPLOAD_FAILED:REGISTRATION_REFUSED:stale_lease/,
  )
  const malformedFetch = (async () => new Response('not json', { status: 200 })) as typeof fetch
  await assert.rejects(
    new StorageArtifactSink('https://edge.local/u', 't', malformedFetch).store(input),
    /ARTIFACT_UPLOAD_FAILED:HTTP_200/,
  )
}

// ── upload refusal classification: permanent fails WITHOUT retry, transient retries ───────────
{
  const refusal = (status: number, body: unknown) =>
    (async () => new Response(JSON.stringify(body), { status })) as typeof fetch
  const runWithSink = async (sinkFetch: typeof fetch) => {
    const finishes: Array<{ status: string; errorCode: string | null }> = []
    const finalized: string[] = []
    const compute: DocumentComputeClient = {
      async claim() { return [] },
      async finish(_job, status, _manifest, errorCode) { finishes.push({ status, errorCode }) },
      async finalizeWorkflow(_account, workflowId) {
        finalized.push(workflowId)
        return { kind: 'finalized', status: 'failed', already: false }
      },
      async listUnfinalized() { return [] },
    }
    const job: ComputeJob = {
      account_id: ACCOUNT_ID,
      job_id: randomUUID(),
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
      sink: new StorageArtifactSink('https://edge.local/u', 't', sinkFetch),
      render: async () => pdf,
    })
    return { result, finishes, finalized }
  }

  // permanent refusals (401 auth, 422 package, registration conflict) → failed, finalize runs
  for (const [label, status, body] of [
    ['401 UNAUTHORIZED', 401, { error: { code: 'UNAUTHORIZED' } }],
    ['422 OOXML_INVALID', 422, { error: { code: 'OOXML_INVALID', reason: 'macro_part' } }],
    ['409 registration_conflict', 409, { error: { code: 'REGISTRATION_REFUSED', reason: 'registration_conflict' } }],
  ] as const) {
    const permanent = await runWithSink(refusal(status, body))
    assert.equal(permanent.result, 'failed', `${label} must not retry`)
    assert.deepEqual(permanent.finishes, [{ status: 'failed', errorCode: 'DOCUMENT_ARTIFACT_REFUSED' }], label)
    assert.deepEqual(permanent.finalized, [WORKFLOW_ID], `${label} finalizes the parent`)
  }
  // transient refusals (408 timeout, 5xx, stale lease) → pending retry, parent NOT finalized
  for (const [label, status, body] of [
    ['408 UPLOAD_TIMEOUT', 408, { error: { code: 'UPLOAD_TIMEOUT' } }],
    ['502 STORAGE_UPLOAD_FAILED', 502, { error: { code: 'STORAGE_UPLOAD_FAILED' } }],
    ['409 stale_lease', 409, { error: { code: 'REGISTRATION_REFUSED', reason: 'stale_lease' } }],
  ] as const) {
    const transient = await runWithSink(refusal(status, body))
    assert.equal(transient.result, 'pending', `${label} retries`)
    assert.deepEqual(transient.finishes, [{ status: 'pending', errorCode: 'DOCUMENT_UPLOAD_TRANSIENT' }], label)
    assert.deepEqual(transient.finalized, [], `${label} keeps the parent waiting`)
  }
  // raw HTTP 401/403 without a JSON body are auth, not transport: permanent
  const raw401 = await runWithSink((async () => new Response('denied', { status: 401 })) as typeof fetch)
  assert.equal(raw401.result, 'failed')
  assert.equal(raw401.finishes[0]?.errorCode, 'DOCUMENT_ARTIFACT_REFUSED')
  // deterministic render ⇒ same bytes: size and content conflicts never heal by retry
  for (const [status, code] of [[413, 'REQUEST_TOO_LARGE'], [409, 'STORAGE_CONFLICT']] as const) {
    const permanent = await runWithSink((async () =>
      new Response(JSON.stringify({ error: { code } }), { status })) as typeof fetch)
    assert.equal(permanent.result, 'failed', code)
    assert.equal(permanent.finishes[0]?.errorCode, 'DOCUMENT_ARTIFACT_REFUSED', code)
  }
  // network failure is transient too
  const network = await runWithSink((async () => { throw new TypeError('fetch failed') }) as typeof fetch)
  assert.equal(network.result, 'pending')
  assert.equal(network.finishes[0]?.errorCode, 'DOCUMENT_UPLOAD_TRANSIENT')
}

// ── kind routing: PDF/OOXML → registered boundary, Marp keeps the local path ──────────
{
  const stored: string[] = []
  const recorder = (label: string) => ({
    async store(input: ArtifactSinkInput) { stored.push(`${label}:${input.mimeType}`); return `tenants/x/${label}` },
  })
  const routing = new KindRoutingArtifactSink(recorder('registered'), recorder('legacy'))
  const baseInput = {
    accountId: ACCOUNT_ID, jobId: JOB_ID, claimToken: randomUUID(), leaseEpoch: 1,
    outputName: 'a.bin', bytes: new Uint8Array([1]), sha256: 'c'.repeat(64),
  }
  await routing.store({ ...baseInput, mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' })
  await routing.store({ ...baseInput, mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' })
  await routing.store({ ...baseInput, mimeType: 'application/pdf' })
  await routing.store({ ...baseInput, mimeType: 'text/html' })
  assert.deepEqual(stored.map((s) => s.split(':')[0]), ['registered', 'registered', 'registered', 'legacy'])
}

// ── fail-fast worker configuration: document-scoped token, explicit local mode only ───────────
{
  const base = { NEMO_COMPUTE_API_URL: 'https://edge.local/compute-worker-api', NEMO_DOCUMENT_WORKER_TOKEN: 'doc-token' }
  const withUpload = resolveDocumentWorkerConfig({ ...base, NEMO_DOCUMENT_UPLOAD_URL: 'https://edge.local/u' }, process.cwd())
  // routing sink: the boundary for OOXML, the legacy local path for typst/marp stays alive
  assert.ok(withUpload.sink instanceof KindRoutingArtifactSink)
  assert.equal(withUpload.workerToken, 'doc-token')
  const localMode = resolveDocumentWorkerConfig({ ...base, NEMO_DOCUMENT_LOCAL_SINK: 'true' }, process.cwd())
  assert.ok(localMode.sink instanceof LocalArtifactSink)
  // no upload URL and no explicit local mode → refuse BEFORE any claim
  assert.throws(() => resolveDocumentWorkerConfig(base, process.cwd()), /DOCUMENT_WORKER_MISCONFIGURED/)
  // the generic compute token is NOT accepted in place of the document-scoped one
  assert.throws(() => resolveDocumentWorkerConfig({
    NEMO_COMPUTE_API_URL: 'https://edge.local/c', NEMO_COMPUTE_WORKER_TOKEN: 'generic',
    NEMO_DOCUMENT_UPLOAD_URL: 'https://edge.local/u',
  }, process.cwd()), /DOCUMENT_WORKER_MISCONFIGURED/)
}

console.log('ADR 002 Stage 1B document worker passed: PDF, slides, fencing manifest, traversal, timeout, D2 finalize/sweep honesty, storage sink lease identity, refusal classification, and fail-fast config.')
