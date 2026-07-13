import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { corsPreflight, json } from '../_shared/cors.ts'

const missing = (name: string) => json({ ok: false, code: 'MISSING_BACKEND_SECRET', message: `${name} is not configured on the server.` }, 500)

Deno.serve(async (req) => {
  const preflight = corsPreflight(req)
  if (preflight) return preflight

  const SUPABASE_URL = Deno.env.get('SUPABASE_URL')
  const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')
  const OPENROUTER_API_KEY = Deno.env.get('OPENROUTER_API_KEY')
  if (!SUPABASE_URL) return missing('SUPABASE_URL')
  if (!ANON_KEY) return missing('SUPABASE_ANON_KEY')

  const authHeader = req.headers.get('Authorization')
  if (!authHeader) return json({ ok: false, code: 'UNAUTHORIZED', message: 'Authentication is required for backend status.' }, 401)

  const userDb = createClient(SUPABASE_URL, ANON_KEY, { global: { headers: { Authorization: authHeader } } })
  const { data: { user } } = await userDb.auth.getUser()
  if (!user) return json({ ok: false, code: 'UNAUTHORIZED', message: 'Authentication is required for backend status.' }, 401)

  const { data: prof } = await userDb.from('users').select('account_id').maybeSingle()
  if (!prof?.account_id) return json({ ok: false, code: 'MISSING_ACCOUNT', message: 'Account profile is missing.' }, 403)

  return json({
    ok: true,
    authReady: true,
    accountReady: true,
    llmReady: Boolean(OPENROUTER_API_KEY),
    // provider_keys.api_key is write-only for authenticated clients; only service-role
    // functions can read it back for execution.
    providerKeysSecure: true,
    message: OPENROUTER_API_KEY ? 'Server-side OpenRouter key is configured.' : 'OpenRouter key is not configured on the server.',
  })
})
