// Edit a file with an agent. The client extracts the file to text and sends it
// with an instruction; the LLM returns the edited content (download client-side).
// Authenticated, token-guarded, account-blocked-guarded. Free models, no extra keys.
//
//   POST /functions/v1/edit-file   (Authorization: Bearer <user jwt>)
//   body { "instruction": "...", "filename": "...", "content": "...", "model"?: "...", "agent_id"?: "..." }
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.108.2'
import { callOpenRouter, estimateCostUsd, type ChatMsg } from '../_shared/llm.ts'
import { resolveOpenRouterKey } from '../_shared/keys.ts'
import { corsPreflight, json } from '../_shared/cors.ts'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const OPENROUTER_API_KEY = Deno.env.get('OPENROUTER_API_KEY') ?? ''

const FREE_MODEL = 'google/gemma-4-31b-it:free'
const ALLOWED_MODELS = new Set([
  'google/gemma-4-31b-it:free', 'google/gemma-4-26b-a4b-it:free',
  'meta-llama/llama-3.3-70b-instruct:free', 'qwen/qwen3-next-80b-a3b-instruct:free',
  'nousresearch/hermes-3-llama-3.1-405b:free',
])

Deno.serve(async (req) => {
  const preflight = corsPreflight(req)
  if (preflight) return preflight

  const authHeader = req.headers.get('Authorization')
  if (!authHeader) return json({ error: 'unauthorized' }, 401)
  const userDb = createClient(SUPABASE_URL, ANON_KEY, { global: { headers: { Authorization: authHeader } } })
  const {
    data: { user },
  } = await userDb.auth.getUser()
  if (!user) return json({ error: 'unauthorized' }, 401)

  const body = await req.json().catch(() => ({}))
  const instruction = String(body?.instruction ?? '').trim()
  const filename = String(body?.filename ?? 'file').slice(0, 200)
  const content = String(body?.content ?? '').slice(0, 60_000) // bound prompt size
  if (instruction.length < 2 || !content) return json({ error: 'instruction and content required' }, 400)
  const model = ALLOWED_MODELS.has(body?.model) ? body.model : FREE_MODEL

  const { data: prof } = await userDb.from('users').select('account_id').maybeSingle()
  const accountId = prof?.account_id
  if (!accountId) return json({ error: 'no account' }, 403)
  const admin = createClient(SUPABASE_URL, SERVICE_ROLE)
  const { data: acc } = await admin.from('accounts').select('token_balance, blocked').eq('id', accountId).single()
  if (acc?.blocked) return json({ error: 'blocked' }, 403)
  if (acc && Number(acc.token_balance) <= 0) return json({ error: 'no_tokens' }, 402)

  const messages: ChatMsg[] = [
    {
      role: 'system',
      content:
        'You are a precise file editor. Apply the user instruction to the file content and return ONLY the resulting ' +
        'file content — no explanations, no commentary, no markdown code fences. Preserve the original format (CSV stays CSV, etc.).',
    },
    { role: 'user', content: `File: ${filename}\nInstruction: ${instruction}\n\nContent:\n${content}` },
  ]

  try {
    const orKey = await resolveOpenRouterKey(admin, accountId, OPENROUTER_API_KEY)
    if (!orKey) return json({ ok: false, code: 'MISSING_PROVIDER_SECRET', message: 'OpenRouter key is not configured on the server.' }, 503)
    const out = await callOpenRouter({ apiKey: orKey, model, messages, temperature: 0.2, maxTokens: 4000 })
    if (out.tokens) {
      await admin.from('usage').insert({ account_id: accountId, tokens: out.tokens, model, cost: estimateCostUsd(model, out.tokens) })
      await admin.rpc('decrement_token_balance', { p_account: accountId, p_amount: out.tokens })
    }
    return json({ ok: true, result: out.content })
  } catch (e) {
    console.error('edit-file error:', e)
    return json({ error: 'edit_failed', detail: String(e) }, 502)
  }
})
