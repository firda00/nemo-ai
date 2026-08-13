// Connect a Telegram bot from the UI (authenticated owner).
// Verifies the JWT, links the bot to one of the user's agents, stores the
// channel, and registers the Telegram webhook.
//
//   POST /functions/v1/connect-telegram   (Authorization: Bearer <user jwt>)
//   body { "bot_token": "123:ABC", "agent_id"?: "uuid" }
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.108.2'
import { tgSetWebhook, tgGetMe } from '../_shared/telegram.ts'
import { corsPreflight, json } from '../_shared/cors.ts'
import { isRegulatedAgent, REGULATED_CHANNEL_ERROR } from '../_shared/riskPolicy.ts'
import { blocksExternalActions, PRODUCTION_E2E_EXTERNAL_BLOCK } from '../_shared/productionE2E.ts'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!

Deno.serve(async (req) => {
  const preflight = corsPreflight(req)
  if (preflight) return preflight

  const authHeader = req.headers.get('Authorization')
  if (!authHeader) return json({ error: 'unauthorized' }, 401)

  // user-scoped client -> RLS keeps everything inside the caller's account
  const db = createClient(SUPABASE_URL, ANON_KEY, { global: { headers: { Authorization: authHeader } } })
  const {
    data: { user },
  } = await db.auth.getUser()
  if (!user) return json({ error: 'unauthorized' }, 401)

  const body = await req.json().catch(() => ({}))
  const botToken = body.bot_token
  if (!botToken) return json({ error: 'bot_token required' }, 400)

  const { data: profile } = await db.from('users').select('account_id').eq('id', user.id).maybeSingle()
  const accountId = profile?.account_id
  if (!accountId) return json({ error: 'no account for user' }, 400)
  if (await blocksExternalActions(db, accountId)) return json(PRODUCTION_E2E_EXTERNAL_BLOCK, 403)

  // verify the bot with Telegram
  const me = await tgGetMe(botToken)
  if (!me.ok) return json({ error: 'invalid bot token', detail: me }, 400)

  // optional: bind this bot to a specific SUB-AGENT (its own bot) and/or a GROUP task-bot
  const subAgentId = (body.sub_agent_id as string | undefined) || undefined
  const scope = body.scope === 'group' ? 'group' : 'dm'
  const label = typeof body.label === 'string' ? body.label.slice(0, 80) : null

  // A channel may only be attached to a verified published agent.
  let agentId = body.agent_id as string | undefined
  if (subAgentId) {
    const { data: sa } = await db.from('sub_agents').select('department_id').eq('id', subAgentId).maybeSingle()
    if (!sa) return json({ error: 'sub_agent not found' }, 404)
    const { data: dept } = await db.from('departments').select('main_agent_id').eq('id', sa.department_id).maybeSingle()
    if (dept?.main_agent_id) agentId = dept.main_agent_id
  }
  if (!agentId) {
    const { data: agents } = await db.from('agents').select('id').eq('account_id', accountId).limit(1)
    agentId = agents?.[0]?.id
    if (!agentId) return json({ error: 'AGENT_EVAL_REQUIRED' }, 409)
  }

  const { data: targetAgent } = await db
    .from('agents')
    .select('id, niche, risk_tier, status, config_revision, published_revision')
    .eq('id', agentId)
    .eq('account_id', accountId)
    .maybeSingle()
  if (!targetAgent) return json({ error: 'agent not found' }, 404)
  if (targetAgent.status !== 'active') return json({ error: 'AGENT_EVAL_REQUIRED' }, 409)
  if (isRegulatedAgent(targetAgent)) return json({ error: REGULATED_CHANNEL_ERROR, code: 'REGULATED_CHANNEL_BLOCKED' }, 403)

  const secret = crypto.randomUUID().replace(/-/g, '')
  const { data: channel, error: chErr } = await db
    .from('channels')
    .insert({
      agent_id: agentId,
      sub_agent_id: subAgentId ?? null,
      scope,
      label,
      type: 'telegram',
      credentials: { bot_token: botToken, username: me.result.username },
      secret_token: secret,
      status: 'connected',
    })
    .select('id')
    .single()
  if (chErr || !channel) return json({ error: chErr?.message ?? 'could not create channel' }, 400)

  const webhookUrl = `${SUPABASE_URL}/functions/v1/telegram-webhook/${channel.id}`
  const wh = await tgSetWebhook(botToken, webhookUrl, secret)

  if (wh.ok !== true) {
    // Never retain a row that falsely claims the webhook is connected.
    await db.from('channels').delete().eq('id', channel.id)
  }

  return json({ ok: wh.ok === true, bot: me.result.username, agent_id: agentId, sub_agent_id: subAgentId ?? null, scope, channel_id: channel.id })
})
