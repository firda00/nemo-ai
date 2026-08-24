import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.108.2'
import { corsHeaders, corsPreflight } from '../_shared/cors.ts'
import { openSecret, providerSecretContext } from '../_shared/secretBox.ts'
import {
  generateWebhookSecret,
  normalizeAmoSubdomain,
  normalizeGatewayOrigin,
  sha256Hex,
  webhookUrl,
} from '../_shared/amocrmWebhookSecret.ts'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

function response(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      ...corsHeaders,
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store, max-age=0',
      Pragma: 'no-cache',
    },
  })
}

function uuid(value: unknown): string | null {
  const text = String(value ?? '')
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(text)
    ? text
    : null
}

Deno.serve(async (req) => {
  const preflight = corsPreflight(req)
  if (preflight) return preflight
  if (req.method !== 'POST') return response({ error: 'method_not_allowed' }, 405)

  const authorization = req.headers.get('Authorization')
  if (!authorization) return response({ error: 'unauthorized' }, 401)
  const userDb = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: authorization } },
  })
  const { data: { user } } = await userDb.auth.getUser()
  if (!user) return response({ error: 'unauthorized' }, 401)

  const { data: profile } = await userDb.from('users')
    .select('account_id, role, is_admin')
    .eq('id', user.id)
    .maybeSingle()
  if (!profile?.account_id) return response({ error: 'account_required' }, 403)
  if (profile.role !== 'owner' && profile.is_admin !== true) {
    return response({ error: 'owner_or_admin_required' }, 403)
  }

  const body = await req.json().catch(() => null)
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return response({ error: 'invalid_body' }, 400)
  }
  const input = body as Record<string, unknown>
  const action = String(input.action ?? '')
  let subdomain: string
  try {
    subdomain = normalizeAmoSubdomain(input.subdomain)
  } catch {
    return response({ error: 'invalid_subdomain' }, 400)
  }

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { persistSession: false } })

  // The saved provider credential is the authority for which amoCRM account this tenant controls.
  // A caller cannot mint a valid webhook URL for an arbitrary victim subdomain.
  const { data: keyRow } = await admin.from('provider_keys')
    .select('api_key')
    .eq('account_id', profile.account_id)
    .eq('provider', 'amocrm')
    .maybeSingle()
  if (!keyRow?.api_key) return response({ error: 'amocrm_not_connected' }, 409)
  let connectedSubdomain: string
  try {
    const credential = await openSecret(
      keyRow.api_key,
      providerSecretContext(profile.account_id, 'amocrm'),
    )
    const separator = credential.indexOf('|')
    if (separator <= 0 || separator === credential.length - 1) throw new Error('malformed_amocrm_credential')
    connectedSubdomain = normalizeAmoSubdomain(credential.slice(0, separator))
  } catch {
    return response({ error: 'amocrm_credential_unavailable' }, 503)
  }
  if (connectedSubdomain !== subdomain) return response({ error: 'amocrm_subdomain_mismatch' }, 403)

  if (action === 'status') {
    const { data, error } = await admin.rpc('get_amocrm_webhook_identity_status', {
      p_account_id: profile.account_id,
      p_subdomain: subdomain,
    })
    if (error) return response({ error: 'webhook_status_failed' }, 503)
    return response({ ok: true, subdomain, identities: data ?? [] })
  }

  if (action === 'revoke') {
    const identityId = uuid(input.identity_id)
    if (!identityId) return response({ error: 'invalid_identity_id' }, 400)
    const { data, error } = await admin.rpc('revoke_amocrm_webhook_identity', {
      p_account_id: profile.account_id,
      p_subdomain: subdomain,
      p_identity_id: identityId,
      p_revoked_by: user.id,
    })
    if (error) return response({ error: 'webhook_revoke_failed' }, 503)
    return response({ ok: true, subdomain, ...(data as Record<string, unknown>) })
  }

  if (action === 'rotate') {
    let origin: string
    try {
      origin = normalizeGatewayOrigin(Deno.env.get('NEMO_API_GATEWAY_PUBLIC_URL'))
    } catch {
      return response({ error: 'gateway_origin_not_configured' }, 503)
    }
    const secret = generateWebhookSecret()
    const secretHash = await sha256Hex(secret)
    const { data, error } = await admin.rpc('configure_amocrm_webhook_identity', {
      p_account_id: profile.account_id,
      p_subdomain: subdomain,
      p_secret_hash: secretHash,
      p_created_by: user.id,
    })
    if (error) return response({ error: 'webhook_rotation_failed' }, 503)
    return response({
      ok: true,
      subdomain,
      identity_id: (data as Record<string, unknown>)?.identity_id,
      previous_valid_until: (data as Record<string, unknown>)?.previous_valid_until ?? null,
      webhook_url: webhookUrl(origin, secret),
      shown_once: true,
    })
  }

  return response({ error: 'unknown_action' }, 400)
})
