// Personal daily briefing — Step 2a: settings + authenticated READ-ONLY preview.
// All behavior lives in _shared/dailyBriefingHandler.ts (offline-tested); this wrapper only
// wires real dependencies. There is NO cron entry and NO send path in this function yet —
// delivery ships separately behind the verified-recipient claim design.
//   POST /functions/v1/daily-briefing  (Bearer jwt)  { action: 'settings-get' | 'settings-set' | 'preview', ... }
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.108.2'
import { corsPreflight, json } from '../_shared/cors.ts'
import { openSecret, accountSecretContext } from '../_shared/secretBox.ts'
import { handleDailyBriefing, readRequestBodyBounded } from '../_shared/dailyBriefingHandler.ts'
import { fetchOwnerCalendarSection } from '../_shared/dailyBriefingGoogle.ts'
import { type FetchLike } from '../_shared/dailyBriefingSources.ts'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? ''
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY') ?? ''
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
const OPENWEATHER_KEY = Deno.env.get('OPENWEATHER_API_KEY') ?? ''
const GOOGLE_CLIENT_ID = Deno.env.get('GOOGLE_CLIENT_ID') ?? ''
const GOOGLE_CLIENT_SECRET = Deno.env.get('GOOGLE_CLIENT_SECRET') ?? ''

const fetchImpl: FetchLike = (url, init) => fetch(url, init)

Deno.serve(async (req) => {
  const preflight = corsPreflight(req)
  if (preflight) return preflight
  // fail closed with a constant shape when the function is not provisioned
  if (!SUPABASE_URL || !ANON_KEY || !SERVICE_ROLE) return json({ ok: false, error: 'not_configured' }, 500)

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE)
  const authorization = req.headers.get('Authorization') ?? ''
  const bodyRead = await readRequestBodyBounded(req)
  if (!bodyRead.ok) {
    return bodyRead.reason === 'too_large'
      ? json({ ok: false, error: 'body_too_large' }, 413)
      : json({ ok: false, error: 'timeout' }, 408)
  }
  const result = await handleDailyBriefing({
    admin,
    getUser: async (auth) => {
      if (!auth) return null
      const userDb = createClient(SUPABASE_URL, ANON_KEY, { global: { headers: { Authorization: auth } } })
      const { data: { user } } = await userDb.auth.getUser()
      return user ? { id: user.id } : null
    },
    fetchImpl,
    openWeatherKey: OPENWEATHER_KEY,
    calendarSection: (accountId, date) => fetchOwnerCalendarSection({
      db: admin,
      fetchImpl,
      decrypt: (sealed, forAccount, purpose) => openSecret(sealed, accountSecretContext(forAccount, purpose)),
      envApp: { id: GOOGLE_CLIENT_ID, secret: GOOGLE_CLIENT_SECRET },
    }, { accountId, date }),
    // resolves the bot's public username for the verification deep link; null → the UI shows
    // manual /start instructions instead. ONE deadline bounds the DB read, the getMe call AND
    // the body read, so a stall can never delay the already-successful claim beyond the bound.
    // The channel lookup is account-scoped: another tenant's channel id resolves to nothing.
    getBotUsername: async (channelId, accountId) => {
      const controller = new AbortController()
      let expire: (error: Error) => void = () => {}
      const expired = new Promise<never>((_resolve, reject) => { expire = reject })
      expired.catch(() => {})
      const timer = setTimeout(() => { controller.abort(); expire(new Error('GETME_TIMEOUT')) }, 8_000)
      try {
        const { data } = await Promise.race([
          admin.from('channels').select('credentials').eq('id', channelId).eq('account_id', accountId).maybeSingle(),
          expired,
        ])
        const token = data?.credentials?.bot_token
        if (!token) return null
        const response = await Promise.race([
          fetch(`https://api.telegram.org/bot${token}/getMe`, { signal: controller.signal, redirect: 'error' }),
          expired,
        ])
        const text = await Promise.race([response.text(), expired])
        if (new TextEncoder().encode(text).byteLength > 64 * 1024) return null
        const payload = ((): { result?: { username?: unknown } } | null => {
          try { return JSON.parse(text) } catch { return null }
        })()
        return typeof payload?.result?.username === 'string' ? payload.result.username : null
      } catch {
        return null
      } finally {
        clearTimeout(timer)
      }
    },
    deliverySwitch: Deno.env.get('DAILY_BRIEFING_DELIVERY') ?? '',
  }, {
    method: req.method,
    authorization,
    bodyText: bodyRead.text,
  })
  return json(result.body, result.status)
})
