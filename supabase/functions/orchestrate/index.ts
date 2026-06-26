// Multi-agent orchestrator (the "manager"). Split into SHORT actions the panel
// chains, so no single call hits the Edge Function time limit AND the user sees
// each sub-agent finish live:
//   action 'plan'  { goal }                          -> { plan, steps:[{role,task}] }
//   action 'step'  { goal, role, task, context }     -> { output, sources }   (one sub-agent)
//   action 'synth' { goal, steps:[{role,task,output}], sources } -> { id, result }  (+ saves run)
// Authenticated; each action is token-guarded + usage-accounted.
//
//   POST /functions/v1/orchestrate   (Authorization: Bearer <user jwt>)
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { callOpenRouter, type ChatMsg } from '../_shared/llm.ts'
import { corsHeaders, json } from '../_shared/cors.ts'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const OPENROUTER_API_KEY = Deno.env.get('OPENROUTER_API_KEY')!

// FREE models only (researcher loses live web search — Sonar is paid).
const FREE_MODEL = 'google/gemma-4-31b-it:free'
const PLAN_MODEL = FREE_MODEL
const WORK_MODEL = FREE_MODEL
const RESEARCH_MODEL = FREE_MODEL
const MAX_STEPS = 4

const ROLES = ['researcher', 'analyst', 'writer', 'reviewer'] as const
type Role = (typeof ROLES)[number]
const roleSystem: Record<Role, string> = {
  researcher: 'You are a research specialist. Use current web sources to gather concrete facts, numbers and dates for the task. Be concise and factual.',
  analyst: 'You are an analyst. Using the provided context, produce structured insights, comparisons and conclusions for the task.',
  writer: 'You are a writer. Using the provided context, produce the requested written deliverable, clear and well-structured (Markdown).',
  reviewer: 'You are a critical reviewer. Improve and refine the prior outputs for the task: fix gaps, tighten, and increase accuracy.',
}

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

  const { data: prof } = await userDb.from('users').select('account_id').single()
  const accountId = prof?.account_id
  if (!accountId) return json({ error: 'no account' }, 403)
  const admin = createClient(SUPABASE_URL, SERVICE_ROLE)
  const { data: acc } = await admin.from('accounts').select('token_balance').eq('id', accountId).single()
  if (acc && Number(acc.token_balance) <= 0) return json({ error: 'no_tokens' }, 402)

  const account = async (tokens: number) => {
    if (!tokens) return
    await admin.from('usage').insert({ account_id: accountId, tokens, model: 'orchestrate' })
    await admin.rpc('decrement_token_balance', { p_account: accountId, p_amount: tokens })
  }

  const body = await req.json().catch(() => ({}))
  const action = String(body?.action ?? '')

  try {
    if (action === 'plan') {
      const goal = String(body?.goal ?? '').trim()
      if (goal.length < 4) return json({ error: 'goal too short' }, 400)
      const msgs: ChatMsg[] = [
        {
          role: 'system',
          content:
            'You are a project manager coordinating AI sub-agents (researcher, analyst, writer, reviewer). ' +
            'Break the goal into 2-4 sequential steps, each assigned ONE role. Respond ONLY as JSON: ' +
            '{"plan": string, "steps": [{"role": "researcher"|"analyst"|"writer"|"reviewer", "task": string}]}. ' +
            'Use a researcher first if current facts are needed. Write tasks in the SAME language as the goal.',
        },
        { role: 'user', content: goal },
      ]
      const r = await callOpenRouter({ apiKey: OPENROUTER_API_KEY, model: PLAN_MODEL, messages: msgs, temperature: 0.3 })
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

    if (action === 'step') {
      const goal = String(body?.goal ?? '')
      const role = (ROLES as readonly string[]).includes(body?.role) ? (body.role as Role) : 'analyst'
      const task = String(body?.task ?? '')
      const context = String(body?.context ?? '').slice(0, 4000)
      const model = role === 'researcher' ? RESEARCH_MODEL : WORK_MODEL
      const msgs: ChatMsg[] = [
        { role: 'system', content: roleSystem[role] },
        { role: 'user', content: `Overall goal: ${goal}\n\nYour step: ${task}${context ? `\n\nContext from previous steps:\n${context}` : ''}` },
      ]
      const r = await callOpenRouter({ apiKey: OPENROUTER_API_KEY, model, messages: msgs, temperature: role === 'researcher' ? 0.2 : 0.5, maxTokens: 800 })
      await account(r.tokens)
      return json({ ok: true, output: r.content, sources: r.citations })
    }

    if (action === 'synth') {
      const goal = String(body?.goal ?? '').trim()
      const steps = Array.isArray(body?.steps) ? (body.steps as { role: string; task: string; output: string; sources?: string[] }[]) : []
      const sources = Array.isArray(body?.sources) ? (body.sources as string[]) : []
      const msgs: ChatMsg[] = [
        {
          role: 'system',
          content:
            'You are the project manager. Combine the sub-agents’ outputs into ONE polished final deliverable in Markdown ' +
            '(title, the result, key points, and a Sources list if any). Write in the SAME language as the goal. Do not invent facts.',
        },
        { role: 'user', content: `Goal: ${goal}\n\nSub-agent outputs:\n${steps.map((s) => `## ${s.role}: ${s.task}\n${s.output || '(no output)'}`).join('\n\n')}\n\nSources:\n${sources.join('\n')}` },
      ]
      const r = await callOpenRouter({ apiKey: OPENROUTER_API_KEY, model: WORK_MODEL, messages: msgs, temperature: 0.4, maxTokens: 1400 })
      await account(r.tokens)
      const stepRows = steps.map((s) => ({ query: `${s.role}: ${s.task}`, findings: s.output, sources: s.sources ?? [] }))
      const { data: run } = await userDb
        .from('research_runs')
        .insert({ task: goal, status: 'done', report: r.content, sources, steps: stepRows })
        .select('id')
        .single()
      return json({ ok: true, id: run?.id, result: r.content })
    }

    return json({ error: 'unknown action' }, 400)
  } catch (e) {
    console.error('orchestrate error:', e)
    return json({ error: 'orchestrate_failed', detail: String(e) }, 502)
  }
})
