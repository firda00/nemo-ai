// Shared Telegram update processing — called BOTH by the webhook (legacy waitUntil path) and by
// the queue worker (durable pgmq path). Given a channel id + the raw Telegram update, it runs the
// full flow: voice transcription, group task-bot, DM task-completion, customer dialogue + reply.
// Extracted so the webhook can just enqueue and a rate-capped worker does the heavy LLM work.
import { buildReply, buildSubAgentReply } from './agent.ts'
import { tgSend } from './telegram.ts'
import { handleTaskBot, handleTeamCompletionDM } from './taskbot.ts'
import { resolveOpenRouterKey } from './keys.ts'
import { planOf } from './plans.ts'
import { transcribeAudio } from './transcribe.ts'
import { isRegulatedAgent } from './riskPolicy.ts'

const OPENROUTER_API_KEY = Deno.env.get('OPENROUTER_API_KEY') ?? ''
const MAX_MSG = 4000

// Friendly note when a voice message can't be turned into text (too big, or transcription failed).
// Telegram lets a BOT download files only up to 20 MB — that's the hard ceiling for voice size.
const VOICE_MSG = {
  uz: { long: '🎙 Ovozli xabar juda katta — Telegram bot faqat 20 MB gacha faylni yuklab oladi. Iltimos, qisqaroq ovozli yoki matn yuboring.', fail: '🎙 Ovozli xabarni oʻqiy olmadim. Iltimos, matn koʻrinishida yoki qisqaroq ovozli yuboring.' },
  ru: { long: '🎙 Голосовое слишком большое — Telegram отдаёт боту файлы только до 20 МБ. Отправьте голосовое покороче или текстом.', fail: '🎙 Не смог распознать голосовое. Отправьте текстом или более коротким голосовым.' },
  en: { long: '🎙 The voice message is too large — Telegram only lets a bot download files up to 20 MB. Please send a shorter voice note or text.', fail: '🎙 I couldn’t transcribe that voice message. Please send text or a shorter voice note.' },
}

/* eslint-disable @typescript-eslint/no-explicit-any */

// Reply as a specific sub-agent (its own bot), then persist the message + usage.
async function subAgentReply(db: any, agent: any, subId: string, dialogueId: string): Promise<string> {
  const { data: sub } = await db.from('sub_agents').select('*').eq('id', subId).maybeSingle()
  if (!sub || (sub.status && sub.status !== 'active')) return ''
  const { data: acc } = await db.from('accounts').select('token_balance, plan').eq('id', agent.account_id).single()
  if (acc && Number(acc.token_balance) <= 0) return ''
  const { data: history } = await db.from('messages').select('author, content').eq('dialogue_id', dialogueId).eq('message_type', 'chat').order('created_at', { ascending: false }).limit(20)
  const chronological = (history ?? []).slice().reverse()
  const apiKey = await resolveOpenRouterKey(db, agent.account_id, OPENROUTER_API_KEY)
  // the sub-agent's saved model runs through the same plan gate as every other path
  const { text, tokens } = await buildSubAgentReply(db, apiKey, sub, chronological, planOf(acc?.plan).premium)
  if (text) {
    await db.from('messages').insert({ dialogue_id: dialogueId, author: 'agent', content: text })
    await db.from('usage').insert({ account_id: agent.account_id, tokens, model: null, stage: 'subagent' })
    if (tokens) await db.rpc('decrement_token_balance', { p_account: agent.account_id, p_amount: tokens })
  }
  return text
}

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

// Full processing of ONE Telegram update for a channel. Safe to run in the background / a worker.
export async function processTelegramUpdate(db: any, channelId: string, update: any): Promise<void> {
  const { data: channel } = await db.from('channels').select('*, agents(*)').eq('id', channelId).single()
  if (!channel) return
  const msg = update?.message
  if (!msg) return
  const isGroupChat = msg.chat?.type === 'group' || msg.chat?.type === 'supergroup'

  const chatId = String(msg.chat.id)
  const customerName = [msg.from?.first_name, msg.from?.last_name].filter(Boolean).join(' ') || msg.from?.username || 'Telegram'
  const botToken = channel.credentials?.bot_token
  const botUsername = channel.credentials?.username ?? ''
  const agent = channel.agents
  if (isRegulatedAgent(agent)) {
    await db.from('channels').update({ status: 'safety_blocked' }).eq('id', channelId)
    return
  }

  let text = msg.text ? String(msg.text).slice(0, MAX_MSG) : (msg.caption ? String(msg.caption).slice(0, MAX_MSG) : '')
  const voice = msg.voice ?? msg.audio
  let voiceProblem: 'long' | 'fail' | null = null
  if (!text && voice?.file_id && botToken && OPENROUTER_API_KEY && agent?.account_id) {
    // Telegram bots can only download files up to 20 MB — that's the real ceiling. Duration up to
    // ~3h is fine as long as the file fits under it (low-bitrate voice notes usually do).
    const tooBig = (voice.duration && voice.duration > 3 * 3600) || (voice.file_size && voice.file_size > 19 * 1024 * 1024)
    if (tooBig) {
      voiceProblem = 'long'
    } else {
      try {
        const orKey = await resolveOpenRouterKey(db, agent.account_id, OPENROUTER_API_KEY)
        const b64 = await downloadTelegramFile(botToken, voice.file_id)
        if (b64) {
          text = String(await transcribeAudio(
            orKey,
            b64,
            'ogg',
            agent?.default_lang ?? 'auto',
            agent?.stt_model ?? 'auto',
          )).slice(0, MAX_MSG)
        }
      } catch { /* voice transcription is best-effort */ }
      if (!text) voiceProblem = 'fail'
    }
    if (text) msg.text = text
  }
  // A voice we couldn't turn into text -> tell the user instead of staying silent. DMs only, so we
  // don't add noise to groups (the group task-bot only acts on @mentions anyway).
  if (voice && !text && voiceProblem && botToken && !isGroupChat) {
    const vlang: 'uz' | 'ru' | 'en' = agent?.default_lang === 'ru' ? 'ru' : agent?.default_lang === 'en' ? 'en' : 'uz'
    await tgSend(botToken, chatId, VOICE_MSG[vlang][voiceProblem])
    return
  }
  const hasAttachment = (Array.isArray(msg.photo) && msg.photo.length > 0) || Boolean(msg.document?.file_id)
  if (!text && !hasAttachment) return

  // GROUP task-bot
  if (channel.scope === 'group' || isGroupChat) {
    if (botToken && OPENROUTER_API_KEY && agent?.account_id) {
      const apiKey = await resolveOpenRouterKey(db, agent.account_id, OPENROUTER_API_KEY)
      await handleTaskBot(db, apiKey, channel, agent.account_id, botToken, botUsername, msg)
    }
    return
  }

  // DM task-completion report
  if (botToken && OPENROUTER_API_KEY && agent?.account_id && !channel.sub_agent_id) {
    try {
      const apiKey = await resolveOpenRouterKey(db, agent.account_id, OPENROUTER_API_KEY)
      if (await handleTeamCompletionDM(db, apiKey, channel, agent.account_id, botToken, msg)) return
    } catch { /* fall through to normal reply flow */ }
  }
  if (!text) return

  let { data: dialogue } = await db.from('dialogues').select('*').eq('channel_id', channelId).eq('external_id', chatId).maybeSingle()
  if (!dialogue) {
    const ins = await db.from('dialogues').insert({
      agent_id: agent.id, channel_id: channelId, channel: 'telegram', external_id: chatId,
      customer_name: customerName, customer_contact: msg.from?.username ? '@' + msg.from.username : chatId, status: 'open',
    }).select('*').single()
    dialogue = ins.data
  }

  await db.from('messages').insert({ dialogue_id: dialogue.id, author: 'customer', content: text })
  await db.from('dialogues').update({ status: dialogue.status === 'resolved' ? 'open' : dialogue.status }).eq('id', dialogue.id)

  if (dialogue.operator_takeover) return
  if (agent.status === 'paused') return
  if (!OPENROUTER_API_KEY) {
    await db.from('dialogues').update({ status: 'needs_operator' }).eq('id', dialogue.id)
    if (botToken) await tgSend(botToken, chatId, 'OpenRouter key is not configured on the server. Operator will join shortly.')
    return
  }

  // Sticky routing: keep an earlier hand-off target
  let effectiveAgent = agent
  if (!channel.sub_agent_id && dialogue.agent_id && dialogue.agent_id !== agent.id) {
    const { data: ra } = await db.from('agents').select('*').eq('id', dialogue.agent_id).eq('account_id', agent.account_id).maybeSingle()
    if (ra && (ra.status ?? 'active') === 'active') effectiveAgent = ra
  }

  const reply = channel.sub_agent_id
    ? await subAgentReply(db, agent, channel.sub_agent_id, dialogue.id)
    : await buildReply(db, OPENROUTER_API_KEY, effectiveAgent, dialogue.id)

  if (reply) {
    if (botToken) await tgSend(botToken, chatId, reply)
  } else {
    await db.from('dialogues').update({ status: 'needs_operator' }).eq('id', dialogue.id)
    if (botToken) await tgSend(botToken, chatId, 'Bir lahza, operator ulanadi. / Секунду, оператор скоро подключится.')
  }
}
/* eslint-enable @typescript-eslint/no-explicit-any */
