// Visual RAG (PixelRAG/OCR) pilot — submit/status only. The function never
// performs or fabricates OCR: text extraction belongs to the (not yet deployed)
// GPU worker via the service-role claim/finalize RPCs. Feature-flagged off by
// default (app.visual_rag_enabled must be 'on' in Postgres) → 503 until enabled.
//
//   POST /functions/v1/visual-rag   (Authorization: Bearer <user jwt>)
//   body { action: 'submit', source_path, source_bytes, page_count }
//   body { action: 'status', job_id }
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.108.2'
import { corsPreflight, json } from '../_shared/cors.ts'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!

// RPC error message -> HTTP status. Unknown errors stay 500 without leaking detail.
const ERROR_STATUS: Record<string, number> = {
  feature_disabled: 503,
  active_job_limit: 429,
  daily_page_limit: 429,
  rate_limited: 429,
  invalid_path: 400,
  invalid_size: 400,
  invalid_pages: 400,
  unauthorized: 401,
}

function rpcError(message: string | undefined) {
  const code = Object.keys(ERROR_STATUS).find((k) => (message ?? '').includes(k))
  if (!code) return json({ error: 'internal_error' }, 500)
  return json({ error: code }, ERROR_STATUS[code])
}

Deno.serve(async (req) => {
  const preflight = corsPreflight(req)
  if (preflight) return preflight
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405)

  const authHeader = req.headers.get('Authorization')
  if (!authHeader) return json({ error: 'unauthorized' }, 401)
  // caller-scoped client: the RPCs derive the account from auth.uid() themselves
  const userDb = createClient(SUPABASE_URL, ANON_KEY, { global: { headers: { Authorization: authHeader } } })
  const {
    data: { user },
  } = await userDb.auth.getUser()
  if (!user) return json({ error: 'unauthorized' }, 401)

  const body = await req.json().catch(() => ({}))
  const action = String(body?.action ?? '')

  if (action === 'submit') {
    const { data, error } = await userDb.rpc('submit_visual_rag_job', {
      p_source_path: String(body?.source_path ?? ''),
      p_source_bytes: Number(body?.source_bytes ?? 0),
      p_page_count: Number(body?.page_count ?? 0),
    })
    if (error) return rpcError(error.message)
    const job = Array.isArray(data) ? data[0] : data
    if (!job) return json({ error: 'internal_error' }, 500)
    return json({ ok: true, job })
  }

  if (action === 'status') {
    const jobId = String(body?.job_id ?? '')
    if (!jobId) return json({ error: 'job_id required' }, 400)
    const { data, error } = await userDb.rpc('get_visual_rag_job', { p_job_id: jobId })
    if (error) return rpcError(error.message)
    const job = Array.isArray(data) ? data[0] : data
    if (!job) return json({ error: 'not_found' }, 404)
    return json({ ok: true, job })
  }

  return json({ error: 'unknown_action' }, 400)
})
