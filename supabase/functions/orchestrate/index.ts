// Multi-agent orchestrator (the "manager"). Split into SHORT actions the panel
// chains, so no single call hits the Edge Function time limit AND the user sees
// each sub-agent finish live:
//   action 'scout' { competitor_url, own_url?, platform?, goal? } -> { intel, signals }  (channel recon)
//   action 'plan'  { goal }                          -> { plan, steps:[{role,task}] }
//   action 'staff' { goal, use_skills? }             -> { subagents:[{role,name,skills,prompt}] }
//   action 'step'  { goal, role, task, context, skills? } -> { output, sources }   (one sub-agent)
//   action 'review'{ goal, work, author_role }       -> { approved, score, issues, fix }  (peer QA)
//   action 'synth' { goal, department_id?, steps:[{role,task,output,review?}], sources }
//                  -> { id, result, status }  (+ saves a durable team run)
// Authenticated; each action is token-guarded + usage-accounted.
//
//   POST /functions/v1/orchestrate   (Authorization: Bearer <user jwt>)
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { callOpenRouter, estimateCostUsd, PRIMARY_MODEL, FALLBACK_MODEL, type ChatMsg } from '../_shared/llm.ts'
import { resolveOpenRouterKey } from '../_shared/keys.ts'
import { planOf, monthlyTokens } from '../_shared/plans.ts'
import { modelDef } from '../_shared/models.ts'
import { corsPreflight, json } from '../_shared/cors.ts'
import { MARKETING_SKILLS, skillCatalog, skillBlock } from '../_shared/marketingSkills.ts'
import { CAPABILITY_SKILLS, selectedSkillBlock } from '../_shared/capabilitySkills.ts'
import { safeFetch } from '../_shared/net.ts'
import { marketplaceEvidenceBlock } from '../_shared/marketplaceData.ts'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const OPENROUTER_API_KEY = Deno.env.get('OPENROUTER_API_KEY') ?? ''

// Reliable primary model (paid, cheap) with free fallback so a multi-step team
// run doesn't 502 mid-way on free-tier rate limits.
// The MANAGER (plan/staff) and the final SYNTH need strong instruction-following
// so the team actually delivers the EXACT thing asked. That premium model is the
// main cost driver, so it's gated by PLAN (see resolveModels): paid tiers + admins
// get gpt-4o; the free tier stays on the cheap primary model. Steps default cheap.
const PREMIUM_MODEL = Deno.env.get('MANAGER_MODEL') ?? 'openai/gpt-4o'
const MAX_STEPS = 4
const MAX_SYNTH_STEPS = 5
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const MAX_INPUT_ARTIFACTS = 4
const MAX_ARTIFACT_CHARS = 24_000
const MAX_ARTIFACT_CONTEXT_CHARS = 60_000

interface InputArtifact {
  name: string
  content: string
}

const CAPABILITY_SKILL_IDS = new Set(CAPABILITY_SKILLS.map((skill) => skill.id))
const ORCHESTRATION_SKILL_IDS = new Set([...Object.keys(MARKETING_SKILLS), ...CAPABILITY_SKILL_IDS])

function orchestrationSkillCatalog(): string {
  const capabilityCatalog = CAPABILITY_SKILLS
    .map((skill) => `- ${skill.id} — ${skill.instruction}`)
    .join('\n')
  return [capabilityCatalog, skillCatalog()].filter(Boolean).join('\n')
}

function orchestrationSkillBlock(ids: string[]): string {
  return [selectedSkillBlock(ids), skillBlock(ids)].filter(Boolean).join('\n\n')
}

function inputArtifacts(value: unknown): InputArtifact[] {
  if (!Array.isArray(value)) return []
  let remaining = MAX_ARTIFACT_CONTEXT_CHARS
  const result: InputArtifact[] = []
  for (const item of value.slice(0, MAX_INPUT_ARTIFACTS)) {
    if (!item || typeof item !== 'object' || remaining <= 0) continue
    const row = item as Record<string, unknown>
    const name = String(row.name ?? 'data').replace(/[\r\n\t]/g, ' ').trim().slice(0, 120) || 'data'
    const raw = String(row.content ?? '').split('\u0000').join('').trim()
    if (!raw) continue
    const content = raw.slice(0, Math.min(MAX_ARTIFACT_CHARS, remaining))
    remaining -= content.length
    result.push({ name, content })
  }
  return result
}

function artifactContext(artifacts: InputArtifact[], maxChars = MAX_ARTIFACT_CONTEXT_CHARS): string {
  if (!artifacts.length) return ''
  return artifacts
    .map((artifact) => `=== INPUT FILE: ${artifact.name} ===\n${artifact.content}`)
    .join('\n\n')
    .slice(0, maxChars)
}

function marketplaceEvidence(goal: string, artifacts: InputArtifact[]): string {
  return marketplaceEvidenceBlock([goal, ...artifacts.map((artifact) => artifact.content)].join('\n'))
}

function deterministicSkills(goal: string): string[] {
  if (/(uzum|marketplace|маркетплейс|sku|артикул|товар|остатк|закуп|assortment|inventory)/i.test(goal)) {
    return ['marketplace-growth-manager', 'catalog-inventory-analysis', 'data-analysis']
  }
  if (/(csv|xlsx|spreadsheet|таблиц|выгрузк|dataset|данн.*анализ)/i.test(goal)) return ['data-analysis']
  return []
}

// plan (+ admin) -> which models this account gets. Premium tiers (planOf().premium)
// get gpt-4o for the manager AND the sub-agent steps; free/starter stay on the cheap model.
function resolveModels(plan: string, isAdmin: boolean): { manager: string; work: string } {
  const premium = planOf(plan).premium || isAdmin
  return {
    manager: premium ? PREMIUM_MODEL : PRIMARY_MODEL, // plan/staff/synth
    work: premium ? PREMIUM_MODEL : PRIMARY_MODEL,     // sub-agent steps
  }
}

const ROLES = ['researcher', 'analyst', 'writer', 'reviewer'] as const
type Role = (typeof ROLES)[number]
const LANG_NAME: Record<string, string> = { uz: 'Uzbek', ru: 'Russian', en: 'English' }
const roleSystem: Record<Role, string> = {
  researcher:
    'You are a senior research specialist at a top consulting firm. Gather concrete, current facts for the task: real numbers, dates, named examples and sources. ' +
    'No filler, no hedging, no "as an AI". Present findings as crisp, specific bullets a decision-maker can act on immediately.',
  analyst:
    'You are a senior business analyst. From the provided context produce sharp, structured analysis: clear conclusions, comparisons, trade-offs, and ONE concrete recommendation. ' +
    'Always be specific — use real numbers, steps and examples. Never give generic advice that could apply to any business.',
  writer:
    'You are a senior deliverable writer. Produce the requested output in clean, professional Markdown that a business could use as-is: concrete, specific and complete. ' +
    'No meta-commentary, no apologies, no "as an AI", no restating the task — just the finished deliverable.',
  reviewer:
    'You are a critical senior reviewer. Upgrade the prior outputs: fill gaps, cut fluff and repetition, make every point specific and actionable, fix inaccuracies, and enforce a professional business tone.',
}

// A role is a working lens, not a hard capability wall. The user may ask any saved
// agent to do a task outside its original specialty; the agent should follow the goal,
// use the tools actually supplied by the caller, and explain a missing integration instead
// of refusing with "that is not my role".
const UNIVERSAL_CONTRACT =
  '\n\nUNIVERSAL AGENT CONTRACT: The user\'s requested outcome outranks your specialty label. Execute any legitimate task you can complete with the context and available tools, even when it crosses domains. Do not refuse merely because you are a researcher, writer, analyst, reviewer, or coordinator. If a required integration or permission is missing, state exactly what is missing and provide the best useful partial result. Never claim a tool action happened unless it actually did.\n'

// gpt-4o reasons far more reliably in English; a non-English goal (Cyrillic/Uzbek)
// makes the manager misread the request and drift to the generic domain. So for the
// PLANNING steps we hand it a precise English translation to reason on, while the
// actual output language stays controlled by langRule. Output language is unaffected.
async function englishBrief(orKey: string, goal: string): Promise<string> {
  // already ASCII/English -> no translation needed (avoid a control-char regex)
  const hasNonAscii = (s: string): boolean => { for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) > 127) return true; return false }
  if (!goal || !hasNonAscii(goal)) return ''
  try {
    const r = await callOpenRouter({
      apiKey: orKey, model: PRIMARY_MODEL, fallbackModel: FALLBACK_MODEL, temperature: 0, maxTokens: 400,
      messages: [
        { role: 'system', content: 'Translate the user text into precise English, preserving every specific detail, number, name and requested deliverable. Output ONLY the English translation, nothing else.' },
        { role: 'user', content: goal },
      ],
    })
    return (r.content ?? '').trim()
  } catch {
    return ''
  }
}

function extractJson(text: string): Record<string, unknown> | null {
  let t = (text ?? '').trim()
  // cheap models often wrap JSON in a ```json ... ``` fence — unwrap it first
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fence) t = fence[1].trim()
  const s = t.indexOf('{')
  const e = t.lastIndexOf('}')
  if (s === -1 || e === -1 || e < s) return null
  try {
    return JSON.parse(t.slice(s, e + 1))
  } catch {
    return null
  }
}

// Public signals from a channel/profile URL for the 'scout' action: OG description,
// page title and (for YouTube) caption tracks. SSRF-guarded via safeFetch; best-effort —
// a page we cannot read yields empty signals, never an exception.
async function pageSignals(url: string): Promise<{ url: string; title: string; caption: string; transcript: string; ok: boolean }> {
  try {
    const { body: html } = await safeFetch(
      url,
      { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; NemoBot/1.0)' } },
      { maxBytes: 600_000, timeoutMs: 12_000 },
    )
    const og = (p: string): string => {
      const m = html.match(new RegExp(`<meta[^>]+(?:property|name)=["']og:${p}["'][^>]+content=["']([^"']+)["']`, 'i'))
      return m ? m[1] : ''
    }
    const title = (og('title') || (html.match(/<title>([^<]+)<\/title>/i)?.[1] ?? '')).slice(0, 300)
    const caption = (og('description') || (html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i)?.[1] ?? '')).slice(0, 2000)
    let transcript = ''
    const ct = html.match(/"captionTracks":(\[.*?\])/)
    if (ct) {
      try {
        const tracks = JSON.parse(ct[1].replace(/\\u0026/g, '&'))
        const base = tracks?.[0]?.baseUrl
        if (base) {
          const { body: xml } = await safeFetch(base, {}, { maxBytes: 300_000, timeoutMs: 10_000 })
          transcript = xml.replace(/<[^>]+>/g, ' ').replace(/&#39;/g, "'").replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/\s+/g, ' ').trim().slice(0, 6000)
        }
      } catch { /* captions are a bonus, not a requirement */ }
    }
    return { url, title, caption, transcript, ok: Boolean(title || caption || transcript) }
  } catch {
    return { url, title: '', caption: '', transcript: '', ok: false }
  }
}

// The account's BUSINESS PROFILE ("trained on your business"), formatted as a directive
// block that is appended to every system prompt so the team grounds its work in the
// real business instead of generic advice. Returns '' when the account hasn't filled it.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function loadBusinessContext(admin: any, accountId: string): Promise<string> {
  const { data } = await admin.from('business_profiles').select('*').eq('account_id', accountId).maybeSingle()
  if (!data) return ''
  const rows: [string, unknown][] = [
    ['Компания', data.name], ['Сфера', data.industry], ['О компании', data.about],
    ['Аудитория', data.audience], ['Продукты/услуги', data.offerings], ['Тон общения', data.tone],
    ['Города/регионы', data.cities], ['Ссылки', data.links], ['Доп. факты и правила', data.extra],
  ]
  const filled = rows.filter(([, v]) => v && String(v).trim())
  if (!filled.length) return ''
  return '\n\n=== О БИЗНЕСЕ КЛИЕНТА (реальные факты о компании — используй их, не выдумывай; подстраивай выводы и примеры под ЭТОТ бизнес) ===\n' +
    filled.map(([k, v]) => `${k}: ${String(v).trim()}`).join('\n') +
    '\n=== конец профиля бизнеса ==='
}

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

  const { data: prof } = await userDb.from('users').select('account_id, is_admin').maybeSingle()
  const accountId = prof?.account_id
  if (!accountId) return json({ error: 'no account' }, 403)
  const admin = createClient(SUPABASE_URL, SERVICE_ROLE)
  const { data: acc } = await admin.from('accounts').select('token_balance, blocked, plan').eq('id', accountId).single()
  if (acc?.blocked) return json({ error: 'blocked' }, 403)
  if (acc && Number(acc.token_balance) <= 0) return json({ error: 'no_tokens' }, 402)
  // monthly subscription quota (B2B limits) — admins are exempt
  const plan = planOf(acc?.plan)
  if (!prof?.is_admin) {
    const usedThisMonth = await monthlyTokens(admin, accountId)
    if (usedThisMonth >= plan.tokens) {
      return json({ ok: false, code: 'QUOTA_EXCEEDED', plan: acc?.plan ?? 'free', used: usedThisMonth, quota: plan.tokens, message: `Достигнут месячный лимит тарифа «${plan.label}». Обновите тариф, чтобы продолжить.` }, 402)
    }
  }
  const body = await req.json().catch(() => ({}))
  // plan-based model tiering (cost control at scale)
  const tier = resolveModels(String(acc?.plan ?? 'free'), Boolean(prof?.is_admin))
  // USER-CHOSEN model (honest, real): apply it when allowed — premium models need a
  // premium plan OR the account's own OpenRouter key (BYO = their cost, their choice).
  let chosenModel = ''
  const requested = String(body?.model ?? '').trim()
  if (requested) {
    const def = modelDef(requested)
    if (def) {
      const { data: byo } = await admin.from('provider_keys').select('provider').eq('account_id', accountId).eq('provider', 'openrouter').maybeSingle()
      const hasByo = Boolean(byo)
      if (hasByo || !def.premium || plan.premium || prof?.is_admin) chosenModel = def.id
    }
  }
  const managerModel = chosenModel || tier.manager
  const workModel = chosenModel || tier.work

  // One team run fans out over many HTTP actions, so the client stamps them all with the same
  // run_ref — without it a run's real token and dollar cost cannot be reconstructed afterwards.
  const requestedRunRef = String(body?.run_ref ?? '').trim()
  const runRef = UUID_RE.test(requestedRunRef) ? requestedRunRef : null

  // Record the REAL model that ran (honest transparency — no fake labels), its cost, and the
  // pipeline stage in its own column so a stage tag can never be mistaken for a model.
  const account = async (tokens: number, model: string = managerModel, stage: string | null = null) => {
    if (!tokens) return
    await admin.from('usage').insert({
      account_id: accountId,
      tokens,
      model,
      stage,
      run_ref: runRef,
      cost: estimateCostUsd(model, tokens),
    })
    await admin.rpc('decrement_token_balance', { p_account: accountId, p_amount: tokens })
  }
  // account's own OpenRouter key if set, else Nemo's shared key
  const orKey = await resolveOpenRouterKey(admin, accountId, OPENROUTER_API_KEY)
  if (!orKey) return json({ ok: false, code: 'MISSING_PROVIDER_SECRET', message: 'OpenRouter key is not configured on the server.' }, 503)

  const action = String(body?.action ?? '')

  // the account's business profile — grounds every action in the real business
  const bizBlock = await loadBusinessContext(admin, accountId)

  try {
    // 'scout' — CHANNEL RECON for the competitor factory: pull public signals from the
    // client's own channel and a competitor's channel, then an intelligence analyst
    // (armed with the competitor-profiling skill) turns them into structured intel the
    // Team Architect can staff against. Facts over opinions: works only with what the
    // pages actually expose and labels inferences as such.
    if (action === 'scout') {
      const compUrl = String(body?.competitor_url ?? '').trim().slice(0, 500)
      const ownUrl = String(body?.own_url ?? '').trim().slice(0, 500)
      const platform = String(body?.platform ?? '').trim().slice(0, 40)
      const focus = String(body?.goal ?? '').trim().slice(0, 600)
      const lang = String(body?.lang ?? '').trim()
      if (!compUrl) return json({ error: 'competitor_url required' }, 400)
      const comp = await pageSignals(compUrl)
      const own = ownUrl ? await pageSignals(ownUrl) : null

      const sig = (label: string, s: { url: string; title: string; caption: string; transcript: string; ok: boolean }): string =>
        `${label}:\nURL: ${s.url}\n` +
        (s.title ? `Title: ${s.title}\n` : '') +
        (s.caption ? `Description/bio: ${s.caption}\n` : '') +
        (s.transcript ? `Latest video captions:\n"""\n${s.transcript}\n"""\n` : '') +
        (!s.ok ? '(page exposed no readable signals — analyze from the URL, handle and niche knowledge, and SAY SO)\n' : '')
      const material =
        (platform ? `Platform: ${platform}\n\n` : '') +
        sig('COMPETITOR CHANNEL', comp) +
        (own ? `\n${sig("CLIENT'S OWN CHANNEL", own)}` : "\n(client's own channel not provided)\n") +
        (focus ? `\nClient's focus/goal: ${focus}` : '')

      const langRule = lang && LANG_NAME[lang] ? `Write the entire report in ${LANG_NAME[lang]}.` : 'Write in the language of the client.'
      const msgs: ChatMsg[] = [
        {
          role: 'system',
          content:
            'You are a competitive intelligence analyst on a content-marketing team. From the channel signals provided, produce a sharp COMPETITOR INTEL report with EXACTLY these sections (Markdown, ## headers):\n' +
            '1. Профиль конкурента — positioning, audience, content pillars, hooks, tone, CTA, cadence signals.\n' +
            '2. Что у него работает и почему — concrete patterns worth learning from (tie each to evidence).\n' +
            '3. Наш канал против конкурента — gaps and overlaps (only if own-channel signals are present; otherwise state they were not provided).\n' +
            '4. Где мы можем выиграть — content angles, formats and topics the competitor misses.\n' +
            '5. Бриф для команды — one tight paragraph: what a content team must produce to beat this competitor.\n' +
            'Every claim must trace to the provided signals; label guesses as "гипотеза". If signals are thin, say so honestly and reason from the niche instead of fabricating specifics. ' +
            langRule + skillBlock(['competitor-profiling', 'content-strategy']) + bizBlock,
        },
        { role: 'user', content: material },
      ]
      const r = await callOpenRouter({ apiKey: orKey, model: workModel, messages: msgs, temperature: 0.3, maxTokens: 1600, fallbackModel: FALLBACK_MODEL })
      await account(r.tokens, workModel)
      return json({
        ok: true,
        intel: r.content,
        signals: {
          competitor: { url: comp.url, title: comp.title, hasBio: Boolean(comp.caption), hasTranscript: Boolean(comp.transcript), ok: comp.ok },
          own: own ? { url: own.url, title: own.title, hasBio: Boolean(own.caption), hasTranscript: Boolean(own.transcript), ok: own.ok } : null,
        },
      })
    }

    if (action === 'plan') {
      const goal = String(body?.goal ?? '').trim()
      if (goal.length < 4) return json({ error: 'goal too short' }, 400)
      // optional agent context — the manager assembles a team tailored to the sphere
      const niche = String(body?.niche ?? '').trim()
      const purpose = String(body?.purpose ?? '').trim()
      const lang = String(body?.lang ?? '').trim()
      const ctx = [niche ? `Domain / niche: ${niche}.` : '', purpose ? `Agent purpose: ${purpose}.` : '']
        .filter(Boolean)
        .join(' ')
      const langRule = lang && LANG_NAME[lang]
        ? `Write the plan and tasks in ${LANG_NAME[lang]}.`
        : 'Write tasks in the SAME language as the goal.'
      const enBrief = await englishBrief(orKey, goal)
      const msgs: ChatMsg[] = [
        {
          role: 'system',
          content:
            'You are a department manager coordinating a team of AI sub-agents. Available roles: researcher, analyst, writer, reviewer. ' +
            'If the goal is not in English, first understand it precisely by translating it in your head — the request is about the OUTCOME it states, never the generic domain it mentions. ' +
            'ABSOLUTE RULE: never reinterpret, replace, narrow or invent a new goal. Decompose the user\'s LITERAL request. ' +
            'Example of the mistake to avoid: if the goal is "win back 10 students who stopped paying, with a message to each", do NOT turn it into "make 10 test questions" or "write study tips" — every step must serve winning those students back and producing the messages. ' +
            'First restate (in the plan field) the exact deliverables the user asked for, then choose 2-4 steps whose combined output IS those deliverables (a step may write the actual message drafts, another the action plan, etc.). ' +
            'The domain/niche is only background — the GOAL decides the work, not the domain. Respond ONLY as JSON: ' +
            '{"plan": string, "steps": [{"role": "researcher"|"analyst"|"writer"|"reviewer", "task": string}]}. ' +
            'Use a researcher only if current external facts are truly needed. ' + langRule + bizBlock,
        },
        { role: 'user', content: `${ctx ? `${ctx}\n\n` : ''}Goal: ${goal}${enBrief ? `\n\nGoal in English (for precise understanding — the request is about this outcome, not the domain):\n${enBrief}` : ''}` },
      ]
      const r = await callOpenRouter({ apiKey: orKey, model: managerModel, messages: msgs, temperature: 0.3, fallbackModel: PRIMARY_MODEL })
      await account(r.tokens)
      const parsed = extractJson(r.content)
      let steps = Array.isArray(parsed?.steps) ? (parsed!.steps as { role: string; task: string }[]) : []
      steps = steps
        .filter((s) => s && typeof s.task === 'string')
        .map((s) => ({ role: (ROLES as readonly string[]).includes(s.role) ? s.role : 'analyst', task: s.task }))
        .slice(0, MAX_STEPS)
      if (!steps.length) steps = [{ role: 'researcher', task: goal }, { role: 'writer', task: goal }]
      return json({ ok: true, plan: typeof parsed?.plan === 'string' ? parsed.plan : '', steps })
    }

    // 'staff' — design a persistent team of specialist sub-agents for a sphere.
    if (action === 'staff') {
      const goal = String(body?.goal ?? '').trim()
      const artifacts = inputArtifacts(body?.input_artifacts)
      const niche = String(body?.niche ?? '').trim()
      const purpose = String(body?.purpose ?? '').trim()
      const lang = String(body?.lang ?? '').trim()
      const ctx = [niche ? `Domain / niche: ${niche}.` : '', purpose ? `Purpose: ${purpose}.` : '', goal ? `Goal / context: ${goal}.` : '']
        .filter(Boolean)
        .join(' ')
      const langRule = lang && LANG_NAME[lang] ? `Write every field in ${LANG_NAME[lang]}.` : 'Write every field in the language of the domain.'
      // opt-in marketing skill assignment (competitor factory & co): the architect
      // equips each specialist with 1-3 method briefs from Nemo's skill library, and
      // 'step' later injects those briefs into the specialist's system prompt.
      const useSkills = Boolean(body?.use_skills)
      const marketplaceNoExecutorRule = deterministicSkills(goal).includes('marketplace-growth-manager')
        ? `
MARKETPLACE EXECUTION BOUNDARY:
- Nemo does not have a verified production Uzum executor in this workflow. Never claim that a specialist will publish cards, change prices or stock, configure ads, place orders, or report achieved sales results.
- If the user supplied no marketplace export, build a useful growth diagnostic: a prioritized 7-day experiment plan, product-card and offer improvements that can be drafted from verified facts, the exact minimum data checklist, and measurable acceptance criteria. Label every platform-side change as a draft or human-approved action.
- If source data is supplied, analyze it and produce evidence-based recommendations, but keep every marketplace mutation behind explicit human approval and a separately verified executor.
${artifacts.length === 0
  ? '- NO SOURCE DATA IS ATTACHED. No specialist may claim to analyze current sales, stock, reviews, ads, SKU performance or achieved results. Assign one specialist to produce the exact export/data request and a fillable diagnostic framework; all numeric conclusions remain pending that input.'
  : '- Source data is attached. Every factual conclusion must trace to supplied rows; name missing fields instead of estimating them.'}
`
        : ''
      const skillsRule = useSkills
        ? '\nMARKETING SKILLS — Nemo has a library of proven marketing methods. Give EACH specialist a "skills" array with 1-3 skill ids from this catalog, matched to that specialist\'s function ([] if none fits). Use ONLY ids from the catalog:\n' +
          orchestrationSkillCatalog() +
          '\nAdd the "skills" field next to "role"/"name" in each subagent object.\n'
        : ''
      const enBrief = await englishBrief(orKey, goal)
      const staffSystem =
`You are Nemo's Team Architect. Nemo is a B2B platform that turns one user GOAL into a running team of AI specialist sub-agents. Given a GOAL, design a small pipeline of 2-4 specialists whose COMBINED, sequential work directly accomplishes that GOAL and produces EXACTLY the deliverables it names.

ABSOLUTE RULE — GOAL FIDELITY (highest priority, overrides everything below):
- Never reinterpret, broaden, narrow, or replace the GOAL, and never swap the requested deliverable for an easier or "better" adjacent one. If the GOAL is not in English, first understand it precisely in its own language, then design to its literal intent.
- The team's combined output must BE the deliverables the GOAL asks for — the exact artifacts, formats, quantities, fields, channels, audience, and scope stated (e.g. "a 30-row sheet of leads with columns X,Y,Z", "a 5-email sequence", "a filled contract from this template") — never generic domain content "about" the topic. If the GOAL names a count, format, field list, or constraint, honor it literally in the specialists' tasks and treat it as a hard acceptance requirement. Every specialist must be traceable to a part of the GOAL or a step required to reach it.

TEAM STRUCTURE — ROLE SEPARATION IS THE BACKBONE (no parallel generalists). Build one linear chain of distinct, non-overlapping roles; concentrate reasoning at the two ends:
1. MANAGER / LEAD PLANNER (always first): the team manager who owns the outcome. Decomposes the GOAL into an explicit plan, the exact deliverable specification, and the acceptance criteria (the checklist the final output must pass), assigns each downstream specialist its slice, and is accountable for the final delivery. Front-load the hardest thinking here — "what exactly must exist at the end," in what format and scope. Give this role a clear manager/lead title.
2. EXECUTOR(S) (one or two): do the concrete production work — research, drafting, data assembly, building, computing, outreach — filling in the substance per the plan. Split executors only when the GOAL has genuinely separable work streams; keep their outputs non-overlapping. Scale their number to the GOAL's complexity.
3. REVIEWER / QA (always last, MANDATORY): verifies the finished deliverable line-by-line against the exact GOAL and the planner's acceptance criteria (format, counts, fields, scope) BEFORE delivery, returns it with specific fixes if anything is missing or off-goal, and only then approves. A team without a dedicated reviewer is invalid. Minimum team = Planner + Executor + Reviewer.

TYPED HANDOFFS — multi-agent systems fail at the seams, so make every seam explicit. In each specialist's "tasks", state the contract in this order:
- RECEIVES: the named input artifact from the previous specialist (specialist #1 receives the GOAL itself).
- DOES: the concrete steps it performs on that input.
- HANDS OFF: the single named output artifact it passes to the next specialist (the last hands off the verified final deliverable for delivery).
Name artifacts specifically (e.g. "deliverable spec + acceptance checklist", "researched source pack", "final formatted document"). The chain must be contiguous and gap-free, and each artifact is produced exactly once by exactly one specialist — if two roles would overlap, re-cut them so every link is unique.

TOOLS PER SPECIALIST — inside each specialist's "tasks" or "rules", name the concrete tools/capabilities it uses to produce its artifact (e.g. web research/search, document/sheet/slide creation, spreadsheet formulas and data analysis, email/outreach, calendar, CRM, code execution, data extraction, template filling). Match tools to what that artifact actually requires; never list tools a role won't use.

WRITE EACH FIELD PRECISELY:
- "role": short, specific role title (2-4 words) reflecting its function in the chain (e.g. lead planner, researcher, builder, QA reviewer).
- "name": a realistic first name, fitting the GOAL's language/region and distinct from the others.
- prompt "role": one crisp sentence — who this specialist is and its single focus, distinct from every other.
- prompt "tasks": the concrete steps written as instructions to that specialist, INCLUDING the RECEIVES → DOES → HANDS OFF contract with named artifacts and the tools used. Tie every task to the actual GOAL deliverable in its required format/scope — no filler.
- prompt "tone": the voice and register this specialist works and communicates in.
- prompt "rules": hard constraints — scope boundaries stating what it must NOT do (to prevent overlap), quality bars, tool-use specifics, the exact format of its artifact, a restatement that it serves the exact GOAL deliverable and never substitutes generic content, and — for the Reviewer — the acceptance checklist it verifies against the GOAL plus its authority to send work back before approving.

QUALITY BAR: sharp, non-overlapping personas specific to THIS goal; no vague "assist with"/"help out" phrasing; every specialist adds distinct value; the chain, read top to bottom, visibly produces the exact deliverable the GOAL demands.

OUTPUT CONTRACT:
- Respond with ONLY valid JSON — no prose, no explanation, no markdown, no code fences — matching EXACTLY:
{"subagents":[{"role":string,"name":string,"skills":[string],"prompt":{"role":string,"tasks":string,"tone":string,"rules":string}}]}
- Do not add, rename, or remove fields. Encode all tools and handoffs INSIDE the existing "tasks"/"rules" text.
- Write every field's text in the GOAL's language.

`
      const msgs: ChatMsg[] = [
        { role: 'system', content: staffSystem + skillsRule + marketplaceNoExecutorRule + langRule + bizBlock },
        { role: 'user', content: `${ctx || goal || 'A general business assistant team.'}${enBrief ? `\n\nGoal in English (for precise understanding — design the team around THIS outcome, not the domain):\n${enBrief}` : ''}` },
        ...(artifacts.length
          ? [{
              role: 'user' as const,
              content: `The user attached ${artifacts.length} source file(s): ${artifacts.map((artifact) => artifact.name).join(', ')}. Design concrete roles that use these supplied files; do not replace data work with a generic plan.\n\n${artifactContext(artifacts, 8_000)}`,
            }]
          : []),
      ]
      // Cheap models sometimes truncate or wrap the JSON in prose/code fences, which
      // would leave the team empty. Retry up to 3x with more room + a stricter reminder
      // before giving up, so the architect reliably returns a valid team.
      type Sub = { role: string; name: string; skills: string[]; prompt: { role: string; tasks: string; tone: string; rules: string } }
      let subagents: Sub[] = []
      for (let attempt = 0; attempt < 3 && subagents.length === 0; attempt++) {
        const attemptMsgs: ChatMsg[] = attempt === 0
          ? msgs
          : [...msgs, { role: 'system', content: 'Your previous reply could not be parsed. Reply with ONLY the raw JSON object {"subagents":[...]} — no prose, no markdown, no code fences, and make sure it is complete and valid.' }]
        const r = await callOpenRouter({ apiKey: orKey, model: managerModel, messages: attemptMsgs, temperature: attempt === 0 ? 0.4 : 0.2, maxTokens: 3500, fallbackModel: PRIMARY_MODEL })
        await account(r.tokens)
        const parsed = extractJson(r.content)
        const rawSubs = Array.isArray(parsed?.subagents) ? (parsed!.subagents as Array<Record<string, unknown>>) : []
        subagents = rawSubs
          .filter((s) => s && typeof s.role === 'string')
          .slice(0, 4)
          .map((s) => {
            const p = (s.prompt ?? {}) as Record<string, unknown>
            return {
              role: String(s.role).slice(0, 60),
              name: String((s.name as string) ?? s.role).slice(0, 60),
              // Only canonical ids survive. Deterministic domain methods fill a gap
              // when the architect omits an essential marketplace/data capability.
              skills: useSkills
                ? [...new Set([
                    ...deterministicSkills(goal),
                    ...(Array.isArray(s.skills) ? (s.skills as unknown[]).map(String) : []),
                  ])].filter((id) => ORCHESTRATION_SKILL_IDS.has(id)).slice(0, 3)
                : [],
              prompt: {
                role: String(p.role ?? '').slice(0, 600),
                tasks: String(p.tasks ?? '').slice(0, 1100),
                tone: String(p.tone ?? '').slice(0, 300),
                rules: String(p.rules ?? '').slice(0, 900),
              },
            }
          })
      }
      if (!subagents.length) return json({ error: 'parse_failed' }, 502)
      return json({ ok: true, subagents })
    }

    if (action === 'step') {
      const goal = String(body?.goal ?? '')
      const role = (ROLES as readonly string[]).includes(body?.role) ? (body.role as Role) : 'analyst'
      const task = String(body?.task ?? '')
      const context = String(body?.context ?? '').slice(-18_000)
      const artifacts = inputArtifacts(body?.input_artifacts)
      const lang = String(body?.lang ?? '').trim()
      const langRule = lang && LANG_NAME[lang] ? `\n\nWrite your entire answer in ${LANG_NAME[lang]}.` : ''
      // a saved sub-agent can supply its own system prompt (custom domain role)
      const customSystem = String(body?.system ?? '').trim()
      // marketing skill briefs assigned by the architect (staff use_skills) — injected
      // into the specialist's system prompt so it works BY THE METHOD, not from vibes
      const skills = Array.isArray(body?.skills)
        ? (body.skills as unknown[]).map(String).filter((id) => ORCHESTRATION_SKILL_IDS.has(id)).slice(0, 6)
        : []
      // Not gated on the assigned skills: the architect can label a numeric task anything,
      // and a silent miss here is what lets a specialist do purchase math in prose.
      const calculatedEvidence = marketplaceEvidence(goal, artifacts)
      const webResearch = role === 'researcher' && body?.web_research === true
      const model = workModel
      const msgs: ChatMsg[] = [
        {
          role: 'system',
          content: (customSystem || roleSystem[role]) + UNIVERSAL_CONTRACT + orchestrationSkillBlock(skills) + bizBlock +
            (webResearch
              ? '\n\nLIVE RESEARCH IS ENABLED. Search the web for current evidence. Cite every external factual claim with a Markdown link. Never invent metrics, traffic, customers, growth percentages, quotes, tools used by a company, or competitor facts. If reliable evidence is unavailable, write "Not verified" instead of guessing.'
              : '\n\nGROUNDING RULE: Use only facts present in the goal, business profile, knowledge/context, or cited sources. Never invent metrics, growth percentages, named competitors, testimonials, traffic, dates, or tool usage. Mark missing facts as "Not verified".'),
        },
        {
          role: 'user',
          content:
            `Overall goal (stay strictly on it — deliver exactly what it asks, no generic background essays):\n${goal}\n\n` +
            `Your step: ${task}` +
            `${calculatedEvidence ? `\n\n${calculatedEvidence}\nUse these server-calculated values as the numeric source of truth. Do not invent a safety stock or turn a baseline into a final purchase order.` : ''}` +
            `${artifacts.length ? `\n\nUser-supplied source files (authoritative input; calculate from these rows and name missing columns instead of inventing values):\n${artifactContext(artifacts)}` : ''}` +
            `${context ? `\n\nStructured handoff from previous specialists:\n${context}` : ''}${langRule}`,
        },
      ]
      const r = await callOpenRouter({
        apiKey: orKey,
        model,
        messages: msgs,
        temperature: role === 'researcher' ? 0.2 : 0.5,
        maxTokens: 1400,
        fallbackModel: FALLBACK_MODEL,
        ...(webResearch ? { plugins: [{ id: 'web', engine: 'exa', max_results: 5 }] } : {}),
      })
      await account(r.tokens)
      return json({ ok: true, output: r.content, sources: r.citations })
    }

    if (action === 'review') {
      // PEER CROSS-REVIEW: one specialist critiques ANOTHER's work and returns a
      // structured verdict (approved + score + concrete fixes) so the author can revise.
      // This is what turns a linear pipeline into a team that checks each other and
      // catches errors BEFORE the client sees them (reduces hallucinations).
      const goal = String(body?.goal ?? '')
      const work = String(body?.work ?? '').slice(0, 6000)
      const artifacts = inputArtifacts(body?.input_artifacts)
      const authorRole = String(body?.author_role ?? 'коллега')
      const authorTask = String(body?.author_task ?? '').trim().slice(0, 2_000)
      const reviewerSystem = String(body?.reviewer_system ?? '').trim()
      const criteria = String(body?.criteria ?? '').trim()
      const previousScore = Math.max(0, Math.min(100, Number(body?.previous_score) || 0))
      const previousIssues = Array.isArray(body?.previous_issues)
        ? (body.previous_issues as unknown[]).map(String).slice(0, 8)
        : []
      const revisionRound = Math.max(0, Math.min(3, Number(body?.revision_round) || 0))
      const calculatedEvidence = marketplaceEvidence(goal, artifacts)
      const lang = String(body?.lang ?? '').trim()
      const langRule = lang && LANG_NAME[lang] ? ` Write "issues" and "fix" in ${LANG_NAME[lang]}.` : ''
      // Rubric-based review (advanced-evaluation): score fixed DIMENSIONS instead of a vague
      // holistic number, and let a critical flaw in any one cap the overall score. This makes
      // scores consistent and mitigates leniency/length bias.
      const sys = (reviewerSystem || roleSystem.reviewer) +
        `\n\nYou are PEER-REVIEWING the work of the ${authorRole}. Their assigned handoff contract is:\n${authorTask || 'No separate assignment was provided.'}\n` +
        `Judge whether they completed THEIR ASSIGNED HANDOFF CONTRACT in service of the overall goal` +
        (criteria ? ` and these criteria: ${criteria}` : '') +
        `. Do not require this author to perform work explicitly assigned to a downstream specialist. For example, a planner is complete when it delivers a precise specification and acceptance criteria; it must not be penalized for not producing the analyst's calculations. The final synthesis, not each intermediate author, is responsible for the entire goal. ` +
        `. Score these four dimensions independently, each 0-100: ` +
        `accuracy (facts correct & on-goal, no fabrication), completeness (covers everything the goal asks), clarity (clear, well-structured), actionability (client can use it as-is). ` +
        `The overall "score" reflects the WEAKEST critical dimension, not an average — a serious flaw in accuracy or completeness caps it low. Judge the work, not its length or confident tone. ` +
        (revisionRound > 0
          ? `This is revision round ${revisionRound}. The prior verdict scored ${previousScore}/100 with these issues: ${previousIssues.join('; ') || 'none recorded'}. Check whether those SAME issues were fixed. Do not lower the score merely by inventing new preferences; lower it only for a concrete regression introduced by the revision, and name that regression. `
          : '') +
        `Respond ONLY as compact JSON: {"approved":boolean,"score":0-100,"dimensions":{"accuracy":0-100,"completeness":0-100,"clarity":0-100,"actionability":0-100},"issues":[string],"fix":string}. ` +
        `"issues" = concrete problems (each tied to a dimension); "fix" = ONE actionable instruction telling the author exactly what to change. Set approved:true (empty issues) ONLY if score is at least 80 and every dimension is genuinely strong. Unsupported numbers, named examples, traffic claims, testimonials or growth claims are an accuracy failure. ` +
        `ARITHMETIC CHECK — do this before scoring: recompute every calculation the work states. When a sentence shows its own inputs (for example "77.22 - 12 = 65.22, rounded to 78"), verify that the stated result and rounding actually follow from those inputs. A number that contradicts the values shown beside it, or that contradicts the server-calculated evidence, is a CRITICAL accuracy failure: list it as an issue with the corrected value and cap accuracy below 50.` + langRule + bizBlock
      const msgs: ChatMsg[] = [
        { role: 'system', content: sys },
        {
          role: 'user',
          content: `GOAL:\n${goal}` +
            `${calculatedEvidence ? `\n\n${calculatedEvidence}\nTreat these server-calculated values as authoritative. Reject arithmetic that conflicts with them and reject any invented safety stock.` : ''}` +
            `${artifacts.length ? `\n\nSOURCE FILES USED BY THE AUTHOR — verify claims and calculations against this evidence:\n${artifactContext(artifacts, 30_000)}` : ''}` +
            `\n\nWORK BY THE ${authorRole} — REVIEW IT:\n${work}`,
        },
      ]
      const r = await callOpenRouter({ apiKey: orKey, model: workModel, messages: msgs, temperature: 0.2, maxTokens: 800, fallbackModel: FALLBACK_MODEL })
      await account(r.tokens)
      const parsed = extractJson(r.content) ?? {}
      const clamp = (v: unknown) => Math.max(0, Math.min(100, Number(v) || 0))
      const d = (parsed.dimensions ?? {}) as Record<string, unknown>
      const dimensions = { accuracy: clamp(d.accuracy), completeness: clamp(d.completeness), clarity: clamp(d.clarity), actionability: clamp(d.actionability) }
      const currentScore = clamp(parsed.score)
      // The UI score is explicitly best-so-far, so stochastic reviewer variance cannot
      // make a successful revision look worse. Approval still uses the CURRENT verdict;
      // a regressed draft is rejected even though its historical best remains visible.
      const score = revisionRound > 0 ? Math.max(previousScore, currentScore) : currentScore
      const issues = Array.isArray(parsed.issues) ? parsed.issues.map((x: unknown) => String(x)).slice(0, 8) : []
      const fix = String(parsed.fix ?? '').slice(0, 800)
      const approved = Boolean(parsed.approved) && currentScore >= 80 && Object.values(dimensions).every((n) => n >= 75) && issues.length === 0
      return json({ ok: true, approved, score, current_score: currentScore, dimensions, issues, fix })
    }

    if (action === 'synth') {
      const goal = String(body?.goal ?? '').trim()
      const artifacts = inputArtifacts(body?.input_artifacts)
      const calculatedEvidence = marketplaceEvidence(goal, artifacts)
      type SynthStep = {
        role: string
        task: string
        output: string
        sources?: string[]
        reviewedBy?: string
        review?: { approved?: boolean; score?: number; issues?: string[]; fix?: string } | null
        revised?: boolean
        revisions?: number
        needsHumanReview?: boolean
      }
      const steps = Array.isArray(body?.steps) ? (body.steps as SynthStep[]).slice(0, MAX_SYNTH_STEPS) : []
      const sources = Array.isArray(body?.sources) ? (body.sources as string[]) : []
      const lang = String(body?.lang ?? '').trim()
      const langRule = lang && LANG_NAME[lang] ? `Write the ENTIRE deliverable in ${LANG_NAME[lang]}.` : 'Write in the SAME language as the goal.'
      // A team page may attach the run to its saved department. Validate through the user's
      // RLS-scoped client so a caller cannot attach traces to another account's department.
      const requestedDepartmentId = String(body?.department_id ?? '').trim()
      let departmentId: string | null = null
      if (requestedDepartmentId) {
        if (!UUID_RE.test(requestedDepartmentId)) return json({ error: 'invalid_department_id' }, 400)
        const { data: ownedDepartment, error: departmentError } = await userDb
          .from('departments')
          .select('id')
          .eq('id', requestedDepartmentId)
          .maybeSingle()
        if (departmentError || !ownedDepartment?.id) return json({ error: 'department_not_found' }, 403)
        departmentId = ownedDepartment.id
      }
      const needsHumanReview = steps.some((step) => Boolean(step.needsHumanReview))
      const enBrief = await englishBrief(orKey, goal)
      const msgs: ChatMsg[] = [
        {
          role: 'system',
          content:
            'You are a senior operations consultant delivering directly to a paying business client. ' +
            'FIRST understand the client request precisely (if it is not in English, translate it in your head first). It is about achieving the requested OUTCOME — never the generic domain it mentions. ' +
            'Produce the COMPLETE, ready-to-use deliverable the request asks for: every concrete artifact — action steps, ready-to-send message drafts addressed to the specific people/audience described, lists, real numbers — fully written out. ' +
            'Format as clean professional Markdown: a title, a 2-3 sentence executive summary, the result in sections, and a short "Next steps" list. ' +
            'Your team prepared some notes (below the request). Use them ONLY where they directly help; if they are generic or off-topic, ignore them and write the deliverable yourself. Do NOT let the notes pull you off the exact request. ' +
            'A note marked HUMAN REVIEW REQUIRED is not approved evidence: label the affected decision/action as pending authorized human review, and never convert it into a confirmed action, recommendation, filing, payment, booking, legal/medical/HR/insurance conclusion, or external message. ' +
            'No meta-commentary, no "as an AI", no mention of internal steps, sub-agents or JSON. End with a Sources list only if sources exist. ' +
            `${langRule} Do not invent facts. Never output placeholder names such as "Company 1", unsupported percentages, traffic claims, testimonials, customer counts, dates, or named tools as if verified. Every current external claim must be supported by one of the supplied source URLs; otherwise label it "Not verified" and state what evidence is needed.${bizBlock}`,
        },
        {
          role: 'user',
          content:
            `CLIENT'S REQUEST — this is exactly what you MUST deliver, in full:\n${goal}${enBrief ? `\n(In English, for precise understanding: ${enBrief})` : ''}\n\n` +
            `${calculatedEvidence ? `${calculatedEvidence}\nUse these values exactly. If reorder_units is null, clearly state that the quantity is a planning baseline and request safety_stock before a purchase-ready order; never invent it.\n\n` : ''}` +
            `Reference notes from the team (use ONLY the parts relevant to the request above; ignore anything off-topic or generic):\n` +
            `${steps.map((s) => `## ${s.role}: ${s.task}${s.needsHumanReview ? ' [HUMAN REVIEW REQUIRED]' : ''}\n${s.output || '(no output)'}`).join('\n\n')}\n\n` +
            `${sources.length ? `Sources:\n${sources.join('\n')}\n\n` : ''}` +
            `Now write the complete, ready-to-use deliverable that fulfils the client's request exactly (including any message drafts, lists or steps it asked for).`,
        },
      ]
      const r = await callOpenRouter({ apiKey: orKey, model: managerModel, messages: msgs, temperature: 0.4, maxTokens: 1900, fallbackModel: PRIMARY_MODEL })
      await account(r.tokens)
      const stepRows = steps.map((s) => ({
        query: `${String(s.role ?? '').slice(0, 120)}: ${String(s.task ?? '').slice(0, 500)}`,
        findings: String(s.output ?? '').slice(0, 12_000),
        sources: Array.isArray(s.sources) ? s.sources.map(String).slice(0, 12) : [],
        review: {
          reviewed_by: String(s.reviewedBy ?? '').slice(0, 120),
          approved: Boolean(s.review?.approved),
          score: Math.max(0, Math.min(100, Number(s.review?.score) || 0)),
          issues: Array.isArray(s.review?.issues) ? s.review.issues.map(String).slice(0, 8) : [],
          revised: Boolean(s.revised),
          revisions: Math.max(0, Math.min(1, Number(s.revisions) || 0)),
          needs_human_review: Boolean(s.needsHumanReview),
        },
      }))
      const runStatus = needsHumanReview ? 'needs_review' : 'done'
      // Every call this run made carries its run_ref, so the run's real token and dollar cost
      // is a sum over what actually happened — not a per-run constant applied to everyone.
      let runTokens = 0
      let runCost = 0
      if (runRef) {
        const { data: spend } = await admin.from('usage').select('tokens, cost').eq('run_ref', runRef).limit(2000)
        for (const row of spend ?? []) {
          runTokens += Number(row.tokens) || 0
          runCost += Number(row.cost) || 0
        }
      }
      const { data: run, error: runError } = await userDb
        .from('research_runs')
        .insert({ task: goal, status: runStatus, kind: 'team_run', department_id: departmentId, report: r.content, sources, steps: stepRows, model: managerModel, tokens: runTokens, cost: Number(runCost.toFixed(6)) })
        .select('id')
        .single()
      if (runError || !run?.id) {
        console.error('team run persistence failed:', runError)
        return json({ ok: false, error: 'run_persist_failed' }, 500)
      }
      return json({ ok: true, id: run.id, result: r.content, status: runStatus, needsHumanReview, department_id: departmentId })
    }

    return json({ error: 'unknown action' }, 400)
  } catch (e) {
    console.error('orchestrate error:', e)
    return json({ error: 'orchestrate_failed', detail: String(e) }, 502)
  }
})
