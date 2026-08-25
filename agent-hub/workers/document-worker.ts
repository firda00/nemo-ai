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
import { TypstDocumentInputSchema } from '../documents/typst-renderer.ts'
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
])

interface RpcResult<T> { data: T | null; error: { message?: string; code?: string } | null }

export interface ComputeRpcTransport {
  rpc<T>(name: string, args: Record<string, unknown>): PromiseLike<RpcResult<T>>
}

export interface DocumentComputeClient {
  claim(workerId: string, limit: number): Promise<ComputeJob[]>
  finish(job: ComputeJob, status: 'pending' | 'completed' | 'failed' | 'dead_letter', manifest: ArtifactManifest | null, errorCode: string | null): Promise<void>
}

export interface ArtifactSink {
  store(input: {
    accountId: string
    jobId: string
    outputName: string
    bytes: Uint8Array
    sha256: string
  }): Promise<string>
}

export interface IsolatedDocumentResult {
  bytes: Uint8Array
  outputName: string
  mimeType: 'application/pdf' | 'text/html'
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
}

export class LocalArtifactSink implements ArtifactSink {
  private readonly root: string

  constructor(root: string) {
    this.root = path.resolve(root)
  }

  async store(input: {
    accountId: string
    jobId: string
    outputName: string
    bytes: Uint8Array
    sha256: string
  }): Promise<string> {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/.test(input.outputName)) throw new Error('ARTIFACT_NAME_INVALID')
    const now = new Date()
    const storagePath = [
      'tenants', input.accountId, 'artifacts', String(now.getUTCFullYear()),
      String(now.getUTCMonth() + 1).padStart(2, '0'), String(now.getUTCDate()).padStart(2, '0'),
      `${input.jobId}-${input.outputName}`,
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
    env: { NAPI_RS_FORCE_WASI: '', NODE_ENV: 'production' },
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
      '--allow-env=NAPI_RS_FORCE_WASI,NODE_ENV',
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
      mimeType: payload.kind === 'typst_document' ? 'application/pdf' : 'text/html',
      seed: metadata.seed ?? payload.seed,
      executionTimeMs: Math.max(0, Math.round(performance.now() - startedAt)),
    }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

function failureCode(error: unknown): string {
  if (error instanceof DocumentRenderError) return error.code
  if (error instanceof ZodError) return 'DOCUMENT_INPUT_INVALID'
  return 'DOCUMENT_RENDER_FAILED'
}

function isRetryableDocumentError(code: string): boolean {
  return code === 'DOCUMENT_TIMEOUT' || code === 'DOCUMENT_RENDER_FAILED'
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
      outputName: rendered.outputName,
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
    return status
  }
  // Keep the fenced completion outside the render catch: a stale lease must never be rewritten as
  // a renderer failure or cause a second finish attempt.
  await dependencies.compute.finish(job, 'completed', manifest, null)
  return 'completed'
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
  return jobs.length
}

async function main(): Promise<void> {
  const root = path.resolve(import.meta.dirname, '..', '..')
  loadLocalEnv(root)
  const computeApiUrl = process.env.NEMO_COMPUTE_API_URL ?? ''
  const computeWorkerToken = process.env.NEMO_COMPUTE_WORKER_TOKEN ?? ''
  if (!computeApiUrl || !computeWorkerToken) throw new Error('Missing scoped compute API credentials')
  const compute = new SupabaseDocumentComputeClient(new ScopedComputeApiTransport(computeApiUrl, computeWorkerToken))
  const sink = new LocalArtifactSink(process.env.DOCUMENT_ARTIFACT_ROOT ?? path.join(root, 'var', 'document-artifacts'))
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
