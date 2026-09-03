interface AuthClaims {
  aal?: unknown
  amr?: Array<{ method?: unknown; timestamp?: unknown }>
}

function authClaims(authHeader: string | null): AuthClaims | null {
  const match = authHeader?.match(/^Bearer\s+([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/i)
  if (!match) return null
  try {
    const payload = match[1].split('.')[1].replace(/-/g, '+').replace(/_/g, '/')
    const padded = payload + '='.repeat((4 - (payload.length % 4)) % 4)
    return JSON.parse(atob(padded)) as AuthClaims
  } catch {
    return null
  }
}

export function hasAal2(authHeader: string | null): boolean {
  return authClaims(authHeader)?.aal === 'aal2'
}

export function hasRecentPasswordAndAal2(authHeader: string | null, nowSeconds = Math.floor(Date.now() / 1000)): boolean {
  const claims = authClaims(authHeader)
  if (claims?.aal !== 'aal2' || !Array.isArray(claims.amr)) return false
  return claims.amr.some((entry) => {
    const timestamp = Number(entry?.timestamp)
    const ageSeconds = nowSeconds - timestamp
    return entry?.method === 'password' && Number.isFinite(timestamp) && ageSeconds >= 0 && ageSeconds <= 10 * 60
  })
}
