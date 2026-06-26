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
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { tgSetWebhook, tgGetMe } from '../_shared/telegram.ts'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const SETUP_SECRET = Deno.env.get('SETUP_SECRET')!

Deno.serve(async (req) => {
  if (req.headers.get('x-setup-secret') !== SETUP_SECRET) {
    return Response.json({ error: 'forbidden' }, { status: 403 })
  }

  const body = await req.json().catch(() => ({}))
  const botToken = body.bot_token
  if (!botToken) return Response.json({ error: 'bot_token required' }, { status: 400 })

  const db = createClient(SUPABASE_URL, SERVICE_ROLE)

  // verify the bot token with Telegram
  const me = await tgGetMe(botToken)
  if (!me.ok) return Response.json({ error: 'invalid bot token', detail: me }, { status: 400 })

  // use the given agent, or auto-provision a demo account + agent
  let agentId = body.agent_id as string | undefined
  if (!agentId) {
    const { data: acc } = await db
      .from('accounts')
      .insert({ name: 'Demo · ' + (me.result.username ?? 'bot') })
      .select('id')
      .single()
    const { data: agent } = await db
      .from('agents')
      .insert({
        account_id: acc!.id,
        name: body.agent_name ?? me.result.first_name ?? 'Nemo agent',
        prompt: body.prompt ?? {
          role: 'Biznes uchun mehribon va aniq administrator',
          tasks: 'Mijozlarning savollariga javob berish, mahsulot va narxlar haqida aytib berish, buyurtma/bron qabul qilish',
          tone: 'Do‘stona, qisqa va aniq',
          rules: 'Aniq bilmasang, operatorga ulashni taklif qil. Narx va shartlarni o‘ylab topma.',
        },
        model: body.model ?? 'openai/gpt-4o-mini',
        default_lang: body.default_lang ?? 'auto',
        status: 'active',
      })
      .select('id')
      .single()
    agentId = agent!.id
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
