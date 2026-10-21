import { DocumentInputSchemas, ENQUEUE_SAFE_PAYLOAD_BYTES, serializedPayloadBytes, type DocumentJobKind } from '../../agent-hub/documents/document-models'
import { DocumentSourceSnapshotSchema, type DocumentSourceSnapshot } from './documentSources'
import { z } from 'zod'
import { DocumentPeriodSchema } from './documentPeriod'

// Offline-testable document-jobs client. Requests are keyed by user + submission UUID.
// The durable v2 submission contains exact input/full brief BEFORE enqueue; unresolved jobs
// are protected from TTL and eviction. Completed records and ordinary caches expire after
// 24 hours. Only cache helpers allow tab-memory fallback; enqueue preparation requires a
// successful persistent write. Logout clears all document namespaces via AuthContext.
export type { DocumentJobKind } from '../../agent-hub/documents/document-models'

export interface DocumentJobArtifact {
  name: string
  mime_type: string
  size_bytes: number
  sha256: string
}

export interface DocumentJobStatusResult {
  status: 'processing' | 'completed' | 'failed' | 'cancelled'
  error_code: string | null
  kind: DocumentJobKind
  artifact: DocumentJobArtifact | null
}

export interface DocumentJobDownload {
  url: string
  expires_in: number
  name: string
  mime_type: string
  size_bytes: number
  sha256: string
}

export type DocumentJobsTransport = (body: Record<string, unknown>) =>
  Promise<{ status: number; body: Record<string, unknown> | null }>

export type DocumentJobsError =
  | 'unauthorized' | 'forbidden' | 'blocked' | 'quota_exceeded' | 'idempotency_conflict'
  | 'input_invalid' | 'payload_too_large' | 'runtime_paused' | 'not_found' | 'not_ready'
  | 'artifact_unregistered' | 'timeout' | 'server_error' | 'storage_unavailable' | 'recovery_unavailable'

export class DocumentJobsRequestError extends Error {
  readonly code: DocumentJobsError

  constructor(code: DocumentJobsError) {
    super(`DOCUMENT_JOBS_${code.toUpperCase()}`)
    this.name = 'DocumentJobsRequestError'
    this.code = code
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

const KNOWN_ERRORS: ReadonlySet<string> = new Set([
  'unauthorized', 'forbidden', 'blocked', 'quota_exceeded', 'idempotency_conflict',
  'input_invalid', 'payload_too_large', 'runtime_paused', 'not_found', 'not_ready',
  'artifact_unregistered', 'timeout',
])

function toError(status: number, body: Record<string, unknown> | null): DocumentJobsRequestError {
  const raw = typeof body?.error === 'string' ? body.error : ''
  if (KNOWN_ERRORS.has(raw)) return new DocumentJobsRequestError(raw as DocumentJobsError)
  if (status === 401) return new DocumentJobsRequestError('unauthorized')
  if (status === 403) return new DocumentJobsRequestError('forbidden')
  if (status === 404) return new DocumentJobsRequestError('not_found')
  if (status === 408) return new DocumentJobsRequestError('timeout')
  return new DocumentJobsRequestError('server_error')
}

const REQUEST_PREFIX = 'nemo.documentJobs.request.'
const CONTENT_PREFIX = 'nemo.documentJobs.content.'
const JOB_PREFIX = 'nemo.documentJobs.job.'
const MAX_REQUEST_ENTRIES = 64
const MAX_CONTENT_ENTRIES = 16
const MAX_JOB_ENTRIES = 16
const ENTRY_TTL_MS = 24 * 60 * 60 * 1000
const MAX_RECORD_BYTES = 192 * 1024
type Entry = { at: number; v: string }
const memoryStore = new Map<string, Entry>()
const contentMemory = new Map<string, Entry>()
const jobMemory = new Map<string, Entry>()
const storageKey = (user: string, id: string) => `${REQUEST_PREFIX}${user}.${id}`
const contentKey = (user: string, id: string) => `${CONTENT_PREFIX}${user}.${id}`
const jobKey = (user: string, id: string) => `${JOB_PREFIX}${user}.${id}`

export interface StoredDocumentJob {
  submissionId: string
  jobId: string | null
  kind: DocumentJobKind
  title: string
  brief: string
  briefComplete?: boolean
  version?: 2 | 3
  requestId?: string
  input?: Record<string, unknown>
  state?: 'preparing' | 'submitting' | 'accepted'
  terminal?: boolean
  source?: DocumentSourceSnapshot
  sourceOptions?: SourceDocumentOptions
}

const SourceOptionsSchema = z.object({ language: z.enum(['ru', 'uz', 'en']), currency: z.enum(['UZS', 'USD', 'RUB', 'EUR']).optional(), wholeWorkbook: z.boolean().optional(), period: DocumentPeriodSchema.optional() }).strict()
  .refine((options) => !(options.wholeWorkbook && options.period))
export type SourceDocumentOptions = z.infer<typeof SourceOptionsSchema>

function parseStoredJob(raw: string | null): StoredDocumentJob | null {
  if (!raw || new TextEncoder().encode(raw).byteLength > MAX_RECORD_BYTES) return null
  try {
    const p = JSON.parse(raw) as StoredDocumentJob
    if (!p || typeof p.submissionId !== 'string' || !p.submissionId || p.submissionId.length > 200) return null
    if (typeof p.kind !== 'string' || !Object.hasOwn(DocumentInputSchemas, p.kind)) return null
    if (typeof p.title !== 'string' || p.title.length > 240 || typeof p.brief !== 'string') return null
    if (p.version !== undefined && p.version !== 2 && p.version !== 3) return null
    const base = { submissionId: p.submissionId, jobId: p.jobId, kind: p.kind, title: p.title, brief: p.brief, briefComplete: p.briefComplete === true }
    if (p.version === undefined) return p.source === undefined && p.sourceOptions === undefined && typeof p.jobId === 'string' && UUID_RE.test(p.jobId) ? base : null
    if (typeof p.requestId !== 'string' || !UUID_RE.test(p.requestId) || p.briefComplete !== true || typeof p.terminal !== 'boolean') return null
    let sourceFields: Pick<StoredDocumentJob, 'source' | 'sourceOptions'> = {}
    if (p.version === 3) {
      const source = DocumentSourceSnapshotSchema.safeParse(p.source)
      const options = SourceOptionsSchema.safeParse(p.sourceOptions)
      if (!source.success || source.data.submissionId !== p.submissionId || !options.success) return null
      sourceFields = { source: source.data, sourceOptions: options.data }
      if (p.state === 'preparing') {
        if (p.input !== undefined || p.jobId !== null || p.terminal) return null
        return { ...base, ...sourceFields, version: 3, requestId: p.requestId, state: 'preparing', terminal: false }
      }
    } else if (p.source !== undefined || p.sourceOptions !== undefined) return null
    if (p.state !== 'submitting' && p.state !== 'accepted') return null
    if (p.state === 'submitting' ? p.jobId !== null || p.terminal : typeof p.jobId !== 'string' || !UUID_RE.test(p.jobId)) return null
    const schema = DocumentInputSchemas[p.kind]
    if (!schema.safeParse(p.input).success || serializedPayloadBytes(p.input) > ENQUEUE_SAFE_PAYLOAD_BYTES) return null
    // Keep the exact stored input, including key order/default presence. Validation must not
    // normalize a retry into a different server input hash.
    return { ...base, ...sourceFields, version: p.version, requestId: p.requestId, input: p.input, state: p.state, terminal: p.terminal }
  } catch { return null }
}

function protectedJob(key: string, entry: Entry): boolean {
  if (!key.startsWith(JOB_PREFIX)) return false
  const job = parseStoredJob(entry.v)
  // Unknown enqueue outcomes and jobs still being processed never silently expire/evict.
  return (job?.version === 2 || job?.version === 3) && !job.terminal
}

function memorySet(map: Map<string, Entry>, key: string, entry: Entry, max: number): void {
  map.delete(key)
  map.set(key, entry)
  for (const [oldKey, oldEntry] of map) {
    if (map.size <= max) break
    if (!protectedJob(oldKey, oldEntry)) map.delete(oldKey)
  }
}

function readEntry(key: string, memory: Map<string, Entry>): Entry | null {
  let entry: Entry | undefined
  let raw: string | null = null
  try {
    const storage = globalThis.localStorage
    if (!storage) entry = memory.get(key)
    else {
      raw = storage.getItem(key)
      if (!raw) { memory.delete(key); return null }
    }
  } catch { entry = memory.get(key) }
  if (raw) {
    try { entry = JSON.parse(raw) as Entry } catch { entry = undefined }
  }
  // Malformed durable records are kept as evidence of interrupted recovery. Never replace
  // them with a fresh request ID or resurrect an older memory value.
  if (key.startsWith(JOB_PREFIX) && raw && (!entry || !parseStoredJob(entry.v) || !Number.isFinite(entry.at) || entry.at < 0)) {
    memory.delete(key)
    return null
  }
  if (!entry || typeof entry.v !== 'string' || !Number.isFinite(entry.at) || entry.at < 0
    || (Date.now() - entry.at > ENTRY_TTL_MS && !protectedJob(key, entry))) {
    memory.delete(key)
    try { globalThis.localStorage?.removeItem(key) } catch { /* unavailable */ }
    return null
  }
  return entry
}

function pruneOldest(prefix: string, max: number, memory: Map<string, Entry>): void {
  try {
    const storage = globalThis.localStorage
    if (!storage) return
    const keys = Array.from({ length: storage.length }, (_, index) => storage.key(index))
    const entries = keys.filter((key): key is string => !!key?.startsWith(prefix))
      .flatMap((key) => { const entry = readEntry(key, memory); return entry ? [{ key, ...entry }] : [] })
      .sort((a, b) => a.at - b.at)
    let excess = entries.length - max
    for (const entry of entries) {
      if (excess <= 0) break
      if (protectedJob(entry.key, entry)) continue
      storage.removeItem(entry.key)
      memory.delete(entry.key)
      excess -= 1
    }
  } catch { /* cache cleanup is best effort */ }
}

function writeEntry(prefix: string, key: string, value: string, max: number, memory: Map<string, Entry>, durable = false): void {
  const entry = { at: Date.now(), v: value }
  try {
    const storage = globalThis.localStorage
    if (!storage) throw new Error('storage unavailable')
    if (durable && !storage.getItem(key)) {
      // Do not evict an unresolved submission to make space for another one.
      pruneOldest(prefix, max - 1, memory)
      const count = Array.from({ length: storage.length }, (_, i) => storage.key(i)).filter((k) => k?.startsWith(prefix)).length
      if (count >= max) throw new Error('recovery capacity exhausted')
    }
    const raw = JSON.stringify(entry)
    storage.setItem(key, raw)
    if (durable && storage.getItem(key) !== raw) throw new Error('storage write failed')
  } catch {
    if (durable) throw new DocumentJobsRequestError('storage_unavailable')
  }
  memorySet(memory, key, entry, max)
  pruneOldest(prefix, max, memory)
}

export function clearDocumentJobsStorage(): void {
  memoryStore.clear()
  contentMemory.clear()
  jobMemory.clear()
  try {
    const storage = globalThis.localStorage
    if (!storage) return
    for (let index = storage.length - 1; index >= 0; index -= 1) {
      const key = storage.key(index)
      if (key?.startsWith(REQUEST_PREFIX) || key?.startsWith(CONTENT_PREFIX) || key?.startsWith(JOB_PREFIX)) storage.removeItem(key)
    }
  } catch { /* memory has already been cleared */ }
}

export function persistentRequestId(userId: string, requestKey: string): string {
  if (!userId || !requestKey) throw new Error('DOCUMENT_JOBS_REQUEST_KEY_REQUIRED')
  const pending = recallDocumentJob(userId, requestKey)
  if (pending?.requestId) return pending.requestId
  const key = storageKey(userId, requestKey)
  const stored = readEntry(key, memoryStore)
  if (stored && UUID_RE.test(stored.v)) {
    memorySet(memoryStore, key, stored, MAX_REQUEST_ENTRIES)
    return stored.v
  }
  const generated = crypto.randomUUID()
  writeEntry(REQUEST_PREFIX, key, generated, MAX_REQUEST_ENTRIES, memoryStore)
  return generated
}

export async function stableRequestKey(kind: DocumentJobKind, input: Record<string, unknown>): Promise<string> {
  const bytes = new TextEncoder().encode(`${kind}|${JSON.stringify(input)}`)
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 40)
}

export function recallGeneratedContent(user: string, id: string): string | null {
  const key = contentKey(user, id)
  const entry = readEntry(key, contentMemory)
  if (!entry) return null
  memorySet(contentMemory, key, entry, MAX_CONTENT_ENTRIES)
  return entry.v
}

export function storeGeneratedContent(user: string, id: string, content: string): void {
  if (new TextEncoder().encode(content).byteLength > 64 * 1024) return
  writeEntry(CONTENT_PREFIX, contentKey(user, id), content, MAX_CONTENT_ENTRIES, contentMemory)
}

function removeEntry(key: string, memory: Map<string, Entry>): void {
  memory.delete(key)
  try { globalThis.localStorage?.removeItem(key) } catch { /* unavailable */ }
}

export function releaseGeneratedContent(user: string, id: string): void { removeEntry(contentKey(user, id), contentMemory) }

export function rememberDocumentJob(user: string, meta: StoredDocumentJob): void {
  if (meta.source && meta.source.owner !== user) throw new DocumentJobsRequestError('recovery_unavailable')
  const value = JSON.stringify({ ...meta, briefComplete: meta.briefComplete ?? true })
  if (new TextEncoder().encode(value).byteLength > MAX_RECORD_BYTES) throw new DocumentJobsRequestError('payload_too_large')
  const parsed = parseStoredJob(value)
  if (!parsed) throw new DocumentJobsRequestError('input_invalid')
  writeEntry(JOB_PREFIX, jobKey(user, meta.submissionId), JSON.stringify(parsed), MAX_JOB_ENTRIES, jobMemory, true)
}

// Commit a discoverable, complete record BEFORE enqueue. Neither tokens nor signed links
// belong here. If persistence is unavailable, the caller must stop before enqueue.
export function prepareDocumentSubmission(user: string, meta: Omit<StoredDocumentJob, 'jobId'> & { input: Record<string, unknown> }): StoredDocumentJob {
  const existing = recallDocumentJob(user, meta.submissionId)
  if (existing) {
    if (existing.version === 3 && existing.state === 'preparing') {
      if (existing.kind !== meta.kind || existing.title !== meta.title || existing.brief !== meta.brief) throw new DocumentJobsRequestError('idempotency_conflict')
      const pending: StoredDocumentJob = { ...existing, input: meta.input, state: 'submitting' }
      rememberDocumentJob(user, pending)
      return pending
    }
    if (existing.kind !== meta.kind || JSON.stringify(existing.input) !== JSON.stringify(meta.input)) throw new DocumentJobsRequestError('idempotency_conflict')
    return existing
  }
  const pending: StoredDocumentJob = {
    submissionId: meta.submissionId, kind: meta.kind, title: meta.title, brief: meta.brief,
    version: 2, requestId: persistentRequestId(user, meta.submissionId), input: meta.input,
    state: 'submitting', jobId: null, briefComplete: true, terminal: false,
  }
  rememberDocumentJob(user, pending)
  return pending
}

// A discoverable source draft survives reload BEFORE content generation or clarification.
export function prepareSourceDocument(user: string, meta: Pick<StoredDocumentJob, 'submissionId' | 'kind' | 'title' | 'brief'>,
  source: DocumentSourceSnapshot, sourceOptions: SourceDocumentOptions): StoredDocumentJob {
  const existing = recallDocumentJob(user, meta.submissionId)
  if (existing) {
    if (JSON.stringify(existing.source) !== JSON.stringify(source) || existing.kind !== meta.kind) throw new DocumentJobsRequestError('idempotency_conflict')
    return existing
  }
  const pending: StoredDocumentJob = { ...meta, version: 3, jobId: null, state: 'preparing', terminal: false,
    briefComplete: true, requestId: crypto.randomUUID(), source, sourceOptions }
  rememberDocumentJob(user, pending)
  return pending
}

export function updateSourceDocumentOptions(user: string, submissionId: string, sourceOptions: SourceDocumentOptions): StoredDocumentJob {
  const existing = recallDocumentJob(user, submissionId)
  if (!existing?.source || existing.state !== 'preparing') throw new DocumentJobsRequestError('recovery_unavailable')
  const updated = { ...existing, sourceOptions }
  rememberDocumentJob(user, updated)
  return updated
}

// Atomically replace a terminal record. A failed write leaves the previous snapshot recoverable.
export function regenerateSourceDocument(user: string, submissionId: string): StoredDocumentJob {
  const existing = recallDocumentJob(user, submissionId)
  if (existing?.version !== 3 || !existing.source || !existing.terminal) throw new DocumentJobsRequestError('recovery_unavailable')
  const pending: StoredDocumentJob = { ...existing, input: undefined, requestId: crypto.randomUUID(), jobId: null, terminal: false, state: 'preparing' }
  rememberDocumentJob(user, pending)
  return pending
}

export function discardSourceDocumentDraft(user: string, submissionId: string): void {
  const existing = recallDocumentJob(user, submissionId)
  if (existing?.version !== 3 || existing.state !== 'preparing') throw new DocumentJobsRequestError('recovery_unavailable')
  const key = jobKey(user, submissionId)
  try {
    if (!globalThis.localStorage) throw new Error('storage unavailable')
    globalThis.localStorage.removeItem(key)
    if (globalThis.localStorage.getItem(key) !== null) throw new Error('storage removal failed')
  } catch { throw new DocumentJobsRequestError('storage_unavailable') }
  jobMemory.delete(key)
  releaseGeneratedContent(user, submissionId)
  releaseRequestId(user, submissionId)
}

export function recallDocumentJob(user: string, submissionId: string): StoredDocumentJob | null {
  const key = jobKey(user, submissionId)
  const entry = readEntry(key, jobMemory)
  const parsed = parseStoredJob(entry?.v ?? null)
  if (!parsed || parsed.submissionId !== submissionId || (parsed.source && parsed.source.owner !== user)) {
    let present = false
    try { present = !!globalThis.localStorage?.getItem(key) } catch { /* unavailable */ }
    if (present) throw new DocumentJobsRequestError('recovery_unavailable')
    return null
  }
  memorySet(jobMemory, key, entry!, MAX_JOB_ENTRIES)
  return parsed
}

export function listRecentDocumentJobs(user: string): StoredDocumentJob[] {
  const out: Array<{ at: number; job: StoredDocumentJob }> = []
  try {
    const storage = globalThis.localStorage
    if (!storage) return []
    const prefix = `${JOB_PREFIX}${user}.`
    // Snapshot before readEntry removes expired rows (localStorage indices shift).
    const keys = Array.from({ length: storage.length }, (_, index) => storage.key(index))
    for (const key of keys) {
      if (!key?.startsWith(prefix)) continue
      const entry = readEntry(key, jobMemory)
      const job = parseStoredJob(entry?.v ?? null)
      if (entry && job && (!job.source || job.source.owner === user) && key === jobKey(user, job.submissionId)) out.push({ at: entry.at, job })
    }
  } catch { return [] }
  return out.sort((a, b) => Number(a.job.terminal ?? true) - Number(b.job.terminal ?? true) || b.at - a.at).map((entry) => entry.job)
}

export function hasDocumentRecoveryIssue(user: string): boolean {
  try {
    const storage = globalThis.localStorage
    if (!storage) return false
    const keys = Array.from({ length: storage.length }, (_, i) => storage.key(i))
    return keys.some((key) => {
      if (!key?.startsWith(`${JOB_PREFIX}${user}.`)) return false
      const raw = storage.getItem(key)
      if (!raw) return false
      try {
        const entry = JSON.parse(raw) as Entry
        const job = parseStoredJob(entry.v)
        return !Number.isFinite(entry.at) || entry.at < 0 || !job || (job.source && job.source.owner !== user) || key !== jobKey(user, job.submissionId)
      } catch { return true }
    })
  } catch { return true }
}

export function forgetDocumentJob(user: string, id: string): void { removeEntry(jobKey(user, id), jobMemory) }
export function releaseRequestId(user: string, id: string): void { removeEntry(storageKey(user, id), memoryStore) }


// ── вызовы границы ─────────────────────────────────────────────────────────────────────────────
export async function enqueueDocumentJob(
  transport: DocumentJobsTransport,
  params: { userId: string; requestKey: string; kind: DocumentJobKind; input: Record<string, unknown>; requestId?: string },
): Promise<{ jobId: string; deduplicated: boolean; requestId: string }> {
  const requestId = params.requestId ?? persistentRequestId(params.userId, params.requestKey)
  if (!UUID_RE.test(requestId)) throw new DocumentJobsRequestError('input_invalid')
  const { status, body } = await transport({
    action: 'enqueue',
    request_id: requestId,
    kind: params.kind,
    input: params.input,
  })
  if (status !== 200 || body?.ok !== true) throw toError(status, body)
  const jobId = body.job_id
  if (typeof jobId !== 'string' || !UUID_RE.test(jobId)) throw new DocumentJobsRequestError('server_error')
  return { jobId, deduplicated: body.deduplicated === true, requestId }
}

export async function getDocumentJobStatus(
  transport: DocumentJobsTransport,
  jobId: string,
): Promise<DocumentJobStatusResult> {
  const { status, body } = await transport({ action: 'status', job_id: jobId })
  if (status !== 200 || body?.ok !== true) throw toError(status, body)
  const state = body.status
  if (state !== 'processing' && state !== 'completed' && state !== 'failed' && state !== 'cancelled') {
    throw new DocumentJobsRequestError('server_error')
  }
  const artifact = body.artifact as DocumentJobArtifact | null
  return {
    status: state,
    error_code: typeof body.error_code === 'string' ? body.error_code : null,
    kind: body.kind as DocumentJobKind,
    artifact: state === 'completed' && artifact ? artifact : null,
  }
}

export async function getDocumentJobDownload(
  transport: DocumentJobsTransport,
  jobId: string,
): Promise<DocumentJobDownload> {
  const { status, body } = await transport({ action: 'download', job_id: jobId })
  if (status !== 200 || body?.ok !== true) throw toError(status, body)
  if (typeof body.url !== 'string' || body.expires_in !== 300) throw new DocumentJobsRequestError('server_error')
  return body as unknown as DocumentJobDownload
}

export type DocumentJobPollOutcome =
  | { kind: 'terminal'; result: DocumentJobStatusResult }
  | { kind: 'still_processing'; lastStatus: DocumentJobStatusResult | null }
  | { kind: 'scope_lost' }

// Таймаут = «ещё обрабатывается»: вызывающий показывает это состояние и позже возобновляет
// опрос ТОГО ЖЕ jobId — новых заданий отсюда не рождается. scopeAlive() проверяется перед
// КАЖДЫМ обращением: после смены личности не уходит ни одного лишнего запроса.
export async function pollDocumentJob(
  transport: DocumentJobsTransport,
  jobId: string,
  options: {
    scopeAlive: () => boolean
    intervalMs?: number
    timeoutMs?: number
    sleep?: (ms: number) => Promise<void>
  },
): Promise<DocumentJobPollOutcome> {
  const intervalMs = options.intervalMs ?? 2_500
  const timeoutMs = options.timeoutMs ?? 90_000
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const deadlineAt = Date.now() + timeoutMs
  let lastStatus: DocumentJobStatusResult
  for (;;) {
    if (!options.scopeAlive()) return { kind: 'scope_lost' }
    try {
      lastStatus = await getDocumentJobStatus(transport, jobId)
    } catch (error) {
      // an error that lands in a DEAD scope must not reach the UI as an error either
      if (!options.scopeAlive()) return { kind: 'scope_lost' }
      throw error
    }
    // ПОСЛЕ await тоже: личность могла смениться, пока ответ летел — данные чужой сессии
    // не возвращаются вызывающему ни как terminal, ни как still_processing
    if (!options.scopeAlive()) return { kind: 'scope_lost' }
    if (lastStatus.status !== 'processing') return { kind: 'terminal', result: lastStatus }
    if (Date.now() + intervalMs > deadlineAt) return { kind: 'still_processing', lastStatus }
    await sleep(intervalMs)
  }
}
