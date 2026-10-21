// DOCUMENT JOBS — local END-TO-END BYTES proof across the reviewed boundaries:
//   user enqueue (REAL document-jobs handler) → claim (REAL runtime SQL on PGlite) → render
//   (REAL isolated Deno renderer producing REAL OOXML bytes) → upload (REAL
//   document-artifact-upload handler: inspection, hash, canonical path, registration fence)
//   → finish → inline finalize → status → download (signed url) → downloaded bytes
//   HASH- AND BYTE-EQUAL to what the renderer produced.
//
// REAL in this suite: both Deno.serve handlers verbatim (esbuild-bundled), the full runtime
// migration chain incl. both boundary migrations executed by an actual Postgres (PGlite),
// the actual worker code path (SupabaseDocumentComputeClient + StorageArtifactSink +
// processDocumentJob), the actual renderer child process and OOXML inspector.
// MOCKED, honestly: Supabase Storage is an in-memory map with upsert:false semantics;
// auth identity is a scripted jwt→user map; no network, no deploy, no live services.
// Concurrency is NOT proven here (single PGlite connection).
import { readFileSync } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { beforeAll, afterAll, describe, expect, test } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto'
import esbuild from 'esbuild'
import { buildDocumentModel } from '../agent-hub/documents/document-models'
import { parseDocumentSourceBytes } from '../src/lib/documentSourceParser'
import { buildSourceMarginReport } from '../src/lib/documentSourceReport'
import { validateSourceSnapshot } from '../src/lib/documentSources'
import { periodXlsx, sourceXlsx } from './fixtures/document-source-fixtures'
import {
  processDocumentJob,
  renderProfileBDocument,
  StorageArtifactSink,
  SupabaseDocumentComputeClient,
} from '../agent-hub/workers/document-worker.ts'

const A1 = 'ab11c1de-1111-4111-8111-1111111fab11'
const OWNER = 'ef33a3bc-3333-4333-8333-3333333def33'
const WORKER_TOKEN = 'document-worker-token-0123456789abcdef'

let db: PGlite
let jobsHandler: (req: Request) => Promise<Response>
let uploadHandler: (req: Request) => Promise<Response>
const storageMap = new Map<string, Uint8Array>()
const buildDir = mkdtempSync(path.join(tmpdir(), 'nemo-doc-e2e-'))

const one = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) =>
  (await db.query<T>(sql, params)).rows[0]
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')

// PGlite-backed RPC routing shared by both bundled handlers and the worker transport
const RPC_ARGS: Record<string, string[]> = {
  document_enqueue_job: ['p_account_id', 'p_request_id', 'p_kind', 'p_input'],
  document_job_status: ['p_account_id', 'p_job_id'],
  document_verify_upload: ['p_account_id', 'p_job_id', 'p_claim_token', 'p_expected_epoch'],
  document_register_artifact: ['p_account_id', 'p_job_id', 'p_claim_token', 'p_expected_epoch', 'p_name', 'p_mime_type', 'p_size_bytes', 'p_sha256'],
  document_finalize_workflow: ['p_account_id', 'p_workflow_id'],
  runtime_finish_compute_job: ['p_account_id', 'p_job_id', 'p_claim_token', 'p_expected_epoch', 'p_status', 'p_result_manifest', 'p_error_code'],
}
const ROWSET_RPCS: Record<string, string[]> = {
  runtime_claim_compute_jobs: ['p_worker_id', 'p_lease_duration_seconds', 'p_limit', 'p_profile'],
  document_list_unfinalized: ['p_limit'],
}

async function bridgeRpc(name: string, args: Record<string, unknown>): Promise<{ data: unknown; error: { code?: string } | null }> {
  try {
    if (ROWSET_RPCS[name]) {
      const params = ROWSET_RPCS[name].map((key) => args[key])
      const placeholders = params.map((_, index) => `$${index + 1}`).join(',')
      const rows = await db.query<Record<string, unknown>>(`select * from public.${name}(${placeholders})`, params)
      // PostgREST serializes timestamptz as ISO strings; PGlite hands back Date objects
      const normalized = rows.rows.map((row) => Object.fromEntries(
        Object.entries(row).map(([key, value]) => [key, value instanceof Date ? value.toISOString() : value])))
      return { data: normalized, error: null }
    }
    const spec = RPC_ARGS[name]
    if (!spec) return { data: null, error: { code: 'UNEXPECTED_RPC' } }
    const params = spec.map((key) => {
      const value = args[key]
      return value !== null && typeof value === 'object' ? JSON.stringify(value) : value
    })
    const placeholders = params.map((_, index) => `$${index + 1}`).join(',')
    const row = await one<{ r: unknown }>(`select public.${name}(${placeholders}) as r`, params)
    return { data: row.r, error: null }
  } catch (error) {
    return { data: null, error: { code: (error as Error).message.slice(0, 40) } }
  }
}

const bridge = {
  rpc: bridgeRpc,
  users: { 'jwt-owner': { id: OWNER } } as Record<string, { id: string }>,
  async tableSingle(table: string, filters: Record<string, unknown>) {
    if (table === 'users') {
      return await one('select account_id, role, is_admin from public.users where id = $1', [filters.id]) ?? null
    }
    if (table === 'accounts') {
      return await one('select blocked from public.accounts where id = $1', [filters.id]) ?? null
    }
    if (table === 'document_artifacts') {
      return await one(
        'select name, mime_type, size_bytes, sha256, storage_path from public.document_artifacts where account_id = $1 and job_id = $2',
        [filters.account_id, filters.job_id]) ?? null
    }
    return null
  },
  storage: {
    upload(pathKey: string, bytes: Uint8Array) {
      if (storageMap.has(pathKey)) return { data: null, error: { message: 'The resource already exists', statusCode: '409' } }
      storageMap.set(pathKey, new Uint8Array(bytes))
      return { data: { path: pathKey }, error: null }
    },
    download(pathKey: string) {
      const bytes = storageMap.get(pathKey)
      return bytes
        ? { data: new Blob([bytes as unknown as BlobPart]), error: null }
        : { data: null, error: { message: 'not found' } }
    },
    sign(pathKey: string, ttl: number) {
      if (ttl !== 300) return { data: null, error: { message: 'unexpected ttl' } }
      return { data: { signedUrl: `local-signed://${pathKey}` }, error: null }
    },
  },
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
      action_type text, summary text, evidence jsonb,
      status text not null default 'pending',
      expires_at timestamptz, decided_by uuid, decided_at timestamptz,
      related_research_run_id uuid,
      created_at timestamptz not null default now()
    );
    grant usage on schema public to anon, authenticated;
    create schema storage;
    create table storage.buckets (id text primary key, name text, public boolean, file_size_limit bigint);
  `)
  for (const name of [
    '20260824120000_durable_runtime_phase1.sql',
    '20260824140000_durable_runtime_phase2_rpc.sql',
    '20260824180000_durable_runtime_phase3_context_and_circuit.sql',
    '20260824190000_circuit_breaker_self_healing.sql',
    '20260824200000_compute_jobs_and_sandbox.sql',
    '20260906000000_document_jobs_lifecycle.sql',
    '20260906010000_document_artifacts_storage.sql',
    '20260906020000_document_pdf_artifacts.sql',
  ]) {
    await db.exec(readFileSync(new URL(`../supabase/migrations/${name}`, import.meta.url), 'utf8'))
  }
  await db.exec(`
    insert into public.accounts (id) values ('${A1}');
    insert into public.users (id, account_id, role) values ('${OWNER}', '${A1}', 'owner');
  `)

  // both REAL handlers, bundled with a stub supabase-js proxying to the PGlite bridge
  ;(globalThis as Record<string, unknown>).__docE2eBridge = bridge
  const stubPath = path.join(buildDir, 'supabase-stub.mjs')
  writeFileSync(stubPath, `
const bridge = globalThis.__docE2eBridge
export function createClient(_url, _key, opts) {
  const bearer = (opts?.global?.headers?.Authorization ?? '').replace('Bearer ', '')
  return {
    auth: { getUser: async () => ({ data: { user: bridge.users[bearer] ?? null } }) },
    rpc: (name, args) => bridge.rpc(name, args),
    from(table) {
      const state = { filters: {} }
      const chain = {
        select: () => chain,
        eq: (column, value) => { state.filters[column] = value; return chain },
        maybeSingle: async () => ({ data: await bridge.tableSingle(table, state.filters), error: null }),
      }
      return chain
    },
    storage: { from: () => ({
      upload: async (p, bytes, _opts) => bridge.storage.upload(p, bytes),
      download: async (p) => bridge.storage.download(p),
      createSignedUrl: async (p, ttl) => bridge.storage.sign(p, ttl),
    }) },
  }
}
`)
  const ENV: Record<string, string> = {
    SUPABASE_URL: 'https://stub.local',
    SUPABASE_ANON_KEY: 'anon',
    SUPABASE_SERVICE_ROLE_KEY: 'service',
    NEMO_DOCUMENT_WORKER_TOKEN: WORKER_TOKEN,
    DOCUMENT_UPLOAD_BUDGET_MS: '30000',
  }
  const handlers: Array<(req: Request) => Promise<Response>> = []
  ;(globalThis as Record<string, unknown>).Deno = {
    env: { get: (key: string) => ENV[key] ?? '' },
    serve: (h: (req: Request) => Promise<Response>) => { handlers.push(h) },
  }
  for (const entry of ['supabase/functions/document-jobs/index.ts', 'supabase/functions/document-artifact-upload/index.ts']) {
    const outfile = path.join(buildDir, `${path.basename(path.dirname(entry))}.mjs`)
    await esbuild.build({
      entryPoints: [path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/(?:[A-Za-z]:)/, (m) => m.slice(1))), '..', entry)],
      bundle: true, outfile, format: 'esm', platform: 'node', logLevel: 'silent',
      plugins: [{
        name: 'stub-esm-sh',
        setup(build) { build.onResolve({ filter: /^https:\/\/esm\.sh\// }, () => ({ path: stubPath })) },
      }],
    })
    await import(pathToFileURL(outfile).href)
  }
  ;[jobsHandler, uploadHandler] = handlers
}, 180_000)

afterAll(async () => {
  rmSync(buildDir, { recursive: true, force: true })
  await db?.close()
})

const callJobs = (body: unknown) => jobsHandler(new Request('https://x/document-jobs', {
  method: 'POST',
  headers: { Authorization: 'Bearer jwt-owner', 'content-type': 'application/json' },
  body: JSON.stringify(body),
}))

// both OOXML kinds run the IDENTICAL chain — parameterized so PPTX has full parity with DOCX
const sourceBytes = sourceXlsx()
const sourceSnapshot = validateSourceSnapshot({ version: 1, extractorVersion: 'text-sources-1', owner: OWNER, submissionId: 'e2e-source',
  sources: [{ id: 'S1', name: 'sales.xlsx', size: sourceBytes.length, sha256: sha256(sourceBytes), data: parseDocumentSourceBytes('xlsx', sourceBytes) }] }, OWNER, 'e2e-source')
const sourceReport = buildSourceMarginReport(sourceSnapshot, 'Создай PDF по марже', { language: 'ru' })
if (!sourceReport.ok) throw new Error('source report fixture')
const sourceModel = buildDocumentModel('typst_document', sourceReport.title, sourceReport.text)
if (!sourceModel.ok) throw new Error('source model fixture')
const periodBytes = periodXlsx()
const periodSnapshot = validateSourceSnapshot({ version: 1, extractorVersion: 'text-sources-1', owner: OWNER, submissionId: 'e2e-period',
  sources: [{ id: 'S1', name: 'period.xlsx', size: periodBytes.length, sha256: sha256(periodBytes), data: parseDocumentSourceBytes('xlsx', periodBytes) }] }, OWNER, 'e2e-period')
const periodReport = buildSourceMarginReport(periodSnapshot, 'PDF по марже за июль', { language: 'ru', period: { from: '2026-07-01', to: '2026-07-31' } })
if (!periodReport.ok) throw new Error('period report fixture')
const periodTitle = `${periodReport.title} — июль 2026`
const periodModel = buildDocumentModel('typst_document', periodTitle, periodReport.text)
if (!periodModel.ok) throw new Error('period model fixture')
const E2E_CASES = [
  { kind: 'typst_document' as const, expectedExtension: '.pdf', input: periodModel.input },
  { kind: 'typst_document' as const, expectedExtension: '.pdf', input: sourceModel.input },
  {
    kind: 'typst_document' as const,
    expectedExtension: '.pdf',
    input: {
      kind: 'typst_document', template: 'report', title: 'Отчёт / Hisobot',
      sections: [{ heading: 'Итоги', body: 'Настоящий PDF прошёл очередь, рендер, регистрацию и выдачу. To‘liq ma’lumot saqlanadi.' }],
      line_items: [],
    },
  },
  {
    kind: 'docx_document' as const,
    expectedExtension: '.docx',
    input: {
      kind: 'docx_document',
      title: 'Сквозной отчёт / Uchma-uch hisobot',
      language: 'ru',
      blocks: [
        { type: 'heading', level: 1, text: 'Итоги' },
        { type: 'paragraph', text: 'Документ прошёл весь путь: очередь, рендер, регистрация, выдача.' },
      ],
    },
  },
  {
    kind: 'pptx_presentation' as const,
    expectedExtension: '.pptx',
    input: {
      kind: 'pptx_presentation',
      title: 'Сквозная презентация / Uchma-uch taqdimot',
      slides: [
        { title: 'Путь артефакта', bullets: ['Очередь', 'Рендер', 'Регистрация', 'Выдача'] },
        { title: 'Yakun', bullets: ['Baytlar bir xil'] },
      ],
    },
  },
]

describe('end-to-end document bytes', () => {
  test.each(E2E_CASES)('$kind: enqueue → render → upload/register → finalize → status → download, bytes identical', async ({ kind, input, expectedExtension }) => {
    const requestId = randomUUID()
    // 1) user enqueue through the REAL endpoint; request_id persistence = same job on repeat
    const enqueued = await callJobs({ action: 'enqueue', request_id: requestId, kind, input })
    expect(enqueued.status).toBe(200)
    const { job_id: jobId, workflow_id: workflowId } = await enqueued.json()
    const repeat = await (await callJobs({ action: 'enqueue', request_id: requestId, kind, input })).json()
    expect(repeat).toMatchObject({ ok: true, job_id: jobId, deduplicated: true })

    // 2) poll while nothing has run: still processing (resume the SAME job, no regeneration)
    expect(await (await callJobs({ action: 'status', job_id: jobId })).json())
      .toMatchObject({ ok: true, status: 'processing', artifact: null })

    // 3) the REAL worker path: claim from the REAL SQL, render REAL OOXML bytes in the
    //    isolated child, upload through the REAL boundary handler, finish, finalize inline
    const compute = new SupabaseDocumentComputeClient({ rpc: (name, args) => bridgeRpc(name, args as Record<string, unknown>) })
    const sink = new StorageArtifactSink('https://edge.local/document-artifact-upload', WORKER_TOKEN,
      ((url: RequestInfo | URL, init?: RequestInit) => uploadHandler(new Request(url, init))) as typeof fetch)
    let renderedBytes: Uint8Array | null = null
    const jobs = await compute.claim('e2e-worker', 4)
    expect(jobs.length).toBe(1)
    expect(jobs[0].job_id).toBe(jobId)
    const outcome = await processDocumentJob(jobs[0], {
      compute, sink,
      render: async (payload) => {
        const rendered = await renderProfileBDocument(payload)
        renderedBytes = rendered.bytes
        return rendered
      },
    })
    expect(outcome).toBe('completed')
    expect(renderedBytes).not.toBeNull()
    const renderedSha = sha256(renderedBytes!)

    // 4) the workflow was finalized INLINE; the SQL agrees end to end
    expect(await one(
      'select current_state, terminal_reason_code from runtime.workflow_runs where account_id = $1 and id = $2',
      [A1, workflowId])).toMatchObject({ current_state: 'completed', terminal_reason_code: null })

    // 5) status through the REAL endpoint: completed, artifact metadata matches the bytes
    const status = await (await callJobs({ action: 'status', job_id: jobId })).json()
    expect(status).toMatchObject({ ok: true, status: 'completed', kind })
    expect(status.artifact.sha256).toBe(renderedSha)
    expect(status.artifact.size_bytes).toBe(renderedBytes!.byteLength)
    expect(status.artifact.name.endsWith(expectedExtension)).toBe(true)

    // 6) download through the REAL endpoint: signed url resolves to byte-identical content
    const download = await (await callJobs({ action: 'download', job_id: jobId })).json()
    expect(download).toMatchObject({ ok: true, expires_in: 300, sha256: renderedSha })
    expect(download.url.startsWith('local-signed://')).toBe(true)
    const storedBytes = storageMap.get(download.url.replace('local-signed://', ''))
    expect(storedBytes).toBeTruthy()
    expect(sha256(storedBytes!)).toBe(renderedSha)
    expect(Buffer.from(storedBytes!).equals(Buffer.from(renderedBytes!))).toBe(true)
    // The actual boundary already parsed the PDF/OOXML container before registration.
    if (kind === 'typst_document') {
      expect(new TextDecoder().decode(storedBytes!.subarray(0, 5))).toBe('%PDF-')
      expect(download.mime_type).toBe('application/pdf')
      if (input.title === sourceReport.title || input.title === periodTitle) {
        const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
        const loading = pdfjs.getDocument({ data: new Uint8Array(storedBytes!), useSystemFonts: true })
        try {
          const pdf = await loading.promise
          let text = ''
          for (let i = 1; i <= pdf.numPages; i++) text += (await (await pdf.getPage(i)).getTextContent()).items.map((item) => 'str' in item ? item.str : '').join(' ') + ' '
          text = text.replace(/\s+/g, ' ')
          if (input.title === periodTitle) {
            for (const value of ['290.00 USD', '2026-07-01', '2026-07-31', 'Вне периода', 'sheet:2:row:5', '31.07.2026', periodSnapshot.sources[0].sha256]) expect(text).toContain(value)
            expect(text).not.toContain('Фильтр дат не применялся')
          } else {
            expect(text).toContain('270.00 USD')
            expect(text).toContain('sheet:2:row:2')
            expect(text).toContain(sourceSnapshot.sources[0].sha256)
            expect(text).toContain('Товар Второй')
          }
        } finally { await loading.destroy() }
      }
    } else {
      expect(storedBytes![0]).toBe(0x50)
      expect(storedBytes![1]).toBe(0x4b)
    }

    // 7) a completed request stays resumable: same request_id still returns the SAME job
    const resumed = await (await callJobs({ action: 'enqueue', request_id: requestId, kind, input })).json()
    expect(resumed).toMatchObject({ ok: true, job_id: jobId, deduplicated: true })
  }, 120_000)
})
