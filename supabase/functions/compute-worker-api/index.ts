import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.108.2'

const encoder = new TextEncoder()
const MAX_BODY_BYTES = 384 * 1024

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

Deno.serve(async (request) => {
  if (request.method !== 'POST') return response({ error: { code: 'NOT_FOUND' } }, 404)
  const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? ''
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
  const mediaToken = Deno.env.get('NEMO_MEDIA_WORKER_TOKEN') ?? ''
  const documentToken = Deno.env.get('NEMO_DOCUMENT_WORKER_TOKEN') ?? ''
  if (!supabaseUrl || !serviceRoleKey || mediaToken.length < 32 || documentToken.length < 32 || mediaToken === documentToken) {
    return response({ error: { code: 'COMPUTE_API_NOT_CONFIGURED' } }, 503)
  }

  const authorization = request.headers.get('authorization') ?? ''
  const provided = authorization.startsWith('Bearer ') ? authorization.slice(7) : ''
  const [isMedia, isDocument] = await Promise.all([
    constantTimeTokenMatch(provided, mediaToken),
    constantTimeTokenMatch(provided, documentToken),
  ])
  if (!isMedia && !isDocument) return response({ error: { code: 'UNAUTHORIZED' } }, 401)

  const declaredLength = Number(request.headers.get('content-length') ?? 0)
  if (declaredLength > MAX_BODY_BYTES) return response({ error: { code: 'REQUEST_TOO_LARGE' } }, 413)
  const bytes = new Uint8Array(await request.arrayBuffer())
  if (bytes.byteLength > MAX_BODY_BYTES) return response({ error: { code: 'REQUEST_TOO_LARGE' } }, 413)

  let payload: { rpc?: unknown; args?: unknown }
  try {
    payload = JSON.parse(new TextDecoder().decode(bytes))
  } catch {
    return response({ error: { code: 'INVALID_REQUEST' } }, 400)
  }
  // claim/finish stay available to both worker classes (backward compatible); the document
  // lifecycle RPCs answer ONLY to the DOCUMENT token — the media token cannot finalize
  const DOCUMENT_ONLY_RPCS = ['document_finalize_workflow', 'document_list_unfinalized']
  const SHARED_RPCS = ['runtime_claim_compute_jobs', 'runtime_finish_compute_job']
  const rpcName = typeof payload.rpc === 'string' ? payload.rpc : ''
  if (!SHARED_RPCS.includes(rpcName) && !DOCUMENT_ONLY_RPCS.includes(rpcName)) {
    return response({ error: { code: 'COMPUTE_RPC_DENIED' } }, 403)
  }
  if (DOCUMENT_ONLY_RPCS.includes(rpcName) && !isDocument) {
    return response({ error: { code: 'COMPUTE_RPC_DENIED' } }, 403)
  }
  if (!payload.args || typeof payload.args !== 'object' || Array.isArray(payload.args)) {
    return response({ error: { code: 'INVALID_REQUEST' } }, 400)
  }
  const args = payload.args as Record<string, unknown>
  if (rpcName === 'runtime_claim_compute_jobs') {
    const allowedProfile = isMedia ? 'PROFILE_C_BROWSER' : 'PROFILE_B_DOCS'
    if (args.p_profile !== allowedProfile) return response({ error: { code: 'COMPUTE_PROFILE_DENIED' } }, 403)
  }
  // strict bounded params for the new lifecycle RPCs — nothing beyond their exact shapes
  if (rpcName === 'document_finalize_workflow') {
    const keys = Object.keys(args).sort()
    if (keys.join(',') !== 'p_account_id,p_workflow_id'
      || typeof args.p_account_id !== 'string' || typeof args.p_workflow_id !== 'string') {
      return response({ error: { code: 'INVALID_REQUEST' } }, 400)
    }
  }
  if (rpcName === 'document_list_unfinalized') {
    const keys = Object.keys(args)
    if (keys.length > 1 || (keys.length === 1 && keys[0] !== 'p_limit')
      || (args.p_limit !== undefined && (typeof args.p_limit !== 'number' || !Number.isInteger(args.p_limit) || args.p_limit < 1 || args.p_limit > 25))) {
      return response({ error: { code: 'INVALID_REQUEST' } }, 400)
    }
  }

  const admin = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  })
  const { data, error } = await admin.rpc(payload.rpc, args)
  if (error) return response({ data: null, error: { code: error.code ?? 'COMPUTE_RPC_FAILED' } }, 409)
  return response({ data, error: null })
})
