// WhatsApp Cloud API webhook (Meta).
// URL form: https://<ref>.supabase.co/functions/v1/whatsapp-webhook/<channel_id>
// GET  -> Meta verification (hub.challenge), POST -> inbound messages.
// channel.credentials = { phone_number_id, token }; channel.secret_token = verify token.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { buildReply } from '../_shared/agent.ts'
import { waSend } from '../_shared/meta.ts'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const OPENROUTER_API_KEY = Deno.env.get('OPENROUTER_API_KEY')!

function channelIdFromPath(url: URL) {
  return url.pathname.split('/').filter(Boolean).pop()
}

Deno.serve(async (req) => {
  const url = new URL(req.url)
  const channelId = channelIdFromPath(url)
  const db = createClient(SUPABASE_URL, SERVICE_ROLE)

  const { data: channel } = await db.from('channels').select('*, agents(*)').eq('id', channelId).single()
  if (!channel) return new Response('channel not found', { status: 404 })

  // --- Meta verification handshake ---
  if (req.method === 'GET') {
    const mode = url.searchParams.get('hub.mode')
    const token = url.searchParams.get('hub.verify_token')
    const challenge = url.searchParams.get('hub.challenge')
    if (mode === 'subscribe' && token === channel.secret_token) {
      return new Response(challenge ?? '', { status: 200 })
    }
    return new Response('forbidden', { status: 403 })
  }

  try {
    const body = await req.json()
    const agent = channel.agents
    const creds = channel.credentials ?? {}

    const entries = body?.entry ?? []
    for (const entry of entries) {
      for (const change of entry.changes ?? []) {
        const value = change.value ?? {}
        const contacts = value.contacts ?? []
        for (const m of value.messages ?? []) {
          const text = m.text?.body
          if (!text) continue
          const from = String(m.from)
          const name = contacts[0]?.profile?.name ?? from

          let { data: dialogue } = await db
            .from('dialogues')
            .select('*')
            .eq('channel_id', channelId)
            .eq('external_id', from)
            .maybeSingle()
          if (!dialogue) {
            const ins = await db
              .from('dialogues')
              .insert({ agent_id: agent.id, channel_id: channelId, channel: 'whatsapp', external_id: from, customer_name: name, customer_contact: from, status: 'open' })
              .select('*')
              .single()
            dialogue = ins.data
          }

          await db.from('messages').insert({ dialogue_id: dialogue.id, author: 'customer', content: text })
          if (dialogue.operator_takeover || agent.status === 'paused') continue

          const reply = await buildReply(db, OPENROUTER_API_KEY, agent, dialogue.id)
          if (reply && creds.phone_number_id && creds.token) {
            await waSend(creds.phone_number_id, creds.token, from, reply)
          } else if (!reply) {
            await db.from('dialogues').update({ status: 'needs_operator' }).eq('id', dialogue.id)
          }
        }
      }
    }
    return new Response('ok')
  } catch (e) {
    console.error('whatsapp webhook error:', e)
    return new Response('ok')
  }
})
