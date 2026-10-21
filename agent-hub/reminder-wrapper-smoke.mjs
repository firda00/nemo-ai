// REQUEST-WRAPPER smoke for the reminders endpoint and the briefing/reminder worker: the ACTUAL
// Deno.serve handlers run under Node with a stubbed Deno global and a scripted supabase-js —
// real Request objects in, real Response objects out. This is the layer the shared-function
// suites deliberately do not touch:
//   • reminders: missing bearer refused before anything, GET 405, oversized body 413 (the real
//     8KB streamed cap), and a full auth→handler round trip (bad JSON → 400 bad_json);
//   • worker: wrong/missing x-cron-secret 403 (fail closed), unknown kind 400 (never a default
//     drain), oversized body 413, reminder-plan wired to the RPC, and the briefing kill-switch
//     NOT gating reminder kinds (independent switches).
// Offline: no network, no vite, no deploy. Run: npm run test:reminder-wrapper
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'
import esbuild from 'esbuild'

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/(?:[A-Za-z]:)/, (m) => m.slice(1))), '..')
const buildDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nemo-wrapper-smoke-'))

let failed = 0
const check = (name, cond, detail = '') => {
  if (cond) console.log(`[OK] ${name}`)
  else { failed += 1; console.error(`[FAIL] ${name}${detail ? `: ${detail}` : ''}`) }
}

// ── scripted supabase-js: enough client for the wrappers' real dependency wiring ────────────────
const clientScript = { rpcCalls: [] }
globalThis.__wrapperClientScript = clientScript
const stubSource = `
const script = globalThis.__wrapperClientScript
export function createClient(_url, _key, _opts) {
  return {
    auth: { getUser: async () => ({ data: { user: { id: 'user-1' } } }) },
    rpc(name, args) { script.rpcCalls.push({ name, args }); return Promise.resolve(script.rpcResult ?? { data: 5, error: null }) },
    from(table) {
      const chain = {}
      for (const m of ['select', 'eq', 'order', 'limit']) chain[m] = () => chain
      chain.maybeSingle = async () => table === 'users'
        ? { data: { account_id: 'acc-1', role: 'owner', is_admin: false }, error: null }
        : { data: { blocked: false }, error: null }
      chain.then = (ok, err) => Promise.resolve({ data: [], error: null }).then(ok, err)
      return chain
    },
    storage: { from: () => ({}) },
  }
}
`
const stubPath = path.join(buildDir, 'supabase-stub.mjs')
fs.writeFileSync(stubPath, stubSource)

async function bundleWrapper(entry, outName) {
  const outfile = path.join(buildDir, outName)
  await esbuild.build({
    entryPoints: [path.join(root, entry)],
    bundle: true,
    outfile,
    format: 'esm',
    platform: 'node',
    logLevel: 'silent',
    plugins: [{
      name: 'stub-esm-sh',
      setup(build) {
        build.onResolve({ filter: /^https:\/\/esm\.sh\// }, () => ({ path: stubPath }))
      },
    }],
  })
  return outfile
}

// ── Deno stub capturing the serve handler ───────────────────────────────────────────────────────
const ENV = {
  SUPABASE_URL: 'https://stub.local',
  SUPABASE_ANON_KEY: 'anon',
  SUPABASE_SERVICE_ROLE_KEY: 'service',
  CRON_SECRET: 'cron-secret-value',
  DAILY_BRIEFING_DELIVERY: 'off', // the BRIEFING switch — must not gate reminder kinds
}
let handler = null
globalThis.Deno = {
  env: { get: (key) => ENV[key] ?? '' },
  serve: (h) => { handler = h },
}

const jsonOf = async (response) => { try { return await response.json() } catch { return null } }

try {
  // ── reminders endpoint wrapper ────────────────────────────────────────────────────────────────
  handler = null
  await import(pathToFileURL(await bundleWrapper('supabase/functions/reminders/index.ts', 'reminders.mjs')).href)
  check('reminders wrapper registered a serve handler', typeof handler === 'function')
  const reminders = handler

  const noBearer = await reminders(new Request('https://x/reminders', { method: 'POST', body: '{}' }))
  check('reminders: a missing bearer is refused up front (401)', noBearer.status === 401)

  const got = await reminders(new Request('https://x/reminders', { method: 'GET', headers: { Authorization: 'Bearer j' } }))
  check('reminders: GET is 405', got.status === 405)

  const big = await reminders(new Request('https://x/reminders', {
    method: 'POST',
    headers: { Authorization: 'Bearer j' },
    body: 'x'.repeat(9 * 1024), // over the real 8KB streamed cap
  }))
  check('reminders: an oversized body is 413 at the streamed cap', big.status === 413)

  const badJson = await reminders(new Request('https://x/reminders', {
    method: 'POST',
    headers: { Authorization: 'Bearer j' },
    body: 'not json',
  }))
  const badJsonBody = await jsonOf(badJson)
  check('reminders: the full auth→handler round trip answers bad_json (400)',
    badJson.status === 400 && badJsonBody?.error === 'bad_json')

  // ── worker wrapper ────────────────────────────────────────────────────────────────────────────
  handler = null
  await import(pathToFileURL(await bundleWrapper('supabase/functions/daily-briefing-worker/index.ts', 'worker.mjs')).href)
  check('worker wrapper registered a serve handler', typeof handler === 'function')
  const worker = handler
  const post = (body, secret = 'cron-secret-value') => new Request('https://x/worker', {
    method: 'POST',
    headers: { 'x-cron-secret': secret, 'Content-Type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })

  check('worker: a wrong secret is 403', (await worker(post({ kind: 'reminder-plan' }, 'wrong'))).status === 403)
  check('worker: a missing secret is 403', (await worker(new Request('https://x/worker', { method: 'POST', body: '{}' }))).status === 403)

  clientScript.rpcCalls.length = 0
  const unknown = await worker(post({ kind: 'purge-everything' }))
  const unknownBody = await jsonOf(unknown)
  check('worker: an unknown kind is 400, never a default drain', unknown.status === 400 && unknownBody?.error === 'unknown_kind')
  check('worker: an unknown kind makes NO RPC calls at all', clientScript.rpcCalls.length === 0)

  const bigWorker = await worker(post('{"kind":"' + 'x'.repeat(4096) + '"}'))
  check('worker: an oversized worker body is 413', bigWorker.status === 413)

  clientScript.rpcCalls.length = 0
  clientScript.rpcResult = { data: 7, error: null }
  // freeze the clock at an instant STRADDLING midnight: 20:30 UTC is already 01:30 of the NEXT
  // day in Tashkent (+05:00, no DST) — only the correct timezone yields 2026-09-06
  const RealDate = Date
  const FIXED_EPOCH = RealDate.UTC(2026, 8, 5, 20, 30, 0)
  // eslint-disable-next-line no-global-assign
  Date = class extends RealDate {
    constructor(...args) { if (args.length === 0) super(FIXED_EPOCH); else super(...args) }
    static now() { return FIXED_EPOCH }
  }
  let plan
  try {
    plan = await worker(post({ kind: 'reminder-plan' }))
  } finally {
    // eslint-disable-next-line no-global-assign
    Date = RealDate
  }
  const planBody = await jsonOf(plan)
  check('worker: reminder-plan reaches the RPC and reports the count — with the BRIEFING switch off',
    plan.status === 200 && planBody?.planned === 7
    && clientScript.rpcCalls.some((c) => c.name === 'reminder_plan_occurrences'))
  check('worker: at 20:30 UTC the plan date is the TASHKENT day (2026-09-06), not the UTC one',
    clientScript.rpcCalls[0]?.args?.p_today === '2026-09-06')

  // reminder-drain with REMINDER_DELIVERY unset: the default-OFF switch answers disabled
  const drain = await worker(post({ kind: 'reminder-drain' }))
  const drainBody = await jsonOf(drain)
  check('worker: reminder-drain without REMINDER_DELIVERY=on reports disabled (default OFF)',
    drain.status === 200 && drainBody?.tick?.disabled === true)

  // the briefing kinds DO respect their own switch (off → disabled), independent of reminders
  const briefing = await worker(post({ kind: 'drain' }))
  const briefingBody = await jsonOf(briefing)
  check('worker: the briefing switch still gates briefing kinds only', briefingBody?.disabled === true)
} catch (error) {
  failed += 1
  console.error(`[FAIL] reminder-wrapper-smoke crashed: ${error instanceof Error ? error.stack ?? error.message : String(error)}`)
}

if (failed > 0) { console.error(`reminder-wrapper-smoke: ${failed} check(s) failed.`); process.exit(1) }
console.log('Request-wrapper smoke passed (real Deno.serve handlers under a stubbed runtime).')
