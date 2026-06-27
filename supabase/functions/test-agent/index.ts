// Test sandbox — run an agent's real config (model + prompt + language) against
// a message via OpenRouter and return the reply. Used by the wizard/editor "Test"
// tab so the owner can try the agent BEFORE saving or connecting any channel.
// Nothing is persisted (no dialogue/messages rows) — it's a playground.
//
//   POST /functions/v1/test-agent   (Authorization: Bearer <user jwt>)
//   body { "agent": {...}, "message": "...", "history": [{author, content}] }
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { callOpenRouter, buildSystemPrompt, type ChatMsg } from '../_shared/llm.ts'
import { loadMemory, saveMemory } from '../_shared/memory.ts'
import { resolveOpenRouterKey } from '../_shared/keys.ts'
import { corsHeaders, json } from '../_shared/cors.ts'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const OPENROUTER_API_KEY = Deno.env.get('OPENROUTER_API_KEY')!

const FREE_MODEL = 'google/gemma-4-31b-it:free'
const ALLOWED_MODELS = new Set([
  'google/gemma-4-31b-it:free', 'google/gemma-4-26b-a4b-it:free',
  'meta-llama/llama-3.3-70b-instruct:free', 'qwen/qwen3-next-80b-a3b-instruct:free',
  'nousresearch/hermes-3-llama-3.1-405b:free',
])

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })

  const authHeader = req.headers.get('Authorization')
  if (!authHeader) return json({ error: 'unauthorized' }, 401)

  const userDb = createClient(SUPABASE_URL, ANON_KEY, { global: { headers: { Authorization: authHeader } } })
  const {
    data: { user },
  } = await userDb.auth.getUser()
  if (!user) return json({ error: 'unauthorized' }, 401)

  const body = await req.json().catch(() => ({}))
  const message = String(body?.message ?? '').trim()
  if (!message) return json({ error: 'message required' }, 400)
  const agent = body?.agent ?? {}
  const agentId = typeof body?.agent_id === 'string' ? body.agent_id : null
  const model = ALLOWED_MODELS.has(agent?.model) ? agent.model : FREE_MODEL
  const temperature = Number.isFinite(agent?.temperature) ? Number(agent.temperature) : 0.6

  // token guard against the caller's account
  const { data: prof } = await userDb.from('users').select('account_id').single()
  const accountId = prof?.account_id
  if (!accountId) return json({ error: 'no account' }, 403)
  const admin = createClient(SUPABASE_URL, SERVICE_ROLE)
  const { data: acc } = await admin.from('accounts').select('token_balance').eq('id', accountId).single()
  if (acc && Number(acc.token_balance) <= 0) return json({ error: 'no_tokens' }, 402)

  // cap history to keep the sandbox cheap
  const history: ChatMsg[] = Array.isArray(body?.history)
    ? body.history
        .slice(-12)
        // deno-lint-ignore no-explicit-any
        .map((m: any): ChatMsg => ({ role: m.author === 'agent' ? 'assistant' : 'user', content: String(m.content ?? '') }))
        .filter((m: ChatMsg) => m.content)
    : []

  // Load the saved agent's knowledge base so the sandbox reflects RAG too.
  // RLS on knowledge_docs keeps this scoped to the caller's account.
  let knowledge = ''
  if (agentId) {
    const { data: docs } = await userDb.from('knowledge_docs').select('name, content').eq('owner_id', agentId).limit(10)
    knowledge = (docs ?? [])
      // deno-lint-ignore no-explicit-any
      .map((d: any) => `- ${d.name ?? ''}: ${d.content ?? ''}`)
      .join('\n')
      .slice(0, 4000)
  }

  // self-improving agents recall memory from past chats (and learn from this one)
  const isLearning = agent?.type === 'learning'
  const memory = isLearning && agentId ? await loadMemory(userDb, agentId) : ''

  const messages: ChatMsg[] = [
    {
      role: 'system',
      content: buildSystemPrompt(
        { name: agent?.name, prompt: agent?.prompt, default_lang: agent?.default_lang, country: agent?.country, niche: agent?.niche },
        knowledge,
        memory,
      ),
    },
    ...history,
    { role: 'user', content: message },
  ]

  try {
    const apiKey = await resolveOpenRouterKey(admin, accountId, OPENROUTER_API_KEY)
    const out = await callOpenRouter({ apiKey, model, messages, temperature })
    if (out.tokens) {
      await admin.from('usage').insert({ account_id: accountId, tokens: out.tokens, model })
      await admin.rpc('decrement_token_balance', { p_account: accountId, p_amount: out.tokens })
    }
    if (isLearning && agentId) await saveMemory(userDb, accountId, agentId, null, message)
    return json({ ok: true, reply: out.content })
  } catch (e) {
    console.error('test-agent LLM error:', e)
    return json({ error: 'llm_failed' }, 502)
  }
})
