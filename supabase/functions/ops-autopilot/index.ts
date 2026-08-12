// Autonomous "AI COO" (autopilot). Called daily by pg_cron with x-cron-secret. For every
// account with an owner Telegram, it reads today's real signals (dialogues, leads, open/overdue
// tasks, unattended support), asks an LLM to assess the state and pick the top actions, then
// delivers a short brief to the owner and logs it. No human watches the numbers — the platform
// runs its own operations.
//   POST /functions/v1/ops-autopilot   (header: x-cron-secret: <CRON_SECRET>)
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.108.2'
import { corsPreflight, json } from '../_shared/cors.ts'
import { tgSend } from '../_shared/telegram.ts'
import { callOpenRouter, PRIMARY_MODEL, FALLBACK_MODEL } from '../_shared/llm.ts'
import { resolveOpenRouterKey } from '../_shared/keys.ts'
import { blocksExternalActions } from '../_shared/productionE2E.ts'
import { entitlementFor } from '../_shared/entitlement.ts'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const CRON_SECRET = Deno.env.get('CRON_SECRET') ?? ''
const OPENROUTER_API_KEY = Deno.env.get('OPENROUTER_API_KEY') ?? ''
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any

const LANGNAME: Record<string, string> = { uz: 'Uzbek', ru: 'Russian', en: 'English' }
const HEAD: Record<string, string> = { uz: '🤖 AI-direktor — bugungi hisobot:', ru: '🤖 AI-директор — сводка на сегодня:', en: '🤖 AI COO — today’s brief:' }
const TODO: Record<string, string> = { uz: '\n\nNima qilish kerak:', ru: '\n\nЧто сделать:', en: '\n\nWhat to do:' }
const norm = (v: unknown) => { const s = String(v ?? '').toLowerCase(); return s === 'uz' || s === 'en' ? s : 'ru' }

function extractJson(text: string): Any { const s = text.indexOf('{'); const e = text.lastIndexOf('}'); if (s === -1 || e === -1) return null; try { return JSON.parse(text.slice(s, e + 1)) } catch { return null } }

Deno.serve(async (req) => {
  const preflight = corsPreflight(req)
  if (preflight) return preflight
  const secret = req.headers.get('x-cron-secret')
  const auth = req.headers.get('Authorization') ?? ''
  if (!CRON_SECRET || (secret !== CRON_SECRET && auth !== `Bearer ${SERVICE_ROLE}`)) return new Response('forbidden', { status: 403 })
  const db = createClient(SUPABASE_URL, SERVICE_ROLE)

  const { data: rows, error } = await db.rpc('ops_autopilot_signals')
  if (error) return json({ ok: false, error: error.message }, 500)
  // only accounts with something worth commenting on
  const active = ((rows ?? []) as Any[]).filter((r) => Number(r.dialogues) + Number(r.leads) + Number(r.open_tasks) + Number(r.needs_operator) > 0).slice(0, 50)
  if (!active.length) return json({ ok: true, accounts: (rows ?? []).length, sent: 0 })

  // Каждый аккаунт проверяется отдельно: пакетный прогон, где один плательщик открывает работу
  // всем остальным в списке, — это не замок, а его имитация.
  const deliverable = (await Promise.all(active.map(async (r) =>
    (await blocksExternalActions(db, r.account_id)) || !(await entitlementFor(db, r.account_id)).allowed
      ? null
      : r))).filter(Boolean) as Any[]
  const accIds = deliverable.map((r) => r.account_id)
  // report language + account bot token (via the account's telegram channels)
  let bps: Any[] = []
  let agents: Any[] = []
  if (accIds.length) {
    const [{ data: profileRows }, { data: agentRows }] = await Promise.all([
      db.from('business_profiles').select('account_id, report_lang').in('account_id', accIds),
      db.from('agents').select('id, account_id').in('account_id', accIds),
    ])
    bps = profileRows ?? []
    agents = agentRows ?? []
  }
  const langByAcc = new Map<string, string>()
  for (const b of bps) langByAcc.set(b.account_id, norm(b.report_lang))
  const agentsByAcc: Record<string, string[]> = {}
  for (const a of agents) (agentsByAcc[a.account_id] ??= []).push(a.id)

  let sent = 0
  for (const r of deliverable) {
    try {
      const agentIds = agentsByAcc[r.account_id] ?? []
      if (!agentIds.length) continue
      const { data: ch } = await db.from('channels').select('credentials').eq('type', 'telegram').in('agent_id', agentIds).limit(1).maybeSingle()
      const token = ch?.credentials?.bot_token
      if (!token) continue
      const lang = langByAcc.get(r.account_id) ?? 'ru'

      const apiKey = await resolveOpenRouterKey(db, r.account_id, OPENROUTER_API_KEY)
      const signals = `dialogues_today=${r.dialogues}, new_leads_today=${r.leads}, open_tasks=${r.open_tasks}, overdue_tasks=${r.overdue_tasks}, unattended_support=${r.needs_operator}`
      if (await blocksExternalActions(db, r.account_id)) continue
      const resp = await callOpenRouter({
        apiKey, model: PRIMARY_MODEL, fallbackModel: FALLBACK_MODEL, temperature: 0.4, maxTokens: 350,
        messages: [
          { role: 'system', content: `You are the autonomous COO of a business that uses this AI platform. From today's operational signals, write a VERY short brief in ${LANGNAME[lang]}. Respond ONLY as JSON {"summary": "one sentence on the state", "actions": ["2-4 concrete prioritized actions the owner/agents should take today"]}. Be specific to the numbers (e.g. if unattended_support>0 tell them to answer it; if overdue_tasks>0 push those; if leads with no follow-up, follow up). No fluff.` },
          { role: 'user', content: `Today's signals: ${signals}` },
        ],
      })
      const j = extractJson(resp.content) ?? {}
      const summary = String(j.summary ?? '').trim()
      const actions: string[] = Array.isArray(j.actions) ? j.actions.map((x: Any) => String(x)).slice(0, 4) : []
      if (!summary && !actions.length) continue

      const msg = `${HEAD[lang]}\n${summary}` + (actions.length ? TODO[lang] + '\n' + actions.map((a, i) => `${i + 1}. ${a}`).join('\n') : '')
      await db.from('ops_reports').insert({ account_id: r.account_id, kind: 'autopilot', summary, actions })
      if (await blocksExternalActions(db, r.account_id)) continue
      if (await tgSend(String(token), String(r.notify_chat_id), msg)) sent++
    } catch { /* best effort per account */ }
  }

  return json({ ok: true, accounts: active.length, sent })
})
