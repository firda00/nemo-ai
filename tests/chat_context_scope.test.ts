import { expect, test } from 'vitest'
import { matchesChatContextAccount } from '../supabase/functions/_shared/chatContextScope'
test('restored history is admitted only for the authenticated account it belongs to', () => {
  expect(matchesChatContextAccount({ contextAccountId: 'account-a' }, 'account-a')).toBe(true)
  expect(matchesChatContextAccount({ contextAccountId: 'account-a' }, 'account-b')).toBe(false)
  expect(matchesChatContextAccount({ contextAccountId: null }, 'account-a')).toBe(false)
})
test('legacy clients without restored context preserve their existing API contract', () => {
  expect(matchesChatContextAccount({ model: 'openai/gpt-4o-mini' }, 'account-a')).toBe(true)
})
