// Server-side margin report for chat attachments — Step: chat → deterministic report/downloads.
// Pure and injected (db, storage, clock) so every branch is testable offline.
//
// Security contract (Codex Plan-A conditions + early-review corrections):
//   • the account comes from the AUTHENTICATED user (users row), never from the body; the same
//     owner/is_admin + blocked-account chain as the briefing handler;
//   • there is NO client-supplied path and NO URL fetch anywhere: a first call carries the raw
//     bytes (wrapper-streamed and capped), a follow-up carries only a sha256 — every storage
//     path is built HERE from the caller's own account and that hash, so cross-tenant reads and
//     traversal are structurally impossible (the sha shape is validated on top);
//   • the declared currency is validated against the engine's SUPPORTED_CURRENCIES allowlist
//     BEFORE any storage or compute — report.currency is interpolated into the output path, so
//     caller strings (../, slashes, unsupported codes) must never reach it; the engine carries
//     the same guard as defense in depth, and the path build re-checks the final invariant;
//   • a follow-up download is re-hashed and must equal the requested sha (storage integrity);
//   • the upload is retained ONLY after the bytes parsed as real XLSX — invalid arbitrary
//     binary is never stored; retention is what makes the currency clarification reuse the
//     ORIGINAL file (the user is never asked to re-upload) and lets an expired signed URL be
//     re-issued from the sha without another upload;
//   • outputs land under a DETERMINISTIC private path — account + file sha + currency + engine
//     version — so a retry overwrites the identical artifact instead of duplicating it; links
//     are short-TTL signed URLs;
//   • ONE deadline covers every await (auth, DB, storage, hashing) with a checkpoint before
//     each dependency call, so nothing new dispatches after expiry. The checkpoint also reads
//     the clock — a busy microtask chain can outrun the timer macrotask. Storage writes here
//     are idempotent at deterministic paths, so an already-in-flight late write is harmless,
//     unlike the briefing settings save. Parse+compute are synchronous and bounded by the
//     ingest caps (entry/byte/row limits) — no wall-clock preemption is CLAIMED over them;
//   • the response carries ONLY the aggregate summary and top-3 products — no row-level
//     financial data and no URLs are meant for model history or generic telemetry (this flow is
//     deterministic UI↔function; no LLM sees it).
import { parseXlsxWorkbook } from './xlsxIngest.ts'
import {
  computeProductMargin, formatCents, MARGIN_ENGINE_VERSION, SUPPORTED_CURRENCIES,
  type MarginReport,
} from './productMargin.ts'
import { marginReportToCsv, marginReportToHtml, marginReportToXlsx } from './marginReportExport.ts'

export const MAX_MARGIN_UPLOAD_BYTES = 15 * 1024 * 1024
export const DEFAULT_MARGIN_TIMEOUT_MS = 60_000
const SIGN_TTL_SECONDS = 600
const SHA_RE = /^[0-9a-f]{64}$/
const CODE_RE = /^[A-Z]{3}$/
const DEADLINE_ERR = 'MARGIN_REQUEST_TIMEOUT'

export interface MarginReportDeps {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Supabase service-role client shape
  admin: any
  getUser: (authorization: string) => Promise<{ id: string } | null>
  storagePut: (path: string, bytes: Uint8Array, contentType: string) => Promise<{ error?: unknown }>
  storageGet: (path: string) => Promise<{ bytes?: Uint8Array; notFound?: boolean; error?: unknown }>
  storageSign: (path: string, expiresInSeconds: number) => Promise<{ url?: string; error?: unknown }>
  now?: () => number
}

export interface MarginReportInput {
  method: string
  authorization: string
  bytes?: Uint8Array
  /**
   * Lazy body read: the wrapper hands the stream, the handler pulls it only AFTER the auth
   * chain passed — an unauthenticated caller never gets 15MB of upload buffered.
   */
  readBytes?: () => Promise<{ ok: true; bytes: Uint8Array } | { ok: false; reason: 'too_large' | 'read_failed' | 'timeout' }>
  fileName?: string
  fileSha256?: string
  currency?: string | null
  /** Absolute ms timestamp shared with the wrapper's body read; defaults to now + 60s. */
  deadlineAt?: number
}

export interface MarginReportResult { status: number; body: Record<string, unknown> }

// The streamed, capped body reader moved to the shared module (cli-chat needs it too);
// re-exported here so the wrapper and the endpoint tests keep their import surface.
export { readBytesBounded } from './boundedBody.ts'

interface DeadlineCtx {
  checkpoint: () => void
  race: <T>(inner: Promise<T>) => Promise<T>
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer)
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

function summaryOf(report: MarginReport) {
  return {
    currency: report.currency,
    totalsComplete: report.totalsComplete,
    completenessReasons: report.completenessReasons,
    totals: {
      revenue: formatCents(report.totals.revenueCents),
      costComplete: formatCents(report.totals.costCentsComplete),
      marginComplete: formatCents(report.totals.marginCentsComplete),
      marginPctComplete: report.totals.marginPctComplete,
      rowsComplete: report.totals.rowsComplete,
      rowsTotal: report.totals.rowsTotal,
      returnsCount: report.totals.returnsCount,
    },
    topProducts: report.products.slice(0, 3).map((product) => ({
      name: product.name,
      sku: product.sku,
      coveredMargin: formatCents(product.coveredMarginCents),
      coveredMarginPct: product.coveredMarginPct,
      complete: product.complete,
    })),
  }
}

export async function handleMarginReport(deps: MarginReportDeps, input: MarginReportInput): Promise<MarginReportResult> {
  if (input.method !== 'POST') return { status: 405, body: { ok: false, error: 'method_not_allowed' } }
  const nowMs = deps.now ?? (() => Date.now())
  const deadlineAt = input.deadlineAt ?? nowMs() + DEFAULT_MARGIN_TIMEOUT_MS
  const state = { expired: false }
  let expire: (error: Error) => void = () => {}
  const expired = new Promise<never>((_resolve, reject) => { expire = reject })
  expired.catch(() => {})
  const timer = setTimeout(() => { state.expired = true; expire(new Error(DEADLINE_ERR)) }, Math.max(0, deadlineAt - nowMs()))
  const ctx: DeadlineCtx = {
    // the timer macrotask can lose to a busy microtask chain — the clock is the authority
    checkpoint: () => {
      if (state.expired || nowMs() >= deadlineAt) { state.expired = true; throw new Error(DEADLINE_ERR) }
    },
    race: (inner) => {
      inner.catch(() => {}) // the loser must never surface as unhandled
      return Promise.race([inner, expired])
    },
  }
  const inner = handleInner(deps, input, ctx)
  inner.catch(() => {}) // the abandoned branch may reject at its next checkpoint — never unhandled
  try {
    return await Promise.race([inner, expired])
  } catch (error) {
    const timedOut = error instanceof Error && error.message === DEADLINE_ERR
    return { status: 503, body: { ok: false, error: timedOut ? 'timeout' : 'internal' } }
  } finally {
    clearTimeout(timer)
  }
}

async function handleInner(deps: MarginReportDeps, input: MarginReportInput, ctx: DeadlineCtx): Promise<MarginReportResult> {
  const user = await ctx.race(deps.getUser(input.authorization).catch(() => null))
  ctx.checkpoint()
  if (!user) return { status: 401, body: { ok: false, error: 'unauthorized' } }
  const { data: profile, error: profileError } = await ctx.race(Promise.resolve(deps.admin
    .from('users').select('account_id, role, is_admin').eq('id', user.id).maybeSingle()))
  ctx.checkpoint()
  if (profileError) return { status: 503, body: { ok: false, error: 'profile_unavailable' } }
  if (!profile?.account_id) return { status: 403, body: { ok: false, error: 'no_account' } }
  if (profile.role !== 'owner' && profile.is_admin !== true) return { status: 403, body: { ok: false, error: 'owner_required' } }
  const accountId = String(profile.account_id)
  const { data: account, error: accountError } = await ctx.race(Promise.resolve(deps.admin
    .from('accounts').select('blocked').eq('id', accountId).maybeSingle()))
  ctx.checkpoint()
  if (accountError) return { status: 503, body: { ok: false, error: 'account_unavailable' } }
  if (!account) return { status: 403, body: { ok: false, error: 'no_account' } }
  if (account.blocked) return { status: 403, body: { ok: false, error: 'blocked' } }

  const hasBytes = input.bytes !== undefined || input.readBytes !== undefined
  const hasSha = typeof input.fileSha256 === 'string' && input.fileSha256 !== ''
  if (hasBytes === hasSha) return { status: 400, body: { ok: false, error: 'bad_request' } } // exactly one input mode
  if (input.bytes !== undefined && input.readBytes !== undefined) return { status: 400, body: { ok: false, error: 'bad_request' } }
  // allowlist BEFORE any storage or compute: the effective currency ends up inside the output
  // path, so an arbitrary caller string must be stopped here, not discovered downstream
  const rawCurrency = input.currency === undefined || input.currency === null || input.currency === '' ? null : String(input.currency).toUpperCase()
  if (rawCurrency !== null && !SUPPORTED_CURRENCIES.includes(rawCurrency)) {
    return { status: 400, body: { ok: false, error: 'invalid_currency', supported: [...SUPPORTED_CURRENCIES] } }
  }
  const currency = rawCurrency
  const fileName = (input.fileName ?? 'upload.xlsx').replace(/[^\p{L}\p{N} ._()-]/gu, '').slice(0, 120) || 'upload.xlsx'

  let bytes: Uint8Array
  let fileSha256: string
  // Registry row for the monthly-report source picker. bytes mode carries ONLY the file name on
  // conflict — a re-upload must not refresh uploaded_at or clear a declared period (the
  // "uploaded" stamp shown to the recipient stays the FIRST upload). The sha follow-up REPAIRS
  // a missing row (insert-if-absent, existing rows untouched) — it runs only after the
  // integrity check proved the stored object matches. Non-fatal for the margin report itself,
  // but the outcome is TYPED into the response: a silent false "this file is available monthly"
  // must never happen.
  let registrySaved = true
  const registerUpload = async (repairOnly: boolean): Promise<boolean> => {
    ctx.checkpoint()
    const outcome = await ctx.race(Promise.resolve(deps.admin.from('margin_upload_registry').upsert(
      { account_id: accountId, file_sha256: fileSha256, file_name: fileName },
      repairOnly ? { onConflict: 'account_id,file_sha256', ignoreDuplicates: true } : { onConflict: 'account_id,file_sha256' },
    )).catch((error: unknown) => ({ error })))
    ctx.checkpoint()
    return !(outcome as { error?: unknown }).error
  }
  if (hasBytes) {
    if (input.readBytes) {
      // the stream is pulled only here — past auth, mode and currency validation
      ctx.checkpoint()
      const read = await ctx.race(input.readBytes())
      ctx.checkpoint()
      if (!read.ok) {
        if (read.reason === 'too_large') return { status: 413, body: { ok: false, error: 'file_too_large' } }
        if (read.reason === 'timeout') return { status: 503, body: { ok: false, error: 'timeout' } }
        return { status: 408, body: { ok: false, error: 'body_read_failed' } }
      }
      bytes = read.bytes
    } else {
      bytes = input.bytes!
    }
    if (bytes.byteLength === 0) return { status: 400, body: { ok: false, error: 'empty_file' } }
    if (bytes.byteLength > MAX_MARGIN_UPLOAD_BYTES) return { status: 413, body: { ok: false, error: 'file_too_large' } }
    ctx.checkpoint()
    fileSha256 = await ctx.race(sha256Hex(bytes))
    ctx.checkpoint()
  } else {
    if (!SHA_RE.test(input.fileSha256!)) return { status: 400, body: { ok: false, error: 'invalid_sha' } }
    fileSha256 = input.fileSha256!
    ctx.checkpoint()
    const fetched = await ctx.race(deps.storageGet(`tenants/${accountId}/margin-uploads/${fileSha256}.xlsx`))
    ctx.checkpoint()
    if (fetched.notFound) return { status: 404, body: { ok: false, error: 'file_not_found' } }
    if (fetched.error || !fetched.bytes) return { status: 503, body: { ok: false, error: 'file_read_failed' } }
    if (fetched.bytes.byteLength > MAX_MARGIN_UPLOAD_BYTES) return { status: 413, body: { ok: false, error: 'file_too_large' } }
    // integrity: the stored object must still BE the file the hash names
    if (await ctx.race(sha256Hex(fetched.bytes)) !== fileSha256) return { status: 500, body: { ok: false, error: 'integrity_failed' } }
    ctx.checkpoint()
    bytes = fetched.bytes
  }

  const parsed = parseXlsxWorkbook(bytes)
  // nothing is stored before this point in bytes mode: bytes that are not real XLSX never land
  if (!parsed.ok) return { status: 200, body: { ok: false, error: parsed.reason, detail: parsed.detail } }
  if (!hasBytes) {
    // sha mode: integrity AND a successful parse proved this is a valid workbook of this sha —
    // only now repair a missing registry row (insert-if-absent; existing rows never touched).
    // The registry's invariant stays "valid workbooks only".
    registrySaved = await registerUpload(true)
  }
  const result = computeProductMargin(parsed, { currency, fileName, fileSha256 })

  const uploadPath = `tenants/${accountId}/margin-uploads/${fileSha256}.xlsx`
  const retainUpload = async (): Promise<MarginReportResult | null> => {
    if (!hasBytes) return null // sha mode: the object is already in storage
    ctx.checkpoint()
    const retained = await ctx.race(deps.storagePut(uploadPath, bytes,
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'))
    ctx.checkpoint()
    if (retained.error) return { status: 503, body: { ok: false, error: 'upload_store_failed' } }
    registrySaved = await registerUpload(false)
    return null
  }

  if (!result.ok) {
    if (result.reason === 'needs_currency') {
      // retain the parsed-valid ORIGINAL so the clarification round reuses it via the sha —
      // the user is never asked to re-upload; failing to retain fails the request, because a
      // follow-up that cannot find the file is worse
      const failed = await retainUpload()
      if (failed) return failed
      return { status: 200, body: { ok: true, needs_currency: true, file_sha256: fileSha256, detail: result.detail ?? null, registry_saved: registrySaved } }
    }
    return { status: 200, body: { ok: false, error: result.reason, detail: result.detail } }
  }

  // final invariant where the interpolation happens: the engine guarantees an allowlisted code,
  // but the path build must not depend on a distant module staying correct
  if (!CODE_RE.test(result.currency) || !SUPPORTED_CURRENCIES.includes(result.currency)) {
    return { status: 500, body: { ok: false, error: 'internal' } }
  }
  const failed = await retainUpload()
  if (failed) return failed

  // deterministic retry key: account + file hash + currency + engine version — a retry
  // overwrites the identical artifacts instead of multiplying them
  const outDir = `tenants/${accountId}/margin-reports/${fileSha256}/${result.currency}-v${MARGIN_ENGINE_VERSION}`
  const artifacts: Array<[string, Uint8Array | string, string]> = [
    [`${outDir}/report.csv`, '\uFEFF' + marginReportToCsv(result), 'text/csv;charset=utf-8'],
    [`${outDir}/report.xlsx`, marginReportToXlsx(result), 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
    [`${outDir}/report.html`, marginReportToHtml(result), 'text/html;charset=utf-8'],
  ]
  const files: Record<string, { url: string; expires_in_seconds: number }> = {}
  for (const [path, content, contentType] of artifacts) {
    const data = typeof content === 'string' ? new TextEncoder().encode(content) : content
    ctx.checkpoint()
    const stored = await ctx.race(deps.storagePut(path, data, contentType))
    ctx.checkpoint()
    if (stored.error) return { status: 503, body: { ok: false, error: 'report_store_failed' } }
    const signed = await ctx.race(deps.storageSign(path, SIGN_TTL_SECONDS))
    ctx.checkpoint()
    if (signed.error || !signed.url) return { status: 503, body: { ok: false, error: 'sign_failed' } }
    const key = path.endsWith('.csv') ? 'csv' : path.endsWith('.xlsx') ? 'xlsx' : 'html'
    files[key] = { url: signed.url, expires_in_seconds: SIGN_TTL_SECONDS }
  }
  return {
    status: 200,
    body: { ok: true, file_sha256: fileSha256, summary: summaryOf(result), files, registry_saved: registrySaved },
  }
}
