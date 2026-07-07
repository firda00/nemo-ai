// CRM bridge — forward a lead to a CRM "incoming webhook" URL (authenticated owner).
// Works with Bitrix24 inbound webhooks, AmoCRM hooks, or a Google Apps Script URL —
// no full OAuth app required to start. (Full OAuth flows are a later milestone.)
//
//   POST /functions/v1/crm-push   (Authorization: Bearer <user jwt>)
//   body { "webhook_url": "https://...", "lead": { ... }, "provider"?: "bitrix24"|"amocrm"|"google" }
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { corsHeaders, json } from '../_shared/cors.ts'
import { safeFetch } from '../_shared/net.ts'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })

  const authHeader = req.headers.get('Authorization')
  if (!authHeader) return json({ error: 'unauthorized' }, 401)
  const db = createClient(SUPABASE_URL, ANON_KEY, { global: { headers: { Authorization: authHeader } } })
  const {
    data: { user },
  } = await db.auth.getUser()
  if (!user) return json({ error: 'unauthorized' }, 401)

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
