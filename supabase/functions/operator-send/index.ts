// Operator takeover — send a manual reply to the customer (authenticated owner).
// Authorizes the caller via their JWT (user-scoped client, RLS-enforced), then reads
// the channel bot_token with a service_role client (browser roles can't read secrets).
//
//   POST /functions/v1/operator-send   (Authorization: Bearer <user jwt>)
//   body { "dialogue_id": "uuid", "text": "..." }
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.108.2'
import { tgSend } from '../_shared/telegram.ts'
import { igSend, waSend } from '../_shared/meta.ts'
import { corsPreflight, json } from '../_shared/cors.ts'
import { isRegulatedAgent, REGULATED_CHANNEL_ERROR } from '../_shared/riskPolicy.ts'
import { blocksExternalActions, PRODUCTION_E2E_EXTERNAL_BLOCK } from '../_shared/productionE2E.ts'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

Deno.serve(async (req) => {
  const preflight = corsPreflight(req)
  if (preflight) return preflight

  const authHeader = req.headers.get('Authorization')
  if (!authHeader) return json({ error: 'unauthorized' }, 401)

  // user-scoped client: RLS guarantees the caller can only touch their own rows
  const userDb = createClient(SUPABASE_URL, ANON_KEY, { global: { headers: { Authorization: authHeader } } })
  const {
    data: { user },
  } = await userDb.auth.getUser()
  if (!user) return json({ error: 'unauthorized' }, 401)

  const { dialogue_id, text } = await req.json().catch(() => ({}))
  if (!dialogue_id || !text) return json({ error: 'dialogue_id and text required' }, 400)

  // ownership check via RLS (no secret columns selected)
  const { data: dialogue } = await userDb
    .from('dialogues')
    .select('id, agent_id, external_id, channel, channel_id')
    .eq('id', dialogue_id)
    .single()
  if (!dialogue) return json({ error: 'dialogue not found' }, 404)

  const { data: dialogueAgent } = await userDb
    .from('agents')
    .select('id, account_id, niche, risk_tier')
    .eq('id', dialogue.agent_id)
    .maybeSingle()
  if (!dialogueAgent) return json({ error: 'agent not found' }, 404)
  if (isRegulatedAgent(dialogueAgent)) return json({ error: REGULATED_CHANNEL_ERROR, code: 'REGULATED_CHANNEL_BLOCKED' }, 403)
  const admin = createClient(SUPABASE_URL, SERVICE_ROLE)
  if (dialogue.channel !== 'widget' && await blocksExternalActions(admin, dialogueAgent.account_id)) {
    return json(PRODUCTION_E2E_EXTERNAL_BLOCK, 403)
  }

  // store the operator message (user client -> RLS check enforces ownership);
  // a failed insert must NOT be reported as success — the UI rolls back on it
  const { error: insertError } = await userDb.from('messages').insert({ dialogue_id, author: 'operator', content: text })
  if (insertError) return json({ error: 'message not saved' }, 500)

  // Read delivery credentials server-side only (browser roles cannot select them).
  // The widget receives the persisted message; external channels use their adapter.
  let delivered = dialogue.channel === 'widget'
  if (dialogue.channel_id && dialogue.external_id && ['telegram', 'whatsapp', 'instagram'].includes(dialogue.channel)) {
    // dialogues.channel_id is tenant-writable, so the caller must be able to SEE
    // the channel under RLS (account-scoped; credentials column stays revoked)
    // before the service-role client touches its secrets — a foreign tenant's
    // channel UUID authorizes nothing
    const { data: ownedChannel } = await userDb.from('channels').select('id').eq('id', dialogue.channel_id).maybeSingle()
    if (ownedChannel) {
      const { data: ch } = await admin.from('channels').select('agent_id, type, status, credentials').eq('id', dialogue.channel_id).single()
      const channel = ch as { agent_id?: string; type?: string; status?: string; credentials?: Record<string, string> } | null
      const credentials = channel?.credentials ?? {}
      const channelMatches = channel?.agent_id === dialogue.agent_id && channel?.type === dialogue.channel
      if (channelMatches && channel?.status === 'connected' && dialogue.channel === 'telegram' && credentials.bot_token) {
        delivered = await tgSend(credentials.bot_token, dialogue.external_id, text).catch(() => false)
      } else if (channelMatches && channel?.status === 'connected' && dialogue.channel === 'whatsapp' && credentials.phone_number_id && credentials.token) {
        delivered = await waSend(credentials.phone_number_id, credentials.token, dialogue.external_id, text).catch(() => false)
      } else if (channelMatches && channel?.status === 'connected' && dialogue.channel === 'instagram' && credentials.page_token) {
        delivered = await igSend(credentials.page_token, dialogue.external_id, text).catch(() => false)
      }
    }
  }

  return json({ ok: true, delivered })
})
