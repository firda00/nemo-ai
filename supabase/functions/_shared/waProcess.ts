// Shared WhatsApp processing — called by the webhook (legacy) and the durable-queue worker.
// Given a channel id + the raw Meta webhook body, it processes each inbound message: dedup,
// dialogue upsert, agent reply, and send. Signature is verified at the webhook before enqueue.
import { buildReply } from './agent.ts'
import { waSend } from './meta.ts'
import { isRegulatedAgent } from './riskPolicy.ts'

const OPENROUTER_API_KEY = Deno.env.get('OPENROUTER_API_KEY') ?? ''
const MAX_MSG = 4000

/* eslint-disable @typescript-eslint/no-explicit-any */
export async function processWhatsAppBody(db: any, channelId: string, body: any): Promise<void> {
  const { data: channel } = await db.from('channels').select('*, agents(*)').eq('id', channelId).single()
  if (!channel) return
  const agent = channel.agents
  const creds = channel.credentials ?? {}
  if (isRegulatedAgent(agent)) {
    await db.from('channels').update({ status: 'safety_blocked' }).eq('id', channelId)
    return
  }

  for (const entry of body?.entry ?? []) {
    for (const change of entry.changes ?? []) {
      const value = change.value ?? {}
      const contacts = value.contacts ?? []
      for (const m of value.messages ?? []) {
        const text = m.text?.body?.slice(0, MAX_MSG)
        if (!text) continue
        // idempotency: skip a message id already processed (Meta may redeliver)
        if (m.id) { const { error: dup } = await db.from('webhook_dedup').insert({ channel_id: channelId, msg_id: String(m.id) }); if (dup) continue }
        const from = String(m.from)
        const name = contacts[0]?.profile?.name ?? from

        let { data: dialogue } = await db.from('dialogues').select('*').eq('channel_id', channelId).eq('external_id', from).maybeSingle()
        if (!dialogue) {
          const ins = await db.from('dialogues').insert({ agent_id: agent.id, channel_id: channelId, channel: 'whatsapp', external_id: from, customer_name: name, customer_contact: from, status: 'open' }).select('*').single()
          dialogue = ins.data
        }

        await db.from('messages').insert({ dialogue_id: dialogue.id, author: 'customer', content: text })
        if (dialogue.operator_takeover || agent.status === 'paused') continue
        if (!OPENROUTER_API_KEY) { await db.from('dialogues').update({ status: 'needs_operator' }).eq('id', dialogue.id); continue }

        const reply = await buildReply(db, OPENROUTER_API_KEY, agent, dialogue.id)
        if (reply && creds.phone_number_id && creds.token) {
          await waSend(creds.phone_number_id, creds.token, from, reply)
        } else if (!reply) {
          await db.from('dialogues').update({ status: 'needs_operator' }).eq('id', dialogue.id)
        }
      }
    }
  }
}
/* eslint-enable @typescript-eslint/no-explicit-any */
