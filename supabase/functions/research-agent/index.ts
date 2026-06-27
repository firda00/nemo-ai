// Autonomous research agent. Given a task it: (1) plans focused sub-queries,
// (2) searches the live web for each via Perplexity Sonar (through OpenRouter,
// with citations), (3) synthesizes a sourced report. Steps + report + sources
// are saved to research_runs. Token-guarded + usage-accounted.
//
//   POST /functions/v1/research-agent   (Authorization: Bearer <user jwt>)
//   body { "task": "..." }
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { callOpenRouter, type ChatMsg } from '../_shared/llm.ts'
import { resolveOpenRouterKey } from '../_shared/keys.ts'
import { corsHeaders, json } from '../_shared/cors.ts'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const OPENROUTER_API_KEY = Deno.env.get('OPENROUTER_API_KEY')!

// FREE models only. NOTE: free models cannot browse the web (Sonar is paid), so
// findings come from the model's own knowledge — no live sources. Add a small
// Perplexity budget to restore live web search + citations.
const FREE_MODEL = 'google/gemma-4-31b-it:free'
const PLAN_MODEL = FREE_MODEL
const SEARCH_MODEL = FREE_MODEL
const SYNTH_MODEL = FREE_MODEL
const MAX_QUERIES = 4

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

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })

  const authHeader = req.headers.get('Authorization')
  if (!authHeader) return json({ error: 'unauthorized' }, 401)
  const userDb = createClient(SUPABASE_URL, ANON_KEY, { global: { headers: { Authorization: authHeader } } })
  const {
    data: { user },
  } = await userDb.auth.getUser()
  if (!user) return json({ error: 'unauthorized' }, 401)

  const { task } = await req.json().catch(() => ({}))
  const goal = String(task ?? '').trim()
  if (goal.length < 4) return json({ error: 'task too short' }, 400)

  const { data: prof } = await userDb.from('users').select('account_id').single()
  const accountId = prof?.account_id
  if (!accountId) return json({ error: 'no account' }, 403)
  const admin = createClient(SUPABASE_URL, SERVICE_ROLE)
  const { data: acc } = await admin.from('accounts').select('token_balance').eq('id', accountId).single()
  if (acc && Number(acc.token_balance) <= 0) return json({ error: 'no_tokens' }, 402)
  const orKey = await resolveOpenRouterKey(admin, accountId, OPENROUTER_API_KEY)

  let tokens = 0
  try {
    // 1) PLAN — break the task into focused web-search queries
    const planMsg: ChatMsg[] = [
      {
        role: 'system',
        content:
          'You are a research planner. Break the user task into 3-4 focused, diverse web-search queries that together cover it. ' +
          'Respond ONLY with JSON: {"queries": string[], "angle": string}. Write queries in the SAME language as the task.',
      },
      { role: 'user', content: goal },
    ]
    const plan = await callOpenRouter({ apiKey: orKey, model: PLAN_MODEL, messages: planMsg, temperature: 0.3 })
    tokens += plan.tokens
    const parsed = extractJson(plan.content)
    let queries = Array.isArray(parsed?.queries) ? (parsed!.queries as unknown[]).map(String).filter(Boolean) : []
    if (!queries.length) queries = [goal]
    queries = queries.slice(0, MAX_QUERIES)

    // 2) SEARCH — live web search per query (Sonar returns citations)
    const steps: { query: string; findings: string; sources: string[] }[] = []
    const allSources = new Set<string>()
    for (const q of queries) {
      const searchMsg: ChatMsg[] = [
        { role: 'system', content: 'Research the query using current web sources. Give concise factual findings with concrete numbers/dates. Reply in the language of the query.' },
        { role: 'user', content: q },
      ]
      try {
        const r = await callOpenRouter({ apiKey: orKey, model: SEARCH_MODEL, messages: searchMsg, temperature: 0.2, maxTokens: 700 })
        tokens += r.tokens
        r.citations.forEach((c) => allSources.add(c))
        steps.push({ query: q, findings: r.content, sources: r.citations })
      } catch (e) {
        console.error('search step failed:', q, e)
        steps.push({ query: q, findings: '', sources: [] })
      }
    }

    // 3) SYNTHESIZE — combine findings into a sourced report
    const sources = Array.from(allSources)
    const findingsBlock = steps
      .map((s, i) => `## Sub-query ${i + 1}: ${s.query}\n${s.findings || '(no result)'}`)
      .join('\n\n')
    const synthMsg: ChatMsg[] = [
      {
        role: 'system',
        content:
          'You are a senior research analyst. Using ONLY the findings provided, write a clear, well-structured report in Markdown ' +
          '(title, short summary, sections with headings, bullet points, and a "Sources" list at the end). ' +
          'Be specific and cite concrete facts. Write in the SAME language as the task. Do not invent facts not present in the findings.',
      },
      { role: 'user', content: `Task: ${goal}\n\nFindings:\n${findingsBlock}\n\nKnown source URLs:\n${sources.join('\n')}` },
    ]
    const synth = await callOpenRouter({ apiKey: orKey, model: SYNTH_MODEL, messages: synthMsg, temperature: 0.4, maxTokens: 1800 })
    tokens += synth.tokens
    const report = synth.content

    // account usage + persist the run
    if (tokens) {
      await admin.from('usage').insert({ account_id: accountId, tokens, model: 'research-agent' })
      await admin.rpc('decrement_token_balance', { p_account: accountId, p_amount: tokens })
    }
    const { data: run } = await userDb
      .from('research_runs')
      .insert({ task: goal, status: 'done', report, sources, steps, tokens })
      .select('id, created_at')
      .single()

    return json({ ok: true, id: run?.id, report, sources, steps, queries, tokens })
  } catch (e) {
    console.error('research-agent error:', e)
    return json({ error: 'research_failed', detail: String(e) }, 502)
  }
})
