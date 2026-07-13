const PREFIX = 'enc:v1:'
let cachedKey: Promise<CryptoKey> | null = null

function decodeBase64(value: string): Uint8Array {
  const raw = atob(value.replace(/-/g, '+').replace(/_/g, '/'))
  return Uint8Array.from(raw, (c) => c.charCodeAt(0))
}

function encodeBase64(value: Uint8Array): string {
  let raw = ''
  for (const byte of value) raw += String.fromCharCode(byte)
  return btoa(raw)
}

async function encryptionKey(): Promise<CryptoKey> {
  if (!cachedKey) {
    cachedKey = (async () => {
      const configured = Deno.env.get('CREDENTIAL_ENCRYPTION_KEY') ?? ''
      if (!configured) throw new Error('CREDENTIAL_ENCRYPTION_KEY is not configured')
      const bytes = decodeBase64(configured)
      if (bytes.length !== 32) throw new Error('CREDENTIAL_ENCRYPTION_KEY must be 32 bytes')
      return crypto.subtle.importKey('raw', bytes, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt'])
    })()
  }
  return cachedKey
}

export async function sealSecret(value: string): Promise<string> {
  if (!value || value.startsWith(PREFIX)) return value
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const plaintext = new TextEncoder().encode(value)
  const encrypted = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await encryptionKey(), plaintext))
  return `${PREFIX}${encodeBase64(iv)}:${encodeBase64(encrypted)}`
}

export async function openSecret(value: string | null | undefined): Promise<string> {
  if (!value || !value.startsWith(PREFIX)) return value ?? '' // legacy rows are migrated separately
  const [, , iv64, encrypted64] = value.split(':')
  if (!iv64 || !encrypted64) throw new Error('Malformed encrypted credential')
  const decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: decodeBase64(iv64) }, await encryptionKey(), decodeBase64(encrypted64))
  return new TextDecoder().decode(decrypted)
}
