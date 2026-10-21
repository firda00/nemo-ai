// COMPUTE-WORKER-API gateway smoke: the ACTUAL Deno.serve handler runs under Node with a
// stubbed Deno global and a scripted supabase-js — real Request objects in, real Response
// objects out. D2 conditions under test:
//   • claim/finish stay available to BOTH worker token classes (backward compatible), with the
//     profile fence (media→PROFILE_C_BROWSER only, document→PROFILE_B_DOCS only);
//   • document_finalize_workflow / document_list_unfinalized answer ONLY to the DOCUMENT token
//     (the media token gets COMPUTE_RPC_DENIED, not a validation error);
//   • strict bounded params: finalize takes exactly {p_account_id, p_workflow_id} strings;
//     list takes only an optional integer p_limit in 1..25 — anything else is 400;
//   • transport hygiene: non-POST 404, bad bearer 401, misconfigured/equal tokens 503,
//     oversized bodies 413 (declared AND actual), malformed JSON 400, unknown rpc 403,
//     downstream rpc errors surface as 409 with data:null.
// Offline: no network, no deploy. Run: npm run test:compute-gateway
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'
import esbuild from 'esbuild'

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/(?:[A-Za-z]:)/, (m) => m.slice(1))), '..')
const buildDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nemo-compute-gateway-'))

let failed = 0
const check = (name, cond, detail = '') => {
  if (cond) console.log(`[OK] ${name}`)
  else { failed += 1; console.error(`[FAIL] ${name}${detail ? `: ${detail}` : ''}`) }
}

// ── scripted supabase-js: records every forwarded rpc, result is per-test configurable ─────────
const script = { rpcCalls: [], rpcResult: { data: { ok: true }, error: null } }
globalThis.__computeGatewayScript = script
const stubPath = path.join(buildDir, 'supabase-stub.mjs')
fs.writeFileSync(stubPath, `
const script = globalThis.__computeGatewayScript
export function createClient(_url, _key, _opts) {
  return { rpc(name, args) { script.rpcCalls.push({ name, args }); return Promise.resolve(script.rpcResult) } }
}
`)

const MEDIA_TOKEN = 'media-worker-token-0123456789abcdef-0123'
const DOCUMENT_TOKEN = 'document-worker-token-0123456789abcdef'
const ENV = {
  SUPABASE_URL: 'https://stub.local',
  SUPABASE_SERVICE_ROLE_KEY: 'service',
  NEMO_MEDIA_WORKER_TOKEN: MEDIA_TOKEN,
  NEMO_DOCUMENT_WORKER_TOKEN: DOCUMENT_TOKEN,
}
let handler = null
globalThis.Deno = {
  env: { get: (key) => ENV[key] ?? '' },
  serve: (h) => { handler = h },
}

const call = (token, body, extraHeaders = {}) => handler(new Request('https://x/compute-worker-api', {
  method: 'POST',
  headers: token ? { authorization: `Bearer ${token}`, ...extraHeaders } : extraHeaders,
  body: typeof body === 'string' ? body : JSON.stringify(body),
}))
const jsonOf = async (response) => { try { return await response.json() } catch { return null } }
const ACCOUNT = '11111111-1111-4111-8111-111111111111'
const WORKFLOW = '22222222-2222-4222-8222-222222222222'

try {
  const outfile = path.join(buildDir, 'compute-worker-api.mjs')
  await esbuild.build({
    entryPoints: [path.join(root, 'supabase/functions/compute-worker-api/index.ts')],
    bundle: true,
    outfile,
    format: 'esm',
    platform: 'node',
    logLevel: 'silent',
    plugins: [{
      name: 'stub-esm-sh',
      setup(build) { build.onResolve({ filter: /^https:\/\/esm\.sh\// }, () => ({ path: stubPath })) },
    }],
  })
  await import(pathToFileURL(outfile).href)
  check('gateway registered a serve handler', typeof handler === 'function')

  // ── transport hygiene ───────────────────────────────────────────────────────────────────────
  const got = await handler(new Request('https://x/compute-worker-api', { method: 'GET' }))
  check('non-POST is 404', got.status === 404)

  const savedDoc = ENV.NEMO_DOCUMENT_WORKER_TOKEN
  ENV.NEMO_DOCUMENT_WORKER_TOKEN = ''
  check('missing document token → 503 not configured', (await call(MEDIA_TOKEN, {})).status === 503)
  ENV.NEMO_DOCUMENT_WORKER_TOKEN = ENV.NEMO_MEDIA_WORKER_TOKEN
  check('equal tokens → 503 not configured', (await call(MEDIA_TOKEN, {})).status === 503)
  ENV.NEMO_DOCUMENT_WORKER_TOKEN = savedDoc

  check('missing bearer → 401', (await call(null, { rpc: 'runtime_claim_compute_jobs', args: {} })).status === 401)
  check('wrong bearer → 401', (await call('x'.repeat(40), { rpc: 'runtime_claim_compute_jobs', args: {} })).status === 401)

  const declared = await handler(new Request('https://x/compute-worker-api', {
    method: 'POST',
    headers: { authorization: `Bearer ${DOCUMENT_TOKEN}`, 'content-length': String(512 * 1024) },
    body: '{}',
  }))
  check('declared oversize body → 413', declared.status === 413)
  check('actual oversize body → 413', (await call(DOCUMENT_TOKEN, 'x'.repeat(400 * 1024))).status === 413)
  check('malformed JSON → 400', (await call(DOCUMENT_TOKEN, '{nope')).status === 400)
  check('unknown rpc → 403 denied', (await call(DOCUMENT_TOKEN, { rpc: 'reminder_save_schedule', args: {} })).status === 403)
  check('array args → 400', (await call(DOCUMENT_TOKEN, { rpc: 'runtime_finish_compute_job', args: [] })).status === 400)

  // ── shared claim/finish: both token classes, profile fenced ─────────────────────────────────
  script.rpcCalls.length = 0
  const mediaClaim = await call(MEDIA_TOKEN, { rpc: 'runtime_claim_compute_jobs', args: { p_profile: 'PROFILE_C_BROWSER' } })
  check('media token claims PROFILE_C_BROWSER (forwarded)', mediaClaim.status === 200 && script.rpcCalls.length === 1)
  const mediaDocsClaim = await call(MEDIA_TOKEN, { rpc: 'runtime_claim_compute_jobs', args: { p_profile: 'PROFILE_B_DOCS' } })
  check('media token claiming PROFILE_B_DOCS → 403 profile denied',
    mediaDocsClaim.status === 403 && (await jsonOf(mediaDocsClaim))?.error?.code === 'COMPUTE_PROFILE_DENIED')
  const docClaim = await call(DOCUMENT_TOKEN, { rpc: 'runtime_claim_compute_jobs', args: { p_profile: 'PROFILE_B_DOCS' } })
  check('document token claims PROFILE_B_DOCS (backward compatible)', docClaim.status === 200)
  const docFinish = await call(DOCUMENT_TOKEN, { rpc: 'runtime_finish_compute_job', args: { p_account_id: ACCOUNT } })
  check('document token finish stays available', docFinish.status === 200)

  // ── document-only lifecycle RPCs ────────────────────────────────────────────────────────────
  const mediaFinalize = await call(MEDIA_TOKEN, {
    rpc: 'document_finalize_workflow', args: { p_account_id: ACCOUNT, p_workflow_id: WORKFLOW },
  })
  check('media token finalizing → 403 rpc denied',
    mediaFinalize.status === 403 && (await jsonOf(mediaFinalize))?.error?.code === 'COMPUTE_RPC_DENIED')
  check('media token listing unfinalized → 403 rpc denied',
    (await call(MEDIA_TOKEN, { rpc: 'document_list_unfinalized', args: {} })).status === 403)

  script.rpcCalls.length = 0
  const finalizeOk = await call(DOCUMENT_TOKEN, {
    rpc: 'document_finalize_workflow', args: { p_account_id: ACCOUNT, p_workflow_id: WORKFLOW },
  })
  check('document token finalize with exact args is forwarded', finalizeOk.status === 200
    && script.rpcCalls[0]?.name === 'document_finalize_workflow'
    && script.rpcCalls[0]?.args?.p_workflow_id === WORKFLOW)
  check('finalize with an extra key → 400', (await call(DOCUMENT_TOKEN, {
    rpc: 'document_finalize_workflow', args: { p_account_id: ACCOUNT, p_workflow_id: WORKFLOW, p_force: true },
  })).status === 400)
  check('finalize with a missing key → 400', (await call(DOCUMENT_TOKEN, {
    rpc: 'document_finalize_workflow', args: { p_account_id: ACCOUNT },
  })).status === 400)
  check('finalize with a non-string id → 400', (await call(DOCUMENT_TOKEN, {
    rpc: 'document_finalize_workflow', args: { p_account_id: ACCOUNT, p_workflow_id: 42 },
  })).status === 400)

  check('list with no args is allowed', (await call(DOCUMENT_TOKEN, { rpc: 'document_list_unfinalized', args: {} })).status === 200)
  check('list with p_limit 25 is allowed', (await call(DOCUMENT_TOKEN, { rpc: 'document_list_unfinalized', args: { p_limit: 25 } })).status === 200)
  check('list with p_limit 26 → 400', (await call(DOCUMENT_TOKEN, { rpc: 'document_list_unfinalized', args: { p_limit: 26 } })).status === 400)
  check('list with p_limit 0 → 400', (await call(DOCUMENT_TOKEN, { rpc: 'document_list_unfinalized', args: { p_limit: 0 } })).status === 400)
  check('list with fractional p_limit → 400', (await call(DOCUMENT_TOKEN, { rpc: 'document_list_unfinalized', args: { p_limit: 1.5 } })).status === 400)
  check('list with a foreign key → 400', (await call(DOCUMENT_TOKEN, { rpc: 'document_list_unfinalized', args: { p_account_id: ACCOUNT } })).status === 400)

  // ── downstream error propagation ────────────────────────────────────────────────────────────
  script.rpcResult = { data: null, error: { code: 'P0001' } }
  const downstream = await call(DOCUMENT_TOKEN, {
    rpc: 'document_finalize_workflow', args: { p_account_id: ACCOUNT, p_workflow_id: WORKFLOW },
  })
  const downstreamBody = await jsonOf(downstream)
  check('downstream rpc error → 409 with data:null and the code',
    downstream.status === 409 && downstreamBody?.data === null && downstreamBody?.error?.code === 'P0001')
  script.rpcResult = { data: { ok: true }, error: null }
} catch (error) {
  failed += 1
  console.error(`[FAIL] gateway smoke crashed: ${error?.message ?? error}`)
} finally {
  fs.rmSync(buildDir, { recursive: true, force: true })
}

if (failed) {
  console.error(`compute-gateway smoke: ${failed} check(s) failed`)
  process.exit(1)
}
console.log('compute-gateway smoke passed: token classes, strict shapes, transport hygiene.')
