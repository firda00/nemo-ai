// X (Twitter) posting via API v2 with OAuth 1.0a user-context signing. The customer brings their
// own 4 keys from their X developer app (API Key/Secret + Access Token/Secret) — no redirect flow.
// Text tweets only (media upload can come later). NOTE: posting requires a PAID X API plan (Basic+).

export interface XKeys { api_key: string; api_secret: string; access_token: string; access_secret: string }

// RFC-3986 percent-encoding (OAuth requires escaping ! * ' ( ) too).
const enc = (s: string) => encodeURIComponent(s).replace(/[!*'()]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase())

async function hmacSha1(key: string, msg: string): Promise<string> {
  const k = await crypto.subtle.importKey('raw', new TextEncoder().encode(key), { name: 'HMAC', hash: 'SHA-1' }, false, ['sign'])
  const sig = await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(msg))
  return btoa(String.fromCharCode(...new Uint8Array(sig)))
}

// Build the OAuth 1.0a Authorization header. A JSON request body does NOT participate in the
// signature base string (only the oauth_* params do), so this works for POST /2/tweets.
async function authHeader(keys: XKeys, method: string, url: string): Promise<string> {
  const oauth: Record<string, string> = {
    oauth_consumer_key: keys.api_key,
    oauth_nonce: crypto.randomUUID().replace(/-/g, ''),
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp: String(Math.floor(Date.now() / 1000)),
    oauth_token: keys.access_token,
    oauth_version: '1.0',
  }
  const paramStr = Object.keys(oauth).sort().map((k) => `${enc(k)}=${enc(oauth[k])}`).join('&')
  const base = `${method.toUpperCase()}&${enc(url)}&${enc(paramStr)}`
  const signingKey = `${enc(keys.api_secret)}&${enc(keys.access_secret)}`
  oauth.oauth_signature = await hmacSha1(signingKey, base)
  return 'OAuth ' + Object.keys(oauth).sort().map((k) => `${enc(k)}="${enc(oauth[k])}"`).join(', ')
}

// Verify the keys by reading the authenticated user. Returns @username on success.
export async function twitterVerify(keys: XKeys): Promise<{ ok: boolean; username?: string; error?: string }> {
  try {
    const url = 'https://api.twitter.com/2/users/me'
    const r = await fetch(url, { headers: { Authorization: await authHeader(keys, 'GET', url) } })
    const j = await r.json().catch(() => ({}))
    if (j?.data?.username) return { ok: true, username: j.data.username }
    return { ok: false, error: j?.title || j?.detail || j?.errors?.[0]?.message || 'X отклонил ключи' }
  } catch (e) { return { ok: false, error: String(e).slice(0, 150) } }
}

// Post a text tweet. Returns the tweet id on success.
export async function twitterPost(keys: XKeys, text: string): Promise<{ ok: boolean; id?: string; error?: string }> {
  try {
    const url = 'https://api.twitter.com/2/tweets'
    const r = await fetch(url, {
      method: 'POST',
      headers: { Authorization: await authHeader(keys, 'POST', url), 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: text.slice(0, 280) }),
    })
    const j = await r.json().catch(() => ({}))
    if (j?.data?.id) return { ok: true, id: j.data.id }
    return { ok: false, error: j?.detail || j?.title || j?.errors?.[0]?.message || 'X отклонил пост (нужен платный план?)' }
  } catch (e) { return { ok: false, error: String(e).slice(0, 150) } }
}
