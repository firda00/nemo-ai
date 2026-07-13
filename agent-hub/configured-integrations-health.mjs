import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { createClient } from '@supabase/supabase-js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const secrets = Object.fromEntries(fs.readFileSync(path.join(root, '.secrets.local'), 'utf8').split(/\r?\n/).map((line) => {
  const at = line.indexOf('=')
  return at > 0 ? [line.slice(0, at).trim(), line.slice(at + 1).trim()] : ['', '']
}).filter(([key]) => key))

const ref = secrets.SUPABASE_PROJECT_REF
const secretKey = secrets.SUPABASE_SECRET_KEY
if (!ref || !secretKey) throw new Error('Supabase health credentials are not configured.')

const db = createClient(`https://${ref}.supabase.co`, secretKey, { auth: { persistSession: false, autoRefreshToken: false } })
let failed = 0
const check = (name, ok, detail = '') => {
  if (ok) console.log(`[OK] ${name}${detail ? ` — ${detail}` : ''}`)
  else { failed += 1; console.error(`[FAIL] ${name}${detail ? ` — ${detail}` : ''}`) }
}

// These are intentionally read-only provider calls. The script never prints a token,
// refresh secret, user email, chat id or API response body.
const { data: channels, error: channelsError } = await db.from('channels').select('id, type, status, credentials').eq('type', 'telegram')
const activeTelegram = (channels ?? []).filter((channel) => channel.status === 'connected')
const disabledTelegram = (channels?.length ?? 0) - activeTelegram.length
check('Telegram channel inventory is readable', !channelsError, `${activeTelegram.length} active${disabledTelegram ? `, ${disabledTelegram} disabled/error` : ''}`)
let telegramHealthy = 0
for (const channel of activeTelegram) {
  const token = String(channel.credentials?.bot_token ?? '')
  if (!token) continue
  try {
    const response = await fetch(`https://api.telegram.org/bot${token}/getMe`, { signal: AbortSignal.timeout(12_000) })
    const body = await response.json().catch(() => ({}))
    if (response.ok && body?.ok && body?.result?.id) telegramHealthy += 1
  } catch { /* counted below */ }
}
check('Every active Telegram bot authenticates with getMe', telegramHealthy === activeTelegram.length, `${telegramHealthy}/${activeTelegram.length}`)

const { data: elevenRows, error: elevenError } = await db.from('provider_keys').select('api_key').eq('provider', 'elevenlabs')
check('ElevenLabs key inventory is readable', !elevenError, `${elevenRows?.length ?? 0} configured`)
let elevenHealthy = 0
for (const row of elevenRows ?? []) {
  try {
    const response = await fetch('https://api.elevenlabs.io/v1/user/subscription', {
      headers: { 'xi-api-key': String(row.api_key ?? '') },
      signal: AbortSignal.timeout(12_000),
    })
    if (response.ok) elevenHealthy += 1
  } catch { /* counted below */ }
}
check('Every configured ElevenLabs key authenticates', elevenHealthy === (elevenRows?.length ?? 0), `${elevenHealthy}/${elevenRows?.length ?? 0}`)

const { data: googleRows, error: googleError } = await db.from('google_accounts').select('account_id, refresh_token')
check('Google OAuth inventory is readable', !googleError, `${googleRows?.length ?? 0} configured`)
let googleHealthy = 0
for (const row of googleRows ?? []) {
  const { data: app } = await db.from('google_oauth_apps').select('client_id, client_secret').eq('account_id', row.account_id).maybeSingle()
  if (!app?.client_id || !app?.client_secret || !row.refresh_token) continue
  try {
    const form = new URLSearchParams({
      client_id: app.client_id,
      client_secret: app.client_secret,
      refresh_token: row.refresh_token,
      grant_type: 'refresh_token',
    })
    const response = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form,
      signal: AbortSignal.timeout(12_000),
    })
    const body = await response.json().catch(() => ({}))
    if (response.ok && body?.access_token) googleHealthy += 1
  } catch { /* counted below */ }
}
check('Every configured Google refresh token exchanges successfully', googleHealthy === (googleRows?.length ?? 0), `${googleHealthy}/${googleRows?.length ?? 0}`)

if (secrets.OPENROUTER_API_KEY) {
  try {
    const response = await fetch('https://openrouter.ai/api/v1/key', {
      headers: { Authorization: `Bearer ${secrets.OPENROUTER_API_KEY}` },
      signal: AbortSignal.timeout(12_000),
    })
    check('Shared OpenRouter key authenticates', response.ok)
  } catch {
    check('Shared OpenRouter key authenticates', false, 'network error')
  }
}

const liveUrl = (process.env.NEMO_LIVE_URL || 'https://nemo.185.8.213.144.sslip.io').replace(/\/$/, '')
try {
  const response = await fetch(liveUrl, { signal: AbortSignal.timeout(12_000) })
  const html = await response.text()
  check('Production website responds with the Nemo app', response.ok && /Nemo AI/i.test(html), `HTTP ${response.status}`)
} catch {
  check('Production website responds with the Nemo app', false, 'network error')
}

if (failed) {
  console.error(`${failed} configured integration health check(s) failed.`)
  process.exit(1)
}
console.log('Configured integration health passed. Unconfigured providers are intentionally not reported as verified.')
