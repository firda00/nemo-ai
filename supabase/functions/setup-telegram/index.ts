// One-command Telegram bot registration (setup helper).
// Public function gated by the SETUP_SECRET header so it can run before the
// frontend auth/UI is wired. Creates a demo account + agent (if none given),
// links the bot as a channel, and registers the Telegram webhook.
//
// NOTE: when no agent_id is passed this creates a SEPARATE demo account — use it
// only for a backend smoke test. Real users connect a bot from the UI via
// `connect-telegram`, which attaches the channel to the logged-in user's account.
//
//   POST /functions/v1/setup-telegram
//   header  x-setup-secret: <SETUP_SECRET>
//   body    { "bot_token": "123:ABC", "agent_id"?, "agent_name"?, "model"?, "default_lang"?, "prompt"? }
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.108.2'
import { tgSetWebhook, tgGetMe } from '../_shared/telegram.ts'
import { timingSafeEqual } from '../_shared/safeEqual.ts'
import { isRegulatedAgent, REGULATED_CHANNEL_ERROR } from '../_shared/riskPolicy.ts'
import { blocksExternalActions, PRODUCTION_E2E_EXTERNAL_BLOCK } from '../_shared/productionE2E.ts'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const SETUP_SECRET = Deno.env.get('SETUP_SECRET')!

Deno.serve(async (req) => {
  if (!timingSafeEqual(req.headers.get('x-setup-secret'), SETUP_SECRET)) {
    return Response.json({ error: 'forbidden' }, { status: 403 })
  }

  const body = await req.json().catch(() => ({}))
  const botToken = body.bot_token
  if (!botToken) return Response.json({ error: 'bot_token required' }, { status: 400 })

  const db = createClient(SUPABASE_URL, SERVICE_ROLE)

  if (body.agent_id) {
    const { data: owner } = await db.from('agents').select('account_id').eq('id', body.agent_id).maybeSingle()
    if (!owner) return Response.json({ error: 'agent not found' }, { status: 404 })
    if (await blocksExternalActions(db, owner.account_id)) return Response.json(PRODUCTION_E2E_EXTERNAL_BLOCK, { status: 403 })
  }

  // verify the bot token with Telegram
  const me = await tgGetMe(botToken)
  if (!me.ok) return Response.json({ error: 'invalid bot token', detail: me }, { status: 400 })

  // A public setup helper must never bypass the publish gate.
  const agentId = body.agent_id as string | undefined
  if (!agentId) return Response.json({ error: 'AGENT_EVAL_REQUIRED' }, { status: 409 })

  const { data: targetAgent } = await db.from('agents').select('id, account_id, niche, risk_tier, status, config_revision, published_revision').eq('id', agentId).maybeSingle()
  if (!targetAgent) return Response.json({ error: 'agent not found' }, { status: 404 })
  if (targetAgent.status !== 'active') return Response.json({ error: 'AGENT_EVAL_REQUIRED' }, { status: 409 })
  if (isRegulatedAgent(targetAgent)) {
    return Response.json({ error: REGULATED_CHANNEL_ERROR, code: 'REGULATED_CHANNEL_BLOCKED' }, { status: 403 })
  }

  // create the channel row with a fresh webhook secret
  const secret = crypto.randomUUID().replace(/-/g, '')
  const { data: channel } = await db
    .from('channels')
    .insert({
      agent_id: agentId,
      type: 'telegram',
      credentials: { bot_token: botToken, username: me.result.username },
      secret_token: secret,
      status: 'connected',
    })
    .select('id')
    .single()

  // register the Telegram webhook -> our public function with the channel id in the path
  const webhookUrl = `${SUPABASE_URL}/functions/v1/telegram-webhook/${channel!.id}`
  const wh = await tgSetWebhook(botToken, webhookUrl, secret)

  return Response.json({
    ok: wh.ok === true,
    bot: me.result.username,
    agent_id: agentId,
    channel_id: channel!.id,
    webhook: webhookUrl,
    telegram: wh,
  })
})
