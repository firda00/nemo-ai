// AI agent builder — "ИИ создаёт агента".
// The user describes their business in free text; the LLM returns a structured
// agent config (name + role/tasks/tone/rules + suggested model/language/channels)
// which the panel uses to pre-fill the creation wizard.
//
//   POST /functions/v1/compose-agent   (Authorization: Bearer <user jwt>)
//   body { "description": "...", "ui_lang": "uz" | "ru" | "en" }
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { callOpenRouter, type ChatMsg } from '../_shared/llm.ts'
import { corsHeaders, json } from '../_shared/cors.ts'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const OPENROUTER_API_KEY = Deno.env.get('OPENROUTER_API_KEY')!

// FREE models only (OpenRouter ":free" tier) — keep in sync with src/data/platform.ts
const FREE_MODEL = 'google/gemma-4-31b-it:free'
const COMPOSER_MODEL = FREE_MODEL
const ALLOWED_MODELS = new Set([
  'google/gemma-4-31b-it:free', 'google/gemma-4-26b-a4b-it:free',
  'meta-llama/llama-3.3-70b-instruct:free', 'qwen/qwen3-next-80b-a3b-instruct:free',
  'nousresearch/hermes-3-llama-3.1-405b:free',
])
const CHANNELS = new Set(['telegram', 'whatsapp', 'instagram', 'widget'])
const LANGS = new Set(['auto', 'uz', 'ru', 'en'])
const KINDS_SET = new Set(['chat', 'qualifier', 'coder', 'content', 'learning', 'research', 'workflow'])

const langName = (l: string) => (l === 'uz' ? 'Uzbek' : l === 'en' ? 'English' : 'Russian')

function extractJson(text: string): Record<string, unknown> | null {
  // tolerate ```json fences and surrounding prose
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start === -1 || end === -1 || end < start) return null
  try {
    return JSON.parse(text.slice(start, end + 1))
  } catch {
    return null
  }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })

  const authHeader = req.headers.get('Authorization')
  if (!authHeader) return json({ error: 'unauthorized' }, 401)

  const userDb = createClient(SUPABASE_URL, ANON_KEY, { global: { headers: { Authorization: authHeader } } })
  const {
    data: { user },
  } = await userDb.auth.getUser()
  if (!user) return json({ error: 'unauthorized' }, 401)

  const { description, ui_lang, type: typeHint } = await req.json().catch(() => ({}))
  const desc = String(description ?? '').trim()
  if (desc.length < 8) return json({ error: 'description too short' }, 400)
  const lang = LANGS.has(ui_lang) && ui_lang !== 'auto' ? ui_lang : 'ru'
  // optional: the user already picked the kind in the wizard — bias + lock to it
  const forcedType = typeof typeHint === 'string' && KINDS_SET.has(typeHint) ? typeHint : null

  // resolve account + token guard (service role for balance read)
  const { data: prof } = await userDb.from('users').select('account_id').single()
  const accountId = prof?.account_id
  if (!accountId) return json({ error: 'no account' }, 403)
  const admin = createClient(SUPABASE_URL, SERVICE_ROLE)
  const { data: acc } = await admin.from('accounts').select('token_balance').eq('id', accountId).single()
  if (acc && Number(acc.token_balance) <= 0) return json({ error: 'no_tokens' }, 402)

  const sys = [
    'You are an expert at configuring AI sales & support agents for the Nemo AI platform.',
    'Given a short business description, design ONE agent and output its configuration.',
    `Write the human-readable fields (name, role, tasks, tone, rules) in ${langName(lang)}.`,
    'Output ONLY a single minified JSON object, no markdown, no commentary. Schema:',
    '{"name": string (short, e.g. "Sotuv menejeri"),',
    ' "type": "chat" | "qualifier" | "coder" | "content" | "learning" | "research" | "workflow",',
    ' "prompt": {"role": string, "tasks": string, "tone": string, "rules": string},',
    ' "default_lang": "auto"|"uz"|"ru"|"en" (use "auto" unless the business clearly needs one),',
    ' "model": one of the allowed ids,',
    ' "channels": array of any of ["telegram","whatsapp","instagram","widget"]}',
    forcedType
      ? `The agent type is fixed to "${forcedType}". Write the prompt specifically for a ${forcedType} agent and set "type":"${forcedType}".`
      : 'Pick "type": "qualifier" if the user wants to filter/score leads, ask qualifying questions (budget, need, timeline) and route hot leads to an operator; ' +
        '"coder" if they want to write/fix code; ' +
        '"content" if they want to generate texts, posts, descriptions or creatives; ' +
        '"learning" if they want an assistant that remembers past conversations and improves; ' +
        '"research" if they want market/competitor research, monitoring, analysis or reports; ' +
        '"workflow" for a department/manager that needs a team of sub-agents for a multi-step task; ' +
        '"chat" for customer sales/support conversations on channels. Default "chat".',
    `Allowed model ids: ${[...ALLOWED_MODELS].join(', ')}.`,
    'Pick a cost-effective model (gpt-4o-mini / claude-3.5-haiku / gemini flash) unless the task is complex.',
    'role = who the agent is; tasks = what it does step by step; tone = how it speaks; rules = hard constraints.',
    'Keep each field 1-3 sentences. Be concrete and tailored to the described business.',
  ].join('\n')

  const messages: ChatMsg[] = [
    { role: 'system', content: sys },
    { role: 'user', content: desc },
  ]

  let parsed: Record<string, unknown> | null = null
  let tokens = 0
  try {
    const out = await callOpenRouter({ apiKey: OPENROUTER_API_KEY, model: COMPOSER_MODEL, messages, temperature: 0.5 })
    tokens = out.tokens
    parsed = extractJson(out.content)
  } catch (e) {
    console.error('compose-agent LLM error:', e)
    return json({ error: 'llm_failed' }, 502)
  }
  if (!parsed) return json({ error: 'parse_failed' }, 502)

  // account usage
  if (tokens) {
    await admin.from('usage').insert({ account_id: accountId, tokens, model: COMPOSER_MODEL })
    await admin.rpc('decrement_token_balance', { p_account: accountId, p_amount: tokens })
  }

  // sanitize the model output before handing it to the client
  const p = (parsed.prompt ?? {}) as Record<string, unknown>
  const model = typeof parsed.model === 'string' && ALLOWED_MODELS.has(parsed.model) ? parsed.model : FREE_MODEL
  const default_lang = typeof parsed.default_lang === 'string' && LANGS.has(parsed.default_lang) ? parsed.default_lang : 'auto'
  const channels = Array.isArray(parsed.channels)
    ? parsed.channels.filter((c): c is string => typeof c === 'string' && CHANNELS.has(c))
    : []
  const type = forcedType ?? (typeof parsed.type === 'string' && KINDS_SET.has(parsed.type) ? parsed.type : 'chat')

  const agent = {
    name: String(parsed.name ?? '').slice(0, 80) || (lang === 'uz' ? 'Yangi agent' : lang === 'en' ? 'New agent' : 'Новый агент'),
    type,
    prompt: {
      role: String(p.role ?? '').slice(0, 600),
      tasks: String(p.tasks ?? '').slice(0, 800),
      tone: String(p.tone ?? '').slice(0, 400),
      rules: String(p.rules ?? '').slice(0, 600),
    },
    model,
    default_lang,
    channels,
  }

  return json({ ok: true, agent })
})
