import { createHash, createHmac, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const MAX_METADATA_BYTES = 64 * 1024
const MAX_SNAPSHOT_BYTES = 2 * 1024 * 1024
const MAX_QUEUE_RECORDS = 50_000
const FORBIDDEN_MEDIA_KEY = /(?:^|_)(?:video|videos|video_stream|rtsp|webrtc|frame|frames|raw_media)(?:$|_)/i

const MetadataSchema = z.record(z.unknown()).superRefine((value, context) => {
  try {
    const encoded = new TextEncoder().encode(JSON.stringify(value))
    if (encoded.byteLength > MAX_METADATA_BYTES) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'edge metadata exceeds 64 KiB' })
    }
  } catch {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'edge metadata must be JSON-serializable' })
  }
})

const SnapshotSchema = z.object({
  mime_type: z.literal('image/jpeg'),
  bytes_base64: z.string().min(4).max(Math.ceil(MAX_SNAPSHOT_BYTES * 4 / 3) + 8),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
}).strict()

export const EdgeSyncEventSchema = z.object({
  event_id: z.string().regex(UUID_V7, 'event_id must be UUIDv7'),
  account_id: z.string().uuid(),
  device_id: z.string().min(1).max(160).regex(/^[A-Za-z0-9._:-]+$/),
  timestamp: z.string().datetime({ precision: 3, offset: true }),
  event_type: z.string().min(1).max(120).regex(/^[A-Z][A-Z0-9_]*$/),
  metadata: MetadataSchema,
  snapshot: SnapshotSchema.optional(),
}).strict()

export type EdgeSyncEvent = z.infer<typeof EdgeSyncEventSchema>

export interface EdgeQueueRecord {
  event: EdgeSyncEvent
  status: 'pending' | 'synced' | 'dead_letter'
  queued_at: string
  synced_at: string | null
  attempt_count: number
  last_error_code: string | null
}

const EdgeQueueRecordSchema = z.object({
  event: EdgeSyncEventSchema,
  status: z.enum(['pending', 'synced', 'dead_letter']),
  queued_at: z.string().datetime({ offset: true }),
  synced_at: z.string().datetime({ offset: true }).nullable(),
  attempt_count: z.number().int().nonnegative(),
  last_error_code: z.string().min(1).max(80).nullable(),
}).strict()

const EdgeQueueFileSchema = z.object({
  version: z.literal(1),
  records: z.array(EdgeQueueRecordSchema).max(MAX_QUEUE_RECORDS),
}).strict()

export interface EdgeQueueStore {
  enqueue(event: EdgeSyncEvent, queuedAt: string): Promise<boolean>
  listPending(limit: number): Promise<EdgeQueueRecord[]>
  markAttempt(eventId: string, errorCode: string): Promise<void>
  markSynced(eventId: string, syncedAt: string): Promise<void>
  markDeadLetter(eventId: string, errorCode: string): Promise<void>
  pendingCount(): Promise<number>
}

function cloneRecord(record: EdgeQueueRecord): EdgeQueueRecord {
  return structuredClone(record)
}

export class MemoryEdgeQueueStore implements EdgeQueueStore {
  protected readonly records = new Map<string, EdgeQueueRecord>()

  async enqueue(event: EdgeSyncEvent, queuedAt: string): Promise<boolean> {
    if (this.records.has(event.event_id)) return false
    this.records.set(event.event_id, {
      event: structuredClone(event), status: 'pending', queued_at: queuedAt,
      synced_at: null, attempt_count: 0, last_error_code: null,
    })
    return true
  }

  async listPending(limit: number): Promise<EdgeQueueRecord[]> {
    return [...this.records.values()]
      .filter((record) => record.status === 'pending')
      .sort((left, right) => left.queued_at.localeCompare(right.queued_at))
      .slice(0, limit)
      .map(cloneRecord)
  }

  async markAttempt(eventId: string, errorCode: string): Promise<void> {
    const record = this.records.get(eventId)
    if (!record || record.status !== 'pending') return
    record.attempt_count += 1
    record.last_error_code = errorCode.slice(0, 80)
  }

  async markSynced(eventId: string, syncedAt: string): Promise<void> {
    const record = this.records.get(eventId)
    if (!record) return
    record.status = 'synced'
    record.synced_at = syncedAt
    record.last_error_code = null
  }

  async markDeadLetter(eventId: string, errorCode: string): Promise<void> {
    const record = this.records.get(eventId)
    if (!record || record.status !== 'pending') return
    record.status = 'dead_letter'
    record.attempt_count += 1
    record.last_error_code = errorCode.slice(0, 80)
  }

  async pendingCount(): Promise<number> {
    return [...this.records.values()].filter((record) => record.status === 'pending').length
  }
}

/** Embedded append-state queue with atomic replacement. The volume must be local and encrypted. */
export class FileEdgeQueueStore extends MemoryEdgeQueueStore {
  private readonly filePath: string
  private loaded = false
  private serial: Promise<void> = Promise.resolve()

  constructor(filePath: string) {
    super()
    this.filePath = path.resolve(filePath)
  }

  private async load(): Promise<void> {
    if (this.loaded) return
    try {
      const parsed = EdgeQueueFileSchema.parse(JSON.parse(await readFile(this.filePath, 'utf8')))
      for (const record of parsed.records) this.records.set(record.event.event_id, record)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'ENOENT') throw new Error('EDGE_QUEUE_STORAGE_INVALID')
    }
    this.loaded = true
  }

  private async persist(): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true })
    let records = [...this.records.values()]
    if (records.length > MAX_QUEUE_RECORDS) {
      const pending = records.filter((record) => record.status === 'pending')
      const synced = records.filter((record) => record.status !== 'pending')
        .sort((left, right) => (right.synced_at ?? '').localeCompare(left.synced_at ?? ''))
      records = [...pending, ...synced.slice(0, Math.max(0, MAX_QUEUE_RECORDS - pending.length))]
      if (records.length > MAX_QUEUE_RECORDS) throw new Error('EDGE_QUEUE_CAPACITY_EXCEEDED')
      this.records.clear()
      for (const record of records) this.records.set(record.event.event_id, record)
    }
    const temporary = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`
    await writeFile(temporary, JSON.stringify({ version: 1, records }), { encoding: 'utf8', mode: 0o600 })
    await rename(temporary, this.filePath)
  }

  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.serial.then(operation, operation)
    this.serial = result.then(() => undefined, () => undefined)
    return result
  }

  override enqueue(event: EdgeSyncEvent, queuedAt: string): Promise<boolean> {
    return this.exclusive(async () => {
      await this.load()
      const inserted = await super.enqueue(event, queuedAt)
      if (inserted) await this.persist()
      return inserted
    })
  }

  override listPending(limit: number): Promise<EdgeQueueRecord[]> {
    return this.exclusive(async () => { await this.load(); return super.listPending(limit) })
  }

  override markAttempt(eventId: string, errorCode: string): Promise<void> {
    return this.exclusive(async () => { await this.load(); await super.markAttempt(eventId, errorCode); await this.persist() })
  }

  override markSynced(eventId: string, syncedAt: string): Promise<void> {
    return this.exclusive(async () => { await this.load(); await super.markSynced(eventId, syncedAt); await this.persist() })
  }


  override markDeadLetter(eventId: string, errorCode: string): Promise<void> {
    return this.exclusive(async () => {
      await this.load()
      await super.markDeadLetter(eventId, errorCode)
      await this.persist()
    })
  }

  override pendingCount(): Promise<number> {
    return this.exclusive(async () => { await this.load(); return super.pendingCount() })
  }
}

function assertNoVideo(value: unknown, key = ''): void {
  if (FORBIDDEN_MEDIA_KEY.test(key)) throw new Error('EDGE_VIDEO_EGRESS_DENIED')
  if (typeof value === 'string' && /^(?:rtsp|webrtc):|^data:video\//i.test(value)) {
    throw new Error('EDGE_VIDEO_EGRESS_DENIED')
  }
  if (Array.isArray(value)) for (const item of value) assertNoVideo(item)
  else if (value && typeof value === 'object') {
    for (const [childKey, childValue] of Object.entries(value)) assertNoVideo(childValue, childKey)
  }
}

function validateSnapshot(event: EdgeSyncEvent): void {
  if (!event.snapshot) return
  const bytes = Buffer.from(event.snapshot.bytes_base64, 'base64')
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_SNAPSHOT_BYTES
    || bytes[0] !== 0xff || bytes[1] !== 0xd8
    || bytes.at(-2) !== 0xff || bytes.at(-1) !== 0xd9) {
    throw new Error('EDGE_SNAPSHOT_INVALID')
  }
  const digest = createHash('sha256').update(bytes).digest('hex')
  if (digest !== event.snapshot.sha256) throw new Error('EDGE_SNAPSHOT_HASH_MISMATCH')
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value)
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('EDGE_EVENT_JSON_INVALID')
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`).join(',')}}`
  }
  throw new Error('EDGE_EVENT_JSON_INVALID')
}

export interface EdgeCloudTransportInput {
  eventId: string
  body: Uint8Array
  signature: string
}

export type EdgeCloudTransportResult = 'accepted' | 'duplicate' | 'retryable_failure' | 'permanent_failure'
export interface EdgeCloudTransport {
  send(input: EdgeCloudTransportInput): Promise<EdgeCloudTransportResult>
}

export class HttpEdgeCloudTransport implements EdgeCloudTransport {
  private readonly endpoint: URL
  private readonly timeoutMs: number
  private readonly fetchImpl: typeof fetch

  constructor(endpoint: string, options: { timeoutMs?: number; fetchImpl?: typeof fetch } = {}) {
    this.endpoint = new URL(endpoint)
    if (this.endpoint.protocol !== 'https:' || this.endpoint.username || this.endpoint.password
      || this.endpoint.hash || this.endpoint.search) throw new Error('EDGE_CLOUD_ENDPOINT_INVALID')
    this.timeoutMs = Math.min(10_000, Math.max(250, options.timeoutMs ?? 5_000))
    this.fetchImpl = options.fetchImpl ?? fetch
  }

  async send(input: EdgeCloudTransportInput): Promise<EdgeCloudTransportResult> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    try {
      const response = await this.fetchImpl(this.endpoint, {
        method: 'POST',
        redirect: 'manual',
        headers: {
          'content-type': 'application/json',
          'x-nemo-edge-event-id': input.eventId,
          'x-nemo-edge-signature': input.signature,
        },
        body: input.body,
        signal: controller.signal,
      })
      if (response.status === 409) return 'duplicate'
      if (response.ok) return 'accepted'
      return response.status === 408 || response.status === 429 || response.status >= 500
        ? 'retryable_failure' : 'permanent_failure'
    } catch {
      return 'retryable_failure'
    } finally {
      clearTimeout(timer)
    }
  }
}

export interface EdgeSyncSummary {
  attempted: number
  synced: number
  duplicates: number
  rejected: number
  remaining: number
}

export class EdgeSyncBridge {
  private readonly store: EdgeQueueStore
  private readonly transport: EdgeCloudTransport
  private readonly hmacSecret: string
  private readonly now: () => Date
  private readonly batchSize: number
  private syncing: Promise<EdgeSyncSummary> | null = null

  constructor(options: {
    store: EdgeQueueStore
    transport: EdgeCloudTransport
    hmacSecret: string
    now?: () => Date
    batchSize?: number
  }) {
    if (Buffer.byteLength(options.hmacSecret, 'utf8') < 32) throw new Error('EDGE_HMAC_SECRET_WEAK')
    this.store = options.store
    this.transport = options.transport
    this.hmacSecret = options.hmacSecret
    this.now = options.now ?? (() => new Date())
    this.batchSize = Math.min(100, Math.max(1, options.batchSize ?? 25))
  }

  async enqueue(rawEvent: unknown): Promise<boolean> {
    const event = EdgeSyncEventSchema.parse(rawEvent)
    assertNoVideo(event.metadata)
    validateSnapshot(event)
    return this.store.enqueue(event, this.now().toISOString())
  }

  async pendingCount(): Promise<number> {
    return this.store.pendingCount()
  }

  async syncOnce(): Promise<EdgeSyncSummary> {
    if (this.syncing) return this.syncing
    this.syncing = this.performSync().finally(() => { this.syncing = null })
    return this.syncing
  }

  private async performSync(): Promise<EdgeSyncSummary> {
    const pending = await this.store.listPending(this.batchSize)
    let synced = 0
    let duplicates = 0
    let rejected = 0
    for (const record of pending) {
      const body = Buffer.from(canonicalJson(record.event), 'utf8')
      const signature = `sha256=${createHmac('sha256', this.hmacSecret).update(body).digest('hex')}`
      const result = await this.transport.send({ eventId: record.event.event_id, body, signature })
      if (result === 'accepted' || result === 'duplicate') {
        await this.store.markSynced(record.event.event_id, this.now().toISOString())
        synced += 1
        if (result === 'duplicate') duplicates += 1
      } else if (result === 'retryable_failure') {
        await this.store.markAttempt(record.event.event_id, 'EDGE_SYNC_RETRYABLE')
      } else {
        await this.store.markDeadLetter(record.event.event_id, 'EDGE_SYNC_REJECTED')
        rejected += 1
      }
    }
    return { attempted: pending.length, synced, duplicates, rejected, remaining: await this.store.pendingCount() }
  }
}

export const edgeSyncLimits = Object.freeze({
  maxMetadataBytes: MAX_METADATA_BYTES,
  maxSnapshotBytes: MAX_SNAPSHOT_BYTES,
  maxQueueRecords: MAX_QUEUE_RECORDS,
})
