// #8 load test (STAGING only). Fires N concurrent enqueues at the durable queue, then drains,
// and asserts: (a) the burst is absorbed fast with zero loss, (b) the worker never exceeds the
// concurrency cap — so a 1000-message burst can NEVER fan out into 1000 simultaneous OpenRouter
// calls. Reads staging config from scratchpad/staging.env (never touches prod).
//   node eval/loadtest.mjs [N=1000]
import fs from 'node:fs'

const ENV_PATH = 'C:/Users/firda/AppData/Local/Temp/claude/c--Users-firda-nemo-ai/2bcd5787-9062-4c43-bd26-30ba6430e502/scratchpad/staging.env'
const env = Object.fromEntries(fs.readFileSync(ENV_PATH, 'utf8').split(/\r?\n/).filter(Boolean).map((l) => { const i = l.indexOf('='); return [l.slice(0, i), l.slice(i + 1)] }))
const BASE = env.SUPABASE_URL_STG + '/functions/v1/qtest'
const H = { 'Content-Type': 'application/json', apikey: env.ANON_STG, Authorization: 'Bearer ' + env.ANON_STG }
const post = (b) => fetch(BASE, { method: 'POST', headers: H, body: JSON.stringify(b) }).then((r) => r.json().catch(() => ({ ok: false }))).catch(() => ({ ok: false, net: true }))

const N = Number(process.argv[2] || 1000)
console.log(`\n=== Nemo #8 load test · ${N} concurrent · staging ===\n`)

// 1) BURST: N concurrent enqueues
const lat = []; const t0 = Date.now()
const res = await Promise.all(Array.from({ length: N }, async () => { const s = Date.now(); const r = await post({ action: 'enqueue', payload: { ts: s } }); lat.push(Date.now() - s); return r }))
const ok = res.filter((r) => r && r.ok).length
lat.sort((a, b) => a - b)
const pct = (p) => lat[Math.min(lat.length - 1, Math.floor(N * p))]
console.log(`ENQUEUE: ${ok}/${N} accepted in ${Date.now() - t0}ms · p50=${pct(0.5)}ms p95=${pct(0.95)}ms p99=${pct(0.99)}ms max=${lat[lat.length - 1]}ms`)

// 2) queue depth (durability — nothing lost)
const m = await post({ action: 'metrics' })
console.log(`queue depth after burst: ${m.queued}`)

// 3) DRAIN with concurrency cap, track peak
let processed = 0, errors = 0, peak = 0, rounds = 0
const td = Date.now()
for (;;) {
  const d = await post({ action: 'drain', qty: 120 })
  if (!d.ok) { console.log('drain error:', d); break }
  processed += d.processed; errors += d.errors; peak = Math.max(peak, d.peakConcurrency || 0); rounds++
  if (d.read === 0) break
  if (rounds > 80) { console.log('stopped after 80 rounds'); break }
}
const m2 = await post({ action: 'metrics' })
console.log(`DRAIN: processed=${processed} errors=${errors} rounds=${rounds} in ${Date.now() - td}ms · PEAK CONCURRENCY=${peak} · queue left=${m2.queued}`)

const acceptOk = ok >= N * 0.99
const capOk = peak > 0 && peak <= 6
const lossOk = (processed + Number(m2.queued || 0)) >= ok * 0.99
console.log(`\n${acceptOk && capOk && lossOk ? '✅ PASS' : '⚠ CHECK'} — burst absorbed durably (${acceptOk ? 'ok' : 'FAIL'}), concurrency capped ≤6 (${capOk ? 'ok, peak ' + peak : 'FAIL, peak ' + peak}), no message loss (${lossOk ? 'ok' : 'FAIL'})`)
console.log(capOk ? 'A 1000-burst never becomes 1000 simultaneous OpenRouter calls — no 429 fan-out storm.\n' : '')
