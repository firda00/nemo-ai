import { createHash } from 'node:crypto'

const JPEG_MIME = 'image/jpeg'
export const MAX_SNAPSHOT_BYTES = 2 * 1024 * 1024
export const DEFAULT_RING_WINDOW_MS = 10_000
export const DEFAULT_RING_MAX_BYTES = 20 * 1024 * 1024
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

interface BufferedFrame {
  capturedAtMs: number
  jpeg: Buffer
}

function assertJpeg(bytes: Uint8Array): void {
  if (bytes.byteLength < 4 || bytes.byteLength > MAX_SNAPSHOT_BYTES) {
    throw new Error('VISION_SNAPSHOT_SIZE_INVALID')
  }
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes.at(-2) !== 0xff || bytes.at(-1) !== 0xd9) {
    throw new Error('VISION_SNAPSHOT_MIME_INVALID')
  }
}

/** A bounded in-process buffer. Frames are copied into RAM and are never materialized on disk. */
export class RamVisionRingBuffer {
  readonly windowMs: number
  readonly maxBytes: number
  #frames: BufferedFrame[] = []
  #bytes = 0

  constructor(windowMs = DEFAULT_RING_WINDOW_MS, maxBytes = DEFAULT_RING_MAX_BYTES) {
    if (windowMs < 1_000 || windowMs > 60_000 || maxBytes < MAX_SNAPSHOT_BYTES) {
      throw new Error('VISION_RING_LIMIT_INVALID')
    }
    this.windowMs = windowMs
    this.maxBytes = maxBytes
  }

  push(jpeg: Uint8Array, capturedAtMs = Date.now()): void {
    assertJpeg(jpeg)
    const copy = Buffer.from(jpeg)
    this.#frames.push({ capturedAtMs, jpeg: copy })
    this.#bytes += copy.byteLength
    this.#prune(capturedAtMs)
  }

  nearest(capturedAtMs: number): Buffer | null {
    let selected: BufferedFrame | undefined
    let distance = Number.POSITIVE_INFINITY
    for (const frame of this.#frames) {
      const nextDistance = Math.abs(frame.capturedAtMs - capturedAtMs)
      if (nextDistance < distance) {
        selected = frame
        distance = nextDistance
      }
    }
    return selected ? Buffer.from(selected.jpeg) : null
  }

  get frameCount(): number { return this.#frames.length }
  get sizeBytes(): number { return this.#bytes }

  #prune(nowMs: number): void {
    while (this.#frames.length && (
      this.#frames[0].capturedAtMs < nowMs - this.windowMs
      || this.#bytes > this.maxBytes
    )) {
      const removed = this.#frames.shift()!
      this.#bytes -= removed.jpeg.byteLength
      removed.jpeg.fill(0)
    }
  }
}

export function visionSnapshotPath(accountId: string, eventId: string, timestamp: string): string {
  if (!UUID.test(accountId) || !UUID.test(eventId)) throw new Error('VISION_SNAPSHOT_PATH_INVALID')
  const date = new Date(timestamp)
  if (!Number.isFinite(date.getTime())) throw new Error('VISION_SNAPSHOT_PATH_INVALID')
  const day = date.toISOString().slice(0, 10).replaceAll('-', '/')
  return `tenants/${accountId}/vision/${day}/${eventId}.jpg`
}

export interface SnapshotUploader {
  upload(input: {
    objectKey: string
    body: Uint8Array
    mimeType: typeof JPEG_MIME
    sizeBytes: number
    sha256: string
    ttlSeconds: number
  }): Promise<void>
}

export async function storeVisionSnapshot(input: {
  accountId: string
  eventId: string
  timestamp: string
  jpeg: Uint8Array
  ttlSeconds?: number
  uploader: SnapshotUploader
}): Promise<{ storage_path: string; sha256: string; size_bytes: number; expires_in_seconds: number }> {
  assertJpeg(input.jpeg)
  const ttlSeconds = input.ttlSeconds ?? 86_400
  if (!Number.isInteger(ttlSeconds) || ttlSeconds < 60 || ttlSeconds > 86_400) {
    throw new Error('VISION_SNAPSHOT_TTL_INVALID')
  }
  const storagePath = visionSnapshotPath(input.accountId, input.eventId, input.timestamp)
  const sha256 = createHash('sha256').update(input.jpeg).digest('hex')
  await input.uploader.upload({
    objectKey: storagePath,
    body: input.jpeg,
    mimeType: JPEG_MIME,
    sizeBytes: input.jpeg.byteLength,
    sha256,
    ttlSeconds,
  })
  return {
    storage_path: storagePath,
    sha256,
    size_bytes: input.jpeg.byteLength,
    expires_in_seconds: ttlSeconds,
  }
}
