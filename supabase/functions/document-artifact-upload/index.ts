// Document artifact UPLOAD boundary (Codex conditional GO, local only — no deploy):
// the worker holds ONLY NEMO_DOCUMENT_WORKER_TOKEN; the service role lives here. Order is
// upload → register → finish → finalize. The lease pre-check below is ADVISORY (it cannot
// promise no stale byte writes after it returns); the publication fence is the
// document_register_artifact transaction, which re-verifies claim_token/epoch/lease under
// the parent lock. Bytes a stale worker managed to store stay unreferenced orphans.
//
// Canonical immutable path (server-generated, no client-selected path exists):
//   tenants/<account>/artifacts/<job>/<lease_epoch>/<sha256>-<name>
// A same-path collision can only be the SAME attempt with the SAME declared content; the
// stored object's ACTUAL bytes are downloaded and hash/size-verified before reuse — an
// existing object is never blindly registered.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.108.2'
import { inspectOoxml, type OoxmlKind } from '../_shared/ooxmlInspect.ts'
import { inspectPdf } from '../_shared/pdfInspect.ts'
import { Deadline } from '../_shared/requestDeadline.ts'

const encoder = new TextEncoder()
const BUCKET = 'document-artifacts'
const MAX_ARTIFACT_BYTES = 64 * 1024 * 1024
// one shared budget over the whole request: slow trickle reads, storage calls and the
// registration RPC all race the same deadline (env-tunable, clamped to sane bounds).
// The blank check MUST run before Number(): Number('') is 0, which would silently clamp the
// DEFAULT configuration down to 100ms and time out every normal upload.
function requestBudgetMs(): number {
  const raw = Deno.env.get('DOCUMENT_UPLOAD_BUDGET_MS')
  if (raw === undefined || raw === null || raw.trim() === '') return 60_000
  const configured = Number(raw)
  if (!Number.isSafeInteger(configured) || configured <= 0) return 60_000
  return Math.min(300_000, Math.max(100, configured))
}

type ArtifactKind = OoxmlKind | 'typst_document'
const MIME_BY_KIND: Record<ArtifactKind, string> = {
  docx_document: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  pptx_presentation: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  typst_document: 'application/pdf',
}

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  })
}

async function tokenDigest(value: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value)))
}

async function constantTimeTokenMatch(provided: string, expected: string): Promise<boolean> {
  const [left, right] = await Promise.all([tokenDigest(provided), tokenDigest(expected)])
  let difference = 0
  for (let index = 0; index < left.length; index += 1) difference |= left[index] ^ right[index]
  return difference === 0 && provided.length === expected.length
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const SHA_RE = /^[a-f0-9]{64}$/
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/

function sha256Hex(bytes: Uint8Array): Promise<string> {
  return crypto.subtle.digest('SHA-256', bytes as BufferSource).then((digest) =>
    Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join(''))
}

// The shared Deadline (see _shared/requestDeadline.ts) bounds EVERY await in the handler —
// trickle body reads, the CPU-bound hash/inspection steps AND the network calls.

// Bounded body read that never trusts Content-Length: bytes are COUNTED as they stream, so
// chunked/missing declarations hit the same cap; the shared deadline aborts slow readers.
async function readBodyBounded(request: Request, deadline: Deadline): Promise<Uint8Array | { error: string; status: number }> {
  const declared = request.headers.get('content-length')
  if (declared !== null) {
    const parsed = Number(declared)
    if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > MAX_ARTIFACT_BYTES) {
      return { error: 'REQUEST_TOO_LARGE', status: 413 }
    }
  }
  if (!request.body) return { error: 'EMPTY_BODY', status: 400 }
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      if (deadline.expired) {
        reader.cancel().catch(() => {})
        return { error: 'UPLOAD_TIMEOUT', status: 408 }
      }
      const step = await deadline.bound(() => reader.read())
      if (step.done) break
      total += step.value.byteLength
      if (total > MAX_ARTIFACT_BYTES) {
        reader.cancel().catch(() => {})
        return { error: 'REQUEST_TOO_LARGE', status: 413 }
      }
      chunks.push(step.value)
    }
  } catch {
    reader.cancel().catch(() => {})
    return { error: 'UPLOAD_TIMEOUT', status: 408 }
  }
  if (total === 0) return { error: 'EMPTY_BODY', status: 400 }
  const joined = new Uint8Array(total)
  let position = 0
  for (const chunk of chunks) { joined.set(chunk, position); position += chunk.byteLength }
  return joined
}

Deno.serve(async (request) => {
  if (request.method !== 'POST') return response({ error: { code: 'NOT_FOUND' } }, 404)
  const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? ''
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
  const documentToken = Deno.env.get('NEMO_DOCUMENT_WORKER_TOKEN') ?? ''
  if (!supabaseUrl || !serviceRoleKey || documentToken.length < 32) {
    return response({ error: { code: 'UPLOAD_API_NOT_CONFIGURED' } }, 503)
  }
  const authorization = request.headers.get('authorization') ?? ''
  const provided = authorization.startsWith('Bearer ') ? authorization.slice(7) : ''
  if (!await constantTimeTokenMatch(provided, documentToken)) {
    return response({ error: { code: 'UNAUTHORIZED' } }, 401)
  }

  const deadline = new Deadline(requestBudgetMs())
  // UUIDs are canonicalized to lowercase up front: SQL's uuid::text is lowercase, so an
  // uppercase header would otherwise build a storage path naming a DIFFERENT (nonexistent)
  // object than the one registration references
  const accountId = (request.headers.get('x-account-id') ?? '').toLowerCase()
  const jobId = (request.headers.get('x-job-id') ?? '').toLowerCase()
  const claimToken = (request.headers.get('x-claim-token') ?? '').toLowerCase()
  const epochRaw = request.headers.get('x-lease-epoch')
  const name = request.headers.get('x-artifact-name') ?? ''
  const declaredSha = (request.headers.get('x-artifact-sha256') ?? '').toLowerCase()
  const declaredSizeRaw = request.headers.get('x-artifact-size')
  const epoch = epochRaw === null ? Number.NaN : Number(epochRaw)
  const declaredSize = declaredSizeRaw === null ? Number.NaN : Number(declaredSizeRaw)
  if (!UUID_RE.test(accountId) || !UUID_RE.test(jobId) || !UUID_RE.test(claimToken)
    || !Number.isSafeInteger(epoch) || epoch < 0
    || !NAME_RE.test(name) || name.includes('..')
    || !SHA_RE.test(declaredSha)
    || !Number.isSafeInteger(declaredSize) || declaredSize < 1 || declaredSize > MAX_ARTIFACT_BYTES) {
    return response({ error: { code: 'INVALID_REQUEST' } }, 400)
  }

  // every network call goes through a fetch that carries the shared abort signal — on
  // deadline expiry the in-flight request is cancelled, not merely out-raced
  const admin = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: {
      fetch: (input: RequestInfo | URL, init?: RequestInit) =>
        fetch(input, { ...init, signal: deadline.controller.signal }),
    },
  })

  try {
    // ADVISORY pre-check: refuses an obviously stale worker before streaming 64 MiB and hands
    // back the request kind. The registration transaction is the real fence.
    const precheck = await deadline.bound(() => admin.rpc('document_verify_upload', {
      p_account_id: accountId, p_job_id: jobId, p_claim_token: claimToken, p_expected_epoch: epoch,
    }))
    if (precheck.error) return response({ error: { code: 'UPLOAD_PRECHECK_FAILED' } }, 409)
    const verdict = precheck.data as { ok?: boolean; reason?: string; kind?: string } | null
    if (!verdict || verdict.ok !== true || !verdict.kind || !Object.hasOwn(MIME_BY_KIND, verdict.kind)) {
      return response({ error: { code: 'UPLOAD_REFUSED', reason: verdict?.reason ?? 'unknown' } }, 409)
    }
    const kind = verdict.kind as ArtifactKind
    const expectedExtension = kind === 'docx_document' ? '.docx' : kind === 'typst_document' ? '.pdf' : '.pptx'
    if (!name.endsWith(expectedExtension)) return response({ error: { code: 'INVALID_REQUEST' } }, 400)
    const mimeType = MIME_BY_KIND[kind]

    const body = await readBodyBounded(request, deadline)
    if (!(body instanceof Uint8Array)) return response({ error: { code: body.error } }, body.status)

    // ACTUAL bytes are the authority: declared hash/size must match what actually arrived.
    // Hash and inspection are CPU-bound but still deadline-checked — a slow collision hash
    // must not let an expired handler reach registration.
    const actualSha = await deadline.bound(() => sha256Hex(body))
    if (actualSha !== declaredSha) return response({ error: { code: 'HASH_MISMATCH' } }, 400)
    if (body.byteLength !== declaredSize) return response({ error: { code: 'SIZE_MISMATCH' } }, 400)

    const inspection = await deadline.bound(() => kind === 'typst_document' ? inspectPdf(body) : inspectOoxml(body, kind))
    if (!inspection.ok) {
      return response({ error: { code: kind === 'typst_document' ? 'PDF_INVALID' : 'OOXML_INVALID', reason: inspection.reason } }, 422)
    }

    const storagePath = `tenants/${accountId}/artifacts/${jobId}/${epoch}/${actualSha}-${name}`
    const uploaded = await deadline.bound(() => admin.storage.from(BUCKET).upload(storagePath, body, {
      contentType: mimeType,
      upsert: false,
    }))
    if (uploaded.error) {
      const exists = /exists|duplicate/i.test(uploaded.error.message ?? '')
        || (uploaded.error as { statusCode?: string }).statusCode === '409'
      if (!exists) return response({ error: { code: 'STORAGE_UPLOAD_FAILED' } }, 502)
      // same attempt + same declared content collided: reuse ONLY after verifying the STORED
      // object's actual bytes — never blindly register an existing collision
      const existing = await deadline.bound(() => admin.storage.from(BUCKET).download(storagePath))
      if (existing.error || !existing.data) return response({ error: { code: 'STORAGE_VERIFY_FAILED' } }, 502)
      const storedBytes = new Uint8Array(await deadline.bound(() => existing.data!.arrayBuffer()))
      const storedSha = await deadline.bound(() => sha256Hex(storedBytes))
      if (storedBytes.byteLength !== body.byteLength || storedSha !== actualSha) {
        return response({ error: { code: 'STORAGE_CONFLICT' } }, 409)
      }
    }

    // PUBLICATION FENCE: claim/epoch/lease re-verified inside the transaction under the
    // parent lock; the path is recomputed server-side in SQL from the same inputs. On expiry
    // the shared signal aborts the in-flight rpc; should the server commit anyway, the SQL
    // lease fence made it a CONSISTENT publication and the worker's retry converges on
    // already:true — an expired handler itself never issues further calls (lazy bound()
    // refuses before invoking).
    const registered = await deadline.bound(() => admin.rpc('document_register_artifact', {
      p_account_id: accountId,
      p_job_id: jobId,
      p_claim_token: claimToken,
      p_expected_epoch: epoch,
      p_name: name,
      p_mime_type: mimeType,
      p_size_bytes: body.byteLength,
      p_sha256: actualSha,
    }))
    if (registered.error) return response({ error: { code: 'REGISTRATION_FAILED' } }, 502)
    const outcome = registered.data as { ok?: boolean; reason?: string; storage_path?: string; already?: boolean } | null
    if (!outcome || outcome.ok !== true || typeof outcome.storage_path !== 'string') {
      const reason = outcome?.reason ?? 'unknown'
      return response({ error: { code: 'REGISTRATION_REFUSED', reason } }, reason === 'bad_request' ? 400 : 409)
    }
    // already:true returns the REGISTERED path (the publication truth) — it may name an
    // earlier epoch's object; this attempt's bytes then stay an unreferenced orphan
    return response({
      ok: true,
      storage_path: outcome.storage_path,
      sha256: actualSha,
      size_bytes: body.byteLength,
      already: outcome.already === true,
    })
  } catch (error) {
    if (error instanceof Error && error.message === 'UPLOAD_TIMEOUT') {
      return response({ error: { code: 'UPLOAD_TIMEOUT' } }, 408)
    }
    return response({ error: { code: 'UPLOAD_FAILED' } }, 502)
  }
})
