// Library — everything the AI has created, saved and browsable: team runs (content,
// strategy, analysis, ops — with their full output) and generated media. Read-only.
//   POST /functions/v1/library  (Bearer jwt)  { limit? }  -> { runs, media }
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.108.2'
import { corsPreflight, json } from '../_shared/cors.ts'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

Deno.serve(async (req) => {
  const preflight = corsPreflight(req)
  if (preflight) return preflight
  const authHeader = req.headers.get('Authorization')
  if (!authHeader) return json({ error: 'unauthorized' }, 401)
  const userDb = createClient(SUPABASE_URL, ANON_KEY, { global: { headers: { Authorization: authHeader } } })
  const { data: { user } } = await userDb.auth.getUser()
  if (!user) return json({ error: 'unauthorized' }, 401)
  const { data: prof } = await userDb.from('users').select('account_id').maybeSingle()
  const accountId = prof?.account_id
  if (!accountId) return json({ error: 'no account' }, 403)

  const db = createClient(SUPABASE_URL, SERVICE_ROLE)
  const [runsR, mediaR] = await Promise.all([
    db.from('research_runs').select('id, task, kind, status, report, tokens, model, created_at').eq('account_id', accountId).order('created_at', { ascending: false }).limit(60),
    db.from('media_assets').select('id, kind, prompt, provider, url, data, created_at').eq('account_id', accountId).order('created_at', { ascending: false }).limit(60),
  ])
  return json({ ok: true, runs: runsR.data ?? [], media: mediaR.data ?? [] })
})
