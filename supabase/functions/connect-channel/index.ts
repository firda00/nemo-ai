// Connect a non-Telegram channel (WhatsApp / Instagram / website widget) to a
// specific agent from the panel. Authenticated + agent-scoped via RLS; secrets
// are written server-side into channels.credentials (the browser can't read them).
// For Meta channels it returns the webhook URL + a verify_token to paste into the
// Meta App config. (Telegram has its own function: connect-telegram.)
//
//   POST /functions/v1/connect-channel   (Authorization: Bearer <user jwt>)
//   body { "agent_id": "uuid", "type": "whatsapp"|"instagram"|"widget", "credentials": {...} }
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { corsHeaders, json } from '../_shared/cors.ts'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!

const TYPES = new Set(['whatsapp', 'instagram', 'widget'])

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
  const agentId = String(body?.agent_id ?? '')
  const type = String(body?.type ?? '')
  if (!agentId || !TYPES.has(type)) return json({ error: 'agent_id and valid type required' }, 400)

  // ownership check via RLS (agent must belong to the caller's account)
  const { data: agent } = await db.from('agents').select('id').eq('id', agentId).single()
  if (!agent) return json({ error: 'agent not found' }, 404)

  // minimal per-type credential validation
  const inCreds = (body?.credentials ?? {}) as Record<string, unknown>
  let creds: Record<string, unknown> = {}
  let verify_token: string | undefined
  if (type === 'whatsapp') {
    if (!inCreds.phone_number_id || !inCreds.token) return json({ error: 'phone_number_id and token required' }, 400)
    verify_token = crypto.randomUUID().replace(/-/g, '')
    creds = { phone_number_id: inCreds.phone_number_id, token: inCreds.token, verify_token }
  } else if (type === 'instagram') {
    if (!inCreds.page_token || !inCreds.ig_id) return json({ error: 'page_token and ig_id required' }, 400)
    verify_token = crypto.randomUUID().replace(/-/g, '')
    creds = { page_token: inCreds.page_token, ig_id: inCreds.ig_id, verify_token }
  } // widget: no credentials

  // replace any existing channel of this type for the agent (one per type)
  await db.from('channels').delete().eq('agent_id', agentId).eq('type', type)
  const { data: channel, error } = await db
    .from('channels')
    // secret_token MUST mirror the Meta verify_token: the WA/IG webhook GET handshake compares the
    // hub.verify_token against channel.secret_token, so without this Meta verification returns 403.
    .insert({ agent_id: agentId, type, credentials: creds, secret_token: verify_token ?? null, status: 'connected' })
    .select('id')
    .single()
  if (error || !channel) return json({ error: error?.message ?? 'could not create channel' }, 400)

  const webhook =
    type === 'widget'
      ? `${SUPABASE_URL}/functions/v1/widget-webhook/${channel.id}`
      : type === 'whatsapp' || type === 'instagram'
        ? `${SUPABASE_URL}/functions/v1/${type}-webhook/${channel.id}`
        : undefined

  return json({ ok: true, channel_id: channel.id, webhook, verify_token })
})
