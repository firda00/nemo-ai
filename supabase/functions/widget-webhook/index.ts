// Website widget inbound. The embedded chat widget POSTs a visitor's message here and
// gets the agent's reply back as JSON (there's no bot to push through — the widget renders
// the reply). Public (verify_jwt=false) with open CORS since it's called from the client's
// own website. One dialogue per session_id; the agent's full runtime (RAG, memory, tools,
// team, escalation) runs via buildReply, same as the Telegram/WhatsApp channels.
//
//   POST /functions/v1/widget-webhook/<channel_id>
//   body { message, session_id }  ->  { ok, reply, status }
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.108.2'
import { buildReply } from '../_shared/agent.ts'
import { corsPreflight, json } from '../_shared/cors.ts'
import { isRegulatedAgent, REGULATED_CHANNEL_ERROR } from '../_shared/riskPolicy.ts'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const OPENROUTER_API_KEY = Deno.env.get('OPENROUTER_API_KEY') ?? ''

const WAIT = 'Секунду, оператор скоро подключится.'

Deno.serve(async (req) => {
  const preflight = corsPreflight(req)
  if (preflight) return preflight
  const db = createClient(SUPABASE_URL, SERVICE_ROLE)
  try {
    const channelId = new URL(req.url).pathname.split('/').filter(Boolean).pop() ?? ''
    const body = await req.json().catch(() => ({}))
    const text = String(body?.message ?? '').trim().slice(0, 4000)
    const session = String(body?.session_id ?? '').trim().slice(0, 100)
    if (!channelId || !text || !session) return json({ error: 'channel_id, message and session_id required' }, 400)

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: channel } = await db.from('channels').select('*, agents(*)').eq('id', channelId).eq('type', 'widget').maybeSingle() as { data: any }
    if (!channel || !channel.agents) return json({ error: 'widget not found' }, 404)
    const agent = channel.agents
    if (isRegulatedAgent(agent)) {
      await db.from('channels').update({ status: 'safety_blocked' }).eq('id', channelId)
      return json({ error: REGULATED_CHANNEL_ERROR, code: 'REGULATED_CHANNEL_BLOCKED' }, 403)
    }

    // one dialogue per widget session
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let { data: dialogue } = await db.from('dialogues').select('*').eq('channel_id', channelId).eq('external_id', session).maybeSingle() as { data: any }
    if (!dialogue) {
      const ins = await db.from('dialogues').insert({
        agent_id: agent.id, channel_id: channelId, channel: 'widget', external_id: session,
        customer_name: 'Веб-посетитель', status: 'open',
      }).select('*').single()
      dialogue = ins.data
      // lost the race on unique(channel_id, external_id)? the other request created it — re-read
      if (!dialogue) {
        const re = await db.from('dialogues').select('*').eq('channel_id', channelId).eq('external_id', session).maybeSingle()
        dialogue = re.data
      }
    }
    if (!dialogue) return json({ error: 'dialogue_failed' }, 500)

    await db.from('messages').insert({ dialogue_id: dialogue.id, author: 'customer', content: text })
    if (dialogue.status === 'resolved') await db.from('dialogues').update({ status: 'open' }).eq('id', dialogue.id)

    // operator handling the chat, agent paused, or no LLM key -> ask the visitor to wait
    if (dialogue.operator_takeover || agent.status === 'paused' || !OPENROUTER_API_KEY) {
      await db.from('dialogues').update({ status: 'needs_operator' }).eq('id', dialogue.id)
      return json({ ok: true, reply: WAIT, status: 'needs_operator' })
    }

    // full agent runtime (buildReply saves the agent message + accounts tokens itself)
    const reply = await buildReply(db, OPENROUTER_API_KEY, agent, dialogue.id)
    if (reply) return json({ ok: true, reply, status: 'open' })
    await db.from('dialogues').update({ status: 'needs_operator' }).eq('id', dialogue.id)
    return json({ ok: true, reply: WAIT, status: 'needs_operator' })
  } catch (e) {
    return json({ ok: false, error: String(e).slice(0, 200) }, 500)
  }
})
