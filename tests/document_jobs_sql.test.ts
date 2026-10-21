// D2 document-jobs lifecycle — ACTUAL PostgreSQL execution via in-process PGlite (no docker,
// offline). The REAL runtime migration chain loads first (phase1 tables/constraints, phase2
// RPCs with pgcrypto sha256, phase3 context, circuit-breaker claim_workflow, compute jobs),
// then 20260906000000_document_jobs_lifecycle.sql runs verbatim — the transition-pair FK,
// state CHECKs, lease/terminal integrity constraints and result-manifest CHECK are the
// production ones, not stubs. Covered, per the D2 GO + Codex integration gate:
//   • enqueue = ONE transaction: workflow queued → compute job → queued→waiting_compute
//     (type action_enqueued) → request row; audit trail present;
//   • waiting_compute is STRUCTURALLY unclaimable: runtime_claim_workflow with a NULL type
//     filter (takes everything claimable) and with the document_job filter both leave it;
//   • idempotency BEFORE quota (repeat wins its own job even at exhausted quota); same
//     request_id + different input → idempotency_conflict; jsonb octet_length is the size
//     authority (multibyte payload refused although its JS .length is far below the cap);
//   • blocked-under-account-lock refusal; runtime-paused rollback leaves NO orphans and
//     burns NO quota;
//   • finalize matrix: compute_not_terminal (pending AND running), completed→completed,
//     failed→failed (terminal_reason_code from job error_code), dead_letter→failed,
//     already:true idempotence, finalize_conflict via corrupted request↔job link AND via a
//     diverged terminal pair, cancelled parent never touched, not_document, not_waiting,
//     bad_request on NULLs, cross-tenant not_found;
//   • MANIFEST GATE (Codex): job completed with {} or an unbound manifest finalizes the
//     parent to failed/DOCUMENT_MANIFEST_INVALID — never success; deterministic on re-call;
//     document_job_status never exposes a manifest unless the WORKFLOW completed, and
//     reports 'processing' until the finalizer has spoken;
//   • sweep: deterministic (run.created_at, run.id) order, limit clamped to 1..25,
//     non-document/media compute jobs and non-terminal jobs excluded;
//   • state-machine integrity at the CONSTRAINT level: waiting_compute→cancelled pair does
//     not exist; lease fields on waiting_compute violate lease integrity; terminal_at on
//     waiting_compute violates terminal integrity;
//   • privileges: all four RPCs are service-role only (anon/authenticated denied); RLS on
//     document_job_requests (owner reads own rows, cross-tenant reads nothing, writes revoked).
//
// STORAGE BOUNDARY (Codex conditional GO) also covered here at the SQL layer:
//   • document_register_artifact is the PUBLICATION FENCE: live running-lease with exact
//     claim_token+epoch re-verified under account→parent→job locks; stale token/epoch/expired
//     lease refused; PROFILE_B_DOCS and job↔request workflow mapping enforced (a repointed
//     media-profile job cannot register); blocked account refused; registration after a
//     terminal parent impossible (workflow_terminal);
//   • canonical attempt/content-qualified path tenants/<acc>/artifacts/<job>/<epoch>/<sha>-<name>
//     rebuilt by a table CHECK from the row's own columns; rows append-only (prevent_mutation);
//   • idempotency: one row per job; ALL content metadata must match (never SHA alone) →
//     already:true with the REGISTERED path; any mismatch → registration_conflict;
//   • crash-retry convergence: register at epoch1 → finish fails → reclaim (epoch2) →
//     re-register same content → already:true returns the EPOCH1 path; finish+finalize with
//     that path completes;
//   • finalizer success requires BOTH a valid manifest AND a matching immutable registration
//     — valid-but-unregistered manifests finalize to failed/DOCUMENT_ARTIFACT_UNREGISTERED.
//
// Honest scope: PGlite is a SINGLE connection — FOR UPDATE blocking and SKIP LOCKED races are
// not provable here (plain SQL, so the suite can run against real PostgreSQL later); the
// "concurrent mismatched registration" is proven as its sequential equivalent. storage.buckets
// is a STUB TABLE: the bucket row insert applies, but actual Supabase Storage behavior
// (upload/download/signed URLs) is NOT tested here — the upload endpoint smoke covers the
// handler with a MOCKED storage client, and behavior against real storage remains unproven
// locally (deliberate, no live calls). The amocrm migrations (160000/170000) are unrelated to
// the runtime chain and are not loaded.
// NOTE: a previous build of this suite hit an opaque wasm-level abort in beforeAll; each
// migration therefore logs before it loads so any recurrence is attributable to one file.
import { readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { beforeAll, describe, expect, test } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto'

const A1 = '11111111-1111-4111-8111-111111111111'
const A2 = '22222222-2222-4222-8222-222222222222'
const A3 = '33333333-3333-4333-8333-333333333333' // dedicated to the quota test: no other test enqueues here
const USER1 = 'bbbbbbb1-bbbb-4bbb-8bbb-bbbbbbbbbbb1'
const USER2 = 'bbbbbbb2-bbbb-4bbb-8bbb-bbbbbbbbbbb2'
const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
const PPTX_MIME = 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
const SHA = 'a'.repeat(64)

let db: PGlite

async function one<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T> {
  const result = await db.query<T>(sql, params)
  return result.rows[0]
}
const all = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) =>
  (await db.query<T>(sql, params)).rows
const rpc = async (call: string, params: unknown[]) =>
  (await one<{ r: Record<string, unknown> }>(`select ${call} as r`, params)).r

const enqueue = (account: string, requestId: string, kind: string, input: unknown, quota = 50) =>
  rpc('public.document_enqueue_job($1,$2,$3,$4,$5)', [account, requestId, kind, JSON.stringify(input), quota])
const jobStatus = (account: string, jobId: string) =>
  rpc('public.document_job_status($1,$2)', [account, jobId])
const finalize = (account: string, workflowId: string) =>
  rpc('public.document_finalize_workflow($1,$2)', [account, workflowId])
const listUnfinalized = (limit: number | null) =>
  all<{ account_id: string; workflow_id: string }>('select * from public.document_list_unfinalized($1)', [limit])
const claimDocJobs = (limit = 10) =>
  all<Record<string, unknown>>("select * from public.runtime_claim_compute_jobs('sql-test-worker', 60, $1, 'PROFILE_B_DOCS')", [limit])
const finishJob = (job: Record<string, unknown>, status: string, manifest: unknown, errorCode: string | null) =>
  rpc('public.runtime_finish_compute_job($1,$2,$3,$4,$5,$6,$7)', [
    job.account_id, job.job_id, job.claim_token, job.lease_epoch, status,
    manifest === null ? null : JSON.stringify(manifest), errorCode,
  ])
const runState = (account: string, workflowId: string) =>
  one<{ current_state: string; terminal_at: string | null; terminal_reason_code: string | null; lease_holder: string | null }>(
    'select current_state, terminal_at, terminal_reason_code, lease_holder from runtime.workflow_runs where account_id = $1 and id = $2',
    [account, workflowId])
const manifestValid = async (account: string, jobId: string, kind: string, profile: string, manifest: unknown) =>
  (await one<{ v: boolean }>('select public.document_manifest_valid($1,$2,$3,$4,$5) as v',
    [account, jobId, kind, profile, JSON.stringify(manifest)])).v
const verifyUpload = (account: string, jobId: unknown, token: unknown, epoch: unknown) =>
  rpc('public.document_verify_upload($1,$2,$3,$4)', [account, jobId, token, epoch])
const expireLease = (account: string, jobId: unknown) =>
  db.query("update runtime.compute_jobs set lease_until = clock_timestamp() - interval '1 second' where account_id = $1 and id = $2",
    [account, jobId])

const docInput = (marker: string) => ({ kind: 'docx_document', title: `doc-${marker}`, blocks: [{ type: 'paragraph', text: marker }] })
type DocKind = 'docx_document' | 'pptx_presentation' | 'typst_document'
const artifactMeta = (kind: DocKind) => kind === 'typst_document' ? { name: 'report.pdf', mime: 'application/pdf' } : kind === 'pptx_presentation'
  ? { name: 'deck.pptx', mime: PPTX_MIME }
  : { name: 'report.docx', mime: DOCX_MIME }
// canonical attempt/content-qualified path: tenants/<acc>/artifacts/<job>/<epoch>/<sha>-<name>
const canonicalPath = (account: string, jobId: string, epoch: number, sha: string, name: string) =>
  `tenants/${account}/artifacts/${jobId}/${epoch}/${sha}-${name}`
// kind-bound STRUCTURAL fixture (validator tests; registration state is separate)
const validManifest = (account: string, jobId: string, kind: DocKind = 'docx_document', epoch = 1) => {
  const meta = artifactMeta(kind)
  return {
    job_id: jobId,
    status: 'COMPLETED',
    artifacts: [{
      name: meta.name,
      mime_type: meta.mime,
      size_bytes: 2048,
      sha256: SHA,
      storage_path: canonicalPath(account, jobId, epoch, SHA, meta.name),
    }],
  }
}
const registerArtifact = (account: string, claimed: Record<string, unknown>, kind: DocKind = 'docx_document', overrides: Partial<{ name: string; mime: string; size: number; sha: string; token: unknown; epoch: unknown }> = {}) => {
  const meta = artifactMeta(kind)
  return rpc('public.document_register_artifact($1,$2,$3,$4,$5,$6,$7,$8)', [
    account, claimed.job_id,
    overrides.token !== undefined ? overrides.token : claimed.claim_token,
    overrides.epoch !== undefined ? overrides.epoch : claimed.lease_epoch,
    overrides.name ?? meta.name, overrides.mime ?? meta.mime,
    overrides.size ?? 2048, overrides.sha ?? SHA,
  ])
}
const manifestFor = (jobId: string, kind: DocKind, storagePath: string) => {
  const meta = artifactMeta(kind)
  return {
    job_id: jobId, status: 'COMPLETED',
    artifacts: [{ name: meta.name, mime_type: meta.mime, size_bytes: 2048, sha256: SHA, storage_path: storagePath }],
  }
}

// full product path: enqueue → claim → [register] → finish(status) — returns { workflowId, jobId }
// The register step mirrors the required order upload → register → finish → finalize;
// pass registered:false to model a worker that never published (finalize must then refuse).
async function runToTerminal(
  account: string, kind: DocKind, marker: string, status: 'completed' | 'failed' | 'dead_letter',
  errorCode: string | null = null, manifestOverride?: unknown, registered = true,
) {
  const saved = await enqueue(account, randomUUID(), kind, { ...docInput(marker), kind })
  expect(saved).toMatchObject({ ok: true })
  const jobId = String(saved.job_id)
  const claimed = (await claimDocJobs(25)).find((j) => j.job_id === jobId)
  expect(claimed).toBeTruthy()
  let manifest: unknown = null
  if (status === 'completed') {
    if (manifestOverride !== undefined) {
      manifest = manifestOverride
    } else if (registered) {
      const registration = await registerArtifact(account, claimed!, kind)
      expect(registration).toMatchObject({ ok: true })
      manifest = manifestFor(jobId, kind, String(registration.storage_path))
    } else {
      manifest = manifestFor(jobId, kind, canonicalPath(account, jobId, Number(claimed!.lease_epoch), SHA, artifactMeta(kind).name))
    }
  }
  await finishJob(claimed!, status, manifest, errorCode)
  return { workflowId: String(saved.workflow_id), jobId }
}

beforeAll(async () => {
  db = new PGlite({ extensions: { pgcrypto } })
  await db.exec(`
    create schema extensions;
    create extension pgcrypto with schema extensions;
    create role anon; create role authenticated; create role service_role;
    create schema auth;
    create function auth.uid() returns uuid language sql stable
      as $fn$ select nullif(current_setting('test.uid', true), '')::uuid $fn$;
    create function public.current_account_id() returns uuid language sql stable
      as $fn$ select nullif(current_setting('test.account', true), '')::uuid $fn$;
    create table public.accounts (id uuid primary key, blocked boolean not null default false);
    create table public.users (id uuid primary key, account_id uuid, role text, is_admin boolean default false);
    create table public.research_runs (
      id uuid primary key, account_id uuid, status text,
      human_review_status text, human_reviewed_by uuid, human_reviewed_at timestamptz
    );
    create table public.approval_requests (
      id uuid primary key default gen_random_uuid(),
      account_id uuid not null,
      source text not null default 'workflow',
      action_type text,
      summary text,
      evidence jsonb,
      status text not null default 'pending',
      expires_at timestamptz,
      decided_by uuid,
      decided_at timestamptz,
      related_research_run_id uuid,
      created_at timestamptz not null default now()
    );
    grant usage on schema public to anon, authenticated;
    -- production grants PostgREST roles table access by default; RLS is what restricts
    grant select on public.users to authenticated;
    grant select on public.accounts to authenticated;
    -- storage.buckets STUB: lets the boundary migration apply verbatim; actual Storage
    -- behavior is NOT under test here (see the honest-scope note above)
    create schema storage;
    create table storage.buckets (id text primary key, name text, public boolean, file_size_limit bigint);
  `)
  const chain = [
    '20260824120000_durable_runtime_phase1.sql',
    '20260824140000_durable_runtime_phase2_rpc.sql',
    '20260824180000_durable_runtime_phase3_context_and_circuit.sql',
    '20260824190000_circuit_breaker_self_healing.sql',
    '20260824200000_compute_jobs_and_sandbox.sql',
    '20260906000000_document_jobs_lifecycle.sql',
    '20260906010000_document_artifacts_storage.sql',
    '20260906020000_document_pdf_artifacts.sql',
  ]
  for (const name of chain) {
    // attributable loading: an opaque wasm abort names its file in the vitest output
    console.log(`[document_jobs_sql] loading ${name}`)
    const sql = readFileSync(new URL(`../supabase/migrations/${name}`, import.meta.url), 'utf8')
    await db.exec(sql)
  }
  await db.exec(`
    grant select on public.document_job_requests to authenticated;
    grant select on public.document_artifacts to authenticated;
    insert into public.accounts (id) values ('${A1}'), ('${A2}'), ('${A3}');
    insert into public.users (id, account_id, role) values
      ('${USER1}', '${A1}', 'owner'), ('${USER2}', '${A2}', 'owner');
  `)
}, 120_000)

describe('enqueue transaction', () => {
  test('creates workflow in waiting_compute, pending job, request row and audit trail atomically', async () => {
    const requestId = randomUUID()
    const saved = await enqueue(A1, requestId, 'docx_document', docInput('atomic'))
    expect(saved).toMatchObject({ ok: true, deduplicated: false })
    const workflowId = String(saved.workflow_id)
    const jobId = String(saved.job_id)

    expect(await runState(A1, workflowId)).toMatchObject({
      current_state: 'waiting_compute', terminal_at: null, terminal_reason_code: null, lease_holder: null,
    })
    expect(await one('select status, profile from runtime.compute_jobs where account_id = $1 and id = $2', [A1, jobId]))
      .toMatchObject({ status: 'pending', profile: 'PROFILE_B_DOCS' })
    expect(await one('select kind, workflow_id, job_id from public.document_job_requests where account_id = $1 and request_id = $2', [A1, requestId]))
      .toMatchObject({ kind: 'docx_document', workflow_id: workflowId, job_id: jobId })
    expect(await one(
      `select transition_type from runtime.workflow_transitions
        where account_id = $1 and workflow_id = $2 and from_state = 'queued' and to_state = 'waiting_compute'`,
      [A1, workflowId])).toMatchObject({ transition_type: 'action_enqueued' })
    const audits = await all<{ event_type: string }>(
      'select event_type from runtime.audit_events where account_id = $1 and workflow_id = $2 order by created_at',
      [A1, workflowId])
    expect(audits.map((a) => a.event_type)).toEqual([
      'runtime.event_ingested', 'runtime.compute_job_enqueued', 'runtime.document_workflow_waiting_compute',
    ])
  })

  test('waiting_compute is unclaimable by the NULL-filter claimer AND the typed claimer', async () => {
    // a deliberately claimable probe proves the claimer itself works in this database
    const probe = await rpc('public.runtime_ingest_event($1,$2,$3,$4,$5,$6)', [
      A1, 'probe', `probe-${randomUUID()}`, JSON.stringify({ probe: true }), 'live', randomUUID(),
    ])
    const nullFilter = await all<{ workflow_id: string; workflow_type: string }>(
      "select workflow_id, workflow_type from public.runtime_claim_workflow('sql-test-worker', 60, 50, null, null)")
    expect(nullFilter.map((r) => r.workflow_id)).toEqual([String(probe.workflow_id)])
    expect(nullFilter[0].workflow_type).toBe('probe_event')
    const typed = await all(
      "select workflow_id from public.runtime_claim_workflow('sql-test-worker', 60, 50, null, 'document_job')")
    expect(typed).toEqual([])
    const waiting = await all("select id from runtime.workflow_runs where current_state = 'waiting_compute'")
    expect(waiting.length).toBeGreaterThan(0)
  })

  test('idempotency wins before quota; conflicting input is refused', async () => {
    const requestId = randomUUID()
    const input = docInput('idem')
    const first = await enqueue(A3, requestId, 'docx_document', input, 1)
    expect(first).toMatchObject({ ok: true, deduplicated: false })
    // the day's quota of 1 is now exhausted for NEW requests…
    expect(await enqueue(A3, randomUUID(), 'docx_document', docInput('quota-victim'), 1))
      .toMatchObject({ ok: false, reason: 'quota_exceeded' })
    // …but the REPEAT still gets its own job (idempotency before quota)
    expect(await enqueue(A3, requestId, 'docx_document', input, 1))
      .toMatchObject({ ok: true, deduplicated: true, job_id: first.job_id, workflow_id: first.workflow_id })
    expect(await enqueue(A3, requestId, 'docx_document', docInput('tampered'), 1))
      .toMatchObject({ ok: false, reason: 'idempotency_conflict' })
  })

  test('input validation: nulls, kind mismatch, jsonb octet authority', async () => {
    expect(await rpc('public.document_enqueue_job($1,$2,$3,$4)', [null, randomUUID(), 'docx_document', '{}']))
      .toMatchObject({ ok: false, reason: 'bad_request' })
    expect(await enqueue(A1, randomUUID(), 'marp_presentation', { kind: 'marp_presentation' }))
      .toMatchObject({ ok: false, reason: 'bad_kind' })
    expect(await enqueue(A1, randomUUID(), 'docx_document', { kind: 'pptx_presentation' }))
      .toMatchObject({ ok: false, reason: 'bad_input' })
    // 30000 Cyrillic chars: JS .length 30000 (< 60000) but ~60 KB in UTF-8 octets — SQL refuses
    const multibyte = { kind: 'docx_document', pad: 'я'.repeat(30000) }
    expect(JSON.stringify(multibyte).length).toBeLessThan(60000)
    expect(await enqueue(A1, randomUUID(), 'docx_document', multibyte))
      .toMatchObject({ ok: false, reason: 'payload_too_large' })
  })

  test('blocked account is refused under the account lock', async () => {
    await db.query('update public.accounts set blocked = true where id = $1', [A2])
    expect(await enqueue(A2, randomUUID(), 'docx_document', docInput('blocked')))
      .toMatchObject({ ok: false, reason: 'blocked' })
    await db.query('update public.accounts set blocked = false where id = $1', [A2])
  })

  test('runtime pause rolls back everything: no orphans, no quota burned', async () => {
    const before = await one<{ runs: string; jobs: string; requests: string }>(
      `select (select count(*) from runtime.workflow_runs where account_id = $1) as runs,
              (select count(*) from runtime.compute_jobs where account_id = $1) as jobs,
              (select count(*) from public.document_job_requests where account_id = $1) as requests`, [A2])
    await db.exec(`update runtime.system_controls set ingestion_paused = true,
      reason_code = 'TEST_PAUSE', activated_by = 'sql-test', activated_at = clock_timestamp()`)
    expect(await enqueue(A2, randomUUID(), 'docx_document', docInput('paused')))
      .toMatchObject({ ok: false, reason: 'runtime_paused' })
    await db.exec(`update runtime.system_controls set ingestion_paused = false,
      reason_code = null, activated_by = null, activated_at = null`)
    const after = await one<{ runs: string; jobs: string; requests: string }>(
      `select (select count(*) from runtime.workflow_runs where account_id = $1) as runs,
              (select count(*) from runtime.compute_jobs where account_id = $1) as jobs,
              (select count(*) from public.document_job_requests where account_id = $1) as requests`, [A2])
    expect(after).toEqual(before)
    // quota not burned: with quota 1 the next request still succeeds
    expect(await enqueue(A2, randomUUID(), 'docx_document', docInput('after-pause'), 1)).toMatchObject({ ok: true })
  })
})

describe('finalize matrix', () => {
  test('pending and running jobs are compute_not_terminal; parent untouched', async () => {
    const saved = await enqueue(A1, randomUUID(), 'docx_document', docInput('not-terminal'))
    const workflowId = String(saved.workflow_id)
    expect(await finalize(A1, workflowId)).toMatchObject({ ok: false, reason: 'compute_not_terminal' })
    const claimed = (await claimDocJobs(25)).find((j) => j.job_id === saved.job_id)
    expect(claimed).toBeTruthy()
    expect(await finalize(A1, workflowId)).toMatchObject({ ok: false, reason: 'compute_not_terminal' })
    expect((await runState(A1, workflowId)).current_state).toBe('waiting_compute')
    const registration = await registerArtifact(A1, claimed!)
    expect(registration).toMatchObject({ ok: true })
    await finishJob(claimed!, 'completed', manifestFor(String(saved.job_id), 'docx_document', String(registration.storage_path)), null)
    expect(await finalize(A1, workflowId)).toMatchObject({ ok: true, status: 'completed', already: false })
  })

  test('completed job with a VALID bound manifest → workflow completed; idempotent re-call', async () => {
    const { workflowId, jobId } = await runToTerminal(A1, 'pptx_presentation', 'ok-pptx', 'completed')
    expect(await finalize(A1, workflowId)).toMatchObject({ ok: true, status: 'completed', already: false })
    const run = await runState(A1, workflowId)
    expect(run.current_state).toBe('completed')
    expect(run.terminal_at).not.toBeNull()
    expect(run.terminal_reason_code).toBeNull()
    expect(await one(
      `select transition_type from runtime.workflow_transitions
        where account_id = $1 and workflow_id = $2 and from_state = 'waiting_compute'`,
      [A1, workflowId])).toMatchObject({ transition_type: 'completed' })
    expect(await finalize(A1, workflowId)).toMatchObject({ ok: true, status: 'completed', already: true })
    const status = await jobStatus(A1, jobId)
    expect(status).toMatchObject({ ok: true, status: 'completed', workflow_state: 'completed', compute_status: 'completed' })
    expect((status.manifest as Record<string, unknown>).job_id).toBe(jobId)
  })

  test('failed job → workflow failed with the job error code', async () => {
    const { workflowId, jobId } = await runToTerminal(A1, 'docx_document', 'render-fail', 'failed', 'DOCUMENT_RENDER_FAILED')
    expect(await finalize(A1, workflowId)).toMatchObject({ ok: true, status: 'failed', already: false })
    expect(await runState(A1, workflowId)).toMatchObject({
      current_state: 'failed', terminal_reason_code: 'DOCUMENT_RENDER_FAILED',
    })
    expect(await jobStatus(A1, jobId)).toMatchObject({
      status: 'failed', error_code: 'DOCUMENT_RENDER_FAILED', manifest: null,
    })
    expect(await finalize(A1, workflowId)).toMatchObject({ ok: true, status: 'failed', already: true })
  })

  test('dead_letter job → workflow failed', async () => {
    const { workflowId } = await runToTerminal(A1, 'docx_document', 'dead', 'dead_letter', 'DOCUMENT_TIMEOUT')
    expect(await finalize(A1, workflowId)).toMatchObject({ ok: true, status: 'failed' })
    expect((await runState(A1, workflowId)).terminal_reason_code).toBe('DOCUMENT_TIMEOUT')
  })

  test('MANIFEST GATE: {} manifest never becomes success — failed/DOCUMENT_MANIFEST_INVALID, deterministic', async () => {
    const { workflowId, jobId } = await runToTerminal(A1, 'docx_document', 'empty-manifest', 'completed', null, {})
    // the compute layer accepted {} (baseline only requires an object) — the finalizer must not
    expect(await one('select status, result_manifest from runtime.compute_jobs where account_id = $1 and id = $2', [A1, jobId]))
      .toMatchObject({ status: 'completed', result_manifest: {} })
    expect(await finalize(A1, workflowId)).toMatchObject({ ok: true, status: 'failed', already: false })
    expect(await runState(A1, workflowId)).toMatchObject({
      current_state: 'failed', terminal_reason_code: 'DOCUMENT_MANIFEST_INVALID',
    })
    // deterministic recompute: re-finalize agrees instead of conflicting
    expect(await finalize(A1, workflowId)).toMatchObject({ ok: true, status: 'failed', already: true })
    // status NEVER presents {} as a usable document
    expect(await jobStatus(A1, jobId)).toMatchObject({
      status: 'failed', error_code: 'DOCUMENT_MANIFEST_INVALID', manifest: null, compute_status: 'completed',
    })
  })

  test('manifest binding matrix: job/account/kind/mime/extension/size/hash/path each break validity', async () => {
    const jobId = randomUUID()
    const good = validManifest(A1, jobId)
    expect(await manifestValid(A1, jobId, 'docx_document', 'PROFILE_B_DOCS', good)).toBe(true)
    const goodPptx = validManifest(A1, jobId, 'pptx_presentation')
    expect(await manifestValid(A1, jobId, 'pptx_presentation', 'PROFILE_B_DOCS', goodPptx)).toBe(true)
    expect(await manifestValid(A1, jobId, 'docx_document', 'PROFILE_B_DOCS', {})).toBe(false)
    expect(await manifestValid(A1, jobId, 'docx_document', 'PROFILE_C_BROWSER', good)).toBe(false)
    expect(await manifestValid(A1, randomUUID(), 'docx_document', 'PROFILE_B_DOCS', good)).toBe(false)
    expect(await manifestValid(A1, jobId, 'pptx_presentation', 'PROFILE_B_DOCS', good)).toBe(false)
    expect(await manifestValid(A1, jobId, 'docx_document', 'PROFILE_B_DOCS', { ...good, status: 'RUNNING' })).toBe(false)
    expect(await manifestValid(A1, jobId, 'docx_document', 'PROFILE_B_DOCS', { ...good, artifacts: [] })).toBe(false)
    expect(await manifestValid(A1, jobId, 'docx_document', 'PROFILE_B_DOCS',
      { ...good, artifacts: [good.artifacts[0], good.artifacts[0]] })).toBe(false)
    const withArtifact = (patch: Record<string, unknown>) =>
      ({ ...good, artifacts: [{ ...good.artifacts[0], ...patch }] })
    // name+path patched TOGETHER so each case isolates exactly one violated binding
    const named = (name: string) =>
      withArtifact({ name, storage_path: canonicalPath(A1, jobId, 1, SHA, name) })
    // EXTENSION binding (Codex adversarial probe): an .exe payload with the right MIME is refused
    expect(await manifestValid(A1, jobId, 'docx_document', 'PROFILE_B_DOCS', named('report.exe'))).toBe(false)
    // PPTX kind with a .docx-named artifact is refused even with the PPTX MIME
    const pptxWithDocxName = {
      ...goodPptx,
      artifacts: [{ ...goodPptx.artifacts[0], name: 'report.docx', storage_path: canonicalPath(A1, jobId, 1, SHA, 'report.docx') }],
    }
    expect(await manifestValid(A1, jobId, 'pptx_presentation', 'PROFILE_B_DOCS', pptxWithDocxName)).toBe(false)
    expect(await manifestValid(A1, jobId, 'docx_document', 'PROFILE_B_DOCS', withArtifact({ mime_type: 'text/html' }))).toBe(false)
    expect(await manifestValid(A1, jobId, 'docx_document', 'PROFILE_B_DOCS', withArtifact({ mime_type: PPTX_MIME }))).toBe(false)
    expect(await manifestValid(A1, jobId, 'docx_document', 'PROFILE_B_DOCS', withArtifact({ size_bytes: 0 }))).toBe(false)
    expect(await manifestValid(A1, jobId, 'docx_document', 'PROFILE_B_DOCS', withArtifact({ size_bytes: 67108865 }))).toBe(false)
    expect(await manifestValid(A1, jobId, 'docx_document', 'PROFILE_B_DOCS', withArtifact({ size_bytes: 10.5 }))).toBe(false)
    expect(await manifestValid(A1, jobId, 'docx_document', 'PROFILE_B_DOCS', withArtifact({ sha256: 'XYZ' }))).toBe(false)
    expect(await manifestValid(A1, jobId, 'docx_document', 'PROFILE_B_DOCS', named('../escape.docx'))).toBe(false)
    // EXACT canonical path tenants/<acc>/artifacts/<job>/<epoch>/<sha>-<name>: wrong tenant,
    // foreign job segment, traversal, non-tenants root, suffix name/sha mismatch, malformed
    // epoch, extra segment — none survive
    expect(await manifestValid(A1, jobId, 'docx_document', 'PROFILE_B_DOCS',
      withArtifact({ storage_path: canonicalPath(A2, jobId, 1, SHA, 'report.docx') }))).toBe(false)
    expect(await manifestValid(A1, jobId, 'docx_document', 'PROFILE_B_DOCS',
      withArtifact({ storage_path: canonicalPath(A1, randomUUID(), 1, SHA, 'report.docx') }))).toBe(false)
    expect(await manifestValid(A1, jobId, 'docx_document', 'PROFILE_B_DOCS',
      withArtifact({ storage_path: `tenants/${A1}/artifacts/${jobId}/../etc/${SHA}-report.docx` }))).toBe(false)
    expect(await manifestValid(A1, jobId, 'docx_document', 'PROFILE_B_DOCS',
      withArtifact({ storage_path: `var/local/${jobId}/1/${SHA}-report.docx` }))).toBe(false)
    expect(await manifestValid(A1, jobId, 'docx_document', 'PROFILE_B_DOCS',
      withArtifact({ storage_path: canonicalPath(A1, jobId, 1, SHA, 'other.docx') }))).toBe(false)
    expect(await manifestValid(A1, jobId, 'docx_document', 'PROFILE_B_DOCS',
      withArtifact({ storage_path: canonicalPath(A1, jobId, 1, 'b'.repeat(64), 'report.docx') }))).toBe(false)
    expect(await manifestValid(A1, jobId, 'docx_document', 'PROFILE_B_DOCS',
      withArtifact({ storage_path: `tenants/${A1}/artifacts/${jobId}/x/${SHA}-report.docx` }))).toBe(false)
    expect(await manifestValid(A1, jobId, 'docx_document', 'PROFILE_B_DOCS',
      withArtifact({ storage_path: `tenants/${A1}/artifacts/${jobId}/1/extra/${SHA}-report.docx` }))).toBe(false)
  })

  test('cancelled parent is never touched', async () => {
    const saved = await enqueue(A1, randomUUID(), 'docx_document', docInput('cancelled'))
    const workflowId = String(saved.workflow_id)
    // manufacture a cancelled parent directly (no product path cancels documents yet)
    await db.query(
      `update runtime.workflow_runs set current_state = 'cancelled',
        terminal_at = clock_timestamp(), terminal_reason_code = 'TEST_CANCELLED'
       where account_id = $1 and id = $2`, [A1, workflowId])
    expect(await finalize(A1, workflowId)).toMatchObject({ ok: false, reason: 'cancelled' })
    expect(await runState(A1, workflowId)).toMatchObject({
      current_state: 'cancelled', terminal_reason_code: 'TEST_CANCELLED',
    })
  })

  test('guards: not_document, not_waiting, bad_request, cross-tenant not_found', async () => {
    expect(await rpc('public.document_finalize_workflow($1,$2)', [null, randomUUID()]))
      .toMatchObject({ ok: false, reason: 'bad_request' })
    expect(await finalize(A1, randomUUID())).toMatchObject({ ok: false, reason: 'not_found' })
    // non-document workflow type
    const probe = await rpc('public.runtime_ingest_event($1,$2,$3,$4,$5,$6)', [
      A1, 'probe', `probe-${randomUUID()}`, JSON.stringify({ probe: true }), 'live', randomUUID(),
    ])
    expect(await finalize(A1, String(probe.workflow_id))).toMatchObject({ ok: false, reason: 'not_document' })
    // cross-tenant: A2 cannot finalize A1's workflow
    const saved = await enqueue(A1, randomUUID(), 'docx_document', docInput('tenant'))
    expect(await finalize(A2, String(saved.workflow_id))).toMatchObject({ ok: false, reason: 'not_found' })
    // not_waiting: a corrupted non-waiting active parent refuses instead of transitioning
    const stray = await runToTerminal(A1, 'docx_document', 'not-waiting', 'failed', 'DOCUMENT_RENDER_FAILED')
    await db.query(
      `update runtime.workflow_runs set current_state = 'queued' where account_id = $1 and id = $2`,
      [A1, stray.workflowId])
    expect(await finalize(A1, stray.workflowId)).toMatchObject({ ok: false, reason: 'not_waiting' })
    await db.query(
      `update runtime.workflow_runs set current_state = 'waiting_compute' where account_id = $1 and id = $2`,
      [A1, stray.workflowId])
    expect(await finalize(A1, stray.workflowId)).toMatchObject({ ok: true, status: 'failed' })
  })

  test('finalize_conflict: corrupted request↔job link and diverged terminal pair', async () => {
    const first = await runToTerminal(A1, 'docx_document', 'link-a', 'completed')
    const second = await runToTerminal(A1, 'docx_document', 'link-b', 'completed')
    // NOTE: repointing document_job_requests.job_id is IMPOSSIBLE — unique(account_id, job_id)
    // rejects it (the invariant working). Corrupt the other side of the link instead: the JOB's
    // workflow_id now names a different (existing) parent, FKs still satisfied.
    await db.query(
      'update runtime.compute_jobs set workflow_id = $3 where account_id = $1 and id = $2',
      [A1, first.jobId, second.workflowId])
    expect(await finalize(A1, first.workflowId)).toMatchObject({ ok: false, reason: 'finalize_conflict' })
    await db.query(
      'update runtime.compute_jobs set workflow_id = $3 where account_id = $1 and id = $2',
      [A1, first.jobId, first.workflowId])
    expect(await finalize(A1, first.workflowId)).toMatchObject({ ok: true, status: 'completed' })
    // diverged pair: workflow completed, then the job row is corrupted to failed → conflict, no repaint
    await db.query(
      `update runtime.compute_jobs set status = 'failed', result_manifest = null, error_code = 'TEST_CORRUPT'
        where account_id = $1 and id = $2`, [A1, first.jobId])
    expect(await finalize(A1, first.workflowId)).toMatchObject({ ok: false, reason: 'finalize_conflict' })
    expect((await runState(A1, first.workflowId)).current_state).toBe('completed')
  })
})

describe('artifact registration (publication fence)', () => {
  test('happy path: canonical epoch/content path, table row, audit event', async () => {
    const saved = await enqueue(A1, randomUUID(), 'docx_document', docInput('reg-happy'))
    const claimed = (await claimDocJobs(25)).find((j) => j.job_id === saved.job_id)!
    expect(await verifyUpload(A1, claimed.job_id, claimed.claim_token, claimed.lease_epoch))
      .toMatchObject({ ok: true, kind: 'docx_document' })
    const registration = await registerArtifact(A1, claimed)
    const expectedPath = canonicalPath(A1, String(claimed.job_id), Number(claimed.lease_epoch), SHA, 'report.docx')
    expect(registration).toMatchObject({ ok: true, already: false, storage_path: expectedPath })
    expect(await one(
      'select kind, name, size_bytes, sha256, lease_epoch, storage_path from public.document_artifacts where account_id = $1 and job_id = $2',
      [A1, claimed.job_id])).toMatchObject({
        kind: 'docx_document', name: 'report.docx', size_bytes: 2048, sha256: SHA, storage_path: expectedPath,
      })
    expect((await all(
      "select 1 from runtime.audit_events where account_id = $1 and workflow_id = $2 and event_type = 'runtime.document_artifact_registered'",
      [A1, saved.workflow_id])).length).toBe(1)
    // idempotent repeat with ALL content metadata matching → already:true, same path
    expect(await registerArtifact(A1, claimed)).toMatchObject({ ok: true, already: true, storage_path: expectedPath })
    // ANY metadata mismatch is a conflict, never an overwrite (not SHA alone)
    expect(await registerArtifact(A1, claimed, 'docx_document', { sha: 'c'.repeat(64) }))
      .toMatchObject({ ok: false, reason: 'registration_conflict' })
    expect(await registerArtifact(A1, claimed, 'docx_document', { size: 4096 }))
      .toMatchObject({ ok: false, reason: 'registration_conflict' })
    expect(await registerArtifact(A1, claimed, 'docx_document', { name: 'other.docx' }))
      .toMatchObject({ ok: false, reason: 'registration_conflict' })
  })

  test('fence: wrong token, wrong epoch, expired lease, unclaimed job all refused', async () => {
    const saved = await enqueue(A1, randomUUID(), 'docx_document', docInput('reg-fence'))
    // unclaimed job (pending) has no lease to present
    expect(await registerArtifact(A1, { job_id: saved.job_id, claim_token: randomUUID(), lease_epoch: 0 }))
      .toMatchObject({ ok: false, reason: 'stale_lease' })
    const claimed = (await claimDocJobs(25)).find((j) => j.job_id === saved.job_id)!
    expect(await registerArtifact(A1, claimed, 'docx_document', { token: randomUUID() }))
      .toMatchObject({ ok: false, reason: 'stale_lease' })
    expect(await registerArtifact(A1, claimed, 'docx_document', { epoch: Number(claimed.lease_epoch) + 1 }))
      .toMatchObject({ ok: false, reason: 'stale_lease' })
    // lease expiring MID-UPLOAD: the advisory precheck passed above, then the lease dies
    // before registration — the fence refuses what the precheck admitted
    await expireLease(A1, claimed.job_id)
    expect(await verifyUpload(A1, claimed.job_id, claimed.claim_token, claimed.lease_epoch))
      .toMatchObject({ ok: false, reason: 'stale_lease' })
    expect(await registerArtifact(A1, claimed)).toMatchObject({ ok: false, reason: 'stale_lease' })
    expect((await all('select 1 from public.document_artifacts where account_id = $1 and job_id = $2', [A1, claimed.job_id])).length).toBe(0)
  })

  test('bindings: blocked account, media-profile repoint, workflow repoint, non-document, nulls', async () => {
    const saved = await enqueue(A1, randomUUID(), 'docx_document', docInput('reg-bind'))
    const claimed = (await claimDocJobs(25)).find((j) => j.job_id === saved.job_id)!
    await db.query('update public.accounts set blocked = true where id = $1', [A1])
    expect(await verifyUpload(A1, claimed.job_id, claimed.claim_token, claimed.lease_epoch))
      .toMatchObject({ ok: false, reason: 'blocked' })
    expect(await registerArtifact(A1, claimed)).toMatchObject({ ok: false, reason: 'blocked' })
    await db.query('update public.accounts set blocked = false where id = $1', [A1])
    // repointed media profile: a document registration never accepts a foreign profile
    await db.query("update runtime.compute_jobs set profile = 'PROFILE_C_BROWSER' where account_id = $1 and id = $2", [A1, claimed.job_id])
    expect(await verifyUpload(A1, claimed.job_id, claimed.claim_token, claimed.lease_epoch))
      .toMatchObject({ ok: false, reason: 'mapping_conflict' })
    expect(await registerArtifact(A1, claimed)).toMatchObject({ ok: false, reason: 'mapping_conflict' })
    await db.query("update runtime.compute_jobs set profile = 'PROFILE_B_DOCS' where account_id = $1 and id = $2", [A1, claimed.job_id])
    // repointed job→workflow link
    const other = await enqueue(A1, randomUUID(), 'docx_document', docInput('reg-bind-other'))
    await db.query('update runtime.compute_jobs set workflow_id = $3 where account_id = $1 and id = $2',
      [A1, claimed.job_id, other.workflow_id])
    expect(await registerArtifact(A1, claimed)).toMatchObject({ ok: false, reason: 'mapping_conflict' })
    await db.query('update runtime.compute_jobs set workflow_id = $3 where account_id = $1 and id = $2',
      [A1, claimed.job_id, saved.workflow_id])
    // non-document compute job
    const probe = await rpc('public.runtime_ingest_event($1,$2,$3,$4,$5,$6)', [
      A1, 'media', `media-${randomUUID()}`, JSON.stringify({ media: true }), 'live', randomUUID(),
    ])
    const mediaJob = await rpc('public.runtime_enqueue_compute_job($1,$2,$3,$4)', [
      A1, probe.workflow_id, 'PROFILE_C_BROWSER', JSON.stringify({ media: true }),
    ])
    expect(await registerArtifact(A1, { job_id: mediaJob.job_id, claim_token: randomUUID(), lease_epoch: 1 }))
      .toMatchObject({ ok: false, reason: 'not_document' })
    expect(await rpc('public.document_register_artifact($1,$2,$3,$4,$5,$6,$7,$8)',
      [A1, null, randomUUID(), 1, 'report.docx', DOCX_MIME, 2048, SHA]))
      .toMatchObject({ ok: false, reason: 'bad_request' })
    expect(await registerArtifact(A1, claimed, 'docx_document', { name: 'report.exe' }))
      .toMatchObject({ ok: false, reason: 'bad_request' })
  })

  test('registration after a terminal parent is impossible', async () => {
    const failed = await runToTerminal(A1, 'docx_document', 'reg-after-fail', 'failed', 'DOCUMENT_RENDER_FAILED')
    expect(await finalize(A1, failed.workflowId)).toMatchObject({ ok: true, status: 'failed' })
    expect(await registerArtifact(A1, { job_id: failed.jobId, claim_token: randomUUID(), lease_epoch: 1 }))
      .toMatchObject({ ok: false, reason: 'workflow_terminal' })
  })

  test('crash-retry convergence: epoch2 re-register with same content returns the epoch1 path', async () => {
    const saved = await enqueue(A1, randomUUID(), 'docx_document', docInput('reg-retry'))
    const first = (await claimDocJobs(25)).find((j) => j.job_id === saved.job_id)!
    const registration = await registerArtifact(A1, first)
    expect(registration).toMatchObject({ ok: true, already: false })
    // crash before finish: lease dies, a fresh claim gets epoch+1
    await expireLease(A1, first.job_id)
    const second = (await claimDocJobs(25)).find((j) => j.job_id === saved.job_id)!
    expect(Number(second.lease_epoch)).toBe(Number(first.lease_epoch) + 1)
    // deterministic re-render produced the same content → publication truth is the EXISTING row
    const retried = await registerArtifact(A1, second)
    expect(retried).toMatchObject({ ok: true, already: true, storage_path: registration.storage_path })
    expect(String(retried.storage_path)).toContain(`/${first.lease_epoch}/`)
    // sequential stand-in for the concurrent mismatched registration: different content
    // from the newer attempt still refuses (single-connection honesty — see header)
    expect(await registerArtifact(A1, second, 'docx_document', { sha: 'd'.repeat(64) }))
      .toMatchObject({ ok: false, reason: 'registration_conflict' })
    await finishJob(second, 'completed', manifestFor(String(saved.job_id), 'docx_document', String(retried.storage_path)), null)
    expect(await finalize(A1, String(saved.workflow_id))).toMatchObject({ ok: true, status: 'completed' })
  })

  test('finalizer refuses a valid manifest with no or mismatched registration', async () => {
    // worker "finished" with a self-consistent canonical path it never registered
    const unregistered = await runToTerminal(A1, 'docx_document', 'reg-none', 'completed', null, undefined, false)
    expect(await finalize(A1, unregistered.workflowId)).toMatchObject({ ok: true, status: 'failed' })
    expect((await runState(A1, unregistered.workflowId)).terminal_reason_code).toBe('DOCUMENT_ARTIFACT_UNREGISTERED')
    // deterministic: re-finalize agrees (registration can no longer appear — parent terminal)
    expect(await finalize(A1, unregistered.workflowId)).toMatchObject({ ok: true, status: 'failed', already: true })
    expect(await jobStatus(A1, unregistered.jobId)).toMatchObject({
      status: 'failed', error_code: 'DOCUMENT_ARTIFACT_UNREGISTERED', manifest: null,
    })
    // registered, but the manifest names DIFFERENT content than the registration row
    const saved = await enqueue(A1, randomUUID(), 'docx_document', docInput('reg-mismatch'))
    const claimed = (await claimDocJobs(25)).find((j) => j.job_id === saved.job_id)!
    expect(await registerArtifact(A1, claimed)).toMatchObject({ ok: true })
    const foreignSha = 'e'.repeat(64)
    const mismatched = {
      job_id: saved.job_id, status: 'COMPLETED',
      artifacts: [{ name: 'report.docx', mime_type: DOCX_MIME, size_bytes: 2048, sha256: foreignSha,
        storage_path: canonicalPath(A1, String(saved.job_id), Number(claimed.lease_epoch), foreignSha, 'report.docx') }],
    }
    await finishJob(claimed, 'completed', mismatched, null)
    expect(await finalize(A1, String(saved.workflow_id))).toMatchObject({ ok: true, status: 'failed' })
    expect((await runState(A1, String(saved.workflow_id))).terminal_reason_code).toBe('DOCUMENT_ARTIFACT_UNREGISTERED')
  })

  test('registration rows are immutable and structurally canonical', async () => {
    const saved = await enqueue(A1, randomUUID(), 'docx_document', docInput('reg-immutable'))
    const claimed = (await claimDocJobs(25)).find((j) => j.job_id === saved.job_id)!
    expect(await registerArtifact(A1, claimed)).toMatchObject({ ok: true })
    await expect(db.query(
      "update public.document_artifacts set sha256 = repeat('f', 64) where account_id = $1 and job_id = $2",
      [A1, claimed.job_id])).rejects.toThrow(/append-only/)
    await expect(db.query(
      'delete from public.document_artifacts where account_id = $1 and job_id = $2',
      [A1, claimed.job_id])).rejects.toThrow(/append-only/)
    // a row whose path disagrees with its own columns cannot exist even for a superuser
    const other = await enqueue(A1, randomUUID(), 'docx_document', docInput('reg-check'))
    await expect(db.query(
      `insert into public.document_artifacts (account_id, job_id, workflow_id, kind, name, mime_type, size_bytes, sha256, lease_epoch, storage_path)
       values ($1, $2, $3, 'docx_document', 'report.docx', $4, 2048, $5, 1, 'tenants/somewhere/else')`,
      [A1, other.job_id, other.workflow_id, DOCX_MIME, SHA],
    )).rejects.toThrow(/document_artifacts_canonical_path_check/)
  })
})

describe('status honesty', () => {
  test('processing until the finalizer has spoken; manifest only after workflow completion', async () => {
    const saved = await enqueue(A1, randomUUID(), 'docx_document', docInput('status'))
    const jobId = String(saved.job_id)
    expect(await jobStatus(A1, jobId)).toMatchObject({ ok: true, status: 'processing', compute_status: 'pending', manifest: null })
    const claimed = (await claimDocJobs(25)).find((j) => j.job_id === jobId)
    expect(await jobStatus(A1, jobId)).toMatchObject({ status: 'processing', compute_status: 'running' })
    const registration = await registerArtifact(A1, claimed!)
    expect(registration).toMatchObject({ ok: true })
    await finishJob(claimed!, 'completed', manifestFor(jobId, 'docx_document', String(registration.storage_path)), null)
    // job is terminal but the PARENT outcome is not decided — still processing, manifest hidden
    expect(await jobStatus(A1, jobId)).toMatchObject({ status: 'processing', compute_status: 'completed', manifest: null })
    await finalize(A1, String(saved.workflow_id))
    expect(await jobStatus(A1, jobId)).toMatchObject({ status: 'completed' })
  })

  test('non-document and cross-tenant jobs are invisible', async () => {
    // a media-profile compute job on a non-document workflow
    const probe = await rpc('public.runtime_ingest_event($1,$2,$3,$4,$5,$6)', [
      A1, 'media', `media-${randomUUID()}`, JSON.stringify({ media: true }), 'live', randomUUID(),
    ])
    const mediaJob = await rpc('public.runtime_enqueue_compute_job($1,$2,$3,$4)', [
      A1, probe.workflow_id, 'PROFILE_C_BROWSER', JSON.stringify({ media: true }),
    ])
    expect(await jobStatus(A1, String(mediaJob.job_id))).toMatchObject({ ok: false, reason: 'not_found' })
    const saved = await enqueue(A1, randomUUID(), 'docx_document', docInput('invisible'))
    expect(await jobStatus(A2, String(saved.job_id))).toMatchObject({ ok: false, reason: 'not_found' })
    expect(await rpc('public.document_job_status($1,$2)', [A1, null])).toMatchObject({ ok: false, reason: 'not_found' })
  })
})

describe('sweep', () => {
  test('deterministic order, clamped limit, media and non-terminal exclusion', async () => {
    // clear the field: finalize everything currently pending so only OUR rows remain listed
    for (const row of await listUnfinalized(25)) await finalize(row.account_id, row.workflow_id)
    expect(await listUnfinalized(25)).toEqual([])

    const first = await runToTerminal(A1, 'docx_document', 'sweep-1', 'completed')
    const second = await runToTerminal(A1, 'docx_document', 'sweep-2', 'failed', 'DOCUMENT_RENDER_FAILED')
    const third = await runToTerminal(A2, 'docx_document', 'sweep-3', 'dead_letter', 'DOCUMENT_TIMEOUT')
    // a document workflow whose job is NOT terminal must not be listed
    const notReady = await enqueue(A1, randomUUID(), 'docx_document', docInput('sweep-pending'))

    const listed = await listUnfinalized(25)
    expect(listed).toEqual([
      { account_id: A1, workflow_id: first.workflowId },
      { account_id: A1, workflow_id: second.workflowId },
      { account_id: A2, workflow_id: third.workflowId },
    ])
    expect(listed.map((r) => r.workflow_id)).not.toContain(String(notReady.workflow_id))
    // clamping: null → default, 2 → first two in order, 100 → still bounded (≤25)
    expect((await listUnfinalized(null)).length).toBe(3)
    expect(await listUnfinalized(2)).toEqual(listed.slice(0, 2))
    expect((await listUnfinalized(100)).length).toBe(3)
    for (const row of listed) expect(await finalize(row.account_id, row.workflow_id)).toMatchObject({ ok: true })
    expect(await listUnfinalized(25)).toEqual([])
  })
})

describe('state-machine constraints (database level, not RPC convention)', () => {
  test('waiting_compute→cancelled pair does not exist; illegal transition is rejected by the pair FK', async () => {
    const saved = await enqueue(A1, randomUUID(), 'docx_document', docInput('pair-fk'))
    await expect(db.query(
      `insert into runtime.workflow_transitions (
         account_id, workflow_id, transition_seq, from_state, to_state,
         transition_type, actor_type, actor_id, correlation_id, workflow_version, lease_epoch
       ) values ($1, $2, 99, 'waiting_compute', 'cancelled', 'cancelled', 'system', 'sql-test', $3, 'v1', 0)`,
      [A1, saved.workflow_id, randomUUID()],
    )).rejects.toThrow(/workflow_transitions_pair_fkey/)
  })

  test('lease fields and terminal fields are impossible on waiting_compute rows', async () => {
    const saved = await enqueue(A1, randomUUID(), 'docx_document', docInput('integrity'))
    await expect(db.query(
      `update runtime.workflow_runs set lease_holder = 'w', lease_until = clock_timestamp(), claim_token = gen_random_uuid()
        where account_id = $1 and id = $2`, [A1, saved.workflow_id],
    )).rejects.toThrow(/workflow_runs_lease_integrity_check/)
    await expect(db.query(
      `update runtime.workflow_runs set terminal_at = clock_timestamp()
        where account_id = $1 and id = $2`, [A1, saved.workflow_id],
    )).rejects.toThrow(/workflow_runs_terminal_integrity_check/)
  })
})

describe('privileges and RLS', () => {
  test('all six document RPCs are service-role only', async () => {
    for (const role of ['anon', 'authenticated']) {
      await db.exec(`set role ${role}`)
      await expect(enqueue(A1, randomUUID(), 'docx_document', docInput('priv'))).rejects.toThrow(/permission denied/)
      await expect(jobStatus(A1, randomUUID())).rejects.toThrow(/permission denied/)
      await expect(finalize(A1, randomUUID())).rejects.toThrow(/permission denied/)
      await expect(listUnfinalized(5)).rejects.toThrow(/permission denied/)
      await expect(verifyUpload(A1, randomUUID(), randomUUID(), 1)).rejects.toThrow(/permission denied/)
      await expect(registerArtifact(A1, { job_id: randomUUID(), claim_token: randomUUID(), lease_epoch: 1 }))
        .rejects.toThrow(/permission denied/)
      await db.exec('reset role')
    }
  })

  test('RLS: owner reads own request rows; cross-tenant identity reads nothing; writes revoked', async () => {
    const saved = await enqueue(A1, randomUUID(), 'docx_document', docInput('rls'))
    await db.query("select set_config('test.uid', $1, false), set_config('test.account', $2, false)", [USER1, A1])
    await db.exec('set role authenticated')
    const own = await all('select request_id from public.document_job_requests')
    expect(own.length).toBeGreaterThan(0)
    await expect(db.query(
      'insert into public.document_job_requests (account_id, request_id, kind, input_sha256, workflow_id, job_id) values ($1, $2, $3, $4, $5, $6)',
      [A1, randomUUID(), 'docx_document', SHA, saved.workflow_id, saved.job_id],
    )).rejects.toThrow(/permission denied/)
    await db.exec('reset role')
    // forged identity: A2's user with A1 claimed in the JWT-derived account setting sees nothing
    await db.query("select set_config('test.uid', $1, false), set_config('test.account', $2, false)", [USER2, A1])
    await db.exec('set role authenticated')
    expect(await all('select request_id from public.document_job_requests')).toEqual([])
    expect(await all('select job_id from public.document_artifacts')).toEqual([])
    await db.exec('reset role')
    // registrations: owner reads own rows; a BLOCKED account reads nothing even as owner
    await db.query("select set_config('test.uid', $1, false), set_config('test.account', $2, false)", [USER1, A1])
    await db.exec('set role authenticated')
    expect((await all('select job_id from public.document_artifacts')).length).toBeGreaterThan(0)
    await db.exec('reset role')
    await db.query('update public.accounts set blocked = true where id = $1', [A1])
    await db.exec('set role authenticated')
    expect(await all('select job_id from public.document_artifacts')).toEqual([])
    await db.exec('reset role')
    await db.query('update public.accounts set blocked = false where id = $1', [A1])
    await db.query("select set_config('test.uid', '', false), set_config('test.account', '', false)")
  })
})


describe('PDF lifecycle extension', () => {
  const input = { kind: 'typst_document', template: 'report', title: 'PDF', sections: [{ heading: 'Summary', body: 'Source material' }] }
  test('PDF retains idempotency, kind/MIME binding, tenant isolation and lease fencing', async () => {
    const requestId = randomUUID()
    const saved = await enqueue(A1, requestId, 'typst_document', input)
    expect(saved.ok).toBe(true)
    expect(await enqueue(A1, requestId, 'typst_document', input, 1))
      .toMatchObject({ ok: true, job_id: saved.job_id, deduplicated: true })
    expect(await enqueue(A1, requestId, 'typst_document', { ...input, title: 'Changed' }))
      .toMatchObject({ ok: false, reason: 'idempotency_conflict' })
    expect((await jobStatus(A2, String(saved.job_id))).ok).toBe(false)
    const claimed = (await claimDocJobs(50)).find((job) => job.job_id === saved.job_id)!
    expect(claimed).toBeTruthy()
    expect(await registerArtifact(A1, claimed, 'typst_document', { name: 'report.docx' }))
      .toMatchObject({ ok: false, reason: 'bad_request' })
    expect(await registerArtifact(A1, claimed, 'typst_document', { mime: DOCX_MIME }))
      .toMatchObject({ ok: false, reason: 'bad_request' })
    expect((await registerArtifact(A2, claimed, 'typst_document')).ok).toBe(false)
    expect(await registerArtifact(A1, claimed, 'typst_document', { token: randomUUID() }))
      .toMatchObject({ ok: false, reason: 'stale_lease' })
    await expireLease(A1, claimed.job_id)
    expect(await registerArtifact(A1, claimed, 'typst_document'))
      .toMatchObject({ ok: false, reason: 'stale_lease' })
  })
  test('PDF completion needs a registered matching artifact', async () => {
    const missing = await runToTerminal(A1, 'typst_document', 'pdf-unregistered', 'completed', null, undefined, false)
    await finalize(A1, missing.workflowId)
    expect((await jobStatus(A1, missing.jobId)).status).toBe('failed')
    const valid = await runToTerminal(A1, 'typst_document', 'pdf-registered', 'completed')
    await finalize(A1, valid.workflowId)
    expect(await jobStatus(A1, valid.jobId)).toMatchObject({ ok: true, status: 'completed', kind: 'typst_document' })
  })
})
