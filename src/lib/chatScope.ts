import { supabase, isSupabaseEnabled } from './supabase'
import type { ScopedFunctionClient } from './scopedFunctionCall'

// Organization comes from a JWT-authenticated profile read, never user metadata,
// localStorage, a selected card, or text supplied to the model.
export async function resolveChatScope(userId: string, signal: AbortSignal, options?: {
  client: ScopedFunctionClient; url: string; apiKey: string; fetch: typeof fetch
}): Promise<string | null> {
  if (!userId) return null
  if (!options && !isSupabaseEnabled) return `demo:${userId}`
  const client = options?.client ?? supabase
  const url = options?.url ?? String(import.meta.env.VITE_SUPABASE_URL ?? '')
  const apiKey = options?.apiKey ?? String(import.meta.env.VITE_SUPABASE_ANON_KEY ?? '')
  if (!client || !url || !apiKey) return null
  const controller = new AbortController()
  const abort = () => controller.abort()
  signal.addEventListener('abort', abort, { once: true })
  const subscription = client.auth.onAuthStateChange?.((event, session) => {
    if (event === 'SIGNED_OUT' || session?.user.id !== userId) abort()
  }).data.subscription
  const check = () => { if (signal.aborted || controller.signal.aborted) throw new Error('CHAT_SCOPE_LOST') }
  const timer = setTimeout(abort, 12_000)
  let rejectOnAbort: (() => void) | undefined
  try {
    check()
    const cancelled = new Promise<never>((_, reject) => {
      rejectOnAbort = () => reject(new Error('CHAT_SCOPE_LOST'))
      controller.signal.addEventListener('abort', rejectOnAbort, { once: true })
    })
    const work = async () => {
    const { data, error } = await client.auth.getSession()
    check()
    if (error || data.session?.user.id !== userId || !data.session.access_token) throw new Error('CHAT_AUTH_REQUIRED')
    const endpoint = new URL('/rest/v1/users', url)
    endpoint.search = new URLSearchParams({ select: 'account_id', id: `eq.${userId}`, limit: '1' }).toString()
    const response = await (options?.fetch ?? fetch)(endpoint, { redirect: 'error', signal: controller.signal,
      headers: { apikey: apiKey, Authorization: `Bearer ${data.session.access_token}` } })
    check()
    if (!response.ok) throw new Error('CHAT_PROFILE_UNAVAILABLE')
    const rows = await response.json()
    check()
    if (!Array.isArray(rows) || rows.length !== 1 || typeof rows[0].account_id !== 'string' || !/^[0-9a-f-]{36}$/i.test(rows[0].account_id)) throw new Error('CHAT_PROFILE_UNAVAILABLE')
    const current = await client.auth.getSession()
    check()
    if (current.error || current.data.session?.user.id !== userId) throw new Error('CHAT_SCOPE_LOST')
    return `${new URL(url).origin}:${rows[0].account_id}:${userId}`
    }
    return await Promise.race([work(), cancelled])
  } finally {
    if (rejectOnAbort) controller.signal.removeEventListener('abort', rejectOnAbort)
    clearTimeout(timer); signal.removeEventListener('abort', abort); subscription?.unsubscribe()
  }
}
