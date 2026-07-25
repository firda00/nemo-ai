import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const migration = fs.readFileSync(path.join(root, 'supabase/migrations/20260722120000_visual_rag_pilot.sql'), 'utf8')
const edge = fs.readFileSync(path.join(root, 'supabase/functions/visual-rag/index.ts'), 'utf8')
const config = fs.readFileSync(path.join(root, 'supabase/config.toml'), 'utf8')

const checks = []
function check(name, condition) {
  assert.ok(condition, name)
  checks.push(name)
  console.log(`[OK] ${name}`)
}

check('feature flag is fail-closed and maps to HTTP 503',
  migration.includes("current_setting('app.visual_rag_enabled', true)") &&
  migration.includes("raise exception 'feature_disabled'") &&
  /feature_disabled:\s*503/.test(edge))
check('hard source limits are 20 MiB and 200 pages',
  migration.includes('20971520') && migration.includes('p_page_count > 200'))
check('account limit is two active jobs under an advisory transaction lock',
  migration.includes('pg_advisory_xact_lock') && migration.includes('v_active >= 2'))
check('rolling limits are 1000 pages per 24h and 30 submissions per minute',
  migration.includes("interval '24 hours'") && migration.includes('> 1000') &&
  migration.includes("interval '1 minute'") && migration.includes('v_subs_1m >= 30'))
check('client tables are read-only and worker RPCs are service-role only',
  migration.includes('grant select on public.visual_rag_jobs to authenticated') &&
  migration.includes('revoke all on function public.claim_visual_rag_job() from public, anon, authenticated') &&
  migration.includes('grant execute on function public.claim_visual_rag_job() to service_role'))
check('page rows enforce the same account as their parent job',
  migration.includes('foreign key (job_id, account_id)') &&
  migration.includes('references public.visual_rag_jobs(id, account_id)'))
check('worker claim uses SKIP LOCKED and returns tenant context',
  /for update skip locked/i.test(migration) &&
  migration.includes('returns setof public.visual_rag_jobs'))
check('Qdrant contract requires account payload and query filter',
  /every point carries account_id/i.test(migration) && /query must filter by account_id/i.test(migration))
check('edge function only exposes submit/status and never performs OCR',
  edge.includes("action === 'submit'") && edge.includes("action === 'status'") &&
  !/tesseract|pixelrag|qdrant.*upsert|ocr\s*\(/i.test(edge.replace(/^\/\/.*$/gm, '')))
check('edge function requires JWT verification',
  /\[functions\.visual-rag\][\s\S]*?verify_jwt\s*=\s*true/.test(config))

const limits = Object.freeze({ bytes: 20 * 1024 * 1024, pages: 200, active: 2, dailyPages: 1000, perMinute: 30 })
class DeterministicGate {
  constructor(accountId) { this.accountId = accountId; this.jobs = [] }
  submit({ accountId, sourcePath, bytes, pages, at = 0 }) {
    if (accountId !== this.accountId) throw new Error('cross_tenant')
    const prefix = `${accountId}/visual-rag/`
    if (!sourcePath.startsWith(prefix) || sourcePath.length === prefix.length || sourcePath.includes('..') || sourcePath.includes('\\') || sourcePath.startsWith('/')) throw new Error('invalid_path')
    if (bytes < 1 || bytes > limits.bytes) throw new Error('invalid_size')
    if (pages < 1 || pages > limits.pages) throw new Error('invalid_pages')
    if (this.jobs.filter((j) => ['queued', 'processing'].includes(j.status)).length >= limits.active) throw new Error('active_job_limit')
    if (this.jobs.filter((j) => at - j.at < 86400000).reduce((n, j) => n + j.pages, 0) + pages > limits.dailyPages) throw new Error('daily_page_limit')
    if (this.jobs.filter((j) => at - j.at < 60000).length >= limits.perMinute) throw new Error('rate_limited')
    const job = { accountId, sourcePath, bytes, pages, at, status: 'queued' }
    this.jobs.push(job)
    return job
  }
}

const tenant = '11111111-1111-1111-1111-111111111111'
const foreign = '22222222-2222-2222-2222-222222222222'
const gate = new DeterministicGate(tenant)
const burst = [0, 1, 2].map((n) => {
  try { gate.submit({ accountId: tenant, sourcePath: `${tenant}/visual-rag/${n}.pdf`, bytes: limits.bytes, pages: 1 }); return 'accepted' }
  catch (error) { return error.message }
})
check('deterministic concurrency admits exactly two active jobs', burst.filter((x) => x === 'accepted').length === 2)
check('deterministic concurrency rejects the excess job', burst[2] === 'active_job_limit')
for (const job of gate.jobs) job.status = 'succeeded'

for (const sample of [`${tenant}/visual-rag/../secret.pdf`, `${tenant}\\visual-rag\\secret.pdf`, `/visual-rag/secret.pdf`, `${tenant}/visual-rag/`]) {
  assert.throws(() => gate.submit({ accountId: tenant, sourcePath: sample, bytes: 1, pages: 1 }), /invalid_path/)
}
check('path traversal and malformed tenant prefixes are rejected', true)
assert.throws(() => gate.submit({ accountId: foreign, sourcePath: `${foreign}/visual-rag/a.pdf`, bytes: 1, pages: 1 }), /cross_tenant/)
check('cross-tenant submission is denied', true)
assert.throws(() => gate.submit({ accountId: tenant, sourcePath: `${tenant}/visual-rag/too-large.pdf`, bytes: limits.bytes + 1, pages: 1 }), /invalid_size/)
assert.throws(() => gate.submit({ accountId: tenant, sourcePath: `${tenant}/visual-rag/too-many.pdf`, bytes: 1, pages: limits.pages + 1 }), /invalid_pages/)
check('size and per-job page boundaries reject one unit over', true)

const daily = new DeterministicGate(tenant)
for (let i = 0; i < 5; i++) {
  daily.submit({ accountId: tenant, sourcePath: `${tenant}/visual-rag/d${i}.pdf`, bytes: 1, pages: 200, at: i * 61000 }).status = 'succeeded'
}
assert.throws(() => daily.submit({ accountId: tenant, sourcePath: `${tenant}/visual-rag/d6.pdf`, bytes: 1, pages: 1, at: 5 * 61000 }), /daily_page_limit/)
check('rolling 24h page boundary accepts 1000 and rejects 1001', true)

const rate = new DeterministicGate(tenant)
for (let i = 0; i < 30; i++) {
  rate.submit({ accountId: tenant, sourcePath: `${tenant}/visual-rag/r${i}.pdf`, bytes: 1, pages: 1 }).status = 'succeeded'
}
assert.throws(() => rate.submit({ accountId: tenant, sourcePath: `${tenant}/visual-rag/r30.pdf`, bytes: 1, pages: 1 }), /rate_limited/)
check('rolling minute boundary accepts 30 and rejects 31', true)

if (process.env.VISUAL_RAG_LIVE === '1') {
  const required = ['VISUAL_RAG_LIVE_URL', 'VISUAL_RAG_LIVE_ANON_KEY', 'VISUAL_RAG_LIVE_JWT', 'VISUAL_RAG_LIVE_ACCOUNT_ID']
  const missing = required.filter((key) => !process.env[key])
  if (missing.length) throw new Error(`VISUAL_RAG_LIVE=1 but missing ${missing.join(', ')}`)
  const base = process.env.VISUAL_RAG_LIVE_URL.replace(/\/$/, '')
  const response = await fetch(`${base}/functions/v1/visual-rag`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.VISUAL_RAG_LIVE_JWT}`, apikey: process.env.VISUAL_RAG_LIVE_ANON_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'submit', source_path: `${process.env.VISUAL_RAG_LIVE_ACCOUNT_ID}/visual-rag/contract-smoke.pdf`, source_bytes: 1, page_count: 1 }),
  })
  check('configured live submit reaches the deployed feature', response.status === 200 || response.status === 429)
} else {
  console.log('[SKIP] live Visual RAG smoke (set VISUAL_RAG_LIVE=1 with explicit credentials)')
}

console.log(`Visual RAG pilot contracts passed (${checks.length} checks).`)
