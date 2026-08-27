import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.108.2'
import { handleForgeWebhook } from '../_shared/forgeEventBridge.ts'
import { normalizeUzumForgeEvent } from '../_shared/forgeEventNormalizers.ts'

const db = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  { auth: { persistSession: false, autoRefreshToken: false } },
)

Deno.serve((request) => handleForgeWebhook(request, {
  provider: 'uzum',
  db,
  normalize: normalizeUzumForgeEvent,
}))
