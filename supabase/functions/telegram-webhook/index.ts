// Telegram inbound webhook (NEMO_AI_SPEC §8 agent runtime).
// URL form: https://<ref>.supabase.co/functions/v1/telegram-webhook/<channel_id>
// Public (verify_jwt = false) — authenticity is checked via Telegram's secret token.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { buildReply, buildSubAgentReply } from '../_shared/agent.ts'
import { tgSend } from '../_shared/telegram.ts'
import { handleTaskBot } from '../_shared/taskbot.ts'
import { resolveOpenRouterKey } from '../_shared/keys.ts'
import { transcribeAudio } from '../_shared/transcribe.ts'
import { timingSafeEqual } from '../_shared/safeEqual.ts'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const OPENROUTER_API_KEY = Deno.env.get('OPENROUTER_API_KEY') ?? ''
const MAX_MSG = 4000

// Reply as a specific sub-agent (its own bot), then persist the message + usage.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function subAgentReply(db: any, agent: any, subId: string, dialogueId: string): Promise<string> {
  const { data: sub } = await db.from('sub_agents').select('*').eq('id', subId).maybeSingle()
  if (!sub || (sub.status && sub.status !== 'active')) return ''
  const { data: acc } = await db.from('accounts').select('token_balance').eq('id', agent.account_id).single()
  if (acc && Number(acc.token_balance) <= 0) return ''
  const { data: history } = await db
    .from('messages').select('author, content').eq('dialogue_id', dialogueId)
    .order('created_at', { ascending: true }).limit(20)
  const apiKey = await resolveOpenRouterKey(db, agent.account_id, OPENROUTER_API_KEY)
  const { text, tokens } = await buildSubAgentReply(db, apiKey, sub, history ?? [])
  if (text) {
    await db.from('messages').insert({ dialogue_id: dialogueId, author: 'agent', content: text })
    await db.from('usage').insert({ account_id: agent.account_id, tokens, model: 'subagent' })
    if (tokens) await db.rpc('decrement_token_balance', { p_account: agent.account_id, p_amount: tokens })
  }
  return text
}

// Download a Telegram file (voice/audio) and return it base64-encoded, for transcription.
async function downloadTelegramFile(token: string, fileId: string): Promise<string> {
  try {
    const gf = await fetch(`https://api.telegram.org/bot${token}/getFile?file_id=${fileId}`).then((r) => r.json())
    const path = gf?.result?.file_path
    if (!path) return ''
    const buf = await fetch(`https://api.telegram.org/file/bot${token}/${path}`).then((r) => r.arrayBuffer())
    const bytes = new Uint8Array(buf)
    let bin = ''
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i])
    return btoa(bin)
  } catch { return '' }
}

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
    if (!channel.secret_token || !timingSafeEqual(secret, channel.secret_token)) {
      return new Response('forbidden', { status: 403 })
    }

    const update = await req.json()
    const msg = update?.message
    if (!msg) return new Response('ok')

    const chatId = String(msg.chat.id)
    const customerName =
      [msg.from?.first_name, msg.from?.last_name].filter(Boolean).join(' ') || msg.from?.username || 'Telegram'
    const botToken = channel.credentials?.bot_token
    const botUsername = channel.credentials?.username ?? ''
    const agent = channel.agents

    // Text, OR transcribe a voice/audio message — so the bot "understands voice"
    // (transcription runs on Nemo's OpenRouter key = included in the subscription).
    let text = msg.text ? String(msg.text).slice(0, MAX_MSG) : ''
    const voice = msg.voice ?? msg.audio
    if (!text && voice?.file_id && botToken && OPENROUTER_API_KEY && agent?.account_id) {
      try {
        const orKey = await resolveOpenRouterKey(db, agent.account_id, OPENROUTER_API_KEY)
        const b64 = await downloadTelegramFile(botToken, voice.file_id)
        if (b64) text = String(await transcribeAudio(orKey, b64, 'ogg')).slice(0, MAX_MSG)
      } catch { /* voice transcription is best-effort */ }
      if (text) msg.text = text // let the group task-bot + downstream see the transcript
    }
    if (!text) return new Response('ok')

    // GROUP task-bot: this bot lives in a team group, not a 1:1 chat. Parse
    // assignments/queries (@mention it) and stop — no customer dialogue.
    if (channel.scope === 'group') {
      if (botToken && OPENROUTER_API_KEY && agent?.account_id) {
        const apiKey = await resolveOpenRouterKey(db, agent.account_id, OPENROUTER_API_KEY)
        await handleTaskBot(db, apiKey, channel, agent.account_id, botToken, botUsername, msg)
      }
      return new Response('ok')
    }

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

    await db.from('messages').insert({ dialogue_id: dialogue.id, author: 'customer', content: text })
    await db.from('dialogues').update({ status: dialogue.status === 'resolved' ? 'open' : dialogue.status }).eq('id', dialogue.id)

    if (dialogue.operator_takeover) return new Response('ok')
    if (agent.status === 'paused') return new Response('ok')
    if (!OPENROUTER_API_KEY) {
      await db.from('dialogues').update({ status: 'needs_operator' }).eq('id', dialogue.id)
      if (botToken) await tgSend(botToken, chatId, 'OpenRouter key is not configured on the server. Operator will join shortly.')
      return new Response(JSON.stringify({ ok: false, code: 'MISSING_PROVIDER_SECRET', message: 'OpenRouter key is not configured on the server.' }), { status: 503, headers: { 'Content-Type': 'application/json' } })
    }

    // Sticky routing: if an earlier turn handed this dialogue to another agent, keep using it.
    let effectiveAgent = agent
    if (!channel.sub_agent_id && dialogue.agent_id && dialogue.agent_id !== agent.id) {
      const { data: ra } = await db.from('agents').select('*').eq('id', dialogue.agent_id).eq('account_id', agent.account_id).maybeSingle()
      if (ra && (ra.status ?? 'active') === 'active') effectiveAgent = ra
    }

    // Per-sub-agent bot: reply in that specialist's own persona (may consult a teammate).
    const reply = channel.sub_agent_id
      ? await subAgentReply(db, agent, channel.sub_agent_id, dialogue.id)
      : await buildReply(db, OPENROUTER_API_KEY, effectiveAgent, dialogue.id)

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
