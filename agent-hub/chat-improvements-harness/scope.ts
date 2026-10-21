// Explicit synthetic scope lookup. Real auth/profile boundary has separate tests.
export async function resolveChatScope(userId: string, signal: AbortSignal) {
  const g = globalThis as unknown as { __syntheticAccount?: string }
  if (signal.aborted) throw new Error('MOCK_SCOPE_ABORTED')
  return `https://synthetic.invalid:${g.__syntheticAccount ?? 'account-a'}:${userId}`
}
