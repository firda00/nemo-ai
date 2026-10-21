import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { ZodError, z } from 'zod'
import { ScopedComputeApiTransport } from '../compute/scoped-client.ts'
import { ArtifactManifestSchema, ComputeJobSchema, type ArtifactManifest, type ComputeJob } from '../contracts/sandbox.ts'
import { loadLocalEnv } from '../load-local-env.mjs'
import { MarpPresentationInputSchema } from '../documents/marp-renderer.ts'
import { TypstDocumentInputSchema } from '../documents/typst-model.ts'
import { DocxDocumentInputSchema } from '../documents/docx-assembler.ts'
import { PptxPresentationInputSchema } from '../documents/pptx-assembler.ts'
import { sanitizeSandboxOutput } from '../sandbox/wasi-runner.ts'

const PROFILE = 'PROFILE_B_DOCS'
const MEMORY_MIB = 256
const TIMEOUT_MS = 15_000
const MAX_ARTIFACT_BYTES = 64 * 1024 * 1024
const MAX_CAPTURE_BYTES = 64 * 1024
const ENGINE_VERSION = 'nemo-docs-profile-b/1 typst-ts/0.7.0 marp-core/4.2.0'
const WORKER_ID = `document-worker:${process.pid}`

const DocumentPayloadSchema = z.discriminatedUnion('kind', [
  TypstDocumentInputSchema,
  MarpPresentationInputSchema,
  DocxDocumentInputSchema,
  PptxPresentationInputSchema,
])

const DOCUMENT_MIME_BY_KIND = {
  typst_document: 'application/pdf',
  marp_presentation: 'text/html',
  docx_document: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  pptx_presentation: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
} as const

interface RpcResult<T> { data: T | null; error: { message?: string; code?: string } | null }

export interface ComputeRpcTransport {
  rpc<T>(name: string, args: Record<string, unknown>): PromiseLike<RpcResult<T>>
}

// Typed finalize outcome: a known non-final refusal is a SKIP, never a success; anything the
// reply schema does not recognize (null, {}, unknown reason) throws instead of counting.
export type DocumentFinalizeOutcome =
  | { kind: 'finalized'; status: 'completed' | 'failed'; already: boolean }
  | { kind: 'skipped'; reason: 'compute_not_terminal' | 'cancelled' | 'not_document' | 'not_found' | 'not_waiting' }

const FinalizeReplySchema = z.union([
  z.object({ ok: z.literal(true), status: z.enum(['completed', 'failed']), already: z.boolean() }),
  z.object({ ok: z.literal(false), reason: z.string().min(1) }),
])

const SKIPPABLE_FINALIZE_REASONS = ['compute_not_terminal', 'cancelled', 'not_document', 'not_found', 'not_waiting'] as const

const UnfinalizedRowSchema = z.object({ account_id: z.string().uuid(), workflow_id: z.string().uuid() })

export interface DocumentComputeClient {
  claim(workerId: string, limit: number): Promise<ComputeJob[]>
  finish(job: ComputeJob, status: 'pending' | 'completed' | 'failed' | 'dead_letter', manifest: ArtifactManifest | null, errorCode: string | null): Promise<void>
  /** D2 lifecycle: transfer the job's TERMINAL outcome onto its waiting_compute parent. */
  finalizeWorkflow?(accountId: string, workflowId: string): Promise<DocumentFinalizeOutcome>
  /** D2 recovery sweep: waiting_compute document parents whose job is already terminal. */
  listUnfinalized?(limit: number): Promise<Array<{ account_id: string; workflow_id: string }>>
}

// The sink receives the job's lease identity: the upload boundary re-verifies
// claim_token/lease_epoch inside the registration transaction (publication fence), so a
// stale worker's bytes can never become the published artifact.
export interface ArtifactSinkInput {
  accountId: string
  jobId: string
  claimToken: string
  leaseEpoch: number
  outputName: string
  mimeType: string
  bytes: Uint8Array
  sha256: string
}

export interface ArtifactSink {
  store(input: ArtifactSinkInput): Promise<string>
}

export interface IsolatedDocumentResult {
  bytes: Uint8Array
  outputName: string
  mimeType: (typeof DOCUMENT_MIME_BY_KIND)[keyof typeof DOCUMENT_MIME_BY_KIND]
  seed: string | number
  executionTimeMs: number
}

export class DocumentRenderError extends Error {
  readonly code: 'DOCUMENT_TIMEOUT' | 'DOCUMENT_OUTPUT_LIMIT' | 'DOCUMENT_RENDER_FAILED'

  constructor(code: 'DOCUMENT_TIMEOUT' | 'DOCUMENT_OUTPUT_LIMIT' | 'DOCUMENT_RENDER_FAILED', message: string) {
    super(message)
    this.name = 'DocumentRenderError'
    this.code = code
  }
}

export class SupabaseDocumentComputeClient implements DocumentComputeClient {
  private readonly transport: ComputeRpcTransport

  constructor(transport: ComputeRpcTransport) {
    this.transport = transport
  }

  async claim(workerId: string, limit: number): Promise<ComputeJob[]> {
    const { data, error } = await this.transport.rpc<unknown[]>('runtime_claim_compute_jobs', {
      p_worker_id: workerId,
      p_lease_duration_seconds: 60,
      p_limit: limit,
      p_profile: PROFILE,
    })
    if (error) throw new Error(`COMPUTE_CLAIM_FAILED:${error.code ?? 'UNKNOWN'}`)
    const jobs = (data ?? []).map((job) => ComputeJobSchema.parse(job))
    if (jobs.some((job) => job.profile !== PROFILE)) throw new Error('COMPUTE_PROFILE_FILTER_BROKEN')
    return jobs
  }

  async finish(
    job: ComputeJob,
    status: 'pending' | 'completed' | 'failed' | 'dead_letter',
    manifest: ArtifactManifest | null,
    errorCode: string | null,
  ): Promise<void> {
    const result = await this.transport.rpc('runtime_finish_compute_job', {
      p_account_id: job.account_id,
      p_job_id: job.job_id,
      p_claim_token: job.claim_token,
      p_expected_epoch: job.lease_epoch,
      p_status: status,
      p_result_manifest: manifest,
      p_error_code: errorCode,
    })
    if (result.error) throw new Error(`COMPUTE_FINISH_FAILED:${result.error.code ?? 'UNKNOWN'}`)
  }

  async finalizeWorkflow(accountId: string, workflowId: string): Promise<DocumentFinalizeOutcome> {
    const result = await this.transport.rpc<unknown>('document_finalize_workflow', {
      p_account_id: accountId,
      p_workflow_id: workflowId,
    })
    if (result.error) throw new Error(`DOCUMENT_FINALIZE_FAILED:${result.error.code ?? 'UNKNOWN'}`)
    const parsed = FinalizeReplySchema.safeParse(result.data)
    // null / {} / unknown shape is NOT a refusal we understand — surface, never miscount
    if (!parsed.success) throw new Error('DOCUMENT_FINALIZE_MALFORMED_REPLY')
    if (parsed.data.ok) return { kind: 'finalized', status: parsed.data.status, already: parsed.data.already }
    const reason = parsed.data.reason
    if ((SKIPPABLE_FINALIZE_REASONS as readonly string[]).includes(reason)) {
      return { kind: 'skipped', reason: reason as (typeof SKIPPABLE_FINALIZE_REASONS)[number] }
    }
    // finalize_conflict means the request↔job link is corrupt; bad_request/unknown mean the
    // caller or contract broke — all of them are loud failures, not quiet skips
    throw new Error(`DOCUMENT_FINALIZE_REFUSED:${reason}`)
  }

  async listUnfinalized(limit: number): Promise<Array<{ account_id: string; workflow_id: string }>> {
    const bounded = Math.max(1, Math.min(limit, 25))
    const result = await this.transport.rpc<unknown>('document_list_unfinalized', {
      p_limit: bounded,
    })
    if (result.error) throw new Error(`DOCUMENT_SWEEP_FAILED:${result.error.code ?? 'UNKNOWN'}`)
    const rows = z.array(UnfinalizedRowSchema).safeParse(result.data ?? [])
    if (!rows.success) throw new Error('DOCUMENT_SWEEP_MALFORMED_REPLY')
    return rows.data
  }
}

// Offline/dev sink: same CANONICAL path shape as the storage boundary
// (tenants/<acc>/artifacts/<job>/<epoch>/<sha>-<name>) but it does NOT register — against the
// real SQL finalizer a local-sink run honestly finalizes to DOCUMENT_ARTIFACT_UNREGISTERED.
export class LocalArtifactSink implements ArtifactSink {
  private readonly root: string

  constructor(root: string) {
    this.root = path.resolve(root)
  }

  async store(input: ArtifactSinkInput): Promise<string> {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/.test(input.outputName)) throw new Error('ARTIFACT_NAME_INVALID')
    const storagePath = [
      'tenants', input.accountId, 'artifacts', input.jobId,
      String(input.leaseEpoch), `${input.sha256}-${input.outputName}`,
    ].join('/')
    const target = path.resolve(this.root, ...storagePath.split('/'))
    const relative = path.relative(this.root, target)
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('ARTIFACT_PATH_ESCAPE')
    await mkdir(this.root, { recursive: true })
    const canonicalRoot = await realpath(this.root)
    await mkdir(path.dirname(target), { recursive: true })
    const canonicalParent = await realpath(path.dirname(target))
    const canonicalRelative = path.relative(canonicalRoot, canonicalParent)
    if (canonicalRelative.startsWith('..') || path.isAbsolute(canonicalRelative)) throw new Error('ARTIFACT_SYMLINK_ESCAPE')
    try {
      const targetInfo = await lstat(target)
      if (targetInfo.isSymbolicLink() || !targetInfo.isFile()) throw new Error('ARTIFACT_TARGET_INVALID')
      const existing = await readFile(target)
      const existingHash = createHash('sha256').update(existing).digest('hex')
      if (existingHash !== input.sha256) throw new Error('ARTIFACT_IMMUTABILITY_CONFLICT')
      return storagePath
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    const temporary = path.join(path.dirname(target), `.${input.jobId}.${randomUUID()}.tmp`)
    try {
      await writeFile(temporary, input.bytes, { flag: 'wx', mode: 0o600 })
      await rename(temporary, target)
    } finally {
      await rm(temporary, { force: true })
    }
    return storagePath
  }
}

// Upload refusals are CLASSIFIED: a permanent refusal (invalid package, auth/config, a
// conflicting registration) must fail the job WITHOUT retry — re-rendering cannot fix it and
// only burns compute; transport/timeout/storage hiccups stay retryable.
export class ArtifactUploadError extends Error {
  readonly permanent: boolean

  constructor(detail: string, permanent: boolean) {
    super(`ARTIFACT_UPLOAD_FAILED:${detail}`)
    this.name = 'ArtifactUploadError'
    this.permanent = permanent
  }
}

const PERMANENT_UPLOAD_CODES = new Set([
  'OOXML_INVALID', 'PDF_INVALID', 'HASH_MISMATCH', 'SIZE_MISMATCH', 'INVALID_REQUEST',
  'UNAUTHORIZED', 'UPLOAD_API_NOT_CONFIGURED',
  // раз render детерминирован, повтор даст те же байты: тот же размер и тот же конфликт
  'REQUEST_TOO_LARGE', 'STORAGE_CONFLICT',
  // сырые 401/403 без JSON-кода — тоже авторизация, не транспортный сбой
  'HTTP_401', 'HTTP_403',
])
// stale_lease is NOT here: a fresh claim (new epoch) may legitimately succeed
const PERMANENT_REFUSAL_REASONS = new Set([
  'registration_conflict', 'mapping_conflict', 'bad_request', 'blocked',
  'workflow_terminal', 'not_document', 'not_waiting',
])

// Production sink: bytes go to the document-artifact-upload boundary; the worker holds ONLY
// its DOCUMENT worker token — the service role and all storage credentials live behind the
// endpoint. The returned path is the REGISTERED publication path (on a converged retry it may
// name an earlier epoch's object), and it is what the manifest must reference.
export class StorageArtifactSink implements ArtifactSink {
  private readonly uploadUrl: string
  private readonly workerToken: string
  private readonly fetchImpl: typeof fetch
  private readonly timeoutMs: number

  constructor(uploadUrl: string, workerToken: string, fetchImpl: typeof fetch = fetch, timeoutMs = 90_000) {
    this.uploadUrl = uploadUrl
    this.workerToken = workerToken
    this.fetchImpl = fetchImpl
    this.timeoutMs = timeoutMs
  }

  async store(input: ArtifactSinkInput): Promise<string> {
    let response: Response
    try {
      response = await this.fetchImpl(this.uploadUrl, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.workerToken}`,
          'content-type': 'application/octet-stream',
          'x-account-id': input.accountId,
          'x-job-id': input.jobId,
          'x-claim-token': input.claimToken,
          'x-lease-epoch': String(input.leaseEpoch),
          'x-artifact-name': input.outputName,
          'x-artifact-sha256': input.sha256,
          'x-artifact-size': String(input.bytes.byteLength),
        },
        body: input.bytes as unknown as BodyInit,
        signal: AbortSignal.timeout(this.timeoutMs),
      })
    } catch {
      throw new ArtifactUploadError('UPLOAD_NETWORK', false)
    }
    const payload = await response.json().catch(() => null) as
      { ok?: boolean; storage_path?: string; error?: { code?: string; reason?: string } } | null
    if (!response.ok || !payload || payload.ok !== true || typeof payload.storage_path !== 'string') {
      const code = payload?.error?.code ?? `HTTP_${response.status}`
      const reason = payload?.error?.reason
      const permanent = PERMANENT_UPLOAD_CODES.has(code)
        || ((code === 'UPLOAD_REFUSED' || code === 'REGISTRATION_REFUSED')
          && PERMANENT_REFUSAL_REASONS.has(reason ?? ''))
      throw new ArtifactUploadError(`${code}${reason ? `:${reason}` : ''}`, permanent)
    }
    return payload.storage_path
  }
}

// Registered document jobs include PDF and OOXML. Marp HTML retains its existing
// local artifact path; it has no registered document-job lifecycle.
const REGISTERED_MIME_TYPES = new Set([
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
])

export class KindRoutingArtifactSink implements ArtifactSink {
  private readonly registeredSink: ArtifactSink
  private readonly legacySink: ArtifactSink

  constructor(registeredSink: ArtifactSink, legacySink: ArtifactSink) {
    this.registeredSink = registeredSink
    this.legacySink = legacySink
  }

  store(input: ArtifactSinkInput): Promise<string> {
    return REGISTERED_MIME_TYPES.has(input.mimeType) ? this.registeredSink.store(input) : this.legacySink.store(input)
  }
}

export interface DocumentWorkerConfig {
  computeApiUrl: string
  workerToken: string
  sink: ArtifactSink
}

// Fail-fast configuration BEFORE any claim: a worker without an upload boundary would render
// jobs whose parents then honestly finalize DOCUMENT_ARTIFACT_UNREGISTERED — pure waste. The
// local sink exists ONLY as an explicit test/dev mode. The DOCUMENT-scoped token authenticates
// both the compute gateway (which accepts it) and the upload endpoint (which accepts nothing
// else) — never wire the generic compute token here.
export function resolveDocumentWorkerConfig(
  env: Record<string, string | undefined>,
  root: string,
): DocumentWorkerConfig {
  const computeApiUrl = env.NEMO_COMPUTE_API_URL ?? ''
  const workerToken = env.NEMO_DOCUMENT_WORKER_TOKEN ?? ''
  if (!computeApiUrl || !workerToken) {
    throw new Error('DOCUMENT_WORKER_MISCONFIGURED: NEMO_COMPUTE_API_URL and NEMO_DOCUMENT_WORKER_TOKEN are required')
  }
  const uploadUrl = env.NEMO_DOCUMENT_UPLOAD_URL ?? ''
  const localRoot = env.DOCUMENT_ARTIFACT_ROOT ?? path.join(root, 'var', 'document-artifacts')
  if (uploadUrl) {
    // OOXML goes through the registered boundary; typst PDF / marp HTML KEEP their existing
    // local-sink behavior — the production switch must not strand legacy PDF capability
    return {
      computeApiUrl, workerToken,
      sink: new KindRoutingArtifactSink(new StorageArtifactSink(uploadUrl, workerToken), new LocalArtifactSink(localRoot)),
    }
  }
  if (env.NEMO_DOCUMENT_LOCAL_SINK === 'true') {
    return { computeApiUrl, workerToken, sink: new LocalArtifactSink(localRoot) }
  }
  throw new Error('DOCUMENT_WORKER_MISCONFIGURED: set NEMO_DOCUMENT_UPLOAD_URL, or NEMO_DOCUMENT_LOCAL_SINK=true for explicit local mode')
}

function localDenoBinary(): string {
  const executable = process.platform === 'win32' ? 'deno.exe' : 'deno'
  return path.resolve(import.meta.dirname, '..', '..', 'node_modules', 'deno', executable)
}

async function collectChild(
  command: string,
  args: string[],
  timeoutMs: number,
): Promise<{ code: number; stdout: string; stderr: string; timedOut: boolean; outputExceeded: boolean }> {
  const controller = new AbortController()
  let captured = 0
  let timedOut = false
  let outputExceeded = false
  const stdout: Buffer[] = []
  const stderr: Buffer[] = []
  const timer = setTimeout(() => { timedOut = true; controller.abort() }, timeoutMs)
  const child = spawn(command, args, {
    env: { NAPI_RS_FORCE_WASI: '1', NODE_ENV: 'production', CI: '' },
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    signal: controller.signal,
  })
  const capture = (target: Buffer[]) => (chunk: Buffer) => {
    const remaining = MAX_CAPTURE_BYTES - captured
    if (remaining > 0) target.push(chunk.subarray(0, remaining))
    captured += chunk.byteLength
    if (captured > MAX_CAPTURE_BYTES) {
      outputExceeded = true
      controller.abort()
    }
  }
  child.stdout.on('data', capture(stdout))
  child.stderr.on('data', capture(stderr))
  const code = await new Promise<number>((resolve) => {
    let settled = false
    const finish = (value: number) => {
      if (settled) return
      settled = true
      resolve(value)
    }
    child.on('error', () => finish(1))
    child.on('close', (value) => finish(value ?? 1))
  })
  clearTimeout(timer)
  return {
    code,
    stdout: sanitizeSandboxOutput(Buffer.concat(stdout).toString('utf8')),
    stderr: sanitizeSandboxOutput(Buffer.concat(stderr).toString('utf8')),
    timedOut,
    outputExceeded,
  }
}

/** The renderer gets only source modules and an isolated temp directory; Deno denies all network access. */
export async function renderProfileBDocument(
  rawPayload: unknown,
  options: { timeoutMs?: number; denoBinary?: string } = {},
): Promise<IsolatedDocumentResult> {
  const payload = DocumentPayloadSchema.parse(rawPayload)
  const timeoutMs = Math.min(TIMEOUT_MS, Math.max(10, options.timeoutMs ?? TIMEOUT_MS))
  const root = path.resolve(import.meta.dirname, '..', '..')
  const documentsDirectory = path.join(root, 'agent-hub', 'documents')
  const nodeModulesDirectory = path.join(root, 'node_modules')
  const directory = await mkdtemp(path.join(tmpdir(), 'nemo-docs-'))
  const inputPath = path.join(directory, 'input.json')
  const outputPath = path.join(directory, 'artifact.bin')
  const startedAt = performance.now()
  try {
    await writeFile(inputPath, JSON.stringify(payload), { flag: 'wx', mode: 0o400 })
    const execution = await collectChild(options.denoBinary ?? localDenoBinary(), [
      'run', '--no-prompt', '--no-config', '--no-lock', '--no-remote', '--node-modules-dir=manual',
      '--deny-net', '--deny-run', '--deny-sys',
      `--allow-read=${documentsDirectory}`, `--allow-read=${nodeModulesDirectory}`, `--allow-read=${inputPath}`,
      `--allow-write=${directory}`, `--allow-ffi=${nodeModulesDirectory}`,
      '--allow-env=NAPI_RS_FORCE_WASI,NODE_ENV,CI',
      `--v8-flags=--max-old-space-size=${MEMORY_MIB}`,
      path.join(documentsDirectory, 'render-child.ts'), inputPath, outputPath,
    ], timeoutMs)
    if (execution.timedOut) throw new DocumentRenderError('DOCUMENT_TIMEOUT', 'Document render exceeded 15 seconds')
    if (execution.outputExceeded) throw new DocumentRenderError('DOCUMENT_OUTPUT_LIMIT', 'Renderer logs exceeded 64 KiB')
    if (execution.code !== 0) throw new DocumentRenderError('DOCUMENT_RENDER_FAILED', execution.stderr || 'Document renderer failed')
    const files = await readdir(directory, { withFileTypes: true })
    if (files.length > 2 || files.some((entry) => entry.isSymbolicLink() || !entry.isFile())) {
      throw new DocumentRenderError('DOCUMENT_RENDER_FAILED', 'Renderer produced an invalid file set')
    }
    const metadata = JSON.parse(execution.stdout) as { outputName?: string; seed?: string | number }
    const outputInfo = await lstat(outputPath)
    if (outputInfo.isSymbolicLink() || !outputInfo.isFile()) throw new DocumentRenderError('DOCUMENT_RENDER_FAILED', 'Artifact is not a regular file')
    if (outputInfo.size > MAX_ARTIFACT_BYTES) throw new DocumentRenderError('DOCUMENT_OUTPUT_LIMIT', 'Artifact exceeds 64 MiB')
    const bytes = new Uint8Array(await readFile(outputPath))
    return {
      bytes,
      outputName: String(metadata.outputName ?? ''),
      mimeType: DOCUMENT_MIME_BY_KIND[payload.kind],
      seed: metadata.seed ?? payload.seed,
      executionTimeMs: Math.max(0, Math.round(performance.now() - startedAt)),
    }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

function failureCode(error: unknown): string {
  if (error instanceof DocumentRenderError) return error.code
  if (error instanceof ArtifactUploadError) {
    return error.permanent ? 'DOCUMENT_ARTIFACT_REFUSED' : 'DOCUMENT_UPLOAD_TRANSIENT'
  }
  if (error instanceof ZodError) return 'DOCUMENT_INPUT_INVALID'
  return 'DOCUMENT_RENDER_FAILED'
}

function isRetryableDocumentError(code: string): boolean {
  return code === 'DOCUMENT_TIMEOUT' || code === 'DOCUMENT_RENDER_FAILED' || code === 'DOCUMENT_UPLOAD_TRANSIENT'
}

// Once the compute job is terminal, its waiting_compute parent must learn the outcome. A
// finalize failure here is NOT a job failure — the fenced finish already committed — so it is
// logged and left to the recovery sweep instead of rewriting an honest compute result.
async function finalizeParentWorkflow(compute: DocumentComputeClient, job: ComputeJob): Promise<void> {
  if (!compute.finalizeWorkflow) return
  try {
    const outcome = await compute.finalizeWorkflow(job.account_id, job.workflow_id)
    // right after a terminal finish a skip is unexpected — log it, the sweep stays responsible
    if (outcome.kind === 'skipped') {
      console.error(`[document-worker] finalize skipped (${outcome.reason}) for workflow ${job.workflow_id}`)
    }
  } catch (error) {
    console.error(`[document-worker] finalize deferred for workflow ${job.workflow_id}: ${error instanceof Error ? error.message : 'UNKNOWN_ERROR'}`)
  }
}

export async function processDocumentJob(
  job: ComputeJob,
  dependencies: {
    compute: DocumentComputeClient
    sink: ArtifactSink
    render?: typeof renderProfileBDocument
  },
): Promise<'pending' | 'completed' | 'failed' | 'dead_letter'> {
  if (job.profile !== PROFILE) throw new Error('DOCUMENT_PROFILE_MISMATCH')
  let manifest: ArtifactManifest
  try {
    const rendered = await (dependencies.render ?? renderProfileBDocument)(job.input_payload)
    const sha256 = createHash('sha256').update(rendered.bytes).digest('hex')
    const storagePath = await dependencies.sink.store({
      accountId: job.account_id,
      jobId: job.job_id,
      claimToken: job.claim_token,
      leaseEpoch: job.lease_epoch,
      outputName: rendered.outputName,
      mimeType: rendered.mimeType,
      bytes: rendered.bytes,
      sha256,
    })
    manifest = ArtifactManifestSchema.parse({
      job_id: job.job_id,
      status: 'COMPLETED',
      exit_code: 0,
      execution_time_ms: rendered.executionTimeMs,
      stdout_sanitized: '',
      stderr_sanitized: '',
      artifacts: [{
        name: rendered.outputName,
        mime_type: rendered.mimeType,
        size_bytes: rendered.bytes.byteLength,
        sha256,
        storage_path: storagePath,
      }],
      provenance: { engine_version: ENGINE_VERSION, seed: rendered.seed },
    })
  } catch (error) {
    const code = failureCode(error)
    const status = isRetryableDocumentError(code)
      ? (job.attempt_count >= job.max_attempts ? 'dead_letter' : 'pending')
      : 'failed'
    await dependencies.compute.finish(job, status, null, code)
    // pending = retry: the job is NOT terminal, the parent must stay waiting_compute
    if (status !== 'pending') await finalizeParentWorkflow(dependencies.compute, job)
    return status
  }
  // Keep the fenced completion outside the render catch: a stale lease must never be rewritten as
  // a renderer failure or cause a second finish attempt.
  await dependencies.compute.finish(job, 'completed', manifest, null)
  await finalizeParentWorkflow(dependencies.compute, job)
  return 'completed'
}

const SWEEP_LIMIT = 25

// Recovery for parents whose inline finalize failed (worker crash between finish and finalize,
// transient transport error). The SQL returns a deterministic run.created_at, run.id order.
// Counts ONLY genuine ok:true finalizations — a skipped row (e.g. compute_not_terminal after a
// race) is not a success, and a malformed/unknown reply throws in the client and is logged here.
export async function sweepUnfinalizedWorkflows(compute: DocumentComputeClient): Promise<number> {
  if (!compute.listUnfinalized || !compute.finalizeWorkflow) return 0
  let finalized = 0
  const rows = await compute.listUnfinalized(SWEEP_LIMIT)
  for (const row of rows) {
    try {
      const outcome = await compute.finalizeWorkflow(row.account_id, row.workflow_id)
      if (outcome.kind === 'finalized') finalized += 1
    } catch (error) {
      console.error(`[document-worker] sweep finalize failed for workflow ${row.workflow_id}: ${error instanceof Error ? error.message : 'UNKNOWN_ERROR'}`)
    }
  }
  return finalized
}

export async function runDocumentBatch(
  dependencies: { compute: DocumentComputeClient; sink: ArtifactSink; render?: typeof renderProfileBDocument },
  limit = 4,
): Promise<number> {
  const jobs = await dependencies.compute.claim(WORKER_ID, limit)
  for (const job of jobs) {
    try {
      await processDocumentJob(job, dependencies)
    } catch (error) {
      console.error(`[document-worker] job ${job.job_id} failed: ${error instanceof Error ? error.name : 'UNKNOWN_ERROR'}`)
    }
  }
  try {
    await sweepUnfinalizedWorkflows(dependencies.compute)
  } catch (error) {
    console.error(`[document-worker] sweep failed: ${error instanceof Error ? error.name : 'UNKNOWN_ERROR'}`)
  }
  return jobs.length
}

async function main(): Promise<void> {
  const root = path.resolve(import.meta.dirname, '..', '..')
  loadLocalEnv(root)
  // fail-fast: config errors surface HERE, before any job is claimed or rendered
  const config = resolveDocumentWorkerConfig(process.env, root)
  const compute = new SupabaseDocumentComputeClient(new ScopedComputeApiTransport(config.computeApiUrl, config.workerToken))
  const sink = config.sink
  for (;;) {
    try {
      const count = await runDocumentBatch({ compute, sink })
      if (!count) await new Promise((resolve) => setTimeout(resolve, 2_000))
    } catch (error) {
      console.error(`[document-worker] poll failed: ${error instanceof Error ? error.name : 'UNKNOWN_ERROR'}`)
      await new Promise((resolve) => setTimeout(resolve, 2_000))
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`[document-worker] stopped: ${error instanceof Error ? error.name : 'UNKNOWN_ERROR'}`)
    process.exitCode = 1
  })
}
