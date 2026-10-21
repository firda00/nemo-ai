// DOCUMENT-JOBS user endpoint smoke: the ACTUAL Deno.serve handler under Node with a scripted
// supabase-js (auth, tables, rpc, storage sign) — real Request in, real Response out. Covered
// per Codex review:
//   • auth boundary: missing bearer 401, unknown jwt 401, NON-OWNER member 403, authenticated
//     user WITHOUT a membership row 403, BLOCKED account 403 (all three actions), a FOREIGN
//     account's registration row never signs;
//   • enqueue: request_id/kind validation, schema-invalid input 422, schema-valid but
//     serialized-BYTES over budget 413, reason mapping (quota 429, idempotency 409, paused
//     503), injected client fields (account_id, p_daily_quota, storage_path) NEVER reach the
//     RPC (args are exactly p_account_id/p_request_id/p_kind/p_input with the AUTH account),
//     malformed backend success (bad UUIDs) → typed 502 enqueue_malformed, dedup passthrough;
//   • status: processing passthrough without artifact, completed exposes ONLY
//     name/mime/size/sha (no storage path), unknown backend status enum → 502
//     status_malformed;
//   • download: processing → 409 not_ready and the signer is NEVER called; completed + own
//     registration → 200 with TTL=300 and the signed url; registration row missing → 409;
//   • transport: Cache-Control no-store on EVERY response (signed links must not be cached);
//     a HANGING auth dependency returns a real bounded 408 under an injected 400ms budget,
//     and releasing the hung call afterwards still produces NO backend RPC.
// Storage/PostgREST are scripted stubs — no live calls, no deploy. Run: npm run test:document-jobs-endpoint
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'
import { randomUUID } from 'node:crypto'
import esbuild from 'esbuild'

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/(?:[A-Za-z]:)/, (m) => m.slice(1))), '..')
const buildDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nemo-document-jobs-'))

let failed = 0
const check = (name, cond, detail = '') => {
  if (cond) console.log(`[OK] ${name}`)
  else { failed += 1; console.error(`[FAIL] ${name}${detail ? `: ${detail}` : ''}`) }
}

const ACCOUNT = 'ab11c1de-1111-4111-8111-1111111fab11'
const OTHER_ACCOUNT = 'cd22e2fa-2222-4222-8222-2222222abc22'
const OWNER = 'ef33a3bc-3333-4333-8333-3333333def33'
const OPERATOR = 'ab44b4cd-4444-4444-8444-4444444abc44'
const JOB = 'cd55c5de-5555-4555-8555-5555555def55'
const SHA = 'a'.repeat(64)

const script = {
  rpcCalls: [],
  signCalls: [],
  users: {
    'jwt-owner': { id: OWNER },
    'jwt-operator': { id: OPERATOR },
    'jwt-ghost': { id: 'ab66d6ef-6666-4666-8666-6666666abc66' }, // authenticated, NO membership row
  },
  pendingAuth: [],
  memberships: {
    [OWNER]: { account_id: ACCOUNT, role: 'owner', is_admin: false },
    [OPERATOR]: { account_id: ACCOUNT, role: 'operator', is_admin: false },
  },
  accounts: { [ACCOUNT]: { blocked: false }, [OTHER_ACCOUNT]: { blocked: false } },
  registration: null,
  enqueueResult: null,
  statusResult: null,
  hangAuth: false,
}
globalThis.__documentJobsScript = script
const stubPath = path.join(buildDir, 'supabase-stub.mjs')
fs.writeFileSync(stubPath, `
const script = globalThis.__documentJobsScript
export function createClient(_url, key, opts) {
  const bearer = (opts?.global?.headers?.Authorization ?? '').replace('Bearer ', '')
  return {
    auth: {
      getUser: () => script.hangAuth
        ? new Promise((resolve) => { script.pendingAuth.push(() => resolve({ data: { user: script.users[bearer] ?? null } })) })
        : Promise.resolve({ data: { user: script.users[bearer] ?? null } }),
    },
    rpc(name, args) {
      script.rpcCalls.push({ name, args })
      if (name === 'document_enqueue_job') return Promise.resolve(script.enqueueResult ?? { data: { ok: true, job_id: '${JOB}', workflow_id: '${randomUUID()}', deduplicated: false }, error: null })
      if (name === 'document_job_status') return Promise.resolve(script.statusResult ?? { data: { ok: false }, error: null })
      return Promise.resolve({ data: null, error: { code: 'UNEXPECTED' } })
    },
    from(table) {
      const state = { table, filters: {} }
      const chain = {
        select: () => chain,
        eq: (column, value) => { state.filters[column] = value; return chain },
        maybeSingle: async () => {
          if (state.table === 'users') return { data: script.memberships[state.filters.id] ?? null, error: null }
          if (state.table === 'accounts') return { data: script.accounts[state.filters.id] ?? null, error: null }
          if (state.table === 'document_artifacts') {
            const row = script.registration
            const owned = row && state.filters.account_id === row.account_id && state.filters.job_id === row.job_id
            return { data: owned ? row : null, error: null }
          }
          return { data: null, error: null }
        },
      }
      return chain
    },
    storage: { from: () => ({
      createSignedUrl(path, ttl) {
        script.signCalls.push({ path, ttl })
        return Promise.resolve({ data: { signedUrl: 'https://signed.local/' + path }, error: null })
      },
    }) },
  }
}
`)

const ENV = {
  SUPABASE_URL: 'https://stub.local',
  SUPABASE_ANON_KEY: 'anon',
  SUPABASE_SERVICE_ROLE_KEY: 'service',
  DOCUMENT_JOBS_BUDGET_MS: '400',
}
let handler = null
globalThis.Deno = {
  env: { get: (key) => ENV[key] ?? '' },
  serve: (h) => { handler = h },
}

const call = (jwt, body) => handler(new Request('https://x/document-jobs', {
  method: 'POST',
  headers: jwt ? { Authorization: `Bearer ${jwt}`, 'content-type': 'application/json' } : {},
  body: JSON.stringify(body),
}))
const jsonOf = async (response) => { try { return await response.json() } catch { return null } }
const validInput = {
  kind: 'docx_document',
  title: 'Отчёт',
  language: 'ru',
  blocks: [{ type: 'paragraph', text: 'Содержимое отчёта.' }],
}
const enqueueBody = (extra = {}) => ({ action: 'enqueue', request_id: randomUUID(), kind: 'docx_document', input: validInput, ...extra })

try {
  await esbuild.build({
    entryPoints: [path.join(root, 'supabase/functions/document-jobs/index.ts')],
    bundle: true,
    outfile: path.join(buildDir, 'document-jobs.mjs'),
    format: 'esm',
    platform: 'node',
    logLevel: 'silent',
    plugins: [{
      name: 'stub-esm-sh',
      setup(build) { build.onResolve({ filter: /^https:\/\/esm\.sh\// }, () => ({ path: stubPath })) },
    }],
  })
  await import(pathToFileURL(path.join(buildDir, 'document-jobs.mjs')).href)
  check('handler registered', typeof handler === 'function')

  // ── auth boundary ───────────────────────────────────────────────────────────────────────────
  check('missing bearer → 401', (await call(null, enqueueBody())).status === 401)
  check('unknown jwt → 401', (await call('jwt-nobody', enqueueBody())).status === 401)
  check('NON-OWNER member → 403', (await call('jwt-operator', enqueueBody())).status === 403)
  check('authenticated user WITHOUT membership row → 403', (await call('jwt-ghost', enqueueBody())).status === 403)
  script.accounts[ACCOUNT].blocked = true
  check('blocked account → 403 on enqueue', (await call('jwt-owner', enqueueBody())).status === 403)
  check('blocked account → 403 on status', (await call('jwt-owner', { action: 'status', job_id: JOB })).status === 403)
  check('blocked account → 403 on download', (await call('jwt-owner', { action: 'download', job_id: JOB })).status === 403)
  script.accounts[ACCOUNT].blocked = false

  // ── enqueue validation and injection resistance ─────────────────────────────────────────────
  check('unknown action → 400', (await call('jwt-owner', { action: 'delete' })).status === 400)
  check('bad request_id → 400', (await call('jwt-owner', enqueueBody({ request_id: 'not-a-uuid' }))).status === 400)
  check('bad kind → 400', (await call('jwt-owner', enqueueBody({ kind: 'marp_presentation' }))).status === 400)
  const pdfInput = { kind: 'typst_document', template: 'report', title: 'PDF',
    sections: [{ heading: 'Summary', body: 'Supplied material for the PDF.' }], line_items: [] }
  check('typed PDF input is accepted through the same user endpoint',
    (await call('jwt-owner', enqueueBody({ kind: 'typst_document', input: pdfInput }))).status === 200)
  check('PDF raw Typst code and kind mismatch are refused',
    (await call('jwt-owner', enqueueBody({ kind: 'typst_document', input: { ...pdfInput, code: '#read("secret")' } }))).status === 422
    && (await call('jwt-owner', enqueueBody({ kind: 'typst_document', input: validInput }))).status === 422)
  check('schema-invalid input → 422',
    (await call('jwt-owner', enqueueBody({ input: { kind: 'docx_document', title: 'x', blocks: 'nope' } }))).status === 422)
  // schema-valid but over the SERIALIZED byte budget (escaping doubles backslashes)
  const heavy = {
    kind: 'docx_document', title: 'x', language: 'ru',
    blocks: Array.from({ length: 12 }, () => ({ type: 'paragraph', text: '\\'.repeat(3000) })),
  }
  check('serialized-byte budget rejection → 413',
    (await call('jwt-owner', enqueueBody({ input: heavy }))).status === 413)

  script.rpcCalls.length = 0
  const injected = await call('jwt-owner', enqueueBody({
    account_id: OTHER_ACCOUNT,
    p_account_id: OTHER_ACCOUNT,
    p_daily_quota: 100000,
    storage_path: 'tenants/evil',
  }))
  const enqueueCall = script.rpcCalls.find((c) => c.name === 'document_enqueue_job')
  check('injected account/quota/path never reach the RPC; account comes from AUTH',
    injected.status === 200 && enqueueCall
    && Object.keys(enqueueCall.args).sort().join(',') === 'p_account_id,p_input,p_kind,p_request_id'
    && enqueueCall.args.p_account_id === ACCOUNT)

  script.enqueueResult = { data: { ok: false, reason: 'quota_exceeded' }, error: null }
  check('quota_exceeded → 429', (await call('jwt-owner', enqueueBody())).status === 429)
  script.enqueueResult = { data: { ok: false, reason: 'idempotency_conflict' }, error: null }
  check('idempotency_conflict → 409', (await call('jwt-owner', enqueueBody())).status === 409)
  script.enqueueResult = { data: { ok: false, reason: 'runtime_paused' }, error: null }
  check('runtime_paused → 503', (await call('jwt-owner', enqueueBody())).status === 503)
  script.enqueueResult = { data: { ok: true, job_id: 'garbage', workflow_id: 'garbage' }, error: null }
  const malformed = await call('jwt-owner', enqueueBody())
  check('malformed backend success → typed 502 enqueue_malformed',
    malformed.status === 502 && (await jsonOf(malformed))?.error === 'enqueue_malformed')
  script.enqueueResult = { data: { ok: true, job_id: JOB, workflow_id: randomUUID(), deduplicated: true }, error: null }
  const dedup = await call('jwt-owner', enqueueBody())
  check('deduplicated repeat passes through', (await jsonOf(dedup))?.deduplicated === true)
  script.enqueueResult = null

  // ── status honesty ──────────────────────────────────────────────────────────────────────────
  script.statusResult = { data: { ok: true, status: 'processing', compute_status: 'running', kind: 'docx_document', manifest: null }, error: null }
  const processing = await call('jwt-owner', { action: 'status', job_id: JOB })
  const processingBody = await jsonOf(processing)
  check('processing status passes through without artifact',
    processing.status === 200 && processingBody?.status === 'processing' && processingBody?.artifact === null)
  script.statusResult = { data: { ok: true, status: 'exploded' }, error: null }
  check('unknown backend status enum → 502 status_malformed',
    (await call('jwt-owner', { action: 'status', job_id: JOB })).status === 502)
  const registeredPath = `tenants/${ACCOUNT}/artifacts/${JOB}/1/${SHA}-report.docx`
  const completedStatus = {
    ok: true, status: 'completed', kind: 'docx_document',
    manifest: { artifacts: [{ name: 'report.docx', mime_type: 'application/msword-x', size_bytes: 2048, sha256: SHA, storage_path: registeredPath }] },
  }
  script.statusResult = { data: completedStatus, error: null }
  const completed = await call('jwt-owner', { action: 'status', job_id: JOB })
  const completedBody = await jsonOf(completed)
  check('completed status exposes ONLY artifact metadata, never the storage path',
    completed.status === 200 && completedBody?.artifact?.sha256 === SHA
    && JSON.stringify(completedBody).includes('tenants/') === false)

  // ── download gates ──────────────────────────────────────────────────────────────────────────
  script.signCalls.length = 0
  script.statusResult = { data: { ok: true, status: 'processing', compute_status: 'running' }, error: null }
  const notReady = await call('jwt-owner', { action: 'download', job_id: JOB })
  check('processing download → 409 not_ready and the signer is NEVER called',
    notReady.status === 409 && script.signCalls.length === 0)
  script.statusResult = { data: completedStatus, error: null }
  script.registration = null
  check('completed without own registration → 409 artifact_unregistered',
    (await call('jwt-owner', { action: 'download', job_id: JOB })).status === 409 && script.signCalls.length === 0)
  // a FOREIGN account's registration row for the same job id must never sign
  script.registration = {
    account_id: OTHER_ACCOUNT, job_id: JOB,
    name: 'report.docx', mime_type: 'application/msword-x', size_bytes: 2048, sha256: SHA, storage_path: registeredPath,
  }
  check('foreign registration row → 409, signer never called',
    (await call('jwt-owner', { action: 'download', job_id: JOB })).status === 409 && script.signCalls.length === 0)
  script.registration = {
    account_id: ACCOUNT, job_id: JOB,
    name: 'report.docx', mime_type: 'application/msword-x', size_bytes: 2048, sha256: SHA, storage_path: registeredPath,
  }
  const download = await call('jwt-owner', { action: 'download', job_id: JOB })
  const downloadBody = await jsonOf(download)
  check('completed own registration → 200 signed url with TTL 300',
    download.status === 200 && downloadBody?.url?.startsWith('https://signed.local/')
    && downloadBody?.expires_in === 300 && script.signCalls[0]?.ttl === 300
    && script.signCalls[0]?.path === registeredPath)
  check('download response carries no-store', download.headers.get('cache-control') === 'no-store')

  // every response path carries no-store
  const noStoreProbes = [
    await call(null, enqueueBody()),
    await call('jwt-operator', enqueueBody()),
    await call('jwt-owner', { action: 'status', job_id: 'nope' }),
  ]
  check('no-store on refusal responses too', noStoreProbes.every((r) => r.headers.get('cache-control') === 'no-store'))

  // ── deadline: hanging auth → REAL bounded 408 under the injected 400ms budget ───────────────
  script.hangAuth = true
  script.rpcCalls.length = 0
  const started = Date.now()
  const timedOut = await call('jwt-owner', enqueueBody())
  const elapsed = Date.now() - started
  check('hanging auth → bounded 408 timeout',
    timedOut.status === 408 && (await jsonOf(timedOut))?.error === 'timeout' && elapsed < 5_000)
  // releasing the hung auth AFTER the 408 must not resurrect the request into backend calls
  script.pendingAuth.splice(0).forEach((release) => release())
  await new Promise((resolve) => setTimeout(resolve, 30))
  check('no backend RPC after releasing the hung auth', script.rpcCalls.length === 0)

  // DEFAULT budget path: Number('')===0 once clamped the default to ~100ms and timed out
  // normal auth. With absent/blank/whitespace/NaN budget the hang must STILL be pending well
  // past that regression window (default 20s), not 408 within ~1s.
  for (const variant of [undefined, '', '   ', 'not-a-number']) {
    if (variant === undefined) delete ENV.DOCUMENT_JOBS_BUDGET_MS
    else ENV.DOCUMENT_JOBS_BUDGET_MS = variant
    const probe = call('jwt-owner', enqueueBody())
    const state = await Promise.race([
      probe.then((r) => `settled:${r.status}`),
      new Promise((resolve) => setTimeout(() => resolve('pending'), 1_000)),
    ])
    check(`default budget with ${variant === undefined ? 'ABSENT' : JSON.stringify(variant)} env: hang survives the probe window (default budget, not the 100ms regression)`,
      state === 'pending', String(state))
    script.pendingAuth.splice(0).forEach((release) => release())
    await probe // drains after release (auth resolves, request completes normally)
  }
  ENV.DOCUMENT_JOBS_BUDGET_MS = '400'
  script.hangAuth = false
} catch (error) {
  failed += 1
  console.error(`[FAIL] document-jobs smoke crashed: ${error?.stack ?? error}`)
} finally {
  fs.rmSync(buildDir, { recursive: true, force: true })
}

if (failed) {
  console.error(`document-jobs smoke: ${failed} check(s) failed`)
  process.exit(1)
}
console.log('document-jobs smoke passed: auth boundary, injection resistance, typed backend validation, download gates, no-store, bounded timeout.')
