import { createHash, createHmac } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { readFileSync } from 'node:fs'
import { parse } from 'yaml'
import { describe, expect, test } from 'vitest'
import {
  EdgeSyncBridge,
  FileEdgeQueueStore,
  MemoryEdgeQueueStore,
  type EdgeCloudTransport,
  type EdgeCloudTransportInput,
  type EdgeCloudTransportResult,
} from '../agent-hub/edge/edge-sync-bridge.ts'
import { resolveModelProvider } from '../agent-hub/edge/model-config.ts'

const EVENT_ID = '01917b12-3a5c-7d9e-bf33-9118c7e7b8c2'
const ACCOUNT_ID = '01917b12-3a5c-7d9e-bf33-9118c7e7b801'
const HMAC_SECRET = 'edge-sync-test-secret-with-at-least-32-bytes'
const NOW = new Date('2026-08-25T12:00:00.000Z')

const event = (overrides: Record<string, unknown> = {}) => ({
  event_id: EVENT_ID,
  account_id: ACCOUNT_ID,
  device_id: 'bay-camera-01',
  timestamp: '2026-08-25T11:59:59.500Z',
  event_type: 'BAY_VEHICLE_ENTERED',
  metadata: { bay_id: 'bay-3', confidence: 0.98 },
  ...overrides,
})

class MutableTransport implements EdgeCloudTransport {
  result: EdgeCloudTransportResult = 'retryable_failure'
  readonly sent: EdgeCloudTransportInput[] = []
  async send(input: EdgeCloudTransportInput): Promise<EdgeCloudTransportResult> {
    this.sent.push(input)
    return this.result
  }
}

describe('Production Edge synchronization', () => {
  test('persists an event offline and keeps it queued after a network failure', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'nemo-edge-queue-'))
    try {
      const file = path.join(directory, 'events.json')
      const transport = new MutableTransport()
      const bridge = new EdgeSyncBridge({
        store: new FileEdgeQueueStore(file), transport, hmacSecret: HMAC_SECRET, now: () => NOW,
      })
      expect(await bridge.enqueue(event())).toBe(true)
      expect(await bridge.enqueue(event())).toBe(false)
      expect(await bridge.syncOnce()).toMatchObject({ attempted: 1, synced: 0, remaining: 1 })

      const afterRestart = new EdgeSyncBridge({
        store: new FileEdgeQueueStore(file), transport, hmacSecret: HMAC_SECRET, now: () => NOW,
      })
      expect(await afterRestart.pendingCount()).toBe(1)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  test('syncs idempotently after recovery while preserving UUIDv7 and source timestamp', async () => {
    const transport = new MutableTransport()
    const bridge = new EdgeSyncBridge({
      store: new MemoryEdgeQueueStore(), transport, hmacSecret: HMAC_SECRET, now: () => NOW,
    })
    await bridge.enqueue(event())
    expect((await bridge.syncOnce()).remaining).toBe(1)
    transport.result = 'accepted'
    const recovered = await bridge.syncOnce()
    expect(recovered).toMatchObject({ attempted: 1, synced: 1, remaining: 0 })

    const delivered = transport.sent.at(-1)!
    const body = JSON.parse(new TextDecoder().decode(delivered.body))
    expect(body.event_id).toBe(EVENT_ID)
    expect(body.timestamp).toBe('2026-08-25T11:59:59.500Z')
    expect(delivered.signature).toBe(
      `sha256=${createHmac('sha256', HMAC_SECRET).update(delivered.body).digest('hex')}`,
    )
    expect(await bridge.enqueue(event())).toBe(false)
    expect((await bridge.syncOnce()).attempted).toBe(0)
  })

  test('dead-letters a permanent cloud rejection instead of retrying it forever', async () => {
    const transport = new MutableTransport()
    transport.result = 'permanent_failure'
    const bridge = new EdgeSyncBridge({
      store: new MemoryEdgeQueueStore(), transport, hmacSecret: HMAC_SECRET, now: () => NOW,
    })
    await bridge.enqueue(event())
    expect(await bridge.syncOnce()).toMatchObject({ attempted: 1, rejected: 1, remaining: 0 })
    expect((await bridge.syncOnce()).attempted).toBe(0)
  })

  test('allows one verified JPEG snapshot and rejects every video egress shape', async () => {
    const jpeg = Buffer.from([0xff, 0xd8, 0x01, 0x02, 0xff, 0xd9])
    const bridge = new EdgeSyncBridge({
      store: new MemoryEdgeQueueStore(), transport: new MutableTransport(),
      hmacSecret: HMAC_SECRET, now: () => NOW,
    })
    await expect(bridge.enqueue(event({
      snapshot: {
        mime_type: 'image/jpeg', bytes_base64: jpeg.toString('base64'),
        sha256: createHash('sha256').update(jpeg).digest('hex'),
      },
    }))).resolves.toBe(true)
    await expect(bridge.enqueue(event({
      event_id: '01917b12-3a5c-7d9e-bf33-9118c7e7b8c3',
      metadata: { video_stream: 'rtsp://camera/private' },
    }))).rejects.toThrow('EDGE_VIDEO_EGRESS_DENIED')
  })
})

describe('Local model routing', () => {
  const healthyFetch: typeof fetch = async () => new Response('{"models":[{"name":"qwen2.5:7b-instruct"}]}', {
    status: 200, headers: { 'content-type': 'application/json' },
  })

  test('routes basic tasks to healthy local Ollama and heavy reasoning to cloud', async () => {
    const local = await resolveModelProvider({
      task_type: 'license_plate', complexity_score: 0.2, data_policy: 'prefer_local',
    }, { fetchImpl: healthyFetch })
    expect(local).toMatchObject({ provider: 'ollama_local', model: 'qwen2.5:7b-instruct', reason: 'LOCAL_PRIORITY' })

    const cloud = await resolveModelProvider({
      task_type: 'complex_reasoning', complexity_score: 0.92, data_policy: 'cloud_allowed',
    }, { fetchImpl: healthyFetch })
    expect(cloud).toMatchObject({ provider: 'nemo_cloud', reason: 'COMPLEX_REASONING' })
  })

  test('fails closed for local-only data when Ollama is unavailable', async () => {
    await expect(resolveModelProvider({
      task_type: 'ocr', complexity_score: 0.3, data_policy: 'local_only',
    }, { fetchImpl: async () => new Response(null, { status: 503 }) })).rejects.toThrow('LOCAL_MODEL_UNAVAILABLE')
  })

  test('does not route to a healthy Ollama process when the configured model is absent', async () => {
    await expect(resolveModelProvider({
      task_type: 'categorization', complexity_score: 0.1, data_policy: 'local_only',
    }, {
      fetchImpl: async () => new Response('{"models":[{"name":"llama3:8b"}]}', { status: 200 }),
    })).rejects.toThrow('LOCAL_MODEL_UNAVAILABLE')
  })
})

describe('Edge Compose hardening', () => {
  test('isolates workloads, removes swap, and gives cloud egress only to the bridge', () => {
    const composePath = path.resolve(import.meta.dirname, '..', 'deploy', 'edge', 'docker-compose.edge.yml')
    const compose = parse(readFileSync(composePath, 'utf8')) as Record<string, any>
    const services = compose.services
    expect(Object.keys(services).sort()).toEqual(['edge-media-worker', 'edge-sync-bridge', 'edge-vision-gateway'])
    for (const service of Object.values(services) as Array<Record<string, any>>) {
      expect(service.read_only).toBe(true)
      expect(service.cap_drop).toContain('ALL')
      expect(service.security_opt).toContain('no-new-privileges:true')
      expect(service.memswap_limit).toBe(service.mem_limit)
      expect(service.mem_swappiness).toBe(0)
      expect(service.tmpfs.length).toBeGreaterThan(0)
    }
    expect(services['edge-vision-gateway'].mem_limit).toBe('512m')
    expect(services['edge-media-worker'].mem_limit).toBe('1g')
    expect(services['edge-vision-gateway'].networks).not.toContain('edge_cloud_egress')
    expect(services['edge-media-worker'].networks).not.toContain('edge_cloud_egress')
    expect(services['edge-sync-bridge'].networks).toContain('edge_cloud_egress')
    expect(compose.networks.edge_internal.internal).toBe(true)
    const serialized = JSON.stringify(compose)
    expect(serialized).not.toMatch(/SUPABASE_(?:SERVICE_ROLE_KEY|SECRET_KEY)/)
  })
})
