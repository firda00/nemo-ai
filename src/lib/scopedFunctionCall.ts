// Bind each function request to the session verified for this operation. Supplying an
// explicit Authorization header prevents supabase-js from substituting a later user's JWT.
type FunctionResult = { data: unknown; error: { context?: Response } | null }
export interface ScopedFunctionClient {
  auth: {
    getSession: () => PromiseLike<{ data: { session: { user: { id: string }; access_token: string } | null }; error?: unknown }>
    onAuthStateChange?: (callback: (event: string, session: { user: { id: string } } | null) => void) => { data: { subscription: { unsubscribe: () => void } } }
  }
  functions: { invoke: (name: string, options: { body: Record<string, unknown>; headers: Record<string, string>; signal: AbortSignal }) => PromiseLike<FunctionResult> }
}

export async function invokeScopedFunction(
  client: ScopedFunctionClient,
  name: string,
  body: Record<string, unknown>,
  scope: { userId: string; alive: () => boolean; signal: AbortSignal },
  timeoutMs = 60_000,
): Promise<FunctionResult> {
  const controller = new AbortController()
  const abort = () => controller.abort()
  scope.signal.addEventListener('abort', abort, { once: true })
  const alive = () => scope.alive() && !scope.signal.aborted && !controller.signal.aborted
  // Auth events invalidate immediately, even before React commits a new identity. Token
  // refresh / repeated SIGNED_IN for the same user does not cancel legitimate work.
  const subscription = client.auth.onAuthStateChange?.((event, session) => {
    if (event === 'SIGNED_OUT' || session?.user.id !== scope.userId) abort()
  }).data.subscription
  let timer: ReturnType<typeof setTimeout> | undefined
  let onAbort: (() => void) | undefined
  try {
    if (!alive()) throw new Error('SESSION_SCOPE_LOST')
    const cancelled = new Promise<never>((_, reject) => {
      onAbort = () => reject(new Error('SESSION_SCOPE_LOST'))
      controller.signal.addEventListener('abort', onAbort, { once: true })
      timer = setTimeout(abort, timeoutMs)
    })
    const work = (async () => {
      const { data, error } = await client.auth.getSession()
      if (!alive() || error || !scope.userId || data.session?.user.id !== scope.userId || !data.session.access_token) {
        throw new Error('SESSION_SCOPE_LOST')
      }
      const result = await client.functions.invoke(name, {
        body, headers: { Authorization: `Bearer ${data.session.access_token}` }, signal: controller.signal,
      })
      if (!alive()) throw new Error('SESSION_SCOPE_LOST')
      return result
    })()
    return await Promise.race([work, cancelled])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
    if (onAbort) controller.signal.removeEventListener('abort', onAbort)
    scope.signal.removeEventListener('abort', abort)
    subscription?.unsubscribe()
  }
}
