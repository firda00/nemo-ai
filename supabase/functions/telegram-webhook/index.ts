// Telegram inbound webhook. Verifies Telegram's secret token + dedups the update, then EITHER
// enqueues the update to the durable pgmq queue (TG_QUEUE=1 → a lease-serialized, rate-capped
// worker does the heavy LLM work, so a burst can never fan out into 1000 concurrent calls) OR
// processes it inline in the background (legacy waitUntil path). The flag makes this a reversible
// canary. Public (verify_jwt = false) — authenticity is Telegram's secret token.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { processTelegramUpdate } from '../_shared/tgProcess.ts'
import { timingSafeEqual } from '../_shared/safeEqual.ts'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const CRON_SECRET = Deno.env.get('WATCH_CRON_SECRET') ?? Deno.env.get('CRON_SECRET') ?? ''
const TG_QUEUE = Deno.env.get('TG_QUEUE') === '1'
const WORKER_URL = `${SUPABASE_URL}/functions/v1/agent-worker`

Deno.serve(async (req) => {
  try {
    const url = new URL(req.url)
    const channelId = url.pathname.split('/').filter(Boolean).pop()
    if (!channelId) return new Response('no channel', { status: 400 })

    const db = createClient(SUPABASE_URL, SERVICE_ROLE)
    const { data: channel } = await db.from('channels').select('id, secret_token').eq('id', channelId).single()
    if (!channel) return new Response('channel not found', { status: 404 })

    const secret = req.headers.get('x-telegram-bot-api-secret-token')
    if (!channel.secret_token || !timingSafeEqual(secret, channel.secret_token)) return new Response('forbidden', { status: 403 })

    const update = await req.json()

    // Idempotency (Telegram re-delivers without a fast 200). Skip a recent duplicate.
    const updateId = update?.update_id
    if (typeof updateId === 'number') {
      const GRACE_MS = 120_000
      const { data: seen } = await db.from('tg_updates').select('created_at').eq('channel_id', channelId).eq('update_id', updateId).maybeSingle()
      if (seen && Date.now() - Date.parse(seen.created_at) < GRACE_MS) return new Response('ok')
      await db.from('tg_updates').upsert({ channel_id: channelId, update_id: updateId, created_at: new Date().toISOString() }, { onConflict: 'channel_id,update_id' })
    }
    if (!update?.message) return new Response('ok')

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rt = (globalThis as any).EdgeRuntime
    if (TG_QUEUE) {
      // DURABLE QUEUE: persist the job, nudge the worker, ack immediately (no inline LLM work).
      await db.rpc('q_send', { payload: { kind: 'telegram', channel_id: channelId, update } })
      const nudge = fetch(WORKER_URL, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-cron-secret': CRON_SECRET }, body: JSON.stringify({ action: 'drain' }) }).then(() => {}).catch(() => {})
      if (rt?.waitUntil) rt.waitUntil(nudge)
      return new Response('ok')
    }

    // Legacy: ack-then-process inline in the background.
    const run = processTelegramUpdate(db, channelId, update).catch((e: unknown) => console.error('tg bg error:', e))
    if (rt?.waitUntil) rt.waitUntil(run); else await run
    return new Response('ok')
  } catch (e) {
    console.error('telegram webhook error:', e)
    return new Response('ok')
  }
})
