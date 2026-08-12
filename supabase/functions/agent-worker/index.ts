// Durable-queue worker for ALL channels (#8). Drains the pgmq 'tg_jobs' queue and dispatches each
// job by kind — Telegram, WhatsApp, Instagram — to its shared processor. A DB LEASE makes exactly
// ONE worker drain at a time (advisory locks don't survive Supabase's transaction pooler), and an
// internal concurrency cap bounds simultaneous OpenRouter calls GLOBALLY across every channel — so
// a 1000-message burst on any front can never fan out into a 429 storm.
// Triggered by the webhooks (low latency) and by pg_cron (safety net). Auth: x-cron-secret.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.108.2'
import { processTelegramUpdate } from '../_shared/tgProcess.ts'
import { entitlementFor } from '../_shared/entitlement.ts'
import { processWhatsAppBody } from '../_shared/waProcess.ts'
import { processInstagramBody } from '../_shared/igProcess.ts'
import { json } from '../_shared/cors.ts'
import { blocksExternalActions } from '../_shared/productionE2E.ts'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const CRON_SECRET = Deno.env.get('WATCH_CRON_SECRET') ?? Deno.env.get('CRON_SECRET') ?? ''
const CONCURRENCY = 6      // global token bucket: max simultaneous OpenRouter calls
const LEASE_SECS = 55      // one drainer at a time; time budget below stays under this
const TIME_BUDGET_MS = 40_000

/* eslint-disable @typescript-eslint/no-explicit-any */
Deno.serve(async (req) => {
  const secret = req.headers.get('x-cron-secret')
  const auth = req.headers.get('Authorization') ?? ''
  if (!CRON_SECRET || (secret !== CRON_SECRET && auth !== `Bearer ${SERVICE_ROLE}`)) return new Response('forbidden', { status: 403 })

  const db = createClient(SUPABASE_URL, SERVICE_ROLE)
  const { data: gotLease } = await db.rpc('acquire_worker_lease', { secs: LEASE_SECS })
  if (gotLease !== true) return json({ ok: true, skipped: 'another worker is draining' })

  let processed = 0, blocked = 0, errors = 0, batches = 0
  const deadline = Date.now() + TIME_BUDGET_MS
  try {
    while (Date.now() < deadline) {
      const { data: msgs, error } = await db.rpc('q_read', { qty: 30, vt: 120 })
      if (error) { console.error('q_read error:', error.message); break }
      const jobs: any[] = msgs ?? []
      if (!jobs.length) break
      batches++
      const queue = [...jobs]
      const work = async (m: any) => {
        const p = m.message ?? {}
        const kind = p.kind ?? 'telegram' // legacy tg jobs carried no kind
        try {
          const { data: channel } = p.channel_id
            ? await db.from('channels').select('agent_id').eq('id', p.channel_id).maybeSingle()
            : { data: null }
          const { data: agent } = channel?.agent_id
            ? await db.from('agents').select('account_id').eq('id', channel.agent_id).maybeSingle()
            : { data: null }
          // Подписка проверяется ЗДЕСЬ, а не только на входе.
          //
          // Замок стоял на трёх дверях, куда стучится человек: генерация карточки, отправка
          // сводки, нажатие ценовой кнопки. А эта очередь вызывает модель без всякого обращения
          // владельца — сообщение, поставленное в неё до истечения срока, спокойно тратило деньги
          // после. Оплата закрывала три двери, а дом стоял открытым.
          //
          // Заблокированное сообщение УДАЛЯЕТСЯ, а не оставляется в очереди: pgmq вернёт его через
          // время видимости, и аккаунт без подписки крутил бы одну и ту же задачу вечно.
          const stopped = !agent?.account_id
            || await blocksExternalActions(db, agent.account_id)
            || !(await entitlementFor(db, agent.account_id)).allowed
          if (stopped) {
            const { error: deleteError } = await db.rpc('q_delete', { mid: m.msg_id })
            if (deleteError) throw new Error(`blocked job delete failed: ${deleteError.message}`)
            blocked++
            return
          }

          if (kind === 'whatsapp') await processWhatsAppBody(db, p.channel_id, p.body)
          else if (kind === 'instagram') await processInstagramBody(db, p.channel_id, p.body)
          else await processTelegramUpdate(db, p.channel_id, p.update)
          await db.rpc('q_delete', { mid: m.msg_id }); processed++
        } catch (e) { errors++; console.error(`worker job error (${kind}):`, e) } // leave in queue -> pgmq re-delivers after vt
      }
      const runner = async () => { while (queue.length) { const m = queue.shift(); if (m) await work(m) } }
      await Promise.all(Array.from({ length: CONCURRENCY }, runner))
    }
  } finally {
    await db.rpc('release_worker_lease')
  }
  return json({ ok: true, processed, blocked, errors, batches })
})
/* eslint-enable @typescript-eslint/no-explicit-any */
