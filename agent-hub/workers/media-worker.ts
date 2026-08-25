import { createHash } from 'node:crypto'
import { lookup } from 'node:dns/promises'
import { createWriteStream } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { request as httpsRequest, type IncomingMessage } from 'node:https'
import { isIP } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { ZodError } from 'zod'
import { ArtifactManifestSchema, ComputeJobSchema, type ArtifactManifest, type ComputeJob } from '../contracts/sandbox.ts'
import { ScopedComputeApiTransport } from '../compute/scoped-client.ts'
import { loadLocalEnv } from '../load-local-env.mjs'
import {
  assertRegularInput, deriveFfprobePath, MediaJobPayloadSchema, MediaPipelineError,
  MEDIA_TIMEOUT_MS, MediaAssetSchema, runFfmpegPipeline,
  type LocalMediaInputs, type MediaJobPayload,
} from '../media/ffmpeg-pipeline.ts'
import { buildAssFile } from '../media/subtitles.ts'
import { probeCapabilities, type FfmpegCapabilities } from '../media/ffmpeg-engine.ts'

const PROFILE = 'PROFILE_C_BROWSER'
const WORKER_ID = `media-worker:${process.pid}`
const ENGINE_VERSION = 'nemo-media-profile-c/1 ffmpeg-7'

interface RpcResult<T> { data: T | null; error: { code?: string } | null }
interface RpcTransport { rpc<T>(name: string, args: Record<string, unknown>): PromiseLike<RpcResult<T>> }

export interface MediaComputeClient {
  claim(workerId: string, limit: number): Promise<ComputeJob[]>
  finish(job: ComputeJob, status: 'pending' | 'completed' | 'failed' | 'dead_letter', manifest: ArtifactManifest | null, errorCode: string | null): Promise<void>
}

export interface StorageResolver {
  (hostname: string): Promise<Array<{ address: string; family?: number }>>
}

export interface MediaWorkerDependencies {
  compute: MediaComputeClient
  capabilities: FfmpegCapabilities
  ffmpegPath: string
  ffprobePath: string
  storageHosts: ReadonlySet<string>
  resolver?: StorageResolver
  fetchImpl?: typeof fetch
  workRoot?: string
  now?: () => Date
}

export class SupabaseMediaComputeClient implements MediaComputeClient {
  private readonly transport: RpcTransport

  constructor(transport: RpcTransport) { this.transport = transport }

  async claim(workerId: string, limit: number): Promise<ComputeJob[]> {
    const { data, error } = await this.transport.rpc<unknown[]>('runtime_claim_compute_jobs', {
      p_worker_id: workerId, p_lease_duration_seconds: 180, p_limit: limit, p_profile: PROFILE,
    })
    if (error) throw new Error(`MEDIA_CLAIM_FAILED:${error.code ?? 'UNKNOWN'}`)
    const jobs = (data ?? []).map((job) => ComputeJobSchema.parse(job))
    if (jobs.some((job) => job.profile !== PROFILE)) throw new Error('MEDIA_PROFILE_FILTER_BROKEN')
    return jobs
  }

  async finish(job: ComputeJob, status: 'pending' | 'completed' | 'failed' | 'dead_letter', manifest: ArtifactManifest | null, errorCode: string | null): Promise<void> {
    const { error } = await this.transport.rpc('runtime_finish_compute_job', {
      p_account_id: job.account_id, p_job_id: job.job_id, p_claim_token: job.claim_token,
      p_expected_epoch: job.lease_epoch, p_status: status, p_result_manifest: manifest, p_error_code: errorCode,
    })
    if (error) throw new Error(`MEDIA_FINISH_FAILED:${error.code ?? 'UNKNOWN'}`)
  }
}

function isPrivateAddress(address: string): boolean {
  const normalized = address.toLowerCase()
  if (normalized === '::' || normalized === '::1' || normalized.startsWith('fc') || normalized.startsWith('fd')) return true
  if (/^fe[89ab]/.test(normalized)) return true
  const mapped = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)?.[1]
  const ipv4 = mapped ?? (isIP(address) === 4 ? address : null)
  if (!ipv4) return false
  const [a, b] = ipv4.split('.').map(Number)
  return a === 0 || a === 10 || a === 127 || a >= 224
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168)
    || (a === 198 && (b === 18 || b === 19))
}

async function resolveStorageTarget(
  raw: string,
  allowedHosts: ReadonlySet<string>,
  resolver: StorageResolver = async (hostname) => await lookup(hostname, { all: true, verbatim: true }),
): Promise<{ url: URL; addresses: Array<{ address: string; family: number }> }> {
  const url = new URL(raw)
  const hostname = url.hostname.toLowerCase()
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')) throw new Error('STORAGE_URL_INVALID')
  if (!allowedHosts.has(hostname) || isIP(hostname)) throw new Error('STORAGE_HOST_DENIED')
  const addresses = (await resolver(hostname)).map((entry) => ({ address: entry.address, family: entry.family ?? isIP(entry.address) }))
  if (!addresses.length || addresses.some(({ address }) => isPrivateAddress(address))) throw new Error('STORAGE_ADDRESS_DENIED')
  return { url, addresses }
}

export async function validateStorageUrl(
  raw: string,
  allowedHosts: ReadonlySet<string>,
  resolver?: StorageResolver,
): Promise<URL> {
  return (await resolveStorageTarget(raw, allowedHosts, resolver)).url
}

function pinnedHttpsRequest(options: {
  url: URL
  addresses: Array<{ address: string; family: number }>
  method: 'GET' | 'PUT'
  headers?: Record<string, string>
  body?: Uint8Array
  signal: AbortSignal
}): Promise<IncomingMessage> {
  const selected = options.addresses[0]
  return new Promise((resolve, reject) => {
    const request = httpsRequest(options.url, {
      method: options.method,
      headers: options.headers,
      signal: options.signal,
      servername: options.url.hostname,
      lookup: (_hostname, _lookupOptions, callback) => callback(null, selected.address, selected.family),
    }, resolve)
    request.on('error', reject)
    request.end(options.body)
  })
}

function extensionForMime(mime: string): string {
  return ({
    'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp',
    'video/mp4': '.mp4', 'video/webm': '.webm', 'audio/wav': '.wav',
    'audio/mpeg': '.mp3', 'audio/mp4': '.m4a',
  } as Record<string, string>)[mime] ?? '.bin'
}

type MediaAsset = ReturnType<typeof MediaAssetSchema.parse>

export async function downloadStorageAsset(options: {
  asset: MediaAsset
  destination: string
  allowedHosts: ReadonlySet<string>
  resolver?: StorageResolver
  fetchImpl?: typeof fetch
  signal: AbortSignal
}): Promise<void> {
  const target = await resolveStorageTarget(options.asset.download_url, options.allowedHosts, options.resolver)
  const response = options.fetchImpl
    ? await options.fetchImpl(target.url, { redirect: 'error', signal: options.signal })
    : await pinnedHttpsRequest({ url: target.url, addresses: target.addresses, method: 'GET', signal: options.signal })
  const status = response instanceof Response ? response.status : (response.statusCode ?? 0)
  const body = response instanceof Response ? response.body : response
  if (status < 200 || status >= 300 || !body) throw new Error('STORAGE_DOWNLOAD_FAILED')
  const rawContentType = response instanceof Response ? response.headers.get('content-type') : response.headers['content-type']
  const contentType = String(rawContentType ?? '').split(';')[0].trim().toLowerCase() || null
  if (contentType && contentType !== options.asset.mime_type) throw new Error('STORAGE_MIME_MISMATCH')
  const rawLength = response instanceof Response ? response.headers.get('content-length') : response.headers['content-length']
  const declared = rawLength === null || rawLength === undefined ? null : Number(rawLength)
  if (declared !== null && Number.isFinite(declared) && declared !== options.asset.size_bytes) throw new Error('STORAGE_SIZE_MISMATCH')
  let received = 0
  const hash = createHash('sha256')
  const limiter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      received += chunk.byteLength
      if (received > options.asset.size_bytes) return callback(new Error('STORAGE_SIZE_LIMIT'))
      hash.update(chunk)
      callback(null, chunk)
    },
  })
  const readable = response instanceof Response ? Readable.fromWeb(response.body as never) : response
  await pipeline(readable, limiter, createWriteStream(options.destination, { flags: 'wx', mode: 0o600 }))
  if (received !== options.asset.size_bytes || hash.digest('hex') !== options.asset.sha256) throw new Error('STORAGE_INTEGRITY_FAILED')
}

export async function uploadPresignedArtifact(options: {
  payload: MediaJobPayload
  accountId: string
  bytes: Uint8Array
  mimeType: 'video/mp4' | 'video/webm'
  sha256: string
  allowedHosts: ReadonlySet<string>
  resolver?: StorageResolver
  fetchImpl?: typeof fetch
  signal: AbortSignal
  now: Date
}): Promise<void> {
  const expiresAt = Date.parse(options.payload.output.expires_at)
  if (!Number.isFinite(expiresAt) || expiresAt <= options.now.getTime() + 5_000 || expiresAt > options.now.getTime() + 300_000) {
    throw new Error('UPLOAD_CAPABILITY_EXPIRED')
  }
  const target = await resolveStorageTarget(options.payload.output.upload_url, options.allowedHosts, options.resolver)
  let targetPath: string
  try {
    targetPath = decodeURIComponent(target.url.pathname).replace(/^\/+/, '')
  } catch {
    throw new Error('UPLOAD_TENANT_PATH_MISMATCH')
  }
  const tenantPrefix = `tenants/${options.accountId}/`
  if (!targetPath.startsWith(tenantPrefix) || targetPath !== options.payload.output.storage_path) {
    throw new Error('UPLOAD_TENANT_PATH_MISMATCH')
  }
  const headers = {
    'content-type': options.mimeType,
    'content-length': String(options.bytes.byteLength),
    'x-amz-content-sha256': options.sha256,
  }
  const response = options.fetchImpl
    ? await options.fetchImpl(target.url, { method: 'PUT', redirect: 'error', signal: options.signal, body: options.bytes, headers })
    : await pinnedHttpsRequest({ url: target.url, addresses: target.addresses, method: 'PUT', headers, body: options.bytes, signal: options.signal })
  const status = response instanceof Response ? response.status : (response.statusCode ?? 0)
  if (status < 200 || status >= 300) throw new Error('STORAGE_UPLOAD_FAILED')
  if (!(response instanceof Response)) response.resume()
}

async function materializePayload(
  payload: MediaJobPayload,
  workDirectory: string,
  dependencies: MediaWorkerDependencies,
  signal: AbortSignal,
): Promise<LocalMediaInputs> {
  const assets = new Map<string, string>()
  for (const asset of payload.assets) {
    const destination = path.join(workDirectory, `${asset.id}${extensionForMime(asset.mime_type)}`)
    await downloadStorageAsset({
      asset, destination, allowedHosts: dependencies.storageHosts, resolver: dependencies.resolver,
      fetchImpl: dependencies.fetchImpl, signal,
    })
    await assertRegularInput(destination, workDirectory, asset.size_bytes)
    assets.set(asset.id, destination)
  }
  let subtitlesPath: string | null = null
  if (payload.subtitles.length) {
    subtitlesPath = path.join(workDirectory, 'subtitles.ass')
    const cues = payload.subtitles.map((cue) => ({
      startMs: cue.start_ms, endMs: cue.end_ms, text: cue.text, style: cue.style,
      words: cue.words?.map((word) => ({ text: word.text, startMs: word.start_ms, endMs: word.end_ms })),
    }))
    await writeFile(subtitlesPath, buildAssFile(cues, { playResX: payload.width, playResY: payload.height }), { encoding: 'utf8', flag: 'wx', mode: 0o600 })
  }
  return { assets, subtitlesPath, outputPath: path.join(workDirectory, payload.output_name), workDirectory }
}

function errorCode(error: unknown): string {
  if (error instanceof MediaPipelineError) return error.code
  if (error instanceof ZodError) return 'MEDIA_INPUT_INVALID'
  const message = error instanceof Error ? error.message : ''
  return /^[A-Z][A-Z0-9_]{0,63}$/.test(message) ? message : 'MEDIA_RENDER_FAILED'
}

function isRetryableMediaError(code: string): boolean {
  return new Set([
    'MEDIA_TIMEOUT', 'MEDIA_RENDER_FAILED', 'MEDIA_PROBE_FAILED',
    'STORAGE_DOWNLOAD_FAILED', 'STORAGE_UPLOAD_FAILED', 'COMPUTE_API_UNAVAILABLE',
  ]).has(code)
}

export async function processMediaJob(job: ComputeJob, dependencies: MediaWorkerDependencies): Promise<'pending' | 'completed' | 'failed' | 'dead_letter'> {
  if (job.profile !== PROFILE) throw new Error('MEDIA_PROFILE_MISMATCH')
  const controller = new AbortController()
  const deadline = Date.now() + MEDIA_TIMEOUT_MS
  const timer = setTimeout(() => controller.abort(), MEDIA_TIMEOUT_MS)
  const root = dependencies.workRoot ?? path.join(tmpdir(), 'nemo-media')
  await mkdir(root, { recursive: true })
  const workDirectory = await mkdtemp(path.join(root, `${job.job_id}-`))
  let manifest: ArtifactManifest
  try {
    const payload = MediaJobPayloadSchema.parse(job.input_payload)
    if (!payload.output.storage_path.startsWith(`tenants/${job.account_id}/artifacts/`)) throw new Error('MEDIA_TENANT_PATH_MISMATCH')
    const inputs = await materializePayload(payload, workDirectory, dependencies, controller.signal)
    const remainingMs = Math.max(10, deadline - Date.now())
    const rendered = await runFfmpegPipeline({
      payload, inputs, capabilities: dependencies.capabilities,
      ffmpegPath: dependencies.ffmpegPath, ffprobePath: dependencies.ffprobePath, timeoutMs: remainingMs,
    })
    if (controller.signal.aborted) throw new MediaPipelineError('MEDIA_TIMEOUT', 'media job exceeded 120 seconds')
    const sha256 = createHash('sha256').update(rendered.bytes).digest('hex')
    const mimeType = payload.output_name.toLowerCase().endsWith('.webm') ? 'video/webm' : 'video/mp4'
    await uploadPresignedArtifact({
      payload, accountId: job.account_id, bytes: rendered.bytes, mimeType, sha256,
      allowedHosts: dependencies.storageHosts, resolver: dependencies.resolver, fetchImpl: dependencies.fetchImpl,
      signal: controller.signal, now: (dependencies.now ?? (() => new Date()))(),
    })
    manifest = ArtifactManifestSchema.parse({
      job_id: job.job_id, status: 'COMPLETED', exit_code: 0,
      execution_time_ms: rendered.executionTimeMs, stdout_sanitized: '', stderr_sanitized: '',
      artifacts: [{
        name: payload.output_name, mime_type: mimeType, size_bytes: rendered.bytes.byteLength,
        duration_seconds: rendered.durationSeconds, sha256, storage_path: payload.output.storage_path,
      }],
      provenance: { engine_version: ENGINE_VERSION, seed: payload.seed },
    })
  } catch (error) {
    const code = controller.signal.aborted ? 'MEDIA_TIMEOUT' : errorCode(error)
    const status = isRetryableMediaError(code)
      ? (job.attempt_count >= job.max_attempts ? 'dead_letter' : 'pending')
      : 'failed'
    await dependencies.compute.finish(job, status, null, code)
    return status
  } finally {
    clearTimeout(timer)
    await rm(workDirectory, { recursive: true, force: true })
  }
  await dependencies.compute.finish(job, 'completed', manifest, null)
  return 'completed'
}

export async function runMediaBatch(dependencies: MediaWorkerDependencies, limit = 1): Promise<number> {
  const jobs = await dependencies.compute.claim(WORKER_ID, limit)
  for (const job of jobs) {
    try { await processMediaJob(job, dependencies) }
    catch (error) { console.error(`[media-worker] job ${job.job_id} failed: ${error instanceof Error ? error.name : 'UNKNOWN_ERROR'}`) }
  }
  return jobs.length
}

function defaultFfmpegPath(root: string): string {
  if (process.env.FFMPEG_PATH) return process.env.FFMPEG_PATH
  if (process.platform === 'win32') return path.join(root, 'render-worker', 'node_modules', '@remotion', 'compositor-win32-x64-msvc', 'ffmpeg.exe')
  return 'ffmpeg'
}

async function main(): Promise<void> {
  const root = path.resolve(import.meta.dirname, '..', '..')
  loadLocalEnv(root)
  const computeApiUrl = process.env.NEMO_COMPUTE_API_URL ?? ''
  const computeWorkerToken = process.env.NEMO_COMPUTE_WORKER_TOKEN ?? ''
  const storageHosts = new Set((process.env.MEDIA_STORAGE_HOST_ALLOWLIST ?? '').split(',').map((value) => value.trim().toLowerCase()).filter(Boolean))
  if (!computeApiUrl || !computeWorkerToken || !storageHosts.size) throw new Error('Missing scoped compute API credentials or MEDIA_STORAGE_HOST_ALLOWLIST')
  const ffmpegPath = defaultFfmpegPath(root)
  const capabilities = await probeCapabilities(ffmpegPath)
  if (capabilities.missingRequired.length) throw new Error(`FFmpeg lacks required filters: ${capabilities.missingRequired.join(',')}`)
  const dependencies: MediaWorkerDependencies = {
    compute: new SupabaseMediaComputeClient(new ScopedComputeApiTransport(computeApiUrl, computeWorkerToken)),
    capabilities, ffmpegPath, ffprobePath: process.env.FFPROBE_PATH ?? deriveFfprobePath(ffmpegPath), storageHosts,
    workRoot: process.env.MEDIA_WORK_ROOT,
  }
  for (;;) {
    try {
      const count = await runMediaBatch(dependencies)
      if (!count) await new Promise((resolve) => setTimeout(resolve, 2_000))
    } catch (error) {
      console.error(`[media-worker] poll failed: ${error instanceof Error ? error.name : 'UNKNOWN_ERROR'}`)
      await new Promise((resolve) => setTimeout(resolve, 2_000))
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`[media-worker] stopped: ${error instanceof Error ? error.name : 'UNKNOWN_ERROR'}`)
    process.exitCode = 1
  })
}

export { deriveFfprobePath, MediaJobPayloadSchema, probeCapabilities }
