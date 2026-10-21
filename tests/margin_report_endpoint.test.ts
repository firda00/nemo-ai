// margin-report endpoint — offline tests for the injected handler and the streamed body
// reader. Fake db + in-memory storage only; no network. The wrapper's Deno.serve glue is not
// executed here (honest scope): everything it delegates to IS.
import { describe, expect, test } from 'vitest'
import { strToU8, zipSync } from 'fflate'
import {
  handleMarginReport, readBytesBounded, MAX_MARGIN_UPLOAD_BYTES,
  type MarginReportDeps, type MarginReportInput,
} from '../supabase/functions/_shared/marginReportHandler.ts'

// ── XLSX fixture builder (same minimal OOXML as the engine suite) ────────────────────────────────

const cellXml = (ref: string, value: string | number): string =>
  typeof value === 'number'
    ? `<c r="${ref}"><v>${value}</v></c>`
    : `<c r="${ref}" t="inlineStr"><is><t>${value}</t></is></c>`

function sheetXmlOf(rows: Array<Array<string | number | null>>): string {
  const body = rows.map((cells, rowIdx) => {
    const cols = 'ABCDEFGH'
    const xml = cells.map((value, colIdx) => value === null ? '' : cellXml(`${cols[colIdx]}${rowIdx + 1}`, value)).join('')
    return `<row r="${rowIdx + 1}">${xml}</row>`
  }).join('')
  return `<worksheet><sheetData>${body}</sheetData></worksheet>`
}

function makeXlsx(rows: Array<Array<string | number | null>>): Uint8Array {
  return zipSync({
    'xl/workbook.xml': strToU8('<workbook xmlns:r="http://x"><sheets><sheet name="S" sheetId="1" r:id="rId1"/></sheets></workbook>'),
    'xl/_rels/workbook.xml.rels': strToU8('<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>'),
    'xl/worksheets/sheet1.xml': strToU8(sheetXmlOf(rows)),
  }, { level: 6 })
}

// four products with distinct margins — Delta must NEVER appear in a response (top-3 only)
const FOUR_PRODUCTS = makeXlsx([
  ['Товар', 'Выручка', 'Total cost'],
  ['Alpha', 100, 10],
  ['Beta', 100, 30],
  ['Gamma', 100, 50],
  ['Delta', 100, 70],
])

// ── fakes ────────────────────────────────────────────────────────────────────────────────────────

type QueueResult = { data?: unknown; error?: unknown } | 'HANG'

function fakeAdmin(queue: { users?: QueueResult[]; accounts?: QueueResult[] }, upsertError = false) {
  const ops: string[] = []
  const upserts: Array<{ table: string; row: Record<string, unknown>; options: Record<string, unknown> | undefined }> = []
  return {
    ops,
    upserts,
    from(table: string) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const chain: any = {}
      for (const method of ['select', 'eq']) chain[method] = () => chain
      chain.maybeSingle = () => {
        ops.push(`${table}.maybeSingle`)
        const q = queue[table as 'users' | 'accounts']
        const next = q?.length ? q.shift()! : { data: null, error: null }
        if (next === 'HANG') return new Promise(() => {})
        return Promise.resolve(next)
      }
      chain.upsert = (row: Record<string, unknown>, options?: Record<string, unknown>) => {
        ops.push(`${table}.upsert`)
        upserts.push({ table, row, options })
        return Promise.resolve(upsertError ? { error: new Error('db') } : { error: null })
      }
      return chain
    },
  }
}

function memStorage(initial: Record<string, Uint8Array> = {}) {
  const puts: Array<{ path: string; bytes: Uint8Array; contentType: string }> = []
  const gets: string[] = []
  const signs: string[] = []
  const objects = new Map(Object.entries(initial))
  const cfg = { failPutRe: null as RegExp | null, failSign: false, hangPut: false, getError: false }
  const deps = {
    storagePut: async (path: string, bytes: Uint8Array, contentType: string) => {
      if (cfg.hangPut) { await new Promise(() => {}) }
      puts.push({ path, bytes, contentType })
      if (cfg.failPutRe?.test(path)) return { error: new Error('put_failed') }
      objects.set(path, bytes)
      return {}
    },
    storageGet: async (path: string) => {
      gets.push(path)
      if (cfg.getError) return { error: new Error('boom') }
      const bytes = objects.get(path)
      return bytes ? { bytes } : { notFound: true }
    },
    storageSign: async (path: string) => {
      signs.push(path)
      if (cfg.failSign) return { error: new Error('sign_failed') }
      return { url: `https://signed.example/${path}` }
    },
  }
  return { puts, gets, signs, objects, cfg, deps }
}

const OK_PROFILE: QueueResult = { data: { account_id: 'acc-1', role: 'owner', is_admin: false }, error: null }
const OK_ACCOUNT: QueueResult = { data: { blocked: false }, error: null }

function makeDeps(overrides: {
  users?: QueueResult[]; accounts?: QueueResult[]
  getUser?: MarginReportDeps['getUser']
  storage?: ReturnType<typeof memStorage>
  upsertError?: boolean
} = {}) {
  const storage = overrides.storage ?? memStorage()
  const admin = fakeAdmin({ users: overrides.users ?? [OK_PROFILE], accounts: overrides.accounts ?? [OK_ACCOUNT] }, overrides.upsertError === true)
  const deps: MarginReportDeps = {
    admin,
    getUser: overrides.getUser ?? (async () => ({ id: 'u1' })),
    ...storage.deps,
  }
  return { deps, storage, admin }
}

const post = (extra: Partial<MarginReportInput>): MarginReportInput =>
  ({ method: 'POST', authorization: 'Bearer jwt', ...extra })

const SHA_OF = async (bytes: Uint8Array) => {
  const digest = await crypto.subtle.digest('SHA-256', bytes.buffer.slice(0) as ArrayBuffer)
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

// ── auth chain ───────────────────────────────────────────────────────────────────────────────────

describe('margin-report auth chain', () => {
  test('non-POST → 405; missing user → 401', async () => {
    const { deps } = makeDeps()
    expect((await handleMarginReport(deps, { method: 'GET', authorization: '' })).status).toBe(405)
    const anon = makeDeps({ getUser: async () => null })
    expect(await handleMarginReport(anon.deps, post({ bytes: FOUR_PRODUCTS }))).toMatchObject({ status: 401, body: { error: 'unauthorized' } })
  })

  test('profile/account DB failures answer 503, never 403 — and authz failures answer 403', async () => {
    const cases: Array<[QueueResult[], QueueResult[], number, string]> = [
      [[{ data: null, error: new Error('db') }], [OK_ACCOUNT], 503, 'profile_unavailable'],
      [[{ data: null, error: null }], [OK_ACCOUNT], 403, 'no_account'],
      [[{ data: { account_id: 'acc-1', role: 'operator', is_admin: false }, error: null }], [OK_ACCOUNT], 403, 'owner_required'],
      [[OK_PROFILE], [{ data: null, error: new Error('db') }], 503, 'account_unavailable'],
      [[OK_PROFILE], [{ data: null, error: null }], 403, 'no_account'],
      [[OK_PROFILE], [{ data: { blocked: true }, error: null }], 403, 'blocked'],
    ]
    for (const [users, accounts, status, error] of cases) {
      const { deps } = makeDeps({ users, accounts })
      expect(await handleMarginReport(deps, post({ bytes: FOUR_PRODUCTS }))).toMatchObject({ status, body: { error } })
    }
  })

  test('unauthenticated caller never triggers the lazy body read', async () => {
    let pulled = 0
    const { deps } = makeDeps({ getUser: async () => null })
    const result = await handleMarginReport(deps, post({
      readBytes: async () => { pulled += 1; return { ok: true, bytes: FOUR_PRODUCTS } },
    }))
    expect(result.status).toBe(401)
    expect(pulled).toBe(0) // the 15MB stream is not consumed for strangers
  })
})

// ── input validation before any storage or compute ───────────────────────────────────────────────

describe('margin-report input validation', () => {
  test('exactly one input mode: both or neither → 400', async () => {
    const { deps, storage } = makeDeps()
    expect((await handleMarginReport(deps, post({}))).status).toBe(400)
    const both = makeDeps()
    expect((await handleMarginReport(both.deps, post({ bytes: FOUR_PRODUCTS, fileSha256: 'a'.repeat(64) }))).status).toBe(400)
    expect(storage.puts.length + storage.gets.length).toBe(0)
  })

  test('ADVERSARIAL currency dies at the allowlist BEFORE storage or compute', async () => {
    for (const currency of ['../../evil', 'UZS/../x', 'GBP', 'uzs ']) {
      const { deps, storage } = makeDeps()
      const result = await handleMarginReport(deps, post({ bytes: FOUR_PRODUCTS, currency }))
      expect(result).toMatchObject({ status: 400, body: { error: 'invalid_currency' } })
      expect(storage.puts.length + storage.gets.length + storage.signs.length).toBe(0)
    }
    // casing is not identity: lowercase folds and passes
    const ok = makeDeps()
    expect((await handleMarginReport(ok.deps, post({ bytes: FOUR_PRODUCTS, currency: 'uzs' }))).status).toBe(200)
  })

  test('sha traversal shapes → 400 invalid_sha, storage untouched', async () => {
    for (const sha of ['../../../etc/passwd', 'A'.repeat(64), 'a'.repeat(63), `${'a'.repeat(64)}/x`]) {
      const { deps, storage } = makeDeps()
      expect(await handleMarginReport(deps, post({ fileSha256: sha }))).toMatchObject({ status: 400, body: { error: 'invalid_sha' } })
      expect(storage.gets.length).toBe(0)
    }
  })

  test('empty file → 400, oversized file → 413', async () => {
    const empty = makeDeps()
    expect((await handleMarginReport(empty.deps, post({ bytes: new Uint8Array(0) }))).status).toBe(400)
    const big = makeDeps()
    expect((await handleMarginReport(big.deps, post({ bytes: new Uint8Array(MAX_MARGIN_UPLOAD_BYTES + 1) }))).status).toBe(413)
    expect(big.storage.puts.length).toBe(0)
  })

  test('lazy read failures map to transport statuses', async () => {
    for (const [reason, status] of [['too_large', 413], ['read_failed', 408], ['timeout', 503]] as const) {
      const { deps } = makeDeps()
      const result = await handleMarginReport(deps, post({ readBytes: async () => ({ ok: false, reason }) }))
      expect(result.status).toBe(status)
    }
  })
})

// ── retention and the sha follow-up ──────────────────────────────────────────────────────────────

describe('margin-report retention + follow-up', () => {
  test('bytes that are not real XLSX are answered AND never stored or registered', async () => {
    const { deps, storage, admin } = makeDeps()
    const result = await handleMarginReport(deps, post({ bytes: strToU8('not a zip at all') }))
    expect(result.status).toBe(200)
    expect(result.body.ok).toBe(false)
    expect(storage.puts.length).toBe(0) // no retention before a successful parse
    expect(admin.upserts).toHaveLength(0) // and no registry row for junk
  })

  test('needs_currency retains the ORIGINAL under the tenant path; follow-up reuses the exact object', async () => {
    const storage = memStorage()
    const first = makeDeps({ storage })
    const r1 = await handleMarginReport(first.deps, post({ bytes: FOUR_PRODUCTS, currency: null }))
    expect(r1.body).toMatchObject({ ok: true, needs_currency: true })
    const sha = r1.body.file_sha256 as string
    expect(sha).toBe(await SHA_OF(FOUR_PRODUCTS))
    const uploadPath = `tenants/acc-1/margin-uploads/${sha}.xlsx`
    expect(storage.puts.map((p) => p.path)).toEqual([uploadPath])
    // registry upsert carries ONLY the name: uploaded_at and a declared period are never
    // refreshed by a re-upload (the recipient's "uploaded" stamp stays the FIRST upload)
    expect(first.admin.upserts).toEqual([{
      table: 'margin_upload_registry',
      row: { account_id: 'acc-1', file_sha256: sha, file_name: 'upload.xlsx' },
      options: { onConflict: 'account_id,file_sha256' },
    }])

    // clarification round: sha + currency, SAME storage — the original is fetched, not re-sent
    const second = makeDeps({ storage })
    const r2 = await handleMarginReport(second.deps, post({ fileSha256: sha, currency: 'USD' }))
    expect(r2.status).toBe(200)
    expect(r2.body.ok).toBe(true)
    expect(storage.gets).toEqual([uploadPath])
    expect((r2.body.summary as { currency: string }).currency).toBe('USD')
    // the sha follow-up REPAIRS a missing registry row — insert-if-absent, existing untouched
    expect(second.admin.upserts[0]).toMatchObject({
      table: 'margin_upload_registry',
      options: { onConflict: 'account_id,file_sha256', ignoreDuplicates: true },
    })
  })

  test('a failed registry write is VISIBLE (registry_saved=false) — no silent missing monthly source', async () => {
    const broken = makeDeps({ upsertError: true })
    const result = await handleMarginReport(broken.deps, post({ bytes: FOUR_PRODUCTS, currency: 'UZS' }))
    expect(result.status).toBe(200)
    expect(result.body.ok).toBe(true) // the ordinary margin report stays usable
    expect(result.body.registry_saved).toBe(false) // but the picker gap is TYPED, never silent
    const healthy = makeDeps()
    const ok = await handleMarginReport(healthy.deps, post({ bytes: FOUR_PRODUCTS, currency: 'UZS' }))
    expect(ok.body.registry_saved).toBe(true)
  })

  test('cross-tenant sha resolves ONLY under the caller’s account → 404, not another tenant’s file', async () => {
    const sha = await SHA_OF(FOUR_PRODUCTS)
    // the file exists — but under a DIFFERENT account’s prefix
    const storage = memStorage({ [`tenants/acc-OTHER/margin-uploads/${sha}.xlsx`]: FOUR_PRODUCTS })
    const { deps } = makeDeps({ storage })
    const result = await handleMarginReport(deps, post({ fileSha256: sha }))
    expect(result).toMatchObject({ status: 404, body: { error: 'file_not_found' } })
    expect(storage.gets).toEqual([`tenants/acc-1/margin-uploads/${sha}.xlsx`])
  })

  test('integrity: a stored object that no longer matches its sha → 500, storage outage → 503', async () => {
    const sha = await SHA_OF(FOUR_PRODUCTS)
    const tampered = memStorage({ [`tenants/acc-1/margin-uploads/${sha}.xlsx`]: makeXlsx([['Товар', 'Выручка', 'Total cost'], ['X', 1, 1]]) })
    const bad = makeDeps({ storage: tampered })
    expect(await handleMarginReport(bad.deps, post({ fileSha256: sha }))).toMatchObject({ status: 500, body: { error: 'integrity_failed' } })

    const outage = memStorage()
    outage.cfg.getError = true
    const down = makeDeps({ storage: outage })
    expect(await handleMarginReport(down.deps, post({ fileSha256: sha }))).toMatchObject({ status: 503, body: { error: 'file_read_failed' } })
  })
})

// ── success shape and failure of the artifact pipeline ───────────────────────────────────────────

describe('margin-report artifacts + response shape', () => {
  test('success: deterministic tenant paths, three signed artifacts, aggregate-only response', async () => {
    const { deps, storage } = makeDeps()
    const result = await handleMarginReport(deps, post({ bytes: FOUR_PRODUCTS, currency: 'UZS', fileName: 'sales.xlsx' }))
    expect(result.status).toBe(200)
    expect(result.body.ok).toBe(true)
    const sha = result.body.file_sha256 as string
    const outDir = `tenants/acc-1/margin-reports/${sha}/UZS-v1`
    expect(storage.puts.map((p) => p.path)).toEqual([
      `tenants/acc-1/margin-uploads/${sha}.xlsx`,
      `${outDir}/report.csv`, `${outDir}/report.xlsx`, `${outDir}/report.html`,
    ])
    expect(storage.signs).toEqual([`${outDir}/report.csv`, `${outDir}/report.xlsx`, `${outDir}/report.html`])
    const files = result.body.files as Record<string, { url: string; expires_in_seconds: number }>
    expect(Object.keys(files).sort()).toEqual(['csv', 'html', 'xlsx'])
    expect(files.csv.expires_in_seconds).toBe(600)

    // the response is aggregates + top-3 ONLY: the 4th product must not leak anywhere in it
    const summary = result.body.summary as { topProducts: Array<{ name: string }>; totals: { revenue: string } }
    expect(summary.topProducts.map((p) => p.name)).toEqual(['Alpha', 'Beta', 'Gamma'])
    expect(JSON.stringify(result.body)).not.toContain('Delta')
    expect(summary.totals.revenue).toBe('400.00')
  })

  test('artifact store/sign failures → 503 with distinct reasons', async () => {
    const failing = memStorage()
    failing.cfg.failPutRe = /report\.csv$/
    const stored = makeDeps({ storage: failing })
    expect(await handleMarginReport(stored.deps, post({ bytes: FOUR_PRODUCTS, currency: 'UZS' })))
      .toMatchObject({ status: 503, body: { error: 'report_store_failed' } })

    const unsignable = memStorage()
    unsignable.cfg.failSign = true
    const signed = makeDeps({ storage: unsignable })
    expect(await handleMarginReport(signed.deps, post({ bytes: FOUR_PRODUCTS, currency: 'UZS' })))
      .toMatchObject({ status: 503, body: { error: 'sign_failed' } })
  })
})

// ── the shared deadline ──────────────────────────────────────────────────────────────────────────

describe('margin-report deadline', () => {
  test('hung auth answers 503 timeout at the deadline — and nothing dispatches afterwards', async () => {
    const { deps, storage, admin } = makeDeps({ users: ['HANG'] })
    const started = Date.now()
    const result = await handleMarginReport(deps, post({ bytes: FOUR_PRODUCTS, currency: 'UZS', deadlineAt: Date.now() + 120 }))
    expect(result).toMatchObject({ status: 503, body: { error: 'timeout' } })
    expect(Date.now() - started).toBeLessThan(5_000)
    await new Promise((resolve) => setTimeout(resolve, 60)) // let any abandoned branch try
    expect(admin.ops.filter((op) => op.startsWith('accounts'))).toEqual([]) // next phase never started
    expect(storage.puts.length + storage.gets.length).toBe(0)
  })

  test('hung retention put answers 503 timeout without reaching the artifact pipeline', async () => {
    const storage = memStorage()
    storage.cfg.hangPut = true
    const { deps } = makeDeps({ storage })
    const result = await handleMarginReport(deps, post({ bytes: FOUR_PRODUCTS, currency: 'UZS', deadlineAt: Date.now() + 150 }))
    expect(result).toMatchObject({ status: 503, body: { error: 'timeout' } })
    await new Promise((resolve) => setTimeout(resolve, 60))
    expect(storage.signs).toEqual([]) // no signing after expiry
  })
})

// ── streamed body reader ─────────────────────────────────────────────────────────────────────────

const streamOf = (chunks: Uint8Array[], mode: 'close' | 'stall' | 'error' = 'close') =>
  new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (chunks.length) { controller.enqueue(chunks.shift()!); return }
      if (mode === 'stall') return new Promise<never>(() => {})
      if (mode === 'error') { controller.error(new Error('net')); return }
      controller.close()
    },
  })

const reqOf = (body: ReadableStream<Uint8Array> | null, contentLength?: number) => ({
  headers: { get: (name: string) => name.toLowerCase() === 'content-length' && contentLength !== undefined ? String(contentLength) : null },
  body,
})

describe('readBytesBounded', () => {
  test('merges chunks; a declared oversize refuses before reading', async () => {
    const ok = await readBytesBounded(reqOf(streamOf([strToU8('ab'), strToU8('cd')])), { maxBytes: 10, deadlineAt: Date.now() + 1_000 })
    expect(ok).toMatchObject({ ok: true })
    if (ok.ok) expect(new TextDecoder().decode(ok.bytes)).toBe('abcd')
    expect(await readBytesBounded(reqOf(streamOf([]), 11), { maxBytes: 10, deadlineAt: Date.now() + 1_000 }))
      .toMatchObject({ ok: false, reason: 'too_large' })
  })

  test('the metadata refusal still RELEASES the unread stream — cancelled, without awaiting it', async () => {
    let cancelled = 0
    const body = {
      cancel: () => { cancelled += 1; return new Promise<never>(() => {}) }, // never settles — must not block
      getReader: () => { throw new Error('must not read a refused body') },
    } as unknown as ReadableStream<Uint8Array>
    const started = Date.now()
    const result = await readBytesBounded(reqOf(body, 11), { maxBytes: 10, deadlineAt: Date.now() + 60_000 })
    expect(result).toMatchObject({ ok: false, reason: 'too_large' })
    expect(cancelled).toBe(1)
    expect(Date.now() - started).toBeLessThan(1_000) // the hung cancel was not awaited
  })

  test('an UNDERSTATED declared size still hits the streamed cap while arriving', async () => {
    const result = await readBytesBounded(
      reqOf(streamOf([new Uint8Array(8), new Uint8Array(8)]), 4), // liar: says 4, sends 16
      { maxBytes: 10, deadlineAt: Date.now() + 1_000 },
    )
    expect(result).toMatchObject({ ok: false, reason: 'too_large' })
  })

  test('a stalled sender times out at the shared deadline; a broken stream reads as failure', async () => {
    const started = Date.now()
    expect(await readBytesBounded(reqOf(streamOf([strToU8('x')], 'stall')), { maxBytes: 10, deadlineAt: Date.now() + 100 }))
      .toMatchObject({ ok: false, reason: 'timeout' })
    expect(Date.now() - started).toBeLessThan(5_000)
    expect(await readBytesBounded(reqOf(streamOf([], 'error')), { maxBytes: 10, deadlineAt: Date.now() + 1_000 }))
      .toMatchObject({ ok: false, reason: 'read_failed' })
  })
})
