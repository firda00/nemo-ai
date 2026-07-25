export function hasAal2(authHeader: string | null): boolean {
  const match = authHeader?.match(/^Bearer\s+([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/i)
  if (!match) return false
  try {
    const payload = match[1].split('.')[1].replace(/-/g, '+').replace(/_/g, '/')
    const padded = payload + '='.repeat((4 - (payload.length % 4)) % 4)
    const claims = JSON.parse(atob(padded)) as { aal?: unknown }
    return claims.aal === 'aal2'
  } catch {
    return false
  }
}
