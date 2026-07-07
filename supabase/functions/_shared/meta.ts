// WhatsApp Cloud API + Instagram (Meta Graph) send helpers.

// Verify Meta's X-Hub-Signature-256 header: `sha256=<hex>` = HMAC-SHA256 of the
// RAW request body keyed by the Meta App Secret. Constant-time compare. Returns
// false if the secret/header is missing so callers fail closed.
export async function verifyMetaSignature(rawBody: string, header: string | null, appSecret: string): Promise<boolean> {
  if (!appSecret || !header || !header.startsWith('sha256=')) return false
  const provided = header.slice('sha256='.length)
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(appSecret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(rawBody))
  const expected = Array.from(new Uint8Array(mac)).map((b) => b.toString(16).padStart(2, '0')).join('')
  if (expected.length !== provided.length) return false
  let diff = 0
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ provided.charCodeAt(i)
  return diff === 0
}

export async function waSend(phoneNumberId: string, token: string, to: string, text: string): Promise<boolean> {
  const res = await fetch(`https://graph.facebook.com/v19.0/${phoneNumberId}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ messaging_product: 'whatsapp', to, type: 'text', text: { body: text } }),
  })
  return res.ok
}

export async function igSend(token: string, recipientId: string, text: string): Promise<boolean> {
  const res = await fetch(`https://graph.facebook.com/v19.0/me/messages?access_token=${encodeURIComponent(token)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ recipient: { id: recipientId }, message: { text } }),
  })
  return res.ok
}
