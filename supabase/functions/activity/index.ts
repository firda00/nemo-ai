// Activity overview ("who does what") — one place that shows what every team, agent and
// sub-agent has been doing across all sections: team runs, tasks, client dialogues,
// scheduled posts, alerts and token load. Read-only, account-scoped.
//   POST /functions/v1/activity   (Bearer jwt) -> { summary, runs, tasks, dialogues, posts, team, alerts }
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.108.2'
import { corsPreflight, json } from '../_shared/cors.ts'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

/* eslint-disable @typescript-eslint/no-explicit-any */
const countBy = (rows: any[], key: string): Record<string, number> => {
  const o: Record<string, number> = {}
  for (const r of rows) { const k = String(r[key] ?? '—'); o[k] = (o[k] ?? 0) + 1 }
  return o
}

Deno.serve(async (req) => {
  const preflight = corsPreflight(req)
  if (preflight) return preflight
  const authHeader = req.headers.get('Authorization')
  if (!authHeader) return json({ error: 'unauthorized' }, 401)
  const userDb = createClient(SUPABASE_URL, ANON_KEY, { global: { headers: { Authorization: authHeader } } })
  const { data: { user } } = await userDb.auth.getUser()
  if (!user) return json({ error: 'unauthorized' }, 401)
  const { data: prof } = await userDb.from('users').select('account_id').maybeSingle()
  const accountId = prof?.account_id
  if (!accountId) return json({ error: 'no account' }, 403)
  const db = createClient(SUPABASE_URL, SERVICE_ROLE)
  const weekAgo = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString()

  // team runs (marketing / content / ops / autonomous), tasks, posts, alerts, team, usage
  const [runsR, tasksR, postsR, alertsR, agentsR, subsR, usageR] = await Promise.all([
    db.from('research_runs').select('task, kind, status, tokens, created_at').eq('account_id', accountId).order('created_at', { ascending: false }).limit(15),
    db.from('tasks').select('title, status, assignee_tg, assignee_name, due_at, created_at').eq('account_id', accountId).order('created_at', { ascending: false }).limit(100),
    db.from('scheduled_posts').select('status, target_chat, content, scheduled_at').eq('account_id', accountId).order('scheduled_at', { ascending: false }).limit(50),
    db.from('notifications').select('kind, title, created_at, read').eq('account_id', accountId).order('created_at', { ascending: false }).limit(20),
    db.from('agents').select('id, name, type, status').eq('account_id', accountId).limit(50),
    db.from('sub_agents').select('name, role, status').eq('account_id', accountId).limit(50),
    db.from('usage').select('tokens').eq('account_id', accountId).gte('created_at', weekAgo).limit(3000),
  ])

  const runs = runsR.data ?? []
  const tasks = tasksR.data ?? []
  const posts = postsR.data ?? []
  const alerts = alertsR.data ?? []
  const agents = agentsR.data ?? []
  const subs = subsR.data ?? []
  const agentIds = agents.map((a: any) => a.id)

  // client dialogues (scope via the account's agents)
  let dialogues: any[] = []
  let dialogueCount = 0
  if (agentIds.length) {
    const dq = await db.from('dialogues').select('customer_name, status, created_at, agent_id').in('agent_id', agentIds).order('created_at', { ascending: false }).limit(10)
    dialogues = dq.data ?? []
    const cq = await db.from('dialogues').select('id', { count: 'exact', head: true }).in('agent_id', agentIds)
    dialogueCount = cq.count ?? 0
  }

  const openTasks = tasks.filter((t: any) => t.status !== 'done')
  const tokens7d = (usageR.data ?? []).reduce((s: number, u: any) => s + (Number(u.tokens) || 0), 0)
  const nameById: Record<string, string> = {}
  for (const a of agents) nameById[a.id] = a.name

  return json({
    ok: true,
    summary: {
      runs: runs.length,
      openTasks: openTasks.length,
      dialogues: dialogueCount,
      scheduledPosts: posts.filter((p: any) => p.status === 'scheduled').length,
      unreadAlerts: alerts.filter((a: any) => !a.read).length,
      tokens7d,
      agents: agents.length,
      subAgents: subs.length,
    },
    runs,
    tasks: { counts: countBy(tasks, 'status'), open: openTasks.slice(0, 12) },
    dialogues: dialogues.map((d: any) => ({ ...d, agent: nameById[d.agent_id] ?? '—' })),
    posts: { counts: countBy(posts, 'status'), upcoming: posts.filter((p: any) => p.status === 'scheduled').slice(0, 6) },
    team: { agents, subs },
    alerts: alerts.slice(0, 8),
  })
})
/* eslint-enable @typescript-eslint/no-explicit-any */
