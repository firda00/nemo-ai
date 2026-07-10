// WhatsApp Cloud API webhook (Meta).
// URL form: https://<ref>.supabase.co/functions/v1/whatsapp-webhook/<channel_id>
// GET  -> Meta verification (hub.challenge), POST -> inbound messages.
// channel.credentials = { phone_number_id, token }; channel.secret_token = verify token.
//
// POST path: verify Meta's signature + ack 200 fast, then EITHER enqueue the body to the durable
// pgmq queue (WA_QUEUE=1 → the shared lease-serialized, rate-capped worker does the LLM work, so a
// target-driven burst can never fan out into a 429 storm) OR process inline (legacy waitUntil).
// The flag makes this a reversible canary; dedup by message id keeps the fast ack safe.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { processWhatsAppBody } from '../_shared/waProcess.ts'
import { verifyMetaSignature } from '../_shared/meta.ts'
import { timingSafeEqual } from '../_shared/safeEqual.ts'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const CRON_SECRET = Deno.env.get('WATCH_CRON_SECRET') ?? Deno.env.get('CRON_SECRET') ?? ''
const META_APP_SECRET = Deno.env.get('META_APP_SECRET') ?? ''
const WA_QUEUE = Deno.env.get('WA_QUEUE') === '1'
const WORKER_URL = `${SUPABASE_URL}/functions/v1/agent-worker`

Deno.serve(async (req) => {
  const url = new URL(req.url)
  const channelId = url.pathname.split('/').filter(Boolean).pop()
  const db = createClient(SUPABASE_URL, SERVICE_ROLE)

  const { data: channel } = await db.from('channels').select('id, secret_token').eq('id', channelId).single()
  if (!channel) return new Response('channel not found', { status: 404 })

  // --- Meta verification handshake ---
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
    // Authenticity: Meta signs every POST with the App Secret. Verify before trusting the payload.
    const raw = await req.text()
    if (!(await verifyMetaSignature(raw, req.headers.get('x-hub-signature-256'), META_APP_SECRET))) {
      return new Response('invalid signature', { status: 401 })
    }
    const body = JSON.parse(raw)

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rt = (globalThis as any).EdgeRuntime
    if (WA_QUEUE) {
      // DURABLE QUEUE: persist the whole webhook body as one job, nudge the shared worker, ack now.
      await db.rpc('q_send', { payload: { kind: 'whatsapp', channel_id: channelId, body } })
      const nudge = fetch(WORKER_URL, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-cron-secret': CRON_SECRET }, body: JSON.stringify({ action: 'drain' }) }).then(() => {}).catch(() => {})
      if (rt?.waitUntil) rt.waitUntil(nudge)
      return new Response('ok')
    }

    // Legacy: ack-then-process inline in the background.
    const run = processWhatsAppBody(db, channelId!, body).catch((e: unknown) => console.error('whatsapp bg error:', e))
    if (rt?.waitUntil) rt.waitUntil(run); else await run
    return new Response('ok')
  } catch (e) {
    console.error('whatsapp webhook error:', e)
    return new Response('ok')
  }
})
