// Product-margin report from a chat XLSX attachment — authenticated, deterministic, no LLM.
// All behavior lives in _shared/marginReportHandler.ts (offline-tested); this wrapper only
// streams the body under the request's ONE deadline and wires real dependencies.
//
//   POST /functions/v1/margin-report  (Bearer jwt)
//     • binary mode: Content-Type: application/octet-stream, body = raw .xlsx bytes,
//       X-File-Name: <uri-encoded name> (optional), X-Currency: <code> (optional);
//     • follow-up mode: Content-Type: application/json, { file_sha256, currency } — reuses the
//       RETAINED original upload, so a currency clarification never re-uploads.
//
// Ordering matters: a request without a bearer is refused BEFORE any body handling, and the
// 15MB binary body is handed to the handler as a LAZY reader — it is pulled from the wire only
// after the whole auth chain passed. The platform gateway (verify_jwt=true) already rejects
// missing JWTs, but this function must stay safe even if that config drifts.
//
// Storage is a PRIVATE bucket ('margin-files', no browser policies): every path is built inside
// the handler from the authenticated account, and downloads happen only via short-TTL signed
// URLs the handler returns. Reads from the bucket are STREAMED under the same byte cap as
// uploads — a stored object is trusted content but not a license to buffer unbounded bytes.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.108.2'
import { corsPreflight, json } from '../_shared/cors.ts'
import {
  handleMarginReport, readBytesBounded, MAX_MARGIN_UPLOAD_BYTES,
} from '../_shared/marginReportHandler.ts'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? ''
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY') ?? ''
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''

const BUCKET = 'margin-files'
// One wall-clock budget for the WHOLE request — body read AND handler share it. Sized for a
// 15MB upload on a slow link plus hashing and three artifact writes, under the platform limit.
const TOTAL_BUDGET_MS = 110_000
const MAX_JSON_BODY_BYTES = 8 * 1024

function headerText(req: Request, name: string): string | undefined {
  const raw = req.headers.get(name)
  if (raw === null || raw === '') return undefined
  try { return decodeURIComponent(raw) } catch { return raw }
}

Deno.serve(async (req) => {
  const preflight = corsPreflight(req)
  if (preflight) return preflight
  // fail closed with a constant shape when the function is not provisioned
  if (!SUPABASE_URL || !ANON_KEY || !SERVICE_ROLE) return json({ ok: false, error: 'not_configured' }, 500)
  if (req.method !== 'POST') return json({ ok: false, error: 'method_not_allowed' }, 405)
  const authorization = req.headers.get('Authorization') ?? ''
  // early refusal: no bearer means no body is read at all, whatever the gateway config says
  if (!authorization) return json({ ok: false, error: 'unauthorized' }, 401)

  const deadlineAt = Date.now() + TOTAL_BUDGET_MS
  const contentType = (req.headers.get('content-type') ?? '').toLowerCase()
  const readBody = (maxBytes: number) => readBytesBounded(req, { maxBytes, deadlineAt })
  let input: { readBytes?: () => ReturnType<typeof readBody>; fileSha256?: string; currency?: string | null; fileName?: string }

  if (contentType.includes('application/json')) {
    // follow-up mode: a tiny JSON body naming the retained file — never the file itself
    const read = await readBody(MAX_JSON_BODY_BYTES)
    if (!read.ok) {
      return read.reason === 'too_large'
        ? json({ ok: false, error: 'body_too_large' }, 413)
        : json({ ok: false, error: read.reason === 'timeout' ? 'timeout' : 'body_read_failed' }, read.reason === 'timeout' ? 503 : 408)
    }
    const payload = ((): Record<string, unknown> | null => {
      try { return JSON.parse(new TextDecoder().decode(read.bytes)) } catch { return null }
    })()
    if (!payload || typeof payload !== 'object') return json({ ok: false, error: 'bad_request' }, 400)
    input = {
      fileSha256: typeof payload.file_sha256 === 'string' ? payload.file_sha256 : undefined,
      currency: typeof payload.currency === 'string' ? payload.currency : undefined,
    }
  } else {
    // binary mode: the attachment is NOT read here — the handler pulls this lazily after the
    // auth chain passed, streamed and capped while it arrives
    input = {
      readBytes: () => readBody(MAX_MARGIN_UPLOAD_BYTES),
      fileName: headerText(req, 'x-file-name'),
      currency: headerText(req, 'x-currency') ?? null,
    }
  }

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE)
  const result = await handleMarginReport({
    admin,
    getUser: async (auth) => {
      if (!auth) return null
      const userDb = createClient(SUPABASE_URL, ANON_KEY, { global: { headers: { Authorization: auth } } })
      const { data: { user } } = await userDb.auth.getUser()
      return user ? { id: user.id } : null
    },
    storagePut: async (path, data, putContentType) => {
      const { error } = await admin.storage.from(BUCKET).upload(path, data, { contentType: putContentType, upsert: true })
      return { error: error ?? undefined }
    },
    // streamed read with the SAME byte cap as uploads and an abort tied to the shared deadline:
    // SDK download() would buffer the whole object as a Blob before any size check
    storageGet: async (path) => {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), Math.max(0, deadlineAt - Date.now()))
      try {
        const encodedPath = path.split('/').map(encodeURIComponent).join('/')
        const response = await fetch(`${SUPABASE_URL}/storage/v1/object/${BUCKET}/${encodedPath}`, {
          headers: { Authorization: `Bearer ${SERVICE_ROLE}`, apikey: SERVICE_ROLE },
          signal: controller.signal,
          redirect: 'error',
        })
        if (response.status === 404) { void response.body?.cancel().catch(() => {}); return { notFound: true } }
        if (!response.ok) {
          // storage-api versions differ on missing-object status; sniff a SMALL bounded body
          const sniff = await readBytesBounded({ headers: { get: () => null }, body: response.body }, { maxBytes: 1024, deadlineAt })
          const text = sniff.ok ? new TextDecoder().decode(sniff.bytes) : ''
          if (response.status === 400 && /not.?found/i.test(text)) return { notFound: true }
          return { error: new Error(`storage_${response.status}`) }
        }
        const read = await readBytesBounded({ headers: response.headers, body: response.body }, { maxBytes: MAX_MARGIN_UPLOAD_BYTES, deadlineAt })
        // a refused read (declared oversize, cap hit, stall) already cancelled its reader —
        // abort the fetch as well so the connection itself is torn down, not merely unread
        if (!read.ok) { controller.abort(); return { error: new Error(read.reason) } }
        return { bytes: read.bytes }
      } catch (error) {
        return { error }
      } finally {
        clearTimeout(timer)
      }
    },
    storageSign: async (path, expiresInSeconds) => {
      const { data, error } = await admin.storage.from(BUCKET).createSignedUrl(path, expiresInSeconds)
      if (error || !data?.signedUrl) return { error: error ?? new Error('sign_missing_url') }
      return { url: data.signedUrl }
    },
  }, {
    method: req.method,
    authorization,
    readBytes: input.readBytes,
    fileName: input.fileName,
    fileSha256: input.fileSha256,
    currency: input.currency,
    deadlineAt,
  })
  return json(result.body, result.status)
})
