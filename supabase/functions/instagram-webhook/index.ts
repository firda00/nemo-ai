// Instagram messaging webhook (Meta Graph / Messenger format).
// URL form: https://<ref>.supabase.co/functions/v1/instagram-webhook/<channel_id>
// GET -> Meta verification, POST -> inbound DMs.
// channel.credentials = { page_token, ig_id }; channel.secret_token = verify token.
//
// POST path: verify Meta's signature + ack 200 fast, then EITHER enqueue the body to the durable
// pgmq queue (IG_QUEUE=1 → the shared lease-serialized, rate-capped worker does the LLM work) OR
// process inline (legacy waitUntil). The flag makes this a reversible canary; dedup by message id
// keeps the fast ack safe against Meta redelivery.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { processInstagramBody } from '../_shared/igProcess.ts'
import { verifyMetaSignature } from '../_shared/meta.ts'
import { timingSafeEqual } from '../_shared/safeEqual.ts'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const CRON_SECRET = Deno.env.get('WATCH_CRON_SECRET') ?? Deno.env.get('CRON_SECRET') ?? ''
const META_APP_SECRET = Deno.env.get('META_APP_SECRET') ?? ''
const IG_QUEUE = Deno.env.get('IG_QUEUE') === '1'
const WORKER_URL = `${SUPABASE_URL}/functions/v1/agent-worker`

Deno.serve(async (req) => {
  const url = new URL(req.url)
  const channelId = url.pathname.split('/').filter(Boolean).pop()
  const db = createClient(SUPABASE_URL, SERVICE_ROLE)

  const { data: channel } = await db.from('channels').select('id, secret_token').eq('id', channelId).single()
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

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rt = (globalThis as any).EdgeRuntime
    if (IG_QUEUE) {
      // DURABLE QUEUE: persist the whole webhook body as one job, nudge the shared worker, ack now.
      await db.rpc('q_send', { payload: { kind: 'instagram', channel_id: channelId, body } })
      const nudge = fetch(WORKER_URL, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-cron-secret': CRON_SECRET }, body: JSON.stringify({ action: 'drain' }) }).then(() => {}).catch(() => {})
      if (rt?.waitUntil) rt.waitUntil(nudge)
      return new Response('ok')
    }

    // Legacy: ack-then-process inline in the background.
    const run = processInstagramBody(db, channelId!, body).catch((e: unknown) => console.error('instagram bg error:', e))
    if (rt?.waitUntil) rt.waitUntil(run); else await run
    return new Response('ok')
  } catch (e) {
    console.error('instagram webhook error:', e)
    return new Response('ok')
  }
})
