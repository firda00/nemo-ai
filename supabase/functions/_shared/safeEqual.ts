// Constant-time string comparison for secret / token checks. A plain `a !== b`
// short-circuits on the first differing byte, so response timing can leak a
// secret byte by byte to a network attacker. This compares every byte with the
// same work regardless of where they differ. Length is allowed to short-circuit
// because our secrets are fixed-length (UUIDs / random tokens), so length is not
// itself a secret.
export function timingSafeEqual(a: string | null | undefined, b: string | null | undefined): boolean {
  if (typeof a !== 'string' || typeof b !== 'string') return false
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}
