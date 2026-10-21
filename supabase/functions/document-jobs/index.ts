// Документные задания — аутентифицированный endpoint пользователя (владелец/админ):
//   POST /functions/v1/document-jobs  (Bearer jwt)
//     { action: 'enqueue', request_id, kind, input }  → постановка через реviewed RPC
//     { action: 'status',  job_id }                    → исход РОДИТЕЛЯ (processing до финализации)
//     { action: 'download', job_id }                   → подписанная ссылка ТОЛЬКО по
//                                                        зарегистрированному артефакту, TTL 300с
//
// Контракт границы (условное GO Codex):
//   • request_id порождает КЛИЕНТ и хранит его через перезагрузки: повтор после таймаута
//     опроса возвращает ТО ЖЕ задание (deduplicated), никакой второй генерации;
//   • вход валидируется строгими схемами моделей и лимитом сериализованных БАЙТОВ до RPC;
//     SQL остаётся финальным авторитетом размера;
//   • status отражает workflow: манифест виден только у completed (финализатор уже требует
//     валидный манифест И совпадающую регистрацию), наружу уходят только имя/MIME/размер/хэш;
//   • download обслуживает ИСКЛЮЧИТЕЛЬНО собственную зарегистрированную строку аккаунта:
//     подписанная ссылка живёт ≤300с и НИГДЕ не сохраняется; клиентского пути не существует;
//   • blocked-аккаунт отказывается на каждом действии; один общий дедлайн на весь запрос.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.108.2'
import { corsPreflight, json } from '../_shared/cors.ts'
import { readBytesBounded } from '../_shared/boundedBody.ts'
import { Deadline } from '../_shared/requestDeadline.ts'
import {
  DocumentInputSchemas,
  ENQUEUE_SAFE_PAYLOAD_BYTES,
  type DocumentJobKind,
  serializedPayloadBytes,
} from '../../../agent-hub/documents/document-models.ts'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? ''
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY') ?? ''
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''

// env-tunable (clamped) so the smoke can prove the bounded 408 with a real await; read
// PER REQUEST so the default path is testable. The blank check MUST run before Number():
// Number('') is 0 and would clamp the DEFAULT budget down to 100ms, failing normal auth.
function requestBudgetMs(): number {
  const raw = Deno.env.get('DOCUMENT_JOBS_BUDGET_MS')
  if (raw === undefined || raw === null || raw.trim() === '') return 20_000
  const configured = Number(raw)
  if (!Number.isSafeInteger(configured) || configured <= 0) return 20_000
  return Math.min(60_000, Math.max(100, configured))
}
const MAX_JSON_BODY_BYTES = 96 * 1024
const SIGNED_URL_TTL_SECONDS = 300
const BUCKET = 'document-artifacts'
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

// no-store на КАЖДОМ ответе: подписанные ссылки и статусы не должны оседать ни в каком кэше —
// иначе нельзя утверждать, что ссылка нигде не сохраняется
const respond = (body: unknown, status = 200): Response => {
  const response = json(body, status)
  response.headers.set('cache-control', 'no-store')
  return response
}

const ENQUEUE_REASON_STATUS: Record<string, number> = {
  bad_request: 400,
  bad_kind: 400,
  bad_input: 400,
  payload_too_large: 413,
  no_account: 403,
  blocked: 403,
  quota_exceeded: 429,
  idempotency_conflict: 409,
  runtime_paused: 503,
  enqueue_failed: 502,
}

Deno.serve(async (req) => {
  const preflight = corsPreflight(req)
  if (preflight) return preflight
  if (!SUPABASE_URL || !ANON_KEY || !SERVICE_ROLE) return respond({ ok: false, error: 'not_configured' }, 500)
  if (req.method !== 'POST') return respond({ ok: false, error: 'method_not_allowed' }, 405)
  const authorization = req.headers.get('Authorization') ?? ''
  if (!authorization) return respond({ ok: false, error: 'unauthorized' }, 401)

  const deadline = new Deadline(requestBudgetMs(), 'REQUEST_TIMEOUT')
  const read = await readBytesBounded(req, { maxBytes: MAX_JSON_BODY_BYTES, deadlineAt: deadline.at })
  if (!read.ok) {
    return read.reason === 'too_large'
      ? respond({ ok: false, error: 'body_too_large' }, 413)
      : respond({ ok: false, error: read.reason === 'timeout' ? 'timeout' : 'body_read_failed' }, read.reason === 'timeout' ? 408 : 400)
  }
  let payload: Record<string, unknown>
  try {
    const parsed = JSON.parse(new TextDecoder().decode(read.bytes))
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('shape')
    payload = parsed as Record<string, unknown>
  } catch {
    return respond({ ok: false, error: 'bad_json' }, 400)
  }
  const action = payload.action
  if (action !== 'enqueue' && action !== 'status' && action !== 'download') {
    return respond({ ok: false, error: 'unknown_action' }, 400)
  }

  // every network call carries the shared abort signal — expiry cancels in-flight requests
  const boundFetch = (input: RequestInfo | URL, init?: RequestInit) =>
    fetch(input, { ...init, signal: deadline.controller.signal })
  const admin = createClient(SUPABASE_URL, SERVICE_ROLE, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: boundFetch },
  })

  try {
    const userDb = createClient(SUPABASE_URL, ANON_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { headers: { Authorization: authorization }, fetch: boundFetch },
    })
    const { data: { user } } = await deadline.bound(() => userDb.auth.getUser())
    if (!user) return respond({ ok: false, error: 'unauthorized' }, 401)
    const membership = await deadline.bound(() =>
      admin.from('users').select('account_id, role, is_admin').eq('id', user.id).maybeSingle())
    const accountId = membership.data?.account_id as string | undefined
    if (membership.error || !accountId) return respond({ ok: false, error: 'forbidden' }, 403)
    if (membership.data?.role !== 'owner' && membership.data?.is_admin !== true) {
      return respond({ ok: false, error: 'forbidden' }, 403)
    }
    const account = await deadline.bound(() =>
      admin.from('accounts').select('blocked').eq('id', accountId).maybeSingle())
    if (account.error || !account.data) return respond({ ok: false, error: 'forbidden' }, 403)
    if (account.data.blocked) return respond({ ok: false, error: 'blocked' }, 403)

    if (action === 'enqueue') {
      const requestId = typeof payload.request_id === 'string' ? payload.request_id.toLowerCase() : ''
      const kind = payload.kind
      if (!UUID_RE.test(requestId)) return respond({ ok: false, error: 'bad_request_id' }, 400)
      if (typeof kind !== 'string' || !Object.hasOwn(DocumentInputSchemas, kind)) {
        return respond({ ok: false, error: 'bad_kind' }, 400)
      }
      const schema = DocumentInputSchemas[kind as DocumentJobKind]
      const input = schema.safeParse(payload.input)
      if (!input.success) return respond({ ok: false, error: 'input_invalid' }, 422)
      // байтовый бюджет сериализации ДО очереди (экранирование почти удваивает байты);
      // octet_length в SQL остаётся финальным авторитетом
      if (serializedPayloadBytes(input.data) > ENQUEUE_SAFE_PAYLOAD_BYTES) {
        return respond({ ok: false, error: 'payload_too_large' }, 413)
      }
      const enqueued = await deadline.bound(() => admin.rpc('document_enqueue_job', {
        p_account_id: accountId,
        p_request_id: requestId,
        p_kind: kind,
        p_input: input.data,
      }))
      if (enqueued.error) return respond({ ok: false, error: 'enqueue_failed' }, 502)
      const outcome = enqueued.data as { ok?: boolean; reason?: string; job_id?: string; workflow_id?: string; deduplicated?: boolean } | null
      if (!outcome || outcome.ok !== true) {
        const reason = outcome?.reason ?? 'enqueue_failed'
        return respond({ ok: false, error: reason }, ENQUEUE_REASON_STATUS[reason] ?? 502)
      }
      // сломанный backend обязан падать ТИПИЗИРОВАННО, а не превращаться в ok:true с undefined
      if (typeof outcome.job_id !== 'string' || !UUID_RE.test(outcome.job_id)
        || typeof outcome.workflow_id !== 'string' || !UUID_RE.test(outcome.workflow_id)) {
        return respond({ ok: false, error: 'enqueue_malformed' }, 502)
      }
      return respond({
        ok: true,
        job_id: outcome.job_id,
        workflow_id: outcome.workflow_id,
        deduplicated: outcome.deduplicated === true,
      })
    }

    const jobId = typeof payload.job_id === 'string' ? payload.job_id.toLowerCase() : ''
    if (!UUID_RE.test(jobId)) return respond({ ok: false, error: 'bad_job_id' }, 400)
    const statusResult = await deadline.bound(() => admin.rpc('document_job_status', {
      p_account_id: accountId,
      p_job_id: jobId,
    }))
    if (statusResult.error) return respond({ ok: false, error: 'status_failed' }, 502)
    const status = statusResult.data as {
      ok?: boolean
      status?: string
      workflow_state?: string
      compute_status?: string
      error_code?: string | null
      attempt_count?: number
      kind?: string
      manifest?: { artifacts?: Array<{ name?: string; mime_type?: string; size_bytes?: number; sha256?: string }> } | null
      created_at?: string
    } | null
    if (!status || status.ok !== true) return respond({ ok: false, error: 'not_found' }, 404)
    // enum-валидация статуса: неизвестное значение от backend — типизированный сбой, не «успех»
    if (status.status !== 'processing' && status.status !== 'completed'
      && status.status !== 'failed' && status.status !== 'cancelled') {
      return respond({ ok: false, error: 'status_malformed' }, 502)
    }
    const rawArtifact = status.status === 'completed' ? status.manifest?.artifacts?.[0] ?? null : null
    if (status.status === 'completed' && (
      !rawArtifact
      || typeof rawArtifact.name !== 'string'
      || typeof rawArtifact.mime_type !== 'string'
      || !Number.isSafeInteger(rawArtifact.size_bytes)
      || typeof rawArtifact.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(rawArtifact.sha256)
    )) {
      return respond({ ok: false, error: 'status_malformed' }, 502)
    }
    const artifactMeta = rawArtifact

    if (action === 'status') {
      // «processing» до финализации — клиент опрашивает ТО ЖЕ задание; внутренние пути
      // хранилища наружу не уходят, только метаданные артефакта
      return respond({
        ok: true,
        status: status.status,
        error_code: status.error_code ?? null,
        kind: status.kind,
        created_at: status.created_at,
        artifact: artifactMeta ? {
          name: artifactMeta.name,
          mime_type: artifactMeta.mime_type,
          size_bytes: artifactMeta.size_bytes,
          sha256: artifactMeta.sha256,
        } : null,
      })
    }

    // download: ТОЛЬКО завершённый родитель И собственная зарегистрированная строка
    if (status.status !== 'completed') {
      return respond({ ok: false, error: 'not_ready', status: status.status }, 409)
    }
    const registration = await deadline.bound(() => admin
      .from('document_artifacts')
      .select('name, mime_type, size_bytes, sha256, storage_path')
      .eq('account_id', accountId)
      .eq('job_id', jobId)
      .maybeSingle())
    const artifactRow = registration.data
    if (registration.error || !artifactRow) {
      // completed без регистрации невозможен по контракту финализатора — защита в глубину
      return respond({ ok: false, error: 'artifact_unregistered' }, 409)
    }
    const signed = await deadline.bound(() => admin.storage.from(BUCKET)
      .createSignedUrl(artifactRow.storage_path, SIGNED_URL_TTL_SECONDS))
    if (signed.error || !signed.data?.signedUrl) return respond({ ok: false, error: 'sign_failed' }, 502)
    // ссылка НЕ сохраняется нигде: клиент получает её на ≤300с и скачивает сам
    return respond({
      ok: true,
      url: signed.data.signedUrl,
      expires_in: SIGNED_URL_TTL_SECONDS,
      name: artifactRow.name,
      mime_type: artifactRow.mime_type,
      size_bytes: artifactRow.size_bytes,
      sha256: artifactRow.sha256,
    })
  } catch (error) {
    if (error instanceof Error && error.message === 'REQUEST_TIMEOUT') {
      return respond({ ok: false, error: 'timeout' }, 408)
    }
    return respond({ ok: false, error: 'internal' }, 502)
  }
})
