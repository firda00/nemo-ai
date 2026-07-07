// Test sandbox — run an agent's real config (model + prompt + language) against
// a message via OpenRouter and return the reply. Used by the wizard/editor "Test"
// tab so the owner can try the agent BEFORE saving or connecting any channel.
// Nothing is persisted (no dialogue/messages rows) — it's a playground.
//
//   POST /functions/v1/test-agent   (Authorization: Bearer <user jwt>)
//   body { "agent": {...}, "message": "...", "history": [{author, content}] }
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { callOpenRouter, buildSystemPrompt, PRIMARY_MODEL, FALLBACK_MODEL, type ChatMsg } from '../_shared/llm.ts'
import { loadMemory, saveMemory } from '../_shared/memory.ts'
import { resolveOpenRouterKey } from '../_shared/keys.ts'
import { retrieveKnowledge } from '../_shared/knowledge.ts'
import { ESCALATION_RULE, parseEscalation, routingRule, parseRoute, NO_FABRICATION } from '../_shared/agent.ts'
import { runAgentTools } from '../_shared/tools.ts'
import { corsHeaders, json } from '../_shared/cors.ts'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const OPENROUTER_API_KEY = Deno.env.get('OPENROUTER_API_KEY') ?? ''

// Reliable default; allow cheap paid + free models the picker offers.
const DEFAULT_MODEL = PRIMARY_MODEL
const ALLOWED_MODELS = new Set([
  'openai/gpt-4o-mini', 'openai/gpt-4o', 'anthropic/claude-3.5-sonnet',
  'google/gemini-flash-1.5', 'meta-llama/llama-3.3-70b-instruct',
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
  const persist = Boolean(body?.persist) && Boolean(agentId)
  const model = ALLOWED_MODELS.has(agent?.model) ? agent.model : DEFAULT_MODEL
  const temperature = Number.isFinite(agent?.temperature) ? Number(agent.temperature) : 0.6

  // token guard against the caller's account
  const { data: prof } = await userDb.from('users').select('account_id').maybeSingle()
  const accountId = prof?.account_id
  if (!accountId) return json({ error: 'no account' }, 403)
  const admin = createClient(SUPABASE_URL, SERVICE_ROLE)
  const { data: acc } = await admin.from('accounts').select('token_balance, blocked').eq('id', accountId).single()
  if (acc?.blocked) return json({ error: 'blocked' }, 403)
  if (acc && Number(acc.token_balance) <= 0) return json({ error: 'no_tokens' }, 402)

  // cap history to keep the sandbox cheap
  const history: ChatMsg[] = Array.isArray(body?.history)
    ? body.history
        .slice(-12)
        .map((m: { author?: string; content?: unknown }): ChatMsg => ({ role: m.author === 'agent' ? 'assistant' : 'user', content: String(m.content ?? '') }))
        .filter((m: ChatMsg) => m.content)
    : []

  // Load the saved agent's knowledge base via semantic RAG so the sandbox reflects
  // exactly what the live channel agent retrieves (admin/service-role bypasses RLS on chunks).
  let knowledge = ''
  if (agentId) knowledge = await retrieveKnowledge(admin, agentId, message)

  // teammates for dynamic routing (sandbox mirrors the live channel behavior)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let siblings: any[] = []
  if (agentId) {
    const { data: sibs } = await admin.from('agents').select('id, name, type, model, prompt, temperature, default_lang, niche, country')
      .eq('account_id', accountId).eq('status', 'active').neq('id', agentId).neq('type', 'workflow').limit(6)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    siblings = (sibs ?? []).map((s: any) => ({ id: s.id, name: s.name, role: s.prompt?.role ?? s.type ?? '', raw: s }))
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
      ) + ESCALATION_RULE + NO_FABRICATION + routingRule(siblings),
    },
    ...history,
    { role: 'user', content: message },
  ]

  // Scenario A: optionally persist the test conversation (find-or-create a
  // 'web-test' dialogue for this saved agent) so it shows in Dialogues + DB.
  let dialogueId: string | null = null
  if (persist && agentId) {
    const { data: existing } = await userDb.from('dialogues').select('id').eq('agent_id', agentId).eq('channel', 'web-test').limit(1).maybeSingle()
    if (existing?.id) {
      dialogueId = existing.id
    } else {
      const { data: d } = await userDb
        .from('dialogues')
        .insert({ agent_id: agentId, channel: 'web-test', external_id: `web-test:${user.id}`, customer_name: 'Test chat', customer_contact: 'web-test', status: 'open' })
        .select('id')
        .single()
      dialogueId = d?.id ?? null
    }
    if (dialogueId) await userDb.from('messages').insert({ dialogue_id: dialogueId, author: 'customer', content: message })
  }

  try {
    const apiKey = await resolveOpenRouterKey(admin, accountId, OPENROUTER_API_KEY)
    if (!apiKey) return json({ ok: false, code: 'MISSING_PROVIDER_SECRET', message: 'OpenRouter key is not configured on the server.' }, 503)

    // tool-use: if the account has connected tools and the message asks to DO something,
    // execute it for real (create Google Sheet/Doc, send email, browse) and return the REAL result
    const toolRun = await runAgentTools(admin, apiKey, accountId, message, [])
    if (toolRun?.ran) {
      if (toolRun.tokens) { await admin.from('usage').insert({ account_id: accountId, tokens: toolRun.tokens, model: 'tool' }); await admin.rpc('decrement_token_balance', { p_account: accountId, p_amount: toolRun.tokens }) }
      return json({ ok: true, tool: toolRun.tool, reply: toolRun.result, dialogue_id: dialogueId })
    }

    const out = await callOpenRouter({ apiKey, model, messages, temperature, fallbackModel: FALLBACK_MODEL })
    if (out.tokens) {
      await admin.from('usage').insert({ account_id: accountId, tokens: out.tokens, model })
      await admin.rpc('decrement_token_balance', { p_account: accountId, p_amount: out.tokens })
    }

    // dynamic routing: the agent handed the question to a better-suited teammate
    const routeName = parseRoute(out.content)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const target = routeName ? (siblings.find((s: any) => String(s.name).toLowerCase() === routeName.toLowerCase()) ?? siblings.find((s: any) => routeName.toLowerCase().includes(String(s.name).toLowerCase()))) : null
    if (target) {
      const tgt = target.raw
      const tKnow = await retrieveKnowledge(admin, tgt.id, message)
      const tmsgs: ChatMsg[] = [
        { role: 'system', content: buildSystemPrompt({ name: tgt.name, prompt: tgt.prompt, default_lang: tgt.default_lang, country: tgt.country, niche: tgt.niche }, tKnow, '') + ESCALATION_RULE },
        ...history,
        { role: 'user', content: message },
      ]
      const tmodel = ALLOWED_MODELS.has(tgt.model) ? tgt.model : DEFAULT_MODEL
      const tout = await callOpenRouter({ apiKey, model: tmodel, messages: tmsgs, temperature: Number(tgt.temperature) || 0.5, fallbackModel: FALLBACK_MODEL })
      if (tout.tokens) {
        await admin.from('usage').insert({ account_id: accountId, tokens: tout.tokens, model: tmodel })
        await admin.rpc('decrement_token_balance', { p_account: accountId, p_amount: tout.tokens })
      }
      const tesc = parseEscalation(tout.content)
      if (tesc.escalated) return json({ ok: true, routed: true, to: tgt.name, escalated: true, reason: tesc.reason, reply: 'Секунду — передаю ваш вопрос живому специалисту.', dialogue_id: dialogueId })
      return json({ ok: true, routed: true, to: tgt.name, reply: tout.content, dialogue_id: dialogueId })
    }

    // human-in-the-loop: the agent chose to hand off instead of guessing
    const esc = parseEscalation(out.content)
    if (esc.escalated) {
      if (persist && dialogueId) await userDb.from('dialogues').update({ status: 'needs_operator' }).eq('id', dialogueId)
      return json({ ok: true, escalated: true, reason: esc.reason, reply: 'Секунду — передаю ваш вопрос живому специалисту, он скоро ответит.', dialogue_id: dialogueId })
    }
    if (persist && dialogueId && out.content) await userDb.from('messages').insert({ dialogue_id: dialogueId, author: 'agent', content: out.content })
    if (isLearning && agentId) await saveMemory(userDb, accountId, agentId, null, message)
    return json({ ok: true, reply: out.content, dialogue_id: dialogueId })
  } catch (e) {
    console.error('test-agent LLM error:', e)
    return json({ error: 'llm_failed' }, 502)
  }
})
