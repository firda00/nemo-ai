import { callFrontierProvider, FRONTIER_DEADLINE_MS, frontierContinuationContext, parseFrontierInput,
  prepareFrontierState, type FrontierCode } from './frontierChat.ts'
import { resolveTenantChatKey, type TenantKeyDeps } from './llmProvider.ts'
import { openSecret, providerSecretContext, sealSecret } from './secretBox.ts'

export interface FrontierHandlerDeps {
  admin: TenantKeyDeps['admin']
  fetchImpl: typeof fetch
  open?: typeof openSecret
  seal?: typeof sealSecret
  now?: () => number
}

const statusFor = (code: FrontierCode) => ({ NEED_KEY: 409, KEY_UNAVAILABLE: 503, CONTINUATION_UNAVAILABLE: 503,
  PROVIDER_UNAVAILABLE: 504, RATE_LIMITED: 429, KEY_REJECTED: 409, PROVIDER_ERROR: 502,
  INVALID_PROVIDER_RESPONSE: 502, PROVIDER_REFUSAL: 422, OUTPUT_INCOMPLETE: 422 } as Partial<Record<FrontierCode, number>>)[code] ?? 400

// Authentication/account blocking happen in cli-chat before entering this branch. There is
// exactly one tenant-key request and no OpenRouter or platform-credit billing path here.
export async function handleFrontierChat(raw: unknown, identity: { accountId: string; userId: string }, deps: FrontierHandlerDeps,
  options: { deadlineAt?: number; signal?: AbortSignal } = {}) {
  const failure = (code: FrontierCode) => ({ status: statusFor(code), body: { ok: false as const, code } })
  const parsed = parseFrontierInput(raw)
  if (!parsed.ok) return failure(parsed.code)
  const now = deps.now ?? Date.now
  const deadlineAt = Math.min(options.deadlineAt ?? Infinity, now() + FRONTIER_DEADLINE_MS)
  if (!identity.accountId || !identity.userId) return failure('INVALID_REQUEST')
  if (options.signal?.aborted || now() >= deadlineAt) return failure('PROVIDER_UNAVAILABLE')
  let expire: () => void = () => {}
  const expired = new Promise<never>((_resolve, reject) => { expire = () => reject(new Error('deadline')) })
  expired.catch(() => {})
  const timer = setTimeout(expire, Math.max(0, deadlineAt - now()))
  options.signal?.addEventListener('abort', expire, { once: true })
  const bounded = async <T>(promise: PromiseLike<T>) => {
    if (options.signal?.aborted || now() >= deadlineAt) throw new Error('deadline')
    const result = await Promise.race([Promise.resolve(promise), expired])
    if (options.signal?.aborted || now() >= deadlineAt) throw new Error('deadline')
    return result
  }
  const open = deps.open ?? openSecret
  const seal = deps.seal ?? sealSecret
  const { data: input } = parsed
  const context = frontierContinuationContext(identity.accountId, identity.userId, input.selection)
  try {
    // Check local encryption before interpreting a decryption failure as a bad context.
    // A missing server key must not tell the user their valid conversation was tampered with.
    try {
      const proof = await bounded(seal('frontier-context-check', context))
      if (!proof.startsWith('enc:v2:')) return failure('CONTINUATION_UNAVAILABLE')
    } catch { return failure(now() >= deadlineAt || options.signal?.aborted ? 'PROVIDER_UNAVAILABLE' : 'CONTINUATION_UNAVAILABLE') }
    let previous: unknown
    if (input.continuation) {
      try { previous = JSON.parse(await bounded(open(input.continuation, context))) }
      catch { return failure(now() >= deadlineAt || options.signal?.aborted ? 'PROVIDER_UNAVAILABLE' : 'INVALID_CONTINUATION') }
    }
    const prepared = prepareFrontierState(input, previous, now())
    if (!prepared.ok) return failure(prepared.code)
    const resolved = await bounded(resolveTenantChatKey({ admin: deps.admin,
      decrypt: (value, accountId, provider) => open(value, providerSecretContext(accountId, provider)) }, identity.accountId, input.selection.provider))
    if (!resolved.ok) return failure(resolved.code)
    const completion = await bounded(callFrontierProvider(prepared.state, resolved.key,
      { fetchImpl: deps.fetchImpl, deadlineAt, signal: options.signal, now }))
    if (!completion.ok) return failure(completion.code)
    let continuation: string
    try { continuation = await bounded(seal(JSON.stringify(completion.state), context)) }
    catch { return failure('CONTINUATION_UNAVAILABLE') }
    if (!continuation.startsWith('enc:v2:')) return failure('CONTINUATION_UNAVAILABLE')
    return { status: 200, body: { ok: true as const, message: completion.message, model: completion.model, usage: completion.usage,
      frontier: { selection: input.selection, continuation, status: completion.message.tool_calls.length ? 'tool_calls' as const : 'completed' as const } } }
  } catch { return failure(now() >= deadlineAt || options.signal?.aborted ? 'PROVIDER_UNAVAILABLE' : 'KEY_UNAVAILABLE') }
  finally { clearTimeout(timer); options.signal?.removeEventListener('abort', expire) }
}
