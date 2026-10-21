import { afterEach, expect, test, vi } from 'vitest'
vi.mock('../src/lib/supabase', () => ({ supabase: null, isSupabaseEnabled: true }))
import { resolveChatScope } from '../src/lib/chatScope'
import type { ScopedFunctionClient } from '../src/lib/scopedFunctionCall'
const account = '11111111-1111-4111-8111-111111111111'
function fixture() {
  let listener: ((event: string, session: { user: { id: string } } | null) => void) | undefined
  const session = { user: { id: 'user-a' }, access_token: 'synthetic-token' }
  const client: ScopedFunctionClient = {
    auth: { getSession: vi.fn(async () => ({ data: { session } })), onAuthStateChange(callback) { listener = callback; return { data: { subscription: { unsubscribe: vi.fn() } } } } },
    functions: { invoke: vi.fn() },
  }
  const fetcher = vi.fn(async () => Response.json([{ account_id: account }]))
  return { client, session, fetcher, changeUser: () => listener?.('SIGNED_IN', { user: { id: 'user-b' } }), options: { client, url: 'http://127.0.0.1:55431', apiKey: 'synthetic-anon', fetch: fetcher as typeof fetch } }
}
afterEach(() => vi.useRealTimers())
test('scope uses authenticated server profile and pins the JWT', async () => {
  const f = fixture()
  expect(await resolveChatScope('user-a', new AbortController().signal, f.options)).toBe(`http://127.0.0.1:55431:${account}:user-a`)
  const call = f.fetcher.mock.calls[0] as unknown as [URL, RequestInit]
  expect(call[0].searchParams.get('id')).toBe('eq.user-a')
  expect(call[1].headers).toEqual({ apikey: 'synthetic-anon', Authorization: 'Bearer synthetic-token' })
  expect(call[1].redirect).toBe('error')
  expect(f.client.functions.invoke).not.toHaveBeenCalled()
})
test('another signed-in identity is rejected before profile access', async () => {
  const f = fixture(); f.session.user.id = 'user-b'
  await expect(resolveChatScope('user-a', new AbortController().signal, f.options)).rejects.toThrow('CHAT_AUTH_REQUIRED')
  expect(f.fetcher).not.toHaveBeenCalled()
})
test.each([401, 403, 503])('profile HTTP %i fails closed', async status => {
  const f = fixture(); f.fetcher.mockImplementation(async () => new Response('{}', { status }))
  await expect(resolveChatScope('user-a', new AbortController().signal, f.options)).rejects.toThrow('CHAT_PROFILE_UNAVAILABLE')
})
test.each([{ rows: [] }, { rows: [{ account_id: account }, { account_id: account }] }, { rows: [{ account_id: 'invalid' }] }])('invalid profile fails closed $rows', async ({ rows }) => {
  const f = fixture(); f.fetcher.mockImplementation(async () => Response.json(rows))
  await expect(resolveChatScope('user-a', new AbortController().signal, f.options)).rejects.toThrow('CHAT_PROFILE_UNAVAILABLE')
})
test('identity loss during a hung read settles without waiting for the network', async () => {
  const f = fixture(); f.fetcher.mockImplementation(() => new Promise(() => {}))
  const promise = resolveChatScope('user-a', new AbortController().signal, f.options)
  await Promise.resolve(); f.changeUser()
  await expect(promise).rejects.toThrow('CHAT_SCOPE_LOST')
})
test('hung SDK session is bounded too', async () => {
  vi.useFakeTimers()
  const f = fixture(); f.client.auth.getSession = () => new Promise(() => {})
  const assertion = expect(resolveChatScope('user-a', new AbortController().signal, f.options)).rejects.toThrow('CHAT_SCOPE_LOST')
  await vi.advanceTimersByTimeAsync(12_000); await assertion
})
