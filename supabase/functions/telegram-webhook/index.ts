// Telegram inbound webhook (NEMO_AI_SPEC §8 agent runtime).
// URL form: https://<ref>.supabase.co/functions/v1/telegram-webhook/<channel_id>
// Public (verify_jwt = false) — authenticity is checked via Telegram's secret token.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { buildReply } from '../_shared/agent.ts'
import { tgSend } from '../_shared/telegram.ts'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const OPENROUTER_API_KEY = Deno.env.get('OPENROUTER_API_KEY')!

Deno.serve(async (req) => {
  try {
    const url = new URL(req.url)
    const channelId = url.pathname.split('/').filter(Boolean).pop()
    if (!channelId) return new Response('no channel', { status: 400 })

    const db = createClient(SUPABASE_URL, SERVICE_ROLE)

    const { data: channel } = await db.from('channels').select('*, agents(*)').eq('id', channelId).single()
    if (!channel) return new Response('channel not found', { status: 404 })

    // require a configured secret and a matching header (reject if either is missing)
    const secret = req.headers.get('x-telegram-bot-api-secret-token')
    if (!channel.secret_token || secret !== channel.secret_token) {
      return new Response('forbidden', { status: 403 })
    }

    const update = await req.json()
    const msg = update?.message
    if (!msg || !msg.text) return new Response('ok')

    const chatId = String(msg.chat.id)
    const customerName =
      [msg.from?.first_name, msg.from?.last_name].filter(Boolean).join(' ') || msg.from?.username || 'Telegram'
    const botToken = channel.credentials?.bot_token
    const agent = channel.agents

    let { data: dialogue } = await db
      .from('dialogues')
      .select('*')
      .eq('channel_id', channelId)
      .eq('external_id', chatId)
      .maybeSingle()

    if (!dialogue) {
      const ins = await db
        .from('dialogues')
        .insert({
          agent_id: agent.id,
          channel_id: channelId,
          channel: 'telegram',
          external_id: chatId,
          customer_name: customerName,
          customer_contact: msg.from?.username ? '@' + msg.from.username : chatId,
          status: 'open',
        })
        .select('*')
        .single()
      dialogue = ins.data
    }

    await db.from('messages').insert({ dialogue_id: dialogue.id, author: 'customer', content: msg.text })
    await db.from('dialogues').update({ status: dialogue.status === 'resolved' ? 'open' : dialogue.status }).eq('id', dialogue.id)

    if (dialogue.operator_takeover) return new Response('ok')
    if (agent.status === 'paused') return new Response('ok')

    const reply = await buildReply(db, OPENROUTER_API_KEY, agent, dialogue.id)

    if (reply) {
      if (botToken) await tgSend(botToken, chatId, reply)
    } else {
      await db.from('dialogues').update({ status: 'needs_operator' }).eq('id', dialogue.id)
      if (botToken) await tgSend(botToken, chatId, 'Bir lahza, operator ulanadi. / Секунду, оператор скоро подключится.')
    }

    return new Response('ok')
  } catch (e) {
    console.error('telegram webhook error:', e)
    return new Response('ok')
  }
})
