// Monthly reminders — authenticated settings endpoint (list/save). All behavior lives in
// _shared/reminderHandler.ts (offline-tested); this wrapper streams the small JSON body under
// the request's ONE deadline and wires real dependencies. Every write goes through the reviewed
// reminder_save_schedule RPC; the server clock is the only time source.
//   POST /functions/v1/reminders  (Bearer jwt)  { action: 'list' | 'save', ... }
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.108.2'
import { corsPreflight, json } from '../_shared/cors.ts'
import { readBytesBounded } from '../_shared/boundedBody.ts'
import { handleReminders } from '../_shared/reminderHandler.ts'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? ''
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY') ?? ''
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''

const TOTAL_BUDGET_MS = 20_000
const MAX_JSON_BODY_BYTES = 8 * 1024

Deno.serve(async (req) => {
  const preflight = corsPreflight(req)
  if (preflight) return preflight
  // fail closed with a constant shape when the function is not provisioned
  if (!SUPABASE_URL || !ANON_KEY || !SERVICE_ROLE) return json({ ok: false, error: 'not_configured' }, 500)
  if (req.method !== 'POST') return json({ ok: false, error: 'method_not_allowed' }, 405)
  const authorization = req.headers.get('Authorization') ?? ''
  if (!authorization) return json({ ok: false, error: 'unauthorized' }, 401)

  const deadlineAt = Date.now() + TOTAL_BUDGET_MS
  const read = await readBytesBounded(req, { maxBytes: MAX_JSON_BODY_BYTES, deadlineAt })
  if (!read.ok) {
    return read.reason === 'too_large'
      ? json({ ok: false, error: 'body_too_large' }, 413)
      : json({ ok: false, error: read.reason === 'timeout' ? 'timeout' : 'body_read_failed' }, read.reason === 'timeout' ? 503 : 408)
  }

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE)
  const result = await handleReminders({
    admin,
    getUser: async (auth) => {
      if (!auth) return null
      const userDb = createClient(SUPABASE_URL, ANON_KEY, { global: { headers: { Authorization: auth } } })
      const { data: { user } } = await userDb.auth.getUser()
      return user ? { id: user.id } : null
    },
  }, {
    method: req.method,
    authorization,
    bodyText: new TextDecoder().decode(read.bytes),
    deadlineAt,
  })
  return json(result.body, result.status)
})
