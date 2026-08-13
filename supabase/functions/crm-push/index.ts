// CRM bridge — forward a lead to a CRM "incoming webhook" URL (authenticated owner).
// Works with Bitrix24 inbound webhooks, AmoCRM hooks, or a Google Apps Script URL —
// no full OAuth app required to start. (Full OAuth flows are a later milestone.)
//
//   POST /functions/v1/crm-push   (Authorization: Bearer <user jwt>)
//   body { "webhook_url": "https://...", "lead": { ... }, "provider"?: "bitrix24"|"amocrm"|"google" }
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.108.2'
import { corsPreflight, json } from '../_shared/cors.ts'
import { safeFetch } from '../_shared/net.ts'
import { blocksExternalActions, PRODUCTION_E2E_EXTERNAL_BLOCK } from '../_shared/productionE2E.ts'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

Deno.serve(async (req) => {
  const preflight = corsPreflight(req)
  if (preflight) return preflight

  const authHeader = req.headers.get('Authorization')
  if (!authHeader) return json({ error: 'unauthorized' }, 401)
  const db = createClient(SUPABASE_URL, ANON_KEY, { global: { headers: { Authorization: authHeader } } })
  const {
    data: { user },
  } = await db.auth.getUser()
  if (!user) return json({ error: 'unauthorized' }, 401)
  const { data: profile } = await db.from('users').select('account_id').maybeSingle()
  const accountId = profile?.account_id
  if (!accountId) return json({ error: 'no account' }, 403)
  const admin = createClient(SUPABASE_URL, SERVICE_ROLE)
  if (await blocksExternalActions(admin, accountId)) return json(PRODUCTION_E2E_EXTERNAL_BLOCK, 403)

  const body = await req.json().catch(() => ({}))
  const webhookUrl = body.webhook_url as string
  if (!webhookUrl) return json({ error: 'webhook_url required' }, 400)

  try {
    // SSRF-safe: https only, blocks internal/metadata targets, re-validates
    // redirects, times out. Prevents the CRM webhook from becoming an internal proxy.
    const { res } = await safeFetch(
      webhookUrl,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider: body.provider ?? 'generic', lead: body.lead ?? {}, source: 'nemo-ai' }),
      },
      { httpsOnly: true, maxBytes: 10_000, timeoutMs: 10_000, maxRedirects: 2 },
    )
    return json({ ok: res.ok, status: res.status })
  } catch (e) {
    const msg = String((e as Error)?.message ?? e)
    if (msg === 'invalid_url' || msg === 'invalid_protocol') return json({ error: 'invalid webhook_url (https required)' }, 400)
    if (msg === 'blocked_host') return json({ error: 'blocked host' }, 403)
    return json({ ok: false, error: 'push_failed' }, 502)
  }
})
