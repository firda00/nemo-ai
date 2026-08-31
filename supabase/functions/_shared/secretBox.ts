const V1_PREFIX = 'enc:v1:'
const V2_PREFIX = 'enc:v2:'

function decodeBase64(value: string): Uint8Array {
  const raw = atob(value.replace(/-/g, '+').replace(/_/g, '/'))
  return Uint8Array.from(raw, (c) => c.charCodeAt(0))
}

function encodeBase64(value: Uint8Array): string {
  let raw = ''
  for (const byte of value) raw += String.fromCharCode(byte)
  return btoa(raw)
}

// TS 6 models Uint8Array.buffer as ArrayBufferLike, while Web Crypto deliberately accepts only
// an ArrayBuffer-backed BufferSource. Copying the exact view keeps SharedArrayBuffer out of the
// crypto boundary and makes the contract identical in Deno and Node.
function cryptoBuffer(value: Uint8Array): ArrayBuffer {
  return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength) as ArrayBuffer
}

function configuredEncryptionKey(): string {
  const runtime = globalThis as typeof globalThis & {
    Deno?: { env?: { get?: (name: string) => string | undefined } }
    process?: { env?: Record<string, string | undefined> }
  }
  return runtime.Deno?.env?.get?.('CREDENTIAL_ENCRYPTION_KEY')
    ?? runtime.process?.env?.CREDENTIAL_ENCRYPTION_KEY
    ?? ''
}

async function encryptionKey(): Promise<CryptoKey> {
  const configured = configuredEncryptionKey()
  if (!configured) throw new Error('CREDENTIAL_ENCRYPTION_KEY is not configured')
  const bytes = decodeBase64(configured)
  if (bytes.length !== 32) throw new Error('CREDENTIAL_ENCRYPTION_KEY must be 32 bytes')
  return crypto.subtle.importKey('raw', cryptoBuffer(bytes), { name: 'AES-GCM' }, false, ['encrypt', 'decrypt'])
}

export function providerSecretContext(accountId: string, provider: string): string {
  if (!accountId || !provider) throw new Error('Credential context is required')
  return `provider-key:${accountId}:${provider}`
}

export function accountSecretContext(accountId: string, kind: string): string {
  if (!accountId || !kind) throw new Error('Credential context is required')
  return `account-secret:${accountId}:${kind}`
}

export async function sealSecret(value: string, context = ''): Promise<string> {
  if (!value) return value
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const plaintext = new TextEncoder().encode(value)
  try {
    const algorithm: AesGcmParams = context
      ? { name: 'AES-GCM', iv: cryptoBuffer(iv), additionalData: cryptoBuffer(new TextEncoder().encode(context)) }
      : { name: 'AES-GCM', iv: cryptoBuffer(iv) }
    const encrypted = new Uint8Array(await crypto.subtle.encrypt(algorithm, await encryptionKey(), cryptoBuffer(plaintext)))
    return `${context ? V2_PREFIX : V1_PREFIX}${encodeBase64(iv)}:${encodeBase64(encrypted)}`
  } finally {
    plaintext.fill(0)
  }
}

export async function openSecret(value: string | null | undefined, context = ''): Promise<string> {
  if (!value || (!value.startsWith(V1_PREFIX) && !value.startsWith(V2_PREFIX))) return value ?? '' // legacy rows are migrated separately
  const v2 = value.startsWith(V2_PREFIX)
  if (v2 && !context) throw new Error('Credential context is required')
  const [, , iv64, encrypted64] = value.split(':')
  if (!iv64 || !encrypted64) throw new Error('Malformed encrypted credential')
  const algorithm: AesGcmParams = v2
    ? { name: 'AES-GCM', iv: cryptoBuffer(decodeBase64(iv64)), additionalData: cryptoBuffer(new TextEncoder().encode(context)) }
    : { name: 'AES-GCM', iv: cryptoBuffer(decodeBase64(iv64)) }
  const decrypted = new Uint8Array(await crypto.subtle.decrypt(algorithm, await encryptionKey(), cryptoBuffer(decodeBase64(encrypted64))))
  try {
    return new TextDecoder().decode(decrypted)
  } finally {
    decrypted.fill(0)
  }
}
