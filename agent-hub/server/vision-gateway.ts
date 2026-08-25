import { VisionEventSchema, type VisionEvent } from '../contracts/sandbox.ts'
import { verifyDeviceHmac, verifyTimestampWindow } from '../vision/device-verifier.ts'
import { openSecret, accountSecretContext } from '../../supabase/functions/_shared/secretBox.ts'
import {
  createRuntimeClient,
  type RuntimeRpcTransport,
} from '../../supabase/functions/_shared/runtime.ts'

const MAX_VISION_BODY_BYTES = 64 * 1024
const WORKFLOW_TYPE = 'vision_event_shadow_evaluation'

export interface VisionDeviceIdentity {
  accountId: string
  deviceId: string
  deviceSecret: string
}

export type VisionDeviceResolver = (deviceId: string) => Promise<VisionDeviceIdentity | null>

export interface VisionGatewayDeps {
  admin: RuntimeRpcTransport
  resolveDevice?: VisionDeviceResolver
  now?: () => number
}

export interface VisionGatewayResponse {
  status: number
  body: Record<string, unknown>
}

const generic = (status: number): VisionGatewayResponse => ({
  status,
  body: { error: 'invalid_vision_event' },
})

async function resolveEncryptedDevice(
  admin: RuntimeRpcTransport,
  deviceId: string,
): Promise<VisionDeviceIdentity | null> {
  const { data, error } = await admin.rpc('runtime_resolve_vision_device_identity', {
    p_device_id: deviceId,
  })
  if (error) throw new Error('VISION_IDENTITY_UNAVAILABLE')
  const rows = Array.isArray(data) ? data as Array<Record<string, unknown>> : []
  const row = rows.length === 1 ? rows[0] : null
  const accountId = String(row?.account_id ?? '')
  const resolvedDeviceId = String(row?.device_id ?? '')
  const encrypted = String(row?.secret_encrypted ?? '')
  if (!accountId || resolvedDeviceId !== deviceId || !encrypted.startsWith('enc:v2:')) return null
  const secret = await openSecret(
    encrypted,
    accountSecretContext(accountId, `vision-device:${resolvedDeviceId}`),
  )
  return secret ? { accountId, deviceId: resolvedDeviceId, deviceSecret: secret } : null
}

function parseVisionBody(rawBody: Uint8Array): VisionEvent | null {
  if (rawBody.byteLength === 0 || rawBody.byteLength > MAX_VISION_BODY_BYTES) return null
  try {
    const decoded = new TextDecoder('utf-8', { fatal: true }).decode(rawBody)
    return VisionEventSchema.parse(JSON.parse(decoded))
  } catch {
    return null
  }
}

/**
 * Authenticates the physical device, then writes one shadow-only durable event. Duplicate event IDs
 * are rejected from the atomic Runtime Inbox result, so replay protection works across processes.
 */
export async function handleVisionEvent(
  deps: VisionGatewayDeps,
  rawBody: Uint8Array,
  signatureHeader: string | null | undefined,
): Promise<VisionGatewayResponse> {
  const event = parseVisionBody(rawBody)
  if (!event) return generic(400)
  if (verifyTimestampWindow(event.timestamp, deps.now?.() ?? Date.now())) return generic(401)

  let identity: VisionDeviceIdentity | null
  try {
    identity = await (deps.resolveDevice ?? ((deviceId) => resolveEncryptedDevice(deps.admin, deviceId)))(event.device_id)
  } catch {
    return { status: 503, body: { error: 'vision_gateway_unavailable' } }
  }
  // account_id is an assertion by an untrusted device. The server-side identity is authoritative.
  if (!identity || identity.accountId !== event.account_id || identity.deviceId !== event.device_id) {
    return generic(401)
  }
  if (verifyDeviceHmac(rawBody, signatureHeader, identity.deviceSecret)) return generic(401)

  const runtimePayload = {
    event_id: event.event_id,
    device_id: identity.deviceId,
    captured_at: event.timestamp,
    event_type: event.event_type,
    precision_score: event.precision_score,
    ...(event.bounding_box ? { bounding_box: event.bounding_box } : {}),
    ...(event.snapshot_ref ? { snapshot_ref: event.snapshot_ref } : {}),
    untrusted_sensor_output: {
      trust_level: 'untrusted',
      instruction_use: 'forbidden',
      attributes: event.untrusted_attributes,
    },
    safety: {
      execution_mode: 'shadow',
      external_side_effects_allowed: false,
    },
  }

  try {
    const ingested = await createRuntimeClient(deps.admin).ingestEvent({
      accountId: identity.accountId,
      provider: 'vision',
      externalEventId: event.event_id,
      payload: runtimePayload,
      executionMode: 'shadow',
      correlationId: event.event_id,
      eventType: event.event_type.toLowerCase(),
      occurredAt: event.timestamp,
      contractVersion: 'vision-event-v1',
      identityVersion: 'vision-device-hmac-v1',
      workflowType: WORKFLOW_TYPE,
      workflowVersion: 'v1',
      actorId: `vision-device:${identity.deviceId}`,
    })
    if (ingested.status === 'duplicate') return generic(409)
    return {
      status: 202,
      body: {
        ok: true,
        accepted: true,
        mode: 'shadow',
        workflow_id: ingested.workflow_id,
      },
    }
  } catch {
    return {
      status: 503,
      body: { error: 'vision_gateway_unavailable' },
    }
  }
}

export const visionGatewayLimits = Object.freeze({
  maxBodyBytes: MAX_VISION_BODY_BYTES,
  workflowType: WORKFLOW_TYPE,
  executionMode: 'shadow' as const,
})
