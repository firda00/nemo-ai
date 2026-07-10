// Shared agent runtime — used by every channel webhook (Telegram/WhatsApp/Instagram).
// A normal agent answers directly. A WORKFLOW (team) agent runs its whole team on
// each message: the lead delegates to specialist sub-agents, they contribute, and
// the lead replies with one combined answer — so a team "talks" on a channel and
// the agents collaborate. Stores the reply + token usage.
import { callOpenRouter, buildSystemPrompt, estimateCostUsd, SCOPE_GUARD, PRIMARY_MODEL, FALLBACK_MODEL, type ChatMsg } from './llm.ts'
import { planOf } from './plans.ts'
import { loadMemory, saveMemory } from './memory.ts'
import { resolveOpenRouterKey } from './keys.ts'
import { retrieveKnowledge } from './knowledge.ts'
import { amoCreateLead } from './amocrm.ts'
import { runAgentTools } from './tools.ts'
import { roleSkillBlock } from './skills.ts'
import { tgSend } from './telegram.ts'

// Anti-hallucination: appended to single-agent prompts so the bot never invents links or
// claims it did something (created a sheet, sent an email) when it has no working tool.
export const NO_FABRICATION = '\n\nВАЖНО: никогда не выдумывай ссылки и не утверждай, что выполнил действие (создал файл/таблицу/документ, отправил письмо), если инструмента нет или он не сработал. Если для действия нужно подключение (например Google), честно скажи, что это нужно подключить — не давай выдуманных ссылок.'

// Per-dialogue token ceiling — above this a single conversation hands off to a human instead of
// billing unbounded replies (troll / runaway protection). ~200k tokens ≈ dozens of replies; keeps
// a single abusive thread from blowing past the target lead cost.
const SESSION_TOKEN_CAP = 200_000

// HUMAN-IN-THE-LOOP: single agents may hand off to a human instead of guessing.
// The rule below is appended to the agent's system prompt; when the model decides a
// human is needed it answers with the [[ESCALATE]] marker, which the runtime turns
// into a needs_operator handoff (+ an optional Telegram ping to the business admin).
export const ESCALATION_RULE =
  '\n\n=== ПЕРЕДАЧА ЧЕЛОВЕКУ ===\nТы можешь передать диалог живому оператору, когда это правильнее, чем угадывать. ' +
  'Если вопрос требует человека — возврат денег, жалоба, юридические вопросы, индивидуальная цена/скидка, которую тебе НЕ давали, спор об оплате, ' +
  'или ты НЕ можешь ответить точно на основе базы знаний и фактов о бизнесе выше — НЕ выдумывай. ' +
  'Ответь РОВНО так: первой строкой `[[ESCALATE]]`, затем короткая причина на языке клиента. В остальных случаях отвечай как обычно.'

export function parseEscalation(text: string): { escalated: boolean; reason: string } {
  const t = (text || '').trim()
  if (/\[\[\s*ESCALATE\s*\]\]/i.test(t.slice(0, 60))) {
    return { escalated: true, reason: t.replace(/\[\[\s*ESCALATE\s*\]\]/i, '').trim().slice(0, 300) }
  }
  return { escalated: false, reason: '' }
}

// DYNAMIC ROUTING: an agent can hand the conversation to a better-suited teammate
// (e.g. Sales -> Support/Tech). The rule lists the account's other agents; when the
// model decides the question belongs to one of them it replies with [[ROUTE:Name]],
// and the runtime lets THAT agent (its persona + its knowledge) answer instead.
export function routingRule(siblings: { name: string; role: string }[]): string {
  if (!siblings.length) return ''
  const list = siblings.map((s) => `«${s.name}» — ${s.role || 'коллега'}`).join('; ')
  return '\n\n=== ПЕРЕДАЧА КОЛЛЕГЕ ===\nВ команде есть другие агенты: ' + list + '. ' +
    'Если вопрос клиента явно НЕ в твоей зоне и им должен заняться конкретный коллега из списка — не отвечай сам, ' +
    'ответь РОВНО так: `[[ROUTE:Имя]]` (точное имя коллеги из списка) и больше ничего. Если вопрос в твоей зоне — отвечай как обычно.'
}

export function parseRoute(text: string): string | null {
  const m = (text || '').match(/\[\[\s*ROUTE\s*:\s*([^\]]+?)\s*\]\]/i)
  return m ? m[1].trim() : null
}

// Server-side premium-model gate: a client can set agents.model to any id, so a plan without
// `premium` could otherwise run gpt-4o / Claude Opus on Nemo's shared key and blow unit economics
// (~50x). Downgrade frontier models to the cheap primary unless the account's plan allows premium.
const PREMIUM_RE = /opus|sonnet|gpt-4o(?!-mini)|gpt-4\.1|gpt-5(?!-?(?:mini|nano))|(?:^|\/)o[0-9]|grok|gemini-[0-9.]*-pro|deepseek-(?:r[0-9]|reasoner|v[0-9]+-pro)|mistral-large|qwen[\w.]*-?max/i
export function gateModel(requested: string | undefined, premiumAllowed: boolean): string {
  const r = requested || PRIMARY_MODEL
  return (!premiumAllowed && PREMIUM_RE.test(r)) ? PRIMARY_MODEL : r
}

// Minimum confidence to hand off to a teammate — below this the current agent answers itself.
export const ROUTE_CONFIDENCE = 0.6

// Dedicated intent ROUTER: a cheap structured pass that picks which teammate should handle the
// message, WITH a confidence score. Returns { route: exact-name|'self', confidence }. This is
// measurable (every decision can be logged) and exact-matched — unlike a [[ROUTE:Name]] marker
// buried in the reply, which had no confidence and mis-resolved by substring.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function classifyRoute(apiKey: string, text: string, self: any, siblings: { name: string; role: string }[]): Promise<{ route: string; confidence: number; tokens: number }> {
  const roster = [
    `"self" — the current agent "${self?.name ?? 'agent'}" (${self?.prompt?.role ?? self?.type ?? 'general'}); choose this for general questions or anything it can reasonably handle`,
    ...siblings.map((s) => `"${s.name}" — ${s.role || 'teammate'}`),
  ].join('\n')
  const sys = `You are the intent ROUTER for a business's support/sales team. Read the customer's latest message and decide which teammate should handle it.\nOptions:\n${roster}\nRoute to a NAMED teammate ONLY if the message is CLEARLY that teammate's specialty; otherwise choose "self". Reply with ONLY a JSON object: {"route":"<exact option name or self>","confidence":<number 0-1>}. Nothing else.`
  const r = await callOpenRouter({ apiKey, model: PRIMARY_MODEL, fallbackModel: FALLBACK_MODEL, temperature: 0, maxTokens: 40, responseFormat: { type: 'json_object' }, messages: [{ role: 'system', content: sys }, { role: 'user', content: String(text).slice(0, 1500) }] })
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let j: any = {}
  try { j = JSON.parse(r.content) } catch { const s = r.content.indexOf('{'), e = r.content.lastIndexOf('}'); try { j = JSON.parse(r.content.slice(s, e + 1)) } catch { j = {} } }
  return { route: (String(j.route ?? 'self').trim() || 'self'), confidence: Math.max(0, Math.min(1, Number(j.confidence) || 0)), tokens: r.tokens ?? 0 }
}

// Lead capture: extract the customer's details from the conversation into a strict JSON record
// and upsert the dialogue's lead. Only runs when contact info (phone/email) is actually present,
// so it doesn't spend a call on small talk. NEVER invents fields — only what the customer stated.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
// Push a completed lead (name/phone/email) to the account's connected CRM. Best-effort, returns the
// CRM name on success. Fires automatically once a lead has a phone, so leads flow to the CRM without
// relying on the LLM to call a tool.
async function pushLeadToCrm(db: any, accountId: string, lead: Record<string, unknown>): Promise<string | null> {
  try {
    const { data: keys } = await db.from('provider_keys').select('provider, api_key').eq('account_id', accountId).in('provider', ['bitrix24', 'hubspot', 'amocrm'])
    const byP: Record<string, string> = {}; for (const k of (keys ?? []) as any[]) byP[k.provider] = k.api_key
    const name = String(lead.name ?? '').slice(0, 120), phone = String(lead.phone ?? ''), email = String(lead.email ?? ''), note = String(lead.request ?? lead.budget ?? '')
    if (byP.amocrm && byP.amocrm.includes('|')) {
      const [sub, token] = byP.amocrm.split('|')
      const r = await amoCreateLead(sub, token, { name, phone, email, note })
      if (r.ok) return 'amocrm'
    }
    if (byP.bitrix24 && /^https?:\/\//i.test(byP.bitrix24)) {
      const base = byP.bitrix24.replace(/\/+$/, '')
      const fields: any = { TITLE: `Nemo lead: ${name || phone || 'клиент'}` }
      if (name) fields.NAME = name
      if (note) fields.COMMENTS = note
      if (phone) fields.PHONE = [{ VALUE: phone, VALUE_TYPE: 'WORK' }]
      const r = await fetch(`${base}/crm.lead.add.json`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ fields }) }).then((x) => x.json()).catch(() => ({}))
      if (r?.result) return 'bitrix24'
    }
    if (byP.hubspot) {
      const props: any = {}
      if (email) props.email = email
      if (name) { const parts = name.split(' '); props.firstname = parts[0]; if (parts.length > 1) props.lastname = parts.slice(1).join(' ') }
      if (phone) props.phone = phone
      if (props.email || props.phone) {
        const r = await fetch('https://api.hubapi.com/crm/v3/objects/contacts', { method: 'POST', headers: { Authorization: `Bearer ${byP.hubspot}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ properties: props }) }).then((x) => x.json()).catch(() => ({}))
        if (r?.id) return 'hubspot'
      }
    }
    return null
  } catch { return null }
}

async function extractLead(db: any, apiKey: string, dialogueId: string, history: any[], existing: Record<string, unknown>, rowId: string | null, wantFields: string[] = [], eager = false, accountId = ''): Promise<number> {
  const convo = (history ?? []).map((m: any) => `${m.author === 'customer' ? 'Customer' : 'Agent'}: ${String(m.content ?? '')}`).join('\n').slice(-4000)
  const hasContact = /(\+?\d[\d\s()\-]{6,}\d)|([\w.+-]+@[\w-]+\.[\w.-]+)/.test(convo)
  // qualifier/sales/booking agents always try (name-only leads count); others only when the
  // conversation already carries a phone or email, to avoid spending on small talk.
  if (!eager && !hasContact) return 0
  // strict allowed-key set = core contact fields + the agent's own configured lead-form fields
  // (so a custom field like "course" is actually captured, not just the 5 hardcoded ones).
  const keys = [...new Set(['name', 'phone', 'email', 'request', 'budget', ...wantFields.map((f) => String(f).trim()).filter(Boolean)])].slice(0, 12)
  const r = await callOpenRouter({
    apiKey, model: PRIMARY_MODEL, fallbackModel: FALLBACK_MODEL, temperature: 0, maxTokens: 300,
    responseFormat: { type: 'json_object' },
    messages: [
      { role: 'system', content: `Extract the customer's lead details from this conversation. Return ONLY a JSON object. Include a key ONLY if the customer EXPLICITLY stated it. Allowed keys: ${keys.join(', ')}. If an allowed key names a specific thing the customer mentioned (e.g. a course, product or service they want), put that value under THAT key rather than only in 'request'. Use ONLY values the customer actually gave — NEVER invent, guess or infer. Omit keys you did not find. If nothing, return {}.` },
      { role: 'user', content: convo },
    ],
  })
  let obj: any = {}
  try { obj = JSON.parse(r.content) } catch {
    const s = r.content.indexOf('{'); const e = r.content.lastIndexOf('}')
    try { obj = s >= 0 && e > s ? JSON.parse(r.content.slice(s, e + 1)) : {} } catch { obj = {} }
  }
  const clean: Record<string, string> = {}
  for (const k of keys) {
    const v = obj?.[k]
    if (v != null && String(v).trim() && String(v).trim().toLowerCase() !== 'null') clean[k] = String(v).slice(0, 300)
  }
  // value validation — never persist a non-numeric "phone" or a malformed "email" as fact
  // (e.g. the model echoing "тот же номер" / "call me" into the phone field).
  if (clean.phone && (clean.phone.replace(/\D/g, '').length < 6)) delete clean.phone
  if (clean.email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(clean.email)) delete clean.email
  if (Object.keys(clean).length) {
    const merged: Record<string, unknown> = { ...(existing ?? {}), ...clean }
    if (rowId) await db.from('leads').update({ fields: merged }).eq('id', rowId)
    else { const ins = await db.from('leads').insert({ dialogue_id: dialogueId, fields: merged, status: 'new' }).select('id').single(); rowId = ins?.data?.id ?? null }
    // once a lead has a phone, auto-forward it to the connected CRM (once), no LLM tool-call needed
    if (accountId && merged.phone && !merged.crm_pushed) {
      const pushed = await pushLeadToCrm(db, accountId, merged)
      if (pushed && rowId) { merged.crm_pushed = pushed; await db.from('leads').update({ fields: merged }).eq('id', rowId) }
    }
  }
  return r.tokens ?? 0
}

// Best-effort Telegram ping to the business admin when a dialogue is escalated.
// Requires business_profiles.notify_chat_id set + any Telegram bot on the account.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function notifyEscalation(db: any, agent: any, lastCustomer: string, reason: string): Promise<void> {
  try {
    const { data: bp } = await db.from('business_profiles').select('notify_chat_id').eq('account_id', agent.account_id).maybeSingle()
    const target = bp?.notify_chat_id
    if (!target) return
    const { data: ch } = await db.from('channels').select('credentials').eq('agent_id', agent.id).eq('type', 'telegram').limit(1).maybeSingle()
    const token = ch?.credentials?.bot_token
    if (!token) return
    const alert = `🔔 Нужен оператор\nАгент: ${agent.name ?? 'ИИ'}\nВопрос клиента: "${String(lastCustomer).slice(0, 300)}"\nПричина: ${reason || '—'}\n\nОткройте раздел «Диалоги» в Nemo и ответьте клиенту.`
    await tgSend(String(token), String(target), alert)
  } catch { /* best effort — never block the reply flow */ }
}

const RATE_LIMIT_PER_MIN = 20
const MAX_SPECIALISTS = 3

/* eslint-disable @typescript-eslint/no-explicit-any */
function extractJson(text: string): Record<string, unknown> | null {
  const s = text.indexOf('{')
  const e = text.lastIndexOf('}')
  if (s === -1 || e === -1 || e < s) return null
  try {
    return JSON.parse(text.slice(s, e + 1))
  } catch {
    return null
  }
}

// "HH:MM" now in a timezone (falls back to UTC on a bad zone).
function nowInTz(tz: string): string {
  try {
    return new Date().toLocaleTimeString('en-GB', { timeZone: tz || 'UTC', hour12: false, hour: '2-digit', minute: '2-digit' })
  } catch {
    return new Date().toISOString().slice(11, 16)
  }
}
// Is `now` within [start, end)? Supports overnight windows (e.g. 22:00–06:00).
function withinWorkHours(tz: string, start: string, end: string): boolean {
  if (!start || !end || start === end) return true
  const now = nowInTz(tz)
  return start < end ? now >= start && now < end : now >= start || now < end
}

const LANG_HINT = 'Reply in the SAME language as the latest customer message.'

// The account's BUSINESS PROFILE, appended to every agent's system prompt so channel
// replies are grounded in the real business ("trained on your business"). '' if unset.
async function loadBusinessContext(db: any, accountId: string): Promise<string> {
  const { data } = await db.from('business_profiles').select('*').eq('account_id', accountId).maybeSingle()
  if (!data) return ''
  const rows: [string, unknown][] = [
    ['Компания', data.name], ['Сфера', data.industry], ['О компании', data.about],
    ['Аудитория', data.audience], ['Продукты/услуги', data.offerings], ['Тон общения', data.tone],
    ['Города/регионы', data.cities], ['Ссылки', data.links], ['Доп. факты и правила', data.extra],
  ]
  const filled = rows.filter(([, v]) => v && String(v).trim())
  if (!filled.length) return ''
  return '\n\n=== О БИЗНЕСЕ (реальные факты о компании — используй их, не выдумывай) ===\n' +
    filled.map(([k, v]) => `${k}: ${String(v).trim()}`).join('\n') + '\n=== конец профиля ==='
}

// A team (workflow) agent on a channel: lead plans -> specialists contribute ->
// lead synthesizes ONE reply. Returns the reply text + total tokens spent.
async function buildTeamReply(
  db: any,
  apiKey: string,
  agent: any,
  history: any[],
  knowledge: string,
  bizBlock = '',
  knownLead: Record<string, unknown> = {},
): Promise<{ text: string; tokens: number }> {
  let tokens = 0
  // inject already-known lead details + today's date so the TEAM path also never re-asks (#5)
  const leadSystem = buildSystemPrompt(agent, knowledge, '', { today: new Date().toISOString().slice(0, 10), knownLead }) + bizBlock + NO_FABRICATION
  const hist: ChatMsg[] = (history ?? []).map((m: any): ChatMsg => ({ role: m.author === 'customer' ? 'user' : 'assistant', content: m.content }))
  const lastUser = [...(history ?? [])].reverse().find((m: any) => m.author === 'customer')?.content ?? ''
  const temp = Number(agent.temperature) || 0.5

  // load the lead's saved team (department + specialist sub-agents)
  const { data: depts } = await db.from('departments').select('id').eq('main_agent_id', agent.id).order('created_at', { ascending: false }).limit(1)
  const dept = depts?.[0]
  let subs: any[] = []
  if (dept) {
    const { data } = await db.from('sub_agents').select('role, name, prompt').eq('department_id', dept.id).limit(8)
    subs = (data ?? []).filter((s: any) => (s.status ?? 'active') !== 'paused')
  }

  // no team yet -> the lead just answers directly
  if (!subs.length) {
    const out = await callOpenRouter({ apiKey, model: agent.model || PRIMARY_MODEL, fallbackModel: FALLBACK_MODEL, messages: [{ role: 'system', content: leadSystem }, ...hist], temperature: temp, maxTokens: 700 })
    return { text: out.content, tokens: out.tokens }
  }

  const roster = subs.map((s: any) => `- ${s.name} (${s.role}): ${s.prompt?.tasks ?? ''}`).join('\n')

  // 1) LEAD routes: answer directly for simple messages, else delegate to specialists
  const routeMsgs: ChatMsg[] = [
    {
      role: 'system',
      content:
        `${leadSystem}\n\nYou lead this team:\n${roster}\n\n` +
        'Decide how to handle the customer\'s latest message. If it is a simple greeting or you can answer alone, answer directly. ' +
        'Otherwise delegate to 1-3 relevant specialists. Respond ONLY as JSON: ' +
        '{"answer": string|null, "delegate": [{"name": string, "task": string}]}. ' + LANG_HINT,
    },
    ...hist,
  ]
  const r1 = await callOpenRouter({ apiKey, model: PRIMARY_MODEL, fallbackModel: FALLBACK_MODEL, messages: routeMsgs, temperature: 0.3, maxTokens: 500 })
  tokens += r1.tokens
  const plan = extractJson(r1.content) ?? {}
  const delegate = Array.isArray(plan.delegate) ? (plan.delegate as any[]).slice(0, MAX_SPECIALISTS) : []

  if (!delegate.length) {
    if (typeof plan.answer === 'string' && plan.answer.trim()) return { text: plan.answer.trim(), tokens }
    const out = await callOpenRouter({ apiKey, model: PRIMARY_MODEL, fallbackModel: FALLBACK_MODEL, messages: [{ role: 'system', content: leadSystem }, ...hist], temperature: temp, maxTokens: 700 })
    return { text: out.content, tokens: tokens + out.tokens }
  }

  // 2) SPECIALISTS contribute (each with its own saved prompt)
  const contributions: { name: string; output: string }[] = []
  for (const d of delegate) {
    const nm = String(d?.name ?? '').toLowerCase()
    // exact name first; fall back to substring ONLY if it's unambiguous (exactly one match) —
    // a blind includes() could mis-resolve e.g. "Sales" onto "Sales Support".
    let sa = subs.find((s: any) => String(s.name).toLowerCase() === nm)
    if (!sa && nm) { const m = subs.filter((s: any) => String(s.name).toLowerCase().includes(nm)); if (m.length === 1) sa = m[0] }
    const p = sa?.prompt ?? {}
    const sys = (sa
      ? `You are "${sa.name}", a ${sa.role}. ${p.role ?? ''} Tasks: ${p.tasks ?? ''}. Rules: ${p.rules ?? ''}`
        + roleSkillBlock(String(sa.role ?? ''), `${p.role ?? ''} ${p.tasks ?? ''}`)
      : `You are a specialist named ${d?.name ?? 'Specialist'}.`) + bizBlock
    const rr = await callOpenRouter({
      apiKey, model: PRIMARY_MODEL, fallbackModel: FALLBACK_MODEL, temperature: 0.4, maxTokens: 550,
      messages: [
        { role: 'system', content: `${sys}\n${LANG_HINT}` },
        { role: 'user', content: `Customer said: "${lastUser}"\n\nYour task from the team lead: ${d?.task ?? 'help with the request'}\n\nGive a concrete, specific, professional contribution the lead can use directly. No filler.` },
      ],
    })
    tokens += rr.tokens
    if (rr.content) contributions.push({ name: sa?.name ?? String(d?.name ?? 'Specialist'), output: rr.content })
  }

  if (!contributions.length) {
    const out = await callOpenRouter({ apiKey, model: PRIMARY_MODEL, fallbackModel: FALLBACK_MODEL, messages: [{ role: 'system', content: leadSystem }, ...hist], temperature: temp, maxTokens: 700 })
    return { text: out.content, tokens: tokens + out.tokens }
  }

  // 3) LEAD synthesizes one customer-facing reply
  const synth = await callOpenRouter({
    apiKey, model: PRIMARY_MODEL, fallbackModel: FALLBACK_MODEL, temperature: 0.5, maxTokens: 900,
    messages: [
      {
        role: 'system',
        content:
          `${leadSystem}\n\nYou are the team lead replying to a real customer on behalf of the business. ` +
          'Merge your specialists\' input into ONE clear, warm, professional reply that directly answers the customer and moves the conversation forward. ' +
          'Be concrete and helpful; keep a natural human tone. Never mention internal steps, specialists, JSON, or that you are an AI team. ' +
          `${LANG_HINT}`,
      },
      { role: 'user', content: `Customer: "${lastUser}"\n\nSpecialist input (internal — do not quote):\n${contributions.map((c) => `[${c.name}]: ${c.output}`).join('\n\n')}\n\nWrite the final reply to the customer.` },
    ],
  })
  tokens += synth.tokens
  // Customer-facing: no internal "who contributed" trace — that reads as unprofessional.
  const body = synth.content || contributions.map((c) => c.output).join('\n\n')
  return { text: body.trim(), tokens }
}

// A single SUB-AGENT running its OWN Telegram bot. It answers in its own persona.
// If the message needs a teammate's expertise it quietly consults ONE sibling
// sub-agent (internal collaboration — "the bots consult each other") and folds
// that colleague's input into its own reply. Returns the reply + total tokens.
export async function buildSubAgentReply(
  db: any,
  apiKey: string,
  sub: any,
  history: any[],
): Promise<{ text: string; tokens: number }> {
  let tokens = 0
  const p = sub.prompt ?? {}
  const persona =
    `You are "${sub.name}", a ${sub.role}. ${p.role ?? ''}\n` +
    `Your tasks: ${p.tasks ?? ''}\nTone: ${p.tone ?? ''}\nRules: ${p.rules ?? ''}\n` +
    'Answer the customer as this specialist — concrete and genuinely helpful.\n' + SCOPE_GUARD
  const hist: ChatMsg[] = (history ?? []).map((m: any): ChatMsg => ({ role: m.author === 'customer' ? 'user' : 'assistant', content: m.content }))
  const lastUser = [...(history ?? [])].reverse().find((m: any) => m.author === 'customer')?.content ?? ''

  // teammates in the same department, for optional consultation
  const { data: sibs } = await db
    .from('sub_agents')
    .select('id, name, role, prompt')
    .eq('department_id', sub.department_id)
    .neq('id', sub.id)
    .limit(6)
  const mates = (sibs ?? []).filter((s: any) => (s.status ?? 'active') !== 'paused')
  const roster = mates.map((s: any) => `- ${s.name} (${s.role})`).join('\n')

  let consult = ''
  if (roster) {
    const route = await callOpenRouter({
      apiKey, model: PRIMARY_MODEL, fallbackModel: FALLBACK_MODEL, temperature: 0.2, maxTokens: 200,
      messages: [
        { role: 'system', content: `You are ${sub.name} (${sub.role}). Your teammates:\n${roster}\nIf answering the customer clearly needs one teammate's specific expertise, respond ONLY as JSON {"consult":"<teammate name>","question":"<short question for them>"}. Otherwise respond {"consult":null}.` },
        { role: 'user', content: `Customer said: "${lastUser}"` },
      ],
    })
    tokens += route.tokens
    const j = extractJson(route.content) ?? {}
    if (j.consult && typeof j.consult === 'string') {
      const mate = mates.find((s: any) => String(s.name).toLowerCase() === String(j.consult).toLowerCase())
      if (mate) {
        const mp = mate.prompt ?? {}
        const ans = await callOpenRouter({
          apiKey, model: PRIMARY_MODEL, fallbackModel: FALLBACK_MODEL, temperature: 0.4, maxTokens: 350,
          messages: [
            { role: 'system', content: `You are "${mate.name}", a ${mate.role}. ${mp.role ?? ''} Give a short, concrete expert answer to help your colleague.` },
            { role: 'user', content: `Your colleague ${sub.name} asks: ${(j.question as string) || lastUser}` },
          ],
        })
        tokens += ans.tokens
        if (ans.content) consult = `\n\nA teammate (${mate.name}) advises you: ${ans.content}\nUse this where helpful, but reply in your own voice.`
      }
    }
  }

  const out = await callOpenRouter({
    apiKey, model: sub.model || PRIMARY_MODEL, fallbackModel: FALLBACK_MODEL, temperature: 0.5, maxTokens: 700,
    messages: [{ role: 'system', content: `${persona}${consult}\n${LANG_HINT}` }, ...hist],
  })
  return { text: out.content, tokens: tokens + out.tokens }
}

export async function buildReply(db: any, openrouterKey: string, agent: any, dialogueId: string): Promise<string> {
  // Paused/blocked agents don't reply (admin block pauses all of an account's agents).
  if (agent.status && agent.status !== 'active') return ''

  // Honor custom work hours — 24/7 always replies; 'work-hours' only inside the window.
  if (agent.schedule === 'work-hours' && !withinWorkHours(agent.timezone, agent.work_start, agent.work_end)) return ''

  // Cost guard — per-customer rate limit (a dialogue maps 1:1 to an external_id).
  const since = new Date(Date.now() - 60_000).toISOString()
  const { count: recent } = await db
    .from('messages')
    .select('*', { count: 'exact', head: true })
    .eq('dialogue_id', dialogueId)
    .eq('author', 'customer')
    .gte('created_at', since)
  if ((recent ?? 0) > RATE_LIMIT_PER_MIN) return ''

  // Cost guard — stop when the account has no AI tokens left.
  const { data: acc } = await db.from('accounts').select('token_balance, plan').eq('id', agent.account_id).single()
  if (acc && Number(acc.token_balance) <= 0) return ''

  // Per-session cost guard — cap cumulative tokens for THIS dialogue; on exceed, hand off to a
  // human instead of billing a runaway/troll thread forever. Uses usage.dialogue_id.
  const { data: sessUsage } = await db.from('usage').select('tokens').eq('dialogue_id', dialogueId).limit(1000)
  const sessionTokens = (sessUsage ?? []).reduce((s: number, u: any) => s + (Number(u.tokens) || 0), 0)
  if (sessionTokens > SESSION_TOKEN_CAP) {
    await db.from('dialogues').update({ status: 'needs_operator' }).eq('id', dialogueId)
    return ''
  }

  // Load the MOST RECENT 20 messages (order desc + reverse to chronological). Fetching
  // ascending+limit(20) returned the OLDEST 20, so a long dialogue permanently lost its recent
  // context. Now the agent always sees the latest turns.
  const { data: historyRaw } = await db
    .from('messages')
    .select('author, content, created_at')
    .eq('dialogue_id', dialogueId)
    .order('created_at', { ascending: false })
    .limit(20)
  const history = (historyRaw ?? []).slice().reverse()

  // RAG: pull the chunks most relevant to the latest customer message (semantic
  // pgvector search; falls back to a raw dump for agents not yet indexed). `db` is
  // the service-role client, so it bypasses RLS on knowledge_chunks.
  const lastCustomer = [...(history ?? [])].reverse().find((m: any) => m.author === 'customer')?.content ?? ''
  const knowledge = await retrieveKnowledge(db, agent.id, String(lastCustomer))

  // self-improving agents recall memory across dialogues; a PERSONAL assistant also
  // remembers its owner across chats
  const isLearning = agent.type === 'learning'
  const personal = agent.persona_mode === 'personal'
  const memory = (isLearning || personal) ? await loadMemory(db, agent.id) : ''

  try {
    // use the account's own OpenRouter key if they set one, else Nemo's shared key
    const apiKey = await resolveOpenRouterKey(db, agent.account_id, openrouterKey)
    // the account's business profile — grounds replies in the real business
    const bizBlock = await loadBusinessContext(db, agent.account_id)

    // Lead capture + state: customer-facing agents collect the customer's details, persist them
    // to the leads table, and get the already-known fields injected so they never re-ask.
    const today = new Date().toISOString().slice(0, 10)
    // 'workflow' (team) agents serve customers on channels too, so they also load/capture lead state
    const CUSTOMER_TYPES = ['chat', 'qualifier', 'sales', 'support', 'booking', 'workflow']
    const isCustomerFacing = CUSTOMER_TYPES.includes(agent.type)
    const lf = agent.lead_form
    const leadFields: string[] = isCustomerFacing
      ? (lf?.enabled && Array.isArray(lf.fields) && lf.fields.length ? lf.fields.map((f: any) => String(f.label || f.id || '')).filter(Boolean) : ['имя', 'телефон'])
      : []
    let knownLead: Record<string, unknown> = {}
    let leadRowId: string | null = null
    if (isCustomerFacing) {
      const { data: lr } = await db.from('leads').select('id, fields').eq('dialogue_id', dialogueId).order('created_at', { ascending: false }).limit(1).maybeSingle()
      if (lr) { leadRowId = lr.id; knownLead = (lr.fields ?? {}) as Record<string, unknown> }
    }
    const promptOpts = { today, leadFields, knownLead }

    // Server-side premium-model gate — the account's plan decides if a frontier model is allowed.
    const premiumAllowed = planOf(acc?.plan).premium
    const model = gateModel(agent.model, premiumAllowed)

    let replyText = ''
    let tokensUsed = 0
    let modelTag: string = model

    // TOOL-USE (ALL agent types, incl. teams): if the account has connected tools and the
    // message asks to DO an action (create Google Sheet/Doc, send email, calendar, CRM),
    // execute it for real and reply with the REAL result — instead of hallucinating a link.
    // pass the Telegram chat context so task tools can create remindable DB tasks in this chat
    const { data: dia } = await db.from('dialogues').select('channel_id, external_id, channel').eq('id', dialogueId).maybeSingle()
    const tgCtx = { dialogueId, ...(dia?.channel === 'telegram' && dia?.external_id ? { channelId: dia.channel_id as string, chatId: String(dia.external_id) } : {}) }
    const toolRun = lastCustomer ? await runAgentTools(db, apiKey, agent.account_id, String(lastCustomer), history ?? [], agent.type, tgCtx, Array.isArray(agent.skills) ? agent.skills : []) : null
    if (toolRun?.ran) {
      replyText = String(toolRun.result ?? 'Готово.')
      tokensUsed = toolRun.tokens
      modelTag = 'tool'
    } else if (agent.type === 'workflow') {
      // TEAM: the lead runs the whole department on this message (with known lead state injected)
      const team = await buildTeamReply(db, apiKey, agent, history ?? [], knowledge, bizBlock, knownLead)
      replyText = team.text
      tokensUsed = team.tokens
      modelTag = 'team'
    } else {
      // DYNAMIC ROUTING via a dedicated intent CLASSIFIER (not a marker buried in the reply):
      // pick the right teammate WITH a confidence score BEFORE answering, so routing is measurable
      // (every decision logged to routing_decisions), exact-matched (no 'Sales'/'Sales Support'
      // collision), and gated by confidence. Only runs when the account actually has teammates.
      const { data: sibs } = await db.from('agents').select('id, name, type, model, prompt, temperature, default_lang, account_id, niche, country')
        .eq('account_id', agent.account_id).eq('status', 'active').neq('id', agent.id).neq('type', 'workflow').limit(6)
      const siblings = (sibs ?? []).map((s: any) => ({ id: s.id, name: s.name, role: s.prompt?.role ?? s.type ?? '', raw: s }))

      let target: any = null
      // a personal assistant is a single individual — never route to "teammates"
      if (!personal && siblings.length && lastCustomer) {
        const cls = await classifyRoute(apiKey, String(lastCustomer), agent, siblings)
        tokensUsed += cls.tokens
        if (cls.route.toLowerCase() !== 'self' && cls.confidence >= ROUTE_CONFIDENCE) {
          target = siblings.find((s: any) => String(s.name).trim().toLowerCase() === cls.route.trim().toLowerCase()) ?? null
        }
        try { await db.from('routing_decisions').insert({ account_id: agent.account_id, dialogue_id: dialogueId, from_agent: agent.id, to_agent: target?.id ?? null, chosen: cls.route, confidence: cls.confidence, resolved: Boolean(target) }) } catch { /* observability best-effort */ }
      }

      if (target) {
        // the chosen teammate (its persona + its knowledge) answers; the dialogue is reassigned
        await db.from('dialogues').update({ agent_id: target.id }).eq('id', dialogueId)
        const tgt = target.raw
        const tKnow = await retrieveKnowledge(db, tgt.id, String(lastCustomer))
        const tModel = gateModel(tgt.model, premiumAllowed)
        const tmsgs: ChatMsg[] = [
          { role: 'system', content: buildSystemPrompt(tgt, tKnow, '', { today, knownLead }) + bizBlock + ESCALATION_RULE },
          ...history.map((m: any): ChatMsg => ({ role: m.author === 'customer' ? 'user' : 'assistant', content: m.content })),
        ]
        const tout = await callOpenRouter({ apiKey, model: tModel, messages: tmsgs, temperature: Number(tgt.temperature) || 0.5, fallbackModel: FALLBACK_MODEL })
        tokensUsed += tout.tokens
        modelTag = tModel
        const tesc = parseEscalation(tout.content)
        if (tesc.escalated) {
          await db.from('dialogues').update({ status: 'needs_operator' }).eq('id', dialogueId)
          await notifyEscalation(db, tgt, String(lastCustomer), tesc.reason)
          if (tokensUsed) { await db.from('usage').insert({ account_id: agent.account_id, tokens: tokensUsed, model: tModel, dialogue_id: dialogueId, cost: estimateCostUsd(tModel, tokensUsed) }); await db.rpc('decrement_token_balance', { p_account: agent.account_id, p_amount: tokensUsed }) }
          return ''
        }
        replyText = tout.content
      } else {
        // this agent answers directly (router chose self, confidence too low, or no teammates).
        // Personal mode drops the business framing (bizBlock), the operator-escalation rule and
        // the org fabrication guard — a personal assistant speaks purely as its owner.
        const sysContent = personal
          ? buildSystemPrompt(agent, knowledge, memory, promptOpts)
          : buildSystemPrompt(agent, knowledge, memory, promptOpts) + bizBlock + ESCALATION_RULE + NO_FABRICATION
        const messages: ChatMsg[] = [
          { role: 'system', content: sysContent },
          ...history.map((m: any): ChatMsg => ({ role: m.author === 'customer' ? 'user' : 'assistant', content: m.content })),
        ]
        const out = await callOpenRouter({ apiKey, model, messages, temperature: Number(agent.temperature), fallbackModel: FALLBACK_MODEL })
        tokensUsed += out.tokens
        // a personal assistant never hands off to a business operator
        const esc = parseEscalation(out.content)
        if (!personal && esc.escalated) {
          await db.from('dialogues').update({ status: 'needs_operator' }).eq('id', dialogueId)
          await notifyEscalation(db, agent, String(lastCustomer), esc.reason)
          if (tokensUsed) { await db.from('usage').insert({ account_id: agent.account_id, tokens: tokensUsed, model, dialogue_id: dialogueId, cost: estimateCostUsd(model, tokensUsed) }); await db.rpc('decrement_token_balance', { p_account: agent.account_id, p_amount: tokensUsed }) }
          return '' // caller sends the graceful "operator will join" message to the customer
        }
        replyText = out.content
      }
    }

    // Lead capture: pull the customer's details into a strict-JSON lead record (only what they
    // actually stated — no invention) so a lead is persisted and can be handed off / pushed to CRM.
    if (isCustomerFacing && !personal && replyText) {
      const eager = ['qualifier', 'sales', 'booking'].includes(agent.type)
      try { tokensUsed += await extractLead(db, apiKey, dialogueId, history, knownLead, leadRowId, leadFields, eager, agent.account_id) } catch { /* best effort */ }
    }

    if (replyText) {
      await db.from('messages').insert({ dialogue_id: dialogueId, author: 'agent', content: replyText })
      await db.from('usage').insert({ account_id: agent.account_id, tokens: tokensUsed, model: modelTag, dialogue_id: dialogueId, cost: estimateCostUsd(modelTag, tokensUsed) })
      if (tokensUsed) await db.rpc('decrement_token_balance', { p_account: agent.account_id, p_amount: tokensUsed })
      if (isLearning || personal) {
        const lastCustomer = [...(history ?? [])].reverse().find((m: any) => m.author === 'customer')
        if (lastCustomer?.content) await saveMemory(db, agent.account_id, agent.id, dialogueId, lastCustomer.content)
      }
    }
    return replyText
  } catch (e) {
    console.error('buildReply error:', e)
    return ''
  }
}
/* eslint-enable @typescript-eslint/no-explicit-any */
