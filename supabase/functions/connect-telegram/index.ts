// Connect a Telegram bot from the UI (authenticated owner).
// Verifies the JWT, links the bot to one of the user's agents, stores the
// channel, and registers the Telegram webhook.
//
//   POST /functions/v1/connect-telegram   (Authorization: Bearer <user jwt>)
//   body { "bot_token": "123:ABC", "agent_id"?: "uuid" }
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { tgSetWebhook, tgGetMe } from '../_shared/telegram.ts'
import { corsHeaders, json } from '../_shared/cors.ts'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })

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

  // verify the bot with Telegram
  const me = await tgGetMe(botToken)
  if (!me.ok) return json({ error: 'invalid bot token', detail: me }, 400)

  const { data: profile } = await db.from('users').select('account_id').eq('id', user.id).single()
  const accountId = profile?.account_id
  if (!accountId) return json({ error: 'no account for user' }, 400)

  // pick the target agent (provided, or first, or create a default one)
  let agentId = body.agent_id as string | undefined
  if (!agentId) {
    const { data: agents } = await db.from('agents').select('id').eq('account_id', accountId).limit(1)
    agentId = agents?.[0]?.id
    if (!agentId) {
      const { data: a } = await db
        .from('agents')
        .insert({ account_id: accountId, name: me.result.first_name ?? 'Nemo agent', status: 'active' })
        .select('id')
        .single()
      agentId = a?.id
    }
  }

  const secret = crypto.randomUUID().replace(/-/g, '')
  const { data: channel, error: chErr } = await db
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
  if (chErr || !channel) return json({ error: chErr?.message ?? 'could not create channel' }, 400)

  const webhookUrl = `${SUPABASE_URL}/functions/v1/telegram-webhook/${channel.id}`
  const wh = await tgSetWebhook(botToken, webhookUrl, secret)

  return json({ ok: wh.ok === true, bot: me.result.username, agent_id: agentId, channel_id: channel.id })
})
