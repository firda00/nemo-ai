// Authenticated model proxy for @nemo-ai/cli. Provider credentials never leave the server.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.108.2'
import { CLI_MAX_BODY_BYTES, CLI_MAX_COMPLETION_TOKENS, parseCliChatInput } from '../_shared/cliChat.ts'
import { corsPreflight, json } from '../_shared/cors.ts'
import { CLIENT_RESPONSE_STYLE, estimateCostUsd, PRIMARY_MODEL } from '../_shared/llm.ts'
import { monthlyTokens, planOf } from '../_shared/plans.ts'
import { readBytesBounded } from '../_shared/boundedBody.ts'
import { handleFrontierChat } from '../_shared/frontierChatHandler.ts'
import { FRONTIER_DEADLINE_MS, withinFrontierDeadline } from '../_shared/frontierChat.ts'
import { matchesChatContextAccount } from '../_shared/chatContextScope.ts'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const OPENROUTER_API_KEY = Deno.env.get('OPENROUTER_API_KEY') ?? ''
const PREMIUM_MODELS = new Set([
  'anthropic/claude-sonnet-4', 'openai/gpt-4o', 'openai/gpt-4o-mini',
  'deepseek/deepseek-chat', 'qwen/qwen-2.5-72b-instruct',
])

const inFlightPerAccount = new Map<string, number>()
const MAX_CONCURRENT_PER_ACCOUNT = 10

function bearer(req: Request): string | null {
  const value = req.headers.get('Authorization') ?? ''
  return /^Bearer\s+\S+$/i.test(value) ? value : null
}

Deno.serve(async (req) => {
  const requestDeadline = Date.now() + FRONTIER_DEADLINE_MS
  const preflight = corsPreflight(req)
  if (preflight) return preflight
  if (!['GET', 'POST'].includes(req.method)) return json({ ok: false, code: 'METHOD_NOT_ALLOWED' }, 405)

  const authHeader = bearer(req)
  if (!authHeader) return json({ ok: false, code: 'UNAUTHORIZED' }, 401)
  const boundedFetch: typeof fetch = (input, init) => fetch(input, { ...init,
    signal: AbortSignal.any([req.signal, AbortSignal.timeout(Math.max(1, requestDeadline - Date.now())), ...(init?.signal ? [init.signal] : [])]) })
  const userDb = createClient(SUPABASE_URL, ANON_KEY, { global: { headers: { Authorization: authHeader }, fetch: boundedFetch } })
  const authResult = await withinFrontierDeadline(userDb.auth.getUser(), requestDeadline, req.signal).catch(() => null)
  if (!authResult) return json({ ok: false, code: 'AUTH_UNAVAILABLE' }, 503)
  const { data: { user } } = authResult
  if (!user) return json({ ok: false, code: 'UNAUTHORIZED' }, 401)
  const profileResult = await withinFrontierDeadline(userDb.from('users').select('account_id').eq('id', user.id).maybeSingle(), requestDeadline, req.signal).catch(() => null)
  if (!profileResult) return json({ ok: false, code: 'ACCOUNT_UNAVAILABLE' }, 503)
  const { data: profile } = profileResult
  const accountId = profile?.account_id
  if (!accountId) return json({ ok: false, code: 'NO_ACCOUNT' }, 403)

  const activeCount = inFlightPerAccount.get(accountId) ?? 0
  if (activeCount >= MAX_CONCURRENT_PER_ACCOUNT) {
    return json({ ok: false, code: 'RATE_LIMITED', message: 'Too many concurrent requests on this account' }, 429)
  }
  inFlightPerAccount.set(accountId, activeCount + 1)

  try {
    const admin = createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { persistSession: false }, global: { fetch: boundedFetch } })
    const accountResult = await withinFrontierDeadline(admin
      .from('accounts').select('blocked, token_balance, plan').eq('id', accountId).single(), requestDeadline, req.signal).catch(() => null)
    if (!accountResult) return json({ ok: false, code: 'ACCOUNT_UNAVAILABLE' }, 503)
    const { data: account, error: accountError } = accountResult
    if (accountError || !account) return json({ ok: false, code: 'ACCOUNT_UNAVAILABLE' }, 503)
    if (account.blocked) return json({ ok: false, code: 'ACCOUNT_BLOCKED' }, 403)
    let raw: unknown
    if (req.method === 'POST') {
      const body = await readBytesBounded(req, { maxBytes: CLI_MAX_BODY_BYTES, deadlineAt: Math.min(requestDeadline, Date.now() + 10_000) })
      if (!body.ok) return json({ ok: false, code: body.reason === 'too_large' ? 'REQUEST_TOO_LARGE' : 'INVALID_REQUEST' }, body.reason === 'too_large' ? 413 : 400)
      try { raw = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body.bytes)) }
      catch { return json({ ok: false, code: 'INVALID_JSON' }, 400) }
      if (!matchesChatContextAccount(raw, accountId)) return json({ ok: false, code: 'CHAT_CONTEXT_ACCOUNT_CHANGED' }, 409)
      if (raw && typeof raw === 'object' && Object.prototype.hasOwnProperty.call(raw, 'selection')) {
        const result = await handleFrontierChat(raw, { accountId, userId: user.id }, { admin, fetchImpl: fetch },
          { deadlineAt: requestDeadline, signal: req.signal })
        return json(result.body, result.status)
      }
    }
    const plan = planOf(account.plan)
    const used = await monthlyTokens(admin, accountId).catch(() => null)
    if (used === null) return json({ ok: false, code: 'BILLING_UNAVAILABLE' }, 503)

    if (req.method === 'GET') {
      return json({ ok: true, plan: account.plan ?? 'free', credits: Number(account.token_balance) || 0, used_tokens: used, token_limit: plan.tokens })
    }
    if (Number(req.headers.get('content-length') ?? 0) > CLI_MAX_BODY_BYTES) return json({ ok: false, code: 'REQUEST_TOO_LARGE' }, 413)
    if (Number(account.token_balance) <= 0 || used >= plan.tokens) return json({ ok: false, code: 'LIMIT_REACHED' }, 402)
    if (!OPENROUTER_API_KEY) return json({ ok: false, code: 'MODEL_PROXY_UNAVAILABLE' }, 503)

    const parsed = parseCliChatInput(raw)
    if (!parsed.ok) return json({ ok: false, code: parsed.code }, 400)

    // Expensive models are a plan entitlement, not a client-controlled escape hatch.
    const requested = parsed.data.model
    // The everyday chat path must feel instant. The inexpensive fast model is available
    // on every plan; premium models remain an entitlement.
    const model = requested === 'openai/gpt-4o-mini'
      ? requested
      : plan.premium && PREMIUM_MODELS.has(requested) ? requested : PRIMARY_MODEL
    const directChat = parsed.data.tools.length === 0
    const requestId = crypto.randomUUID()
    let provider: Response
    try {
      provider = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${OPENROUTER_API_KEY}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': 'https://nemoai.uz',
          'X-Title': 'Nemo CLI',
        },
        body: JSON.stringify({
          model,
          messages: [{ role: 'system', content: CLIENT_RESPONSE_STYLE }, ...parsed.data.messages],
          max_tokens: directChat ? 900 : CLI_MAX_COMPLETION_TOKENS,
          provider: directChat ? { sort: 'throughput', allow_fallbacks: true } : undefined,
          ...(parsed.data.tools.length ? { tools: parsed.data.tools, tool_choice: 'auto' } : {}),
        }),
        signal: AbortSignal.timeout(directChat ? 20_000 : 45_000),
      })
    } catch {
      return json({ ok: false, code: 'MODEL_PROVIDER_UNAVAILABLE' }, 502)
    }
    if (!provider.ok) {
      // Provider bodies can contain internal routing details; never forward them to the terminal.
      await provider.body?.cancel().catch(() => {})
      return json({ ok: false, code: provider.status === 429 ? 'RATE_LIMITED' : 'MODEL_PROVIDER_ERROR' }, provider.status === 429 ? 429 : 502)
    }

    const result = await provider.json().catch(() => null) as Record<string, unknown> | null
    const choice = (result?.choices as Array<Record<string, unknown>> | undefined)?.[0]
    const message = choice?.message as Record<string, unknown> | undefined
    if (!message) return json({ ok: false, code: 'INVALID_PROVIDER_RESPONSE' }, 502)
    const usage = (result?.usage ?? {}) as Record<string, unknown>
    const promptTokens = Math.max(0, Number(usage.prompt_tokens) || 0)
    const completionTokens = Math.max(0, Number(usage.completion_tokens) || 0)
    // Fail closed on missing provider usage, but still account conservatively for work already done.
    const totalTokens = Math.max(1, Number(usage.total_tokens) || promptTokens + completionTokens || CLI_MAX_COMPLETION_TOKENS)
    const actualModel = String(result?.model ?? model)
    const cost = usage.cost != null && Number.isFinite(Number(usage.cost))
      ? Number(usage.cost)
      : estimateCostUsd(actualModel, totalTokens)
    const { error: billingError } = await admin.rpc('record_token_usage', {
      p_account_id: accountId, p_billing_key: `cli-chat:${requestId}`, p_tokens: totalTokens,
      p_cost: Number(cost.toFixed(8)), p_model: actualModel, p_stage: 'cli-chat', p_run_ref: null,
    })
    if (billingError) return json({ ok: false, code: 'BILLING_UNAVAILABLE' }, 503)

    return json({
      ok: true,
      message: { content: typeof message.content === 'string' ? message.content : null, tool_calls: Array.isArray(message.tool_calls) ? message.tool_calls : [] },
      model: actualModel,
      usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: totalTokens },
    })
  } finally {
    const current = inFlightPerAccount.get(accountId) ?? 1
    if (current <= 1) inFlightPerAccount.delete(accountId)
    else inFlightPerAccount.set(accountId, current - 1)
  }
})
