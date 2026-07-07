// Instagram messaging webhook (Meta Graph / Messenger format).
// URL form: https://<ref>.supabase.co/functions/v1/instagram-webhook/<channel_id>
// GET -> Meta verification, POST -> inbound DMs.
// channel.credentials = { page_token, ig_id }; channel.secret_token = verify token.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { buildReply } from '../_shared/agent.ts'
import { igSend, verifyMetaSignature } from '../_shared/meta.ts'
import { timingSafeEqual } from '../_shared/safeEqual.ts'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const OPENROUTER_API_KEY = Deno.env.get('OPENROUTER_API_KEY') ?? ''
const META_APP_SECRET = Deno.env.get('META_APP_SECRET') ?? ''
const MAX_MSG = 4000

Deno.serve(async (req) => {
  const url = new URL(req.url)
  const channelId = url.pathname.split('/').filter(Boolean).pop()
  const db = createClient(SUPABASE_URL, SERVICE_ROLE)

  const { data: channel } = await db.from('channels').select('*, agents(*)').eq('id', channelId).single()
  if (!channel) return new Response('channel not found', { status: 404 })

  if (req.method === 'GET') {
    const mode = url.searchParams.get('hub.mode')
    const token = url.searchParams.get('hub.verify_token')
    const challenge = url.searchParams.get('hub.challenge')
    if (mode === 'subscribe' && channel.secret_token && timingSafeEqual(token, channel.secret_token)) {
      return new Response(challenge ?? '', { status: 200 })
    }
    return new Response('forbidden', { status: 403 })
  }

  try {
    // Authenticity: verify Meta's X-Hub-Signature-256 over the raw body first.
    const raw = await req.text()
    if (!(await verifyMetaSignature(raw, req.headers.get('x-hub-signature-256'), META_APP_SECRET))) {
      return new Response('invalid signature', { status: 401 })
    }
    const body = JSON.parse(raw)
    const agent = channel.agents
    const creds = channel.credentials ?? {}

    for (const entry of body?.entry ?? []) {
      for (const ev of entry.messaging ?? []) {
        const text = ev.message?.text?.slice(0, MAX_MSG)
        const senderId = ev.sender?.id
        if (!text || !senderId || ev.message?.is_echo) continue

        let { data: dialogue } = await db
          .from('dialogues')
          .select('*')
          .eq('channel_id', channelId)
          .eq('external_id', senderId)
          .maybeSingle()
        if (!dialogue) {
          const ins = await db
            .from('dialogues')
            .insert({ agent_id: agent.id, channel_id: channelId, channel: 'instagram', external_id: senderId, customer_name: 'Instagram', customer_contact: senderId, status: 'open' })
            .select('*')
            .single()
          dialogue = ins.data
        }

        await db.from('messages').insert({ dialogue_id: dialogue.id, author: 'customer', content: text })
        if (dialogue.operator_takeover || agent.status === 'paused') continue
        if (!OPENROUTER_API_KEY) {
          await db.from('dialogues').update({ status: 'needs_operator' }).eq('id', dialogue.id)
          continue
        }

        const reply = await buildReply(db, OPENROUTER_API_KEY, agent, dialogue.id)
        if (reply && creds.page_token) {
          await igSend(creds.page_token, senderId, reply)
        } else if (!reply) {
          await db.from('dialogues').update({ status: 'needs_operator' }).eq('id', dialogue.id)
        }
      }
    }
    return new Response('ok')
  } catch (e) {
    console.error('instagram webhook error:', e)
    return new Response('ok')
  }
})
