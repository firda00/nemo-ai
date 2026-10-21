// A precondition for restored plaintext history, not a source of authorization.
// accountId must already have been read using the authenticated user's JWT.
export function matchesChatContextAccount(raw: unknown, accountId: string): boolean {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false
  if (!Object.prototype.hasOwnProperty.call(raw, 'contextAccountId')) return true
  return (raw as Record<string, unknown>).contextAccountId === accountId
}
