// Shared agent runtime — used by every channel webhook (Telegram/WhatsApp/Instagram).
// A normal agent answers directly. A WORKFLOW (team) agent runs its whole team on
// each message: the lead delegates to specialist sub-agents, they contribute, and
// the lead replies with one combined answer — so a team "talks" on a channel and
// the agents collaborate. Stores the reply + token usage.
import { callOpenRouter, buildSystemPrompt, estimateCostUsd, SCOPE_GUARD, PRIMARY_MODEL, FALLBACK_MODEL, type ChatMsg } from './llm.ts'
import { planOf } from './plans.ts'
import { loadMemory, saveMemory } from './memory.ts'
import { openSecret, providerSecretContext } from './secretBox.ts'
import { resolveOpenRouterKey } from './keys.ts'
import { retrieveKnowledge, retrieveTeamKnowledge } from './knowledge.ts'
import { ALLOWED_MODEL_IDS } from './models.ts'
import { amoCreateLead } from './amocrm.ts'
import { buildLeadKeys, sanitizeLeadPatch } from './leadPatch.ts'
import { runAgentTools } from './tools.ts'
import { blocksExternalActions } from './productionE2E.ts'
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
// Kept in sync with the premium flags of the frontend model catalog
// (src/data/platform.ts PROVIDERS) — asserted by release-entitlement-contracts.
const PREMIUM_RE = /opus|sonnet|gpt-4o(?!-mini)|gpt-4\.1(?!-?mini)|gpt-5(?!(?:\.\d+)?-?(?:mini|nano))|(?:^|\/)o[0-9]|grok|gemini[\w.-]*pro|deepseek-(?:r[0-9]|reasoner|v[0-9]+-pro)|mistral-large|qwen[\w.]*-?max/i
// gateModel: (1) only models from the authoritative server allowlist may run at
// all — arbitrary ids saved by a direct API client fall back to the primary
// model; (2) premium models additionally require a premium plan.
export function gateModel(requested: string | undefined, premiumAllowed: boolean): string {
  const r = (requested || PRIMARY_MODEL).trim()
  if (!ALLOWED_MODEL_IDS.has(r)) return PRIMARY_MODEL
  return (!premiumAllowed && PREMIUM_RE.test(r)) ? PRIMARY_MODEL : r
}

// Minimum confidence to hand off to a teammate — below this the current agent answers itself.
export const ROUTE_CONFIDENCE = 0.6

// AGENT TRACE (spec §6.4 "Thought Trace"): structured, versioned steps describing how agents
// collaborated on ONE reply. Persisted as a messages row with message_type='system_trace' —
// operator-facing observability only: never sent to the customer and never fed back into LLM
// context (all history readers filter to message_type='chat'). Stores only names/ids and short
// task summaries — never raw specialist output or model reasoning.
export type TraceStep =
  | { kind: 'route'; fromAgentId: string | null; fromAgentName: string; agentId: string | null; agentName: string; confidence: number }
  | { kind: 'lead_decision'; agentId: string | null; agentName: string; decision: 'direct' | 'delegate' }
  | { kind: 'consult'; agentId: string | null; agentName: string; task: string }
  | { kind: 'unresolved_delegate'; agentName: string; task: string }
  | { kind: 'peer_review'; agentId: string | null; agentName: string; reviewerAgentId: string | null; reviewerAgentName: string; round: 'initial' | 'after_revision'; approved: boolean; score: number; issueCount: number }
  | { kind: 'revise'; agentId: string | null; agentName: string; reviewerAgentId: string | null; reviewerAgentName: string; round: 1 }
  | { kind: 'human_review'; agentId: string | null; agentName: string; reason: string }
  | { kind: 'synthesize'; agentId: string | null; agentName: string }

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
  const proposed = (String(j.route ?? 'self').trim() || 'self')
  const selfName = String(self?.name ?? '').trim().toLowerCase()
  // The lead must not route to itself by name: the classifier sometimes returns
  // "Sales" for a sales lead even though that is the self option, which creates
  // a false delegation and makes the golden routing contract flaky.
  if (proposed.toLowerCase() === selfName) return { route: 'self', confidence: Math.max(0, Math.min(1, Number(j.confidence) || 0)), tokens: r.tokens ?? 0 }
  // Never execute an LLM-invented teammate name; unknown options are self.
  const validSibling = siblings.some((s) => String(s.name).trim().toLowerCase() === proposed.toLowerCase())
  return { route: validSibling ? proposed : 'self', confidence: Math.max(0, Math.min(1, Number(j.confidence) || 0)), tokens: r.tokens ?? 0 }
}

// Lead capture: extract the customer's details from the conversation into a strict JSON record
// and upsert the dialogue's lead. Only runs when contact info (phone/email) is actually present,
// so it doesn't spend a call on small talk. NEVER invents fields — only what the customer stated.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
// Push a completed lead (name/phone/email) to the account's connected CRM. Fires automatically
// once a lead has a phone, so leads flow to the CRM without relying on the LLM to call a tool.
// `attempted` reports whether any HTTP call actually left the building: an attempted-but-failed
// push is AMBIGUOUS (a timeout may still have landed remotely), which the caller must treat
// differently from "no CRM was contacted at all".
async function pushLeadToCrm(db: any, accountId: string, lead: Record<string, unknown>): Promise<{ provider: string | null; attempted: boolean }> {
  let attempted = false
  try {
    if (await blocksExternalActions(db, accountId)) return { provider: null, attempted: false }
    const { data: keys } = await db.from('provider_keys').select('provider, api_key').eq('account_id', accountId).in('provider', ['bitrix24', 'hubspot', 'amocrm'])
    const byP: Record<string, string> = {}
    for (const k of (keys ?? []) as any[]) {
      byP[k.provider] = await openSecret(k.api_key, providerSecretContext(accountId, k.provider))
    }
    const name = String(lead.name ?? '').slice(0, 120), phone = String(lead.phone ?? ''), email = String(lead.email ?? ''), note = String(lead.request ?? lead.budget ?? '')
    // ONE external attempt per claim: after an ambiguous failure (timeout may
    // have landed remotely) we must NOT fan out to the next CRM — that could
    // create the same lead in two systems. The first eligible provider is THE
    // attempt; retry happens on a later claim after the lease expires.
    if (byP.amocrm && byP.amocrm.includes('|')) {
      const [sub, token] = byP.amocrm.split('|')
      attempted = true
      const r = await amoCreateLead(sub, token, { name, phone, email, note })
      return { provider: r.ok ? 'amocrm' : null, attempted }
    }
    if (byP.bitrix24 && /^https?:\/\//i.test(byP.bitrix24)) {
      const base = byP.bitrix24.replace(/\/+$/, '')
      const fields: any = { TITLE: `Nemo lead: ${name || phone || 'клиент'}` }
      if (name) fields.NAME = name
      if (note) fields.COMMENTS = note
      if (phone) fields.PHONE = [{ VALUE: phone, VALUE_TYPE: 'WORK' }]
      attempted = true
      // hard timeout well below the 10-minute CRM-push claim lease
      const r = await fetch(`${base}/crm.lead.add.json`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ fields }), signal: AbortSignal.timeout(10_000) }).then((x) => x.json()).catch(() => ({}))
      return { provider: r?.result ? 'bitrix24' : null, attempted }
    }
    if (byP.hubspot) {
      const props: any = {}
      if (email) props.email = email
      if (name) { const parts = name.split(' '); props.firstname = parts[0]; if (parts.length > 1) props.lastname = parts.slice(1).join(' ') }
      if (phone) props.phone = phone
      if (props.email || props.phone) {
        attempted = true
        const r = await fetch('https://api.hubapi.com/crm/v3/objects/contacts', { method: 'POST', headers: { Authorization: `Bearer ${byP.hubspot}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ properties: props }), signal: AbortSignal.timeout(10_000) }).then((x) => x.json()).catch(() => ({}))
        return { provider: r?.id ? 'hubspot' : null, attempted }
      }
    }
    return { provider: null, attempted }
  } catch { return { provider: null, attempted } }
}

async function extractLead(db: any, apiKey: string, dialogueId: string, history: any[], existing: Record<string, unknown>, rowId: string | null, wantFields: string[] = [], eager = false, accountId = ''): Promise<number> {
  // all lead writes go through tenant-verified RPCs, so the account is mandatory
  if (!accountId) return 0
  const convo = (history ?? []).map((m: any) => `${m.author === 'customer' ? 'Customer' : 'Agent'}: ${String(m.content ?? '')}`).join('\n').slice(-4000)
  const hasContact = /(\+?\d[\d\s()\-]{6,}\d)|([\w.+-]+@[\w-]+\.[\w.-]+)/.test(convo)
  let tokens = 0
  // freshest known fields — replaced by the post-merge row whenever this turn writes
  let fields: Record<string, unknown> = { ...(existing ?? {}) }
  // qualifier/sales/booking agents always try (name-only leads count); others only when the
  // conversation already carries a phone or email, to avoid spending on small talk.
  if (eager || hasContact) {
    // strict allowed-key set = core contact fields + the agent's own configured lead-form fields
    // (so a custom field like "course" is actually captured), minus reserved CRM-claim and
    // prototype names — lead-form labels are user-controlled and must not become those keys.
    const keys = buildLeadKeys(wantFields)
    const r = await callOpenRouter({
      apiKey, model: PRIMARY_MODEL, fallbackModel: FALLBACK_MODEL, temperature: 0, maxTokens: 300,
      responseFormat: { type: 'json_object' },
      messages: [
        { role: 'system', content: `Extract the customer's lead details from this conversation. Return ONLY a JSON object. Include a key ONLY if the customer EXPLICITLY stated it. Allowed keys: ${keys.join(', ')}. If an allowed key names a specific thing the customer mentioned (e.g. a course, product or service they want), put that value under THAT key rather than only in 'request'. Use ONLY values the customer actually gave — NEVER invent, guess or infer. Omit keys you did not find. If nothing, return {}.` },
        { role: 'user', content: convo },
      ],
    })
    tokens = r.tokens ?? 0
    let obj: unknown = {}
    try { obj = JSON.parse(r.content) } catch {
      const s = r.content.indexOf('{'); const e = r.content.lastIndexOf('}')
      try { obj = s >= 0 && e > s ? JSON.parse(r.content.slice(s, e + 1)) : {} } catch { obj = {} }
    }
    const clean = sanitizeLeadPatch(obj, keys)
    if (Object.keys(clean).length) {
      // Atomic server-side merge, advisory-lock serialized per dialogue: concurrent turns can
      // neither drop each other's captured fields nor insert duplicate lead rows.
      const { data, error } = await db.rpc('merge_lead_fields', { p_account_id: accountId, p_dialogue_id: dialogueId, p_patch: clean })
      if (error) { console.error('lead merge failed:', error); return tokens }
      const row = Array.isArray(data) ? data[0] : data
      if (row?.lead_id) { rowId = row.lead_id; fields = (row.lead_fields ?? {}) as Record<string, unknown> }
    }
  }
  // Once a lead has a phone, auto-forward it to the connected CRM — single claimant via a
  // self-expiring lease, so concurrent turns cannot double-push; a previously failed push is
  // retried even on turns that extracted nothing new (and never inserts an empty lead).
  // Only a real provider marker counts as pushed (matching the claim RPC), so junk written
  // through a hostile lead-form label during the deploy window cannot suppress the push.
  const alreadyPushed = ['bitrix24', 'amocrm', 'hubspot'].includes(String(fields.crm_pushed ?? ''))
  if (rowId && fields.phone && !alreadyPushed && !await blocksExternalActions(db, accountId)) {
    const { data: claimData, error: claimError } = await db.rpc('claim_lead_crm_push', { p_account_id: accountId, p_lead_id: rowId })
    if (claimError) { console.error('lead claim failed:', claimError); return tokens }
    const claim = Array.isArray(claimData) ? claimData[0] : claimData
    if (claim?.claim_token) {
      // push the claimed row's CURRENT fields, not this turn's snapshot
      const push = await pushLeadToCrm(db, accountId, (claim.lead_fields ?? fields) as Record<string, unknown>)
      if (push.provider) {
        const { data: finished, error: finishError } = await db.rpc('finish_lead_crm_push', { p_account_id: accountId, p_lead_id: rowId, p_token: claim.claim_token, p_provider: push.provider })
        if (finishError || finished !== true) console.error('lead push finish failed:', finishError ?? 'claim token no longer valid')
      } else if (!push.attempted) {
        // nothing was sent (no eligible CRM connected) — release so the next turn retries cheaply
        const { error: releaseError } = await db.rpc('finish_lead_crm_push', { p_account_id: accountId, p_lead_id: rowId, p_token: claim.claim_token, p_provider: null })
        if (releaseError) console.error('lead claim release failed:', releaseError)
      }
      // attempted-but-failed is ambiguous (a timeout may have landed remotely): keep the
      // lease and let it expire, so a concurrent turn cannot double-push the same lead.
    }
  }
  return tokens
}

// Best-effort Telegram ping to the business admin when a dialogue is escalated.
// Requires business_profiles.notify_chat_id set + any Telegram bot on the account.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function notifyEscalation(db: any, agent: any, lastCustomer: string, reason: string): Promise<void> {
  try {
    if (await blocksExternalActions(db, agent.account_id)) return
    const { data: bp } = await db.from('business_profiles').select('notify_chat_id').eq('account_id', agent.account_id).maybeSingle()
    const target = bp?.notify_chat_id
    if (!target) return
    const { data: ch } = await db.from('channels').select('credentials').eq('agent_id', agent.id).eq('type', 'telegram').limit(1).maybeSingle()
    const token = ch?.credentials?.bot_token
    if (!token) return
    const alert = `🔔 Нужен оператор\nАгент: ${agent.name ?? 'ИИ'}\nВопрос клиента: "${String(lastCustomer).slice(0, 300)}"\nПричина: ${reason || '—'}\n\nОткройте раздел «Диалоги» в Nemo и ответьте клиенту.`
    if (await blocksExternalActions(db, agent.account_id)) return
    await tgSend(String(token), String(target), alert)
  } catch { /* best effort — never block the reply flow */ }
}

const RATE_LIMIT_PER_MIN = 20
// A team may have many saved specialists, but a single request gets at most three relevant
// delegates and one peer-review revision. These hard caps keep channel latency/cost bounded and prevent an
// agent-review-agent recursion loop.
const MAX_SPECIALISTS = 3
const MAX_PEER_REVISIONS = 1
const TEAM_SAFETY_GUARD =
  '\nSafety and human-control contract: preserve every approval limit in the team and specialist instructions. ' +
  'Never claim an external action, booking, payment, refund, contract, price change, consequential decision, or regulated decision happened without a confirmed tool result or authorized human. ' +
  'Medical, legal, hiring, insurance, accounting, payment, safety, and other consequential decisions stay with an authorized human. If the requested result cannot satisfy these rules, require human review instead of weakening the rule.'

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
  premiumAllowed = false,
): Promise<{ text: string; tokens: number; trace: TraceStep[]; humanReviewReason?: string }> {
  let tokens = 0
  const trace: TraceStep[] = []
  const hist: ChatMsg[] = (history ?? []).map((m: any): ChatMsg => ({ role: m.author === 'customer' ? 'user' : 'assistant', content: m.content }))
  const lastUser = [...(history ?? [])].reverse().find((m: any) => m.author === 'customer')?.content ?? ''
  const temp = Number(agent.temperature) || 0.5

  // load the lead's saved team (department + specialist sub-agents) — scoped to
  // the agent's account so a cross-tenant link can never be traversed
  const { data: depts } = await db.from('departments').select('id').eq('main_agent_id', agent.id).eq('account_id', agent.account_id).order('created_at', { ascending: false }).limit(1)
  const dept = depts?.[0]
  let subs: any[] = []
  if (dept) {
    // model is loaded so a specialist's SAVED model choice is honored (plan-gated below)
    const { data } = await db.from('sub_agents').select('id, role, name, prompt, status, model').eq('department_id', dept.id).limit(8)
    subs = (data ?? []).filter((s: any) => (s.status ?? 'active') !== 'paused')
  }

  // TEAM-SHARED RAG: the department's shared knowledge base (owner_type 'team')
  // complements the lead's own docs; the RPC verifies tenant ownership itself.
  const teamKnowledge = dept ? await retrieveTeamKnowledge(db, agent.account_id, dept.id, String(lastUser)) : ''
  const fullKnowledge = [knowledge, teamKnowledge].filter(Boolean).join('\n').slice(0, 8000)
  // inject already-known lead details + today's date so the TEAM path also never re-asks (#5)
  const leadSystem = buildSystemPrompt(agent, fullKnowledge, '', { today: new Date().toISOString().slice(0, 10), knownLead }) + bizBlock + NO_FABRICATION
  // specialists get the same verified knowledge — a delegated task must be answered
  // from the team's real facts, not from the model's imagination
  const specialistKnowledgeBlock = fullKnowledge
    ? `\n\n=== TEAM KNOWLEDGE (verified facts — rely on these, never contradict them) ===\n${fullKnowledge}\n=== end of team knowledge ===`
    : ''

  // every call where the LEAD speaks or decides uses the lead's SAVED model
  // (plan-gated) — routing, direct answers, fallbacks and the final synthesis
  const leadModel = gateModel(agent.model, premiumAllowed)

  // no team yet -> the lead just answers directly (never with an ungated raw model)
  if (!subs.length) {
    const out = await callOpenRouter({ apiKey, model: leadModel, fallbackModel: FALLBACK_MODEL, messages: [{ role: 'system', content: leadSystem }, ...hist], temperature: temp, maxTokens: 700 })
    return { text: out.content, tokens: out.tokens, trace }
  }

  // A saved industry team may have several specialists. The lead can select at most three
  // relevant saved teammates; it can never invent or recursively recruit a new teammate.
  const activeSubs = subs.slice(0, MAX_SPECIALISTS)
  const roster = activeSubs.map((s: any) => `- ${s.name} (${s.role}): ${s.prompt?.tasks ?? ''}`).join('\n')

  // 1) LEAD routes: answer directly for simple messages, else delegate to specialists
  const routeMsgs: ChatMsg[] = [
    {
      role: 'system',
      content:
        `${leadSystem}\n\nYou lead this team:\n${roster}\n\n` +
        'Decide how to handle the customer\'s latest message. Answer directly ONLY for a greeting, acknowledgement, or genuinely trivial question. ' +
        'For every substantive request, delegate concrete, non-overlapping work to one to three relevant saved specialists. ' +
        'Do not recruit or name anyone outside the saved roster. Respond ONLY as JSON: ' +
        '{"answer": string|null, "delegate": [{"name": string, "task": string}]}. ' + LANG_HINT,
    },
    ...hist,
  ]
  const r1 = await callOpenRouter({ apiKey, model: leadModel, fallbackModel: FALLBACK_MODEL, messages: routeMsgs, temperature: 0.3, maxTokens: 500 })
  tokens += r1.tokens
  const plan = extractJson(r1.content) ?? {}
  const delegate = Array.isArray(plan.delegate) ? (plan.delegate as any[]).slice(0, MAX_SPECIALISTS) : []
  // the lead's routing decision is the first trace step — direct answers are traced too
  const leadName = String(agent.name ?? 'Lead').slice(0, 120)
  trace.push({ kind: 'lead_decision', agentId: agent.id ?? null, agentName: leadName, decision: delegate.length ? 'delegate' : 'direct' })

  if (!delegate.length) {
    if (typeof plan.answer === 'string' && plan.answer.trim()) return { text: plan.answer.trim(), tokens, trace }
    const out = await callOpenRouter({ apiKey, model: leadModel, fallbackModel: FALLBACK_MODEL, messages: [{ role: 'system', content: leadSystem }, ...hist], temperature: temp, maxTokens: 700 })
    return { text: out.content, tokens: tokens + out.tokens, trace }
  }

  // 2) Only the lead-selected saved specialists contribute. This keeps a normal customer
  // exchange fast and affordable while preserving a real peer review on substantive work.
  const plannedTasks = new Map<string, string>()
  for (const d of delegate) {
    const nm = String(d?.name ?? '').trim().toLowerCase()
    const sa = activeSubs.find((s: any) => String(s.name).trim().toLowerCase() === nm)
    if (sa) plannedTasks.set(String(sa.id), String(d?.task ?? '').trim().slice(0, 500))
  }
  const specialistSystem = (sa: any) => {
    const p = sa?.prompt ?? {}
    return `You are "${sa.name}", a ${sa.role}. ${p.role ?? ''} Tasks: ${p.tasks ?? ''}. Rules: ${p.rules ?? ''}` +
      roleSkillBlock(String(sa.role ?? ''), `${p.role ?? ''} ${p.tasks ?? ''}`) + specialistKnowledgeBlock + bizBlock + NO_FABRICATION + TEAM_SAFETY_GUARD
  }
  const assignments = activeSubs
    .filter((sa: any) => plannedTasks.has(String(sa.id)))
    .map((sa: any) => ({ sa, task: plannedTasks.get(String(sa.id)) as string }))
  if (!assignments.length) {
    const out = await callOpenRouter({
      apiKey, model: leadModel, fallbackModel: FALLBACK_MODEL,
      messages: [{ role: 'system', content: `${leadSystem}${TEAM_SAFETY_GUARD}` }, ...hist],
      temperature: temp, maxTokens: 700,
    })
    return { text: out.content, tokens: tokens + out.tokens, trace }
  }
  const executed = await Promise.all(assignments.map(async ({ sa, task }) => {
    try {
      const rr = await callOpenRouter({
        apiKey, model: gateModel(sa.model, premiumAllowed), fallbackModel: FALLBACK_MODEL, temperature: 0.35, maxTokens: 520,
        messages: [
          { role: 'system', content: `${specialistSystem(sa)}\n${LANG_HINT}` },
          { role: 'user', content: `Customer said: "${lastUser}"\n\nYour task from the team lead: ${task}\n\nGive a concrete, specific contribution the lead can use directly. No filler. Do not perform or claim external actions.` },
        ],
      })
      return { sa, task, output: String(rr.content ?? '').trim(), tokens: rr.tokens ?? 0 }
    } catch {
      return { sa, task, output: '', tokens: 0 }
    }
  }))
  tokens += executed.reduce((sum, item) => sum + item.tokens, 0)
  for (const item of executed) trace.push({
    kind: 'consult', agentId: item.sa.id ?? null, agentName: String(item.sa.name).slice(0, 120), task: item.task.slice(0, 200),
  })

  type PeerVerdict = { approved: boolean; score: number; issues: string[]; fix: string; requiresHuman: boolean; tokens: number }
  type Contribution = { sa: any; task: string; output: string; reviewer: any; verdict?: PeerVerdict; revised: boolean }
  const contributions: Contribution[] = executed.map((item, index) => ({
    sa: item.sa,
    task: item.task,
    output: item.output,
    reviewer: executed.length > 1 ? executed[(index + 1) % executed.length].sa : agent,
    revised: false,
  }))

  const reviewContribution = async (item: Contribution): Promise<PeerVerdict> => {
    if (!item.output) return { approved: false, score: 0, issues: ['The specialist produced no usable output.'], fix: 'Produce the requested contribution from the supplied facts.', requiresHuman: false, tokens: 0 }
    const reviewer = item.reviewer
    const rp = reviewer?.prompt ?? {}
    const reviewerSystem = reviewer === agent
      ? `${leadSystem}\nYou are performing a bounded quality review of one specialist contribution.`
      : `You are "${reviewer.name}", a ${reviewer.role}. ${rp.role ?? ''} Rules: ${rp.rules ?? ''}` +
        roleSkillBlock(String(reviewer.role ?? ''), `${rp.role ?? ''} ${rp.tasks ?? ''}`) + bizBlock + TEAM_SAFETY_GUARD
    try {
      const rr = await callOpenRouter({
        apiKey, model: PRIMARY_MODEL, fallbackModel: FALLBACK_MODEL, temperature: 0.1, maxTokens: 300,
        responseFormat: { type: 'json_object' },
        messages: [
          {
            role: 'system',
            content: `${reviewerSystem}\nPeer-review the work against the customer's request, the author's assigned task, factual grounding, and every human-approval/safety limit. ` +
              'Reject fabricated facts or claims that an external action happened. Never weaken a rule that reserves a consequential decision or action for an authorized human. ' +
              'Set requires_human:true when the requested result itself needs an authorized person, protected data, missing evidence, or a consequential regulated decision; ordinary writing defects should instead get a concrete fix. ' +
              'Return ONLY JSON: {"approved":boolean,"score":0-100,"issues":[string],"fix":string,"requires_human":boolean}. Approve only when it is ready and safe to use.',
          },
          { role: 'user', content: `CUSTOMER REQUEST:\n${String(lastUser).slice(0, 2500)}\n\nAUTHOR (${item.sa.role}) TASK:\n${item.task}\n\nWORK TO REVIEW:\n${item.output.slice(0, 5000)}` },
        ],
      })
      const parsed = extractJson(rr.content)
      if (!parsed) return { approved: false, score: 0, issues: ['Peer review did not return a valid verdict.'], fix: 'Re-check the contribution against the request and safety rules.', requiresHuman: false, tokens: rr.tokens ?? 0 }
      const score = Math.max(0, Math.min(100, Number(parsed.score) || 0))
      const issues = Array.isArray(parsed.issues) ? (parsed.issues as unknown[]).map(String).filter(Boolean).slice(0, 6) : []
      const requiresHuman = Boolean(parsed.requires_human)
      const approved = Boolean(parsed.approved) && score >= 70 && issues.length === 0 && !requiresHuman
      return { approved, score, issues, fix: String(parsed.fix ?? '').slice(0, 700), requiresHuman, tokens: rr.tokens ?? 0 }
    } catch {
      return { approved: false, score: 0, issues: ['Peer review could not be completed.'], fix: 'A human must verify this contribution.', requiresHuman: true, tokens: 0 }
    }
  }

  // 3) MUTUAL REVIEW. Every contribution is checked by the next saved specialist (round-robin).
  // Rejected ordinary quality issues get exactly one author revision and one re-check.
  const initialReviews = await Promise.all(contributions.map(reviewContribution))
  for (let i = 0; i < contributions.length; i++) {
    contributions[i].verdict = initialReviews[i]
    tokens += initialReviews[i].tokens
    trace.push({
      kind: 'peer_review', agentId: contributions[i].sa.id ?? null, agentName: String(contributions[i].sa.name).slice(0, 120),
      reviewerAgentId: contributions[i].reviewer?.id ?? null, reviewerAgentName: String(contributions[i].reviewer?.name ?? leadName).slice(0, 120),
      round: 'initial', approved: initialReviews[i].approved, score: initialReviews[i].score, issueCount: initialReviews[i].issues.length,
    })
  }

  const revisionCandidates = contributions.filter((item) => !item.verdict?.approved && !item.verdict?.requiresHuman).slice(0, MAX_SPECIALISTS)
  if (MAX_PEER_REVISIONS > 0 && revisionCandidates.length) {
    const revisions = await Promise.all(revisionCandidates.map(async (item) => {
      const verdict = item.verdict as PeerVerdict
      try {
        const rr = await callOpenRouter({
          apiKey, model: gateModel(item.sa.model, premiumAllowed), fallbackModel: FALLBACK_MODEL, temperature: 0.25, maxTokens: 520,
          messages: [
            { role: 'system', content: `${specialistSystem(item.sa)}\nRevise your own contribution once. Preserve every safety and human-approval limit. ${LANG_HINT}` },
            { role: 'user', content: `CUSTOMER REQUEST:\n${String(lastUser).slice(0, 2200)}\n\nYOUR ASSIGNED TASK:\n${item.task}\n\nYOUR PREVIOUS WORK:\n${item.output.slice(0, 4000)}\n\nPEER ISSUES:\n${verdict.issues.join('\n')}\n\nREQUIRED FIX:\n${verdict.fix}\n\nReturn the complete corrected contribution only.` },
          ],
        })
        return { item, output: String(rr.content ?? '').trim(), tokens: rr.tokens ?? 0 }
      } catch {
        return { item, output: '', tokens: 0 }
      }
    }))
    for (const revision of revisions) {
      tokens += revision.tokens
      if (!revision.output) continue
      revision.item.output = revision.output
      revision.item.revised = true
      trace.push({
        kind: 'revise', agentId: revision.item.sa.id ?? null, agentName: String(revision.item.sa.name).slice(0, 120),
        reviewerAgentId: revision.item.reviewer?.id ?? null, reviewerAgentName: String(revision.item.reviewer?.name ?? leadName).slice(0, 120), round: 1,
      })
    }

    const revisedItems = revisionCandidates.filter((item) => item.revised)
    const secondReviews = await Promise.all(revisedItems.map(reviewContribution))
    for (let i = 0; i < revisedItems.length; i++) {
      revisedItems[i].verdict = secondReviews[i]
      tokens += secondReviews[i].tokens
      trace.push({
        kind: 'peer_review', agentId: revisedItems[i].sa.id ?? null, agentName: String(revisedItems[i].sa.name).slice(0, 120),
        reviewerAgentId: revisedItems[i].reviewer?.id ?? null, reviewerAgentName: String(revisedItems[i].reviewer?.name ?? leadName).slice(0, 120),
        round: 'after_revision', approved: secondReviews[i].approved, score: secondReviews[i].score, issueCount: secondReviews[i].issues.length,
      })
    }
  }

  // Fail closed: if any teammate still cannot approve its peer after the single revision, do not
  // synthesize a polished-looking answer from rejected work. Hand the dialogue to a human.
  const rejected = contributions.filter((item) => !item.verdict?.approved)
  if (rejected.length) {
    const reasons = rejected.map((item) => {
      const reason = item.verdict?.requiresHuman
        ? (item.verdict?.issues[0] || 'Authorized human review is required.')
        : (item.verdict?.issues[0] || 'Peer review did not approve the contribution after one revision.')
      trace.push({ kind: 'human_review', agentId: item.sa.id ?? null, agentName: String(item.sa.name).slice(0, 120), reason: reason.slice(0, 200) })
      return `${item.sa.name}: ${reason}`
    })
    return { text: '', tokens, trace, humanReviewReason: reasons.join('; ').slice(0, 500) }
  }

  // 4) LEAD synthesizes one customer-facing reply from peer-approved contributions only.
  const synth = await callOpenRouter({
    apiKey, model: leadModel, fallbackModel: FALLBACK_MODEL, temperature: 0.5, maxTokens: 900,
    messages: [
      {
        role: 'system',
        content:
          `${leadSystem}\n\nYou are the team lead replying to a real customer on behalf of the business. ` +
          'Merge your peer-approved specialists\' input into ONE clear, warm, professional reply that directly answers the customer and moves the conversation forward. ' +
          'Be concrete and helpful; keep a natural human tone. Never mention internal steps, specialists, JSON, or that you are an AI team. ' +
          'Preserve every human-approval and safety limit; do not turn a draft, request, recommendation, or pending decision into a confirmed action. ' +
          `${LANG_HINT}${TEAM_SAFETY_GUARD}`,
      },
      { role: 'user', content: `Customer: "${lastUser}"\n\nPeer-approved specialist input (internal — do not quote):\n${contributions.map((c) => `[${c.sa.name}]: ${c.output}`).join('\n\n')}\n\nWrite the final reply to the customer.` },
    ],
  })
  tokens += synth.tokens
  trace.push({ kind: 'synthesize', agentId: agent.id ?? null, agentName: leadName })
  // Customer-facing: no internal "who contributed" trace — that reads as unprofessional.
  const body = synth.content || contributions.map((c) => c.output).join('\n\n')
  return { text: body.trim(), tokens, trace }
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
  premiumAllowed = false,
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
    apiKey, model: gateModel(sub.model, premiumAllowed), fallbackModel: FALLBACK_MODEL, temperature: 0.5, maxTokens: 700,
    messages: [{ role: 'system', content: `${persona}${consult}\n${LANG_HINT}` }, ...hist],
  })
  return { text: out.content, tokens: tokens + out.tokens }
}

/**
 * Why a reply is empty. Six different conditions used to produce the same silent "" and the same
 * "an operator will join shortly" message to the writer: a paused agent, off-hours, a rate limit,
 * an exhausted balance, a session cap and a genuine escalation. The owner could not tell them
 * apart, and neither could anyone reading the database. The caller fills this in and can say what
 * actually happened — to the OWNER only; customers still get the graceful handoff line.
 */
export interface ReplyDiagnostics {
  reason?: 'agent_paused' | 'outside_work_hours' | 'rate_limited' | 'no_tokens' | 'session_cap' | 'escalated' | 'error' | 'no_output'
  detail?: string
  ownerContext?: boolean
}

export async function buildReply(db: any, openrouterKey: string, agent: any, dialogueId: string, diag: ReplyDiagnostics = {}): Promise<string> {
  // Paused/blocked agents don't reply (admin block pauses all of an account's agents).
  if (agent.status && agent.status !== 'active') { diag.reason = 'agent_paused'; return '' }

  // Honor custom work hours — 24/7 always replies; 'work-hours' only inside the window.
  if (agent.schedule === 'work-hours' && !withinWorkHours(agent.timezone, agent.work_start, agent.work_end)) { diag.reason = 'outside_work_hours'; return '' }

  // Cost guard — per-customer rate limit (a dialogue maps 1:1 to an external_id).
  const since = new Date(Date.now() - 60_000).toISOString()
  const { count: recent } = await db
    .from('messages')
    .select('*', { count: 'exact', head: true })
    .eq('dialogue_id', dialogueId)
    .eq('author', 'customer')
    .gte('created_at', since)
  if ((recent ?? 0) > RATE_LIMIT_PER_MIN) { diag.reason = 'rate_limited'; return '' }

  // Cost guard — stop when the account has no AI tokens left.
  const { data: acc } = await db.from('accounts').select('token_balance, plan').eq('id', agent.account_id).single()
  if (acc && Number(acc.token_balance) <= 0) { diag.reason = 'no_tokens'; return '' }

  // Per-session cost guard — cap cumulative tokens for THIS dialogue; on exceed, hand off to a
  // human instead of billing a runaway/troll thread forever. Uses usage.dialogue_id.
  const { data: sessUsage } = await db.from('usage').select('tokens').eq('dialogue_id', dialogueId).limit(1000)
  const sessionTokens = (sessUsage ?? []).reduce((s: number, u: any) => s + (Number(u.tokens) || 0), 0)
  if (sessionTokens > SESSION_TOKEN_CAP) {
    await db.from('dialogues').update({ status: 'needs_operator' }).eq('id', dialogueId)
    diag.reason = 'session_cap'
    return ''
  }

  // Load the MOST RECENT 20 messages (order desc + reverse to chronological). Fetching
  // ascending+limit(20) returned the OLDEST 20, so a long dialogue permanently lost its recent
  // context. Now the agent always sees the latest turns.
  const { data: historyRaw } = await db
    .from('messages')
    .select('author, content, created_at')
    .eq('dialogue_id', dialogueId)
    .eq('message_type', 'chat') // strict allowlist — system_trace/internal rows never enter LLM context
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
  const memory = (isLearning || personal) ? await loadMemory(db, agent.account_id, agent.id, dialogueId) : ''

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
      // canonical row = newest by (created_at, id) — same deterministic order as merge_lead_fields
      const { data: lr } = await db.from('leads').select('id, fields').eq('dialogue_id', dialogueId).order('created_at', { ascending: false }).order('id', { ascending: false }).limit(1).maybeSingle()
      if (lr) { leadRowId = lr.id; knownLead = (lr.fields ?? {}) as Record<string, unknown> }
    }
    const promptOpts = { today, leadFields, knownLead }

    // Server-side premium-model gate — the account's plan decides if a frontier model is allowed.
    const premiumAllowed = planOf(acc?.plan).premium
    const model = gateModel(agent.model, premiumAllowed)

    let replyText = ''
    let tokensUsed = 0
    let modelTag: string = model
    // The stage is a separate fact from the model. Overwriting the model id with 'tool' or
    // 'team' both erased the model mix AND made estimateCostUsd fall through to its cheap
    // default, so a run on 4o was recorded at a mini-class price.
    let stageTag: string | null = null
    let traceSteps: TraceStep[] = []
    let replyAgentId: string | null = agent.id ?? null

    // TOOL-USE (ALL agent types, incl. teams): if the account has connected tools and the
    // message asks to DO an action (create Google Sheet/Doc, send email, calendar, CRM),
    // execute it for real and reply with the REAL result — instead of hallucinating a link.
    // pass the Telegram chat context so task tools can create remindable DB tasks in this chat
    const { data: dia } = await db.from('dialogues').select('channel_id, external_id, channel').eq('id', dialogueId).maybeSingle()
    const tgCtx = { dialogueId, ...(dia?.channel === 'telegram' && dia?.external_id ? { channelId: dia.channel_id as string, chatId: String(dia.external_id) } : {}) }
    // OWNER CONTEXT. The same bot serves the owner and unknown customers on the same channel, so
    // the runtime assumed "customer" for everyone and denied the read-only store tools — the owner
    // asking their own bot about their own shop got an operator handoff instead of the numbers.
    // The chat id comes from Telegram's update envelope, not from message text, so nothing the
    // writer types can forge it.
    let ownerContext = false
    if (tgCtx.chatId) {
      const { data: ownerProfile } = await db.from('business_profiles').select('notify_chat_id').eq('account_id', agent.account_id).maybeSingle()
      const ownerChat = String(ownerProfile?.notify_chat_id ?? '').trim()
      ownerContext = ownerChat.length > 0 && ownerChat === tgCtx.chatId
      diag.ownerContext = ownerContext
    }
    const toolRun = lastCustomer ? await runAgentTools(db, apiKey, agent.account_id, String(lastCustomer), history ?? [], agent.type, tgCtx, Array.isArray(agent.skills) ? agent.skills : [], ownerContext) : null
    if (toolRun?.ran) {
      replyText = String(toolRun.result ?? 'Готово.')
      tokensUsed = toolRun.tokens
      stageTag = 'tool'
    } else if (agent.type === 'workflow') {
      // TEAM: the lead runs the whole department on this message (with known lead state injected)
      const team = await buildTeamReply(db, apiKey, agent, history ?? [], knowledge, bizBlock, knownLead, premiumAllowed)
      replyText = team.text
      tokensUsed = team.tokens
      stageTag = 'team'
      traceSteps = team.trace
      // A peer-review failure is a real human handoff, not a hidden warning followed by an
      // unapproved answer. Persist the trace even though no agent reply is emitted; the channel
      // caller will send its existing graceful operator-handoff message.
      if (team.humanReviewReason) {
        await db.from('dialogues').update({ status: 'needs_operator' }).eq('id', dialogueId)
        await notifyEscalation(db, agent, String(lastCustomer), team.humanReviewReason)
        if (traceSteps.length) {
          const { error: traceErr } = await db.from('messages').insert({
            dialogue_id: dialogueId,
            author: 'agent',
            agent_id: agent.id ?? null,
            message_type: 'system_trace',
            content: JSON.stringify({ version: 2, replyMessageId: null, escalated: true, steps: traceSteps }),
          })
          if (traceErr) console.error('escalation trace insert failed:', traceErr)
        }
        await db.from('usage').insert({ account_id: agent.account_id, tokens: tokensUsed, model: modelTag, stage: stageTag, dialogue_id: dialogueId, cost: estimateCostUsd(modelTag, tokensUsed) })
        if (tokensUsed) await db.rpc('decrement_token_balance', { p_account: agent.account_id, p_amount: tokensUsed })
        return ''
      }
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
          if (target) traceSteps = [{ kind: 'route', fromAgentId: agent.id ?? null, fromAgentName: String(agent.name ?? '').slice(0, 120), agentId: target.id, agentName: String(target.name).slice(0, 120), confidence: cls.confidence }]
        }
        try { await db.from('routing_decisions').insert({ account_id: agent.account_id, dialogue_id: dialogueId, from_agent: agent.id, to_agent: target?.id ?? null, chosen: cls.route, confidence: cls.confidence, resolved: Boolean(target) }) } catch { /* observability best-effort */ }
      }

      if (target) {
        // the chosen teammate (its persona + its knowledge) answers; the dialogue is reassigned
        await db.from('dialogues').update({ agent_id: target.id }).eq('id', dialogueId)
        replyAgentId = target.id
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
          diag.reason = 'escalated'
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
      // agent_id records exactly which agent spoke (team lead / routed teammate / self)
      const { data: replyRow, error: replyErr } = await db
        .from('messages')
        .insert({ dialogue_id: dialogueId, author: 'agent', agent_id: replyAgentId, content: replyText })
        .select('id')
        .single()
      if (replyErr) console.error('reply insert failed:', replyErr)
      // Trace is best-effort observability: written only after a successful reply insert, and a
      // trace failure must never turn a valid reply into '' (callers would tell the customer an
      // operator is needed). supabase-js reports failures via `error`, not by throwing.
      if (!replyErr && traceSteps.length) {
        const { error: traceErr } = await db.from('messages').insert({
          dialogue_id: dialogueId,
          author: 'agent',
          agent_id: agent.id ?? null,
          message_type: 'system_trace',
          content: JSON.stringify({ version: 2, replyMessageId: replyRow?.id ?? null, steps: traceSteps }),
        })
        if (traceErr) console.error('trace insert failed:', traceErr)
      }
      await db.from('usage').insert({ account_id: agent.account_id, tokens: tokensUsed, model: modelTag, stage: stageTag, dialogue_id: dialogueId, cost: estimateCostUsd(modelTag, tokensUsed) })
      if (tokensUsed) await db.rpc('decrement_token_balance', { p_account: agent.account_id, p_amount: tokensUsed })
      if (isLearning || personal) {
        const lastCustomer = [...(history ?? [])].reverse().find((m: any) => m.author === 'customer')
        if (lastCustomer?.content) await saveMemory(db, agent.account_id, agent.id, dialogueId, lastCustomer.content)
      }
    }
    return replyText
  } catch (e) {
    // A thrown error looked exactly like a deliberate handoff to everyone downstream.
    console.error('buildReply error:', e)
    diag.reason = 'error'
    diag.detail = String((e as Error)?.message ?? e).slice(0, 200)
    return ''
  }
}
/* eslint-enable @typescript-eslint/no-explicit-any */
