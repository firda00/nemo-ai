import { createHmac, timingSafeEqual } from 'node:crypto'

export const VISION_TIMESTAMP_WINDOW_MS = 30_000
export const VISION_SIGNATURE_SHAPE = /^sha256=([a-f0-9]{64})$/i

export type DeviceVerificationFailure =
  | 'invalid_signature'
  | 'stale_timestamp'

export function verifyTimestampWindow(
  timestamp: string,
  nowMs = Date.now(),
  windowMs = VISION_TIMESTAMP_WINDOW_MS,
): DeviceVerificationFailure | null {
  const parsed = Date.parse(timestamp)
  if (!Number.isFinite(parsed) || Math.abs(nowMs - parsed) > windowMs) return 'stale_timestamp'
  return null
}

/**
 * HMAC is calculated over the exact request bytes. Parsing and re-serializing JSON here would make
 * whitespace/key order part of an undocumented canonicalization scheme and reject valid devices.
 */
export function verifyDeviceHmac(
  rawBody: Uint8Array,
  signatureHeader: string | null | undefined,
  deviceSecret: string,
): DeviceVerificationFailure | null {
  const match = VISION_SIGNATURE_SHAPE.exec(String(signatureHeader ?? ''))
  if (!match || !deviceSecret) return 'invalid_signature'
  const supplied = Buffer.from(match[1], 'hex')
  const expected = createHmac('sha256', deviceSecret).update(rawBody).digest()
  return supplied.length === expected.length && timingSafeEqual(supplied, expected)
    ? null
    : 'invalid_signature'
}

export function signVisionBody(rawBody: Uint8Array, deviceSecret: string): string {
  return `sha256=${createHmac('sha256', deviceSecret).update(rawBody).digest('hex')}`
}
