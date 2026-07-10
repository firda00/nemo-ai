// #8 load-test rig (STAGING). Proves the durable-queue + token-bucket backpressure design:
//   • enqueue: pgmq.send -> fast 200 (a burst is absorbed durably, survives isolate death)
//   • drain:   read a batch, process with a HARD concurrency cap (the global token bucket), so no
//              matter how big the burst, OpenRouter never sees more than CONCURRENCY calls at once.
//   • metrics: current queue depth.
// The worker does a real (1-token) OpenRouter call per job to prove the paced real path holds;
// failed jobs are left in the queue and pgmq re-delivers them after the visibility timeout (retry).
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const URL = Deno.env.get('SUPABASE_URL')!
const SVC = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const OR = Deno.env.get('OPENROUTER_API_KEY') ?? ''
const CONCURRENCY = 6 // global token bucket: max simultaneous OpenRouter calls across the drain

Deno.serve(async (req) => {
  const db = createClient(URL, SVC)
  const body = await req.json().catch(() => ({}))
  const action = String(body?.action ?? '')

  if (action === 'enqueue') {
    const { data, error } = await db.rpc('q_send', { payload: body?.payload ?? { t: Date.now() } })
    return new Response(JSON.stringify(error ? { ok: false, error: error.message } : { ok: true, id: data }), { status: error ? 500 : 200, headers: { 'Content-Type': 'application/json' } })
  }

  if (action === 'metrics') {
    const { data, error } = await db.rpc('q_len')
    return new Response(JSON.stringify(error ? { ok: false, error: error.message } : { ok: true, queued: Number(data) }), { headers: { 'Content-Type': 'application/json' } })
  }

  if (action === 'drain') {
    const qty = Math.min(Number(body?.qty) || 120, 500)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: msgs, error } = await db.rpc('q_read', { qty, vt: 60 })
    if (error) return new Response(JSON.stringify({ ok: false, error: error.message }), { status: 500, headers: { 'Content-Type': 'application/json' } })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const jobs: any[] = msgs ?? []
    let processed = 0, errors = 0, peak = 0, active = 0
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const work = async (m: any) => {
      active++; peak = Math.max(peak, active)
      try {
        const r = await fetch('https://openrouter.ai/api/v1/chat/completions', { method: 'POST', headers: { Authorization: `Bearer ${OR}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ model: 'openai/gpt-4o-mini', max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] }) })
        if (r.ok) { await db.rpc('q_delete', { mid: m.msg_id }); processed++ }
        else { errors++ } // leave in queue -> pgmq re-delivers after vt (durable retry, no loss)
      } catch { errors++ } finally { active-- }
    }
    const queue = [...jobs]
    const runner = async () => { while (queue.length) { const m = queue.shift(); if (m) await work(m) } }
    await Promise.all(Array.from({ length: CONCURRENCY }, runner))
    return new Response(JSON.stringify({ ok: true, read: jobs.length, processed, errors, peakConcurrency: peak, cap: CONCURRENCY }), { headers: { 'Content-Type': 'application/json' } })
  }

  return new Response(JSON.stringify({ ok: false, error: 'unknown action' }), { status: 400, headers: { 'Content-Type': 'application/json' } })
})
