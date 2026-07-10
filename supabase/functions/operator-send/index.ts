// Operator takeover — send a manual reply to the customer (authenticated owner).
// Authorizes the caller via their JWT (user-scoped client, RLS-enforced), then reads
// the channel bot_token with a service_role client (browser roles can't read secrets).
//
//   POST /functions/v1/operator-send   (Authorization: Bearer <user jwt>)
//   body { "dialogue_id": "uuid", "text": "..." }
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { tgSend } from '../_shared/telegram.ts'
import { corsHeaders, json } from '../_shared/cors.ts'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })

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
    .select('id, external_id, channel, channel_id')
    .eq('id', dialogue_id)
    .single()
  if (!dialogue) return json({ error: 'dialogue not found' }, 404)

  // store the operator message (user client -> RLS check enforces ownership);
  // a failed insert must NOT be reported as success — the UI rolls back on it
  const { error: insertError } = await userDb.from('messages').insert({ dialogue_id, author: 'operator', content: text })
  if (insertError) return json({ error: 'message not saved' }, 500)

  // read the bot token server-side only (browser roles cannot select credentials).
  // `delivered` tells the UI whether the customer actually got the message: only
  // the in-app widget delivers by persistence alone; every external channel needs
  // its adapter to succeed, and this endpoint only has a Telegram adapter.
  let delivered = dialogue.channel === 'widget'
  if (dialogue.channel === 'telegram' && dialogue.channel_id && dialogue.external_id) {
    // dialogues.channel_id is tenant-writable, so the caller must be able to SEE
    // the channel under RLS (account-scoped; credentials column stays revoked)
    // before the service-role client touches its secrets — a foreign tenant's
    // channel UUID authorizes nothing
    const { data: ownedChannel } = await userDb.from('channels').select('id').eq('id', dialogue.channel_id).maybeSingle()
    if (ownedChannel) {
      const admin = createClient(SUPABASE_URL, SERVICE_ROLE)
      const { data: ch } = await admin.from('channels').select('credentials').eq('id', dialogue.channel_id).single()
      const botToken = (ch as { credentials?: { bot_token?: string } } | null)?.credentials?.bot_token
      if (botToken) delivered = await tgSend(botToken, dialogue.external_id, text).catch(() => false)
    }
  }

  return json({ ok: true, delivered })
})
