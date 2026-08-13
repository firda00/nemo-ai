// Register a WhatsApp or Instagram channel (setup helper, gated by SETUP_SECRET).
// Returns the webhook URL + verify token to paste into the Meta App dashboard.
//
//   POST /functions/v1/setup-meta   header x-setup-secret: <SETUP_SECRET>
//   body { "type": "whatsapp"|"instagram", "agent_id"?, "credentials": {...}, "verify_token"? }
//   whatsapp credentials: { phone_number_id, token }
//   instagram credentials: { page_token, ig_id }
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.108.2'
import { timingSafeEqual } from '../_shared/safeEqual.ts'
import { isRegulatedAgent, REGULATED_CHANNEL_ERROR } from '../_shared/riskPolicy.ts'
import { blocksExternalActions, PRODUCTION_E2E_EXTERNAL_BLOCK } from '../_shared/productionE2E.ts'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const SETUP_SECRET = Deno.env.get('SETUP_SECRET')!

Deno.serve(async (req) => {
  if (!timingSafeEqual(req.headers.get('x-setup-secret'), SETUP_SECRET)) {
    return Response.json({ error: 'forbidden' }, { status: 403 })
  }

  const body = await req.json().catch(() => ({}))
  const type = body.type as string
  if (type !== 'whatsapp' && type !== 'instagram') {
    return Response.json({ error: 'type must be whatsapp or instagram' }, { status: 400 })
  }

  const db = createClient(SUPABASE_URL, SERVICE_ROLE)

  if (body.agent_id) {
    const { data: owner } = await db.from('agents').select('account_id').eq('id', body.agent_id).maybeSingle()
    if (!owner) return Response.json({ error: 'agent not found' }, { status: 404 })
    if (await blocksExternalActions(db, owner.account_id)) return Response.json(PRODUCTION_E2E_EXTERNAL_BLOCK, { status: 403 })
  }

  const agentId = body.agent_id as string | undefined
  if (!agentId) return Response.json({ error: 'AGENT_EVAL_REQUIRED' }, { status: 409 })

  const { data: targetAgent } = await db.from('agents').select('id, account_id, niche, risk_tier, status, config_revision, published_revision').eq('id', agentId).maybeSingle()
  if (!targetAgent) return Response.json({ error: 'agent not found' }, { status: 404 })
  if (targetAgent.status !== 'active') return Response.json({ error: 'AGENT_EVAL_REQUIRED' }, { status: 409 })
  if (isRegulatedAgent(targetAgent)) {
    return Response.json({ error: REGULATED_CHANNEL_ERROR, code: 'REGULATED_CHANNEL_BLOCKED' }, { status: 403 })
  }

  const verify = (body.verify_token as string) || crypto.randomUUID().replace(/-/g, '')
  const { data: channel, error: channelError } = await db
    .from('channels')
    .insert({ agent_id: agentId, type, credentials: body.credentials ?? {}, secret_token: verify, status: 'connected' })
    .select('id')
    .single()
  if (channelError || !channel) return Response.json({ error: channelError?.message ?? 'could not create channel' }, { status: 400 })

  const webhookUrl = `${SUPABASE_URL}/functions/v1/${type}-webhook/${channel.id}`
  return Response.json({
    ok: true,
    type,
    agent_id: agentId,
    channel_id: channel!.id,
    webhook: webhookUrl,
    verify_token: verify,
    note: 'Paste webhook URL + verify token into your Meta App → Webhooks, and subscribe to messages.',
  })
})
