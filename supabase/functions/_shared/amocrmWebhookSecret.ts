const SUBDOMAIN = /^[a-z0-9](?:[a-z0-9-]{0,98}[a-z0-9])?$/

export function normalizeAmoSubdomain(value: unknown): string {
  const normalized = String(value ?? '').trim().toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/\/.*$/, '')
    .replace(/\.amocrm\.(?:ru|com)$/, '')
  if (!SUBDOMAIN.test(normalized)) throw new Error('invalid_amocrm_subdomain')
  return normalized
}

export function generateWebhookSecret(random = crypto.getRandomValues(new Uint8Array(32))): string {
  if (!(random instanceof Uint8Array) || random.byteLength !== 32) {
    throw new Error('webhook_secret_requires_32_bytes')
  }
  let binary = ''
  for (const byte of random) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

export async function sha256Hex(value: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

export function normalizeGatewayOrigin(value: unknown): string {
  let parsed: URL
  try {
    parsed = new URL(String(value ?? '').trim())
  } catch {
    throw new Error('invalid_gateway_origin')
  }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password
    || parsed.pathname !== '/' || parsed.search || parsed.hash) {
    throw new Error('invalid_gateway_origin')
  }
  return parsed.origin
}

export function webhookUrl(origin: string, secret: string): string {
  return `${normalizeGatewayOrigin(origin)}/v1/crm/amocrm/webhook/${secret}`
}
