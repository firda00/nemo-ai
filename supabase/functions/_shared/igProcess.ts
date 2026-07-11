// Shared Instagram processing — called by the webhook (legacy) and the durable-queue worker.
// Given a channel id + the raw Meta (Messenger-format) webhook body, it processes each inbound
// DM: dedup, dialogue upsert, agent reply, and send. Signature is verified before enqueue.
import { buildReply } from './agent.ts'
import { igSend } from './meta.ts'
import { isRegulatedAgent } from './riskPolicy.ts'

const OPENROUTER_API_KEY = Deno.env.get('OPENROUTER_API_KEY') ?? ''
const MAX_MSG = 4000

/* eslint-disable @typescript-eslint/no-explicit-any */
export async function processInstagramBody(db: any, channelId: string, body: any): Promise<void> {
  const { data: channel } = await db.from('channels').select('*, agents(*)').eq('id', channelId).single()
  if (!channel) return
  const agent = channel.agents
  const creds = channel.credentials ?? {}
  if (isRegulatedAgent(agent)) {
    await db.from('channels').update({ status: 'safety_blocked' }).eq('id', channelId)
    return
  }

  for (const entry of body?.entry ?? []) {
    for (const ev of entry.messaging ?? []) {
      const text = ev.message?.text?.slice(0, MAX_MSG)
      const senderId = ev.sender?.id
      if (!text || !senderId || ev.message?.is_echo) continue
      const mid = ev.message?.mid
      if (mid) { const { error: dup } = await db.from('webhook_dedup').insert({ channel_id: channelId, msg_id: String(mid) }); if (dup) continue }

      let { data: dialogue } = await db.from('dialogues').select('*').eq('channel_id', channelId).eq('external_id', senderId).maybeSingle()
      if (!dialogue) {
        const ins = await db.from('dialogues').insert({ agent_id: agent.id, channel_id: channelId, channel: 'instagram', external_id: senderId, customer_name: 'Instagram', customer_contact: senderId, status: 'open' }).select('*').single()
        dialogue = ins.data
      }

      await db.from('messages').insert({ dialogue_id: dialogue.id, author: 'customer', content: text })
      if (dialogue.operator_takeover || agent.status === 'paused') continue
      if (!OPENROUTER_API_KEY) { await db.from('dialogues').update({ status: 'needs_operator' }).eq('id', dialogue.id); continue }

      const reply = await buildReply(db, OPENROUTER_API_KEY, agent, dialogue.id)
      if (reply && creds.page_token) {
        await igSend(creds.page_token, senderId, reply)
      } else if (!reply) {
        await db.from('dialogues').update({ status: 'needs_operator' }).eq('id', dialogue.id)
      }
    }
  }
}
/* eslint-enable @typescript-eslint/no-explicit-any */
