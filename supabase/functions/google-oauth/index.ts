// Google OAuth for Nemo (Gmail send + Sheets + Calendar).
// Each account can connect its OWN Google Cloud OAuth app (self-service); if it hasn't,
// we fall back to the shared Nemo app (env GOOGLE_CLIENT_ID/SECRET). The client_secret is
// stored server-only and never returned to the browser.
//   POST ?action=authorize    (Bearer jwt) -> { url }            consent URL to open
//   POST ?action=status       (Bearer jwt) -> { connected, email }
//   POST ?action=get_app      (Bearer jwt) -> { configured, account_configured, client_id, redirect_uri }
//   POST ?action=set_app      (Bearer jwt) { client_id, client_secret } -> stores this account's app
//   POST ?action=clear_app    (Bearer jwt) -> removes this account's app (falls back to shared)
//   POST ?action=disconnect   (Bearer jwt) -> removes the linked Google account
//   GET  /callback?code&state              -> exchanges code, stores refresh_token, redirects
// Deployed with --no-verify-jwt (the callback is a public Google redirect); authed actions
// verify the JWT manually and the callback is protected by a signed state.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { corsPreflight, json } from '../_shared/cors.ts'
import { openSecret, sealSecret } from '../_shared/secretBox.ts'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const ENV_CLIENT_ID = Deno.env.get('GOOGLE_CLIENT_ID') ?? ''
const ENV_CLIENT_SECRET = Deno.env.get('GOOGLE_CLIENT_SECRET') ?? ''
const APP_URL = Deno.env.get('APP_URL') ?? 'http://nemo.185.8.213.144.sslip.io'
const REDIRECT_URI = `${SUPABASE_URL}/functions/v1/google-oauth/callback`

const SCOPES = [
  'openid', 'email', 'profile',
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.compose',
  'https://www.googleapis.com/auth/spreadsheets',
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/documents',
  'https://www.googleapis.com/auth/drive.file',
].join(' ')

/* eslint-disable @typescript-eslint/no-explicit-any */

// sign/verify the account id we round-trip through Google as `state`
async function hmac(input: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(SERVICE_ROLE), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(input))
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('')
}
async function makeState(accountId: string): Promise<string> { return `${accountId}.${await hmac(accountId)}` }
async function readState(state: string): Promise<string | null> {
  const i = state.lastIndexOf('.'); if (i < 0) return null
  const id = state.slice(0, i); const sig = state.slice(i + 1)
  return (await hmac(id)) === sig ? id : null
}

async function accountForUser(authHeader: string): Promise<string | null> {
  const db = createClient(SUPABASE_URL, ANON_KEY, { global: { headers: { Authorization: authHeader } } })
  const { data: { user } } = await db.auth.getUser()
  if (!user) return null
  const { data } = await db.from('users').select('account_id').maybeSingle()
  return data?.account_id ?? null
}

// account's own Google app creds if set, else the shared Nemo app (env)
async function loadAppCreds(admin: any, accountId: string): Promise<{ id: string; secret: string; own: boolean }> {
  const { data } = await admin.from('google_oauth_apps').select('client_id, client_secret').eq('account_id', accountId).maybeSingle()
  if (data?.client_id && data?.client_secret) return { id: data.client_id, secret: await openSecret(data.client_secret), own: true }
  return { id: ENV_CLIENT_ID, secret: ENV_CLIENT_SECRET, own: false }
}

Deno.serve(async (req) => {
  const preflight = corsPreflight(req)
  if (preflight) return preflight
  const url = new URL(req.url)

  // ---- Google redirect callback (public; protected by signed state) ----
  if (url.pathname.endsWith('/callback')) {
    const code = url.searchParams.get('code')
    const state = url.searchParams.get('state') ?? ''
    const accountId = await readState(state)
    if (!code || !accountId) return Response.redirect(`${APP_URL}/app/integrations?google=error`, 302)
    try {
      const admin = createClient(SUPABASE_URL, SERVICE_ROLE)
      const creds = await loadAppCreds(admin, accountId)
      const tok = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ code, client_id: creds.id, client_secret: creds.secret, redirect_uri: REDIRECT_URI, grant_type: 'authorization_code' }),
      }).then((r) => r.json())
      if (!tok.refresh_token) return Response.redirect(`${APP_URL}/app/integrations?google=norefresh`, 302)
      let email = ''
      try {
        const ui = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', { headers: { Authorization: `Bearer ${tok.access_token}` } }).then((r) => r.json())
        email = ui.email ?? ''
      } catch { /* non-fatal */ }
      await admin.from('google_accounts').upsert({
        account_id: accountId, google_email: email, refresh_token: await sealSecret(tok.refresh_token), scopes: SCOPES, updated_at: new Date().toISOString(),
      }, { onConflict: 'account_id' })
      return Response.redirect(`${APP_URL}/app/integrations?google=connected`, 302)
    } catch {
      return Response.redirect(`${APP_URL}/app/integrations?google=error`, 302)
    }
  }

  const authHeader = req.headers.get('Authorization')
  if (!authHeader) return json({ error: 'unauthorized' }, 401)
  const accountId = await accountForUser(authHeader)
  if (!accountId) return json({ error: 'unauthorized' }, 401)
  const body = await req.json().catch(() => ({}))
  const action = url.searchParams.get('action') ?? body?.action ?? ''
  const admin = createClient(SUPABASE_URL, SERVICE_ROLE)

  if (action === 'get_app') {
    const { data } = await admin.from('google_oauth_apps').select('client_id').eq('account_id', accountId).maybeSingle()
    return json({
      ok: true,
      account_configured: Boolean(data?.client_id),
      configured: Boolean(data?.client_id || ENV_CLIENT_ID),
      client_id: data?.client_id ?? null,
      redirect_uri: REDIRECT_URI,
    })
  }

  if (action === 'set_app') {
    const cid = String(body?.client_id ?? '').trim()
    const csec = String(body?.client_secret ?? '').trim()
    if (cid.length < 12 || !cid.includes('.apps.googleusercontent.com')) return json({ ok: false, error: 'Client ID выглядит некорректно — он должен заканчиваться на .apps.googleusercontent.com' }, 200)
    if (csec.length < 6) return json({ ok: false, error: 'Введите корректный Client Secret.' }, 200)
    await admin.from('google_oauth_apps').upsert({ account_id: accountId, client_id: cid, client_secret: await sealSecret(csec), updated_at: new Date().toISOString() }, { onConflict: 'account_id' })
    return json({ ok: true, account_configured: true, configured: true, client_id: cid, redirect_uri: REDIRECT_URI })
  }

  if (action === 'clear_app') {
    await admin.from('google_oauth_apps').delete().eq('account_id', accountId)
    return json({ ok: true, account_configured: false, configured: Boolean(ENV_CLIENT_ID) })
  }

  if (action === 'authorize') {
    const creds = await loadAppCreds(admin, accountId)
    if (!creds.id) return json({ ok: false, code: 'GOOGLE_NOT_CONFIGURED', message: 'Сначала подключите Google-приложение: вставьте Client ID и Client Secret по инструкции.', redirect_uri: REDIRECT_URI }, 200)
    const state = await makeState(accountId)
    const params = new URLSearchParams({
      client_id: creds.id, redirect_uri: REDIRECT_URI, response_type: 'code', scope: SCOPES,
      access_type: 'offline', prompt: 'consent', include_granted_scopes: 'true', state,
    })
    return json({ ok: true, url: `https://accounts.google.com/o/oauth2/v2/auth?${params}` })
  }

  if (action === 'status') {
    const { data } = await admin.from('google_accounts').select('google_email, scopes, updated_at').eq('account_id', accountId).maybeSingle()
    return json({ ok: true, connected: Boolean(data), email: data?.google_email ?? null, scopes: data?.scopes ?? null })
  }

  if (action === 'disconnect') {
    await admin.from('google_accounts').delete().eq('account_id', accountId)
    return json({ ok: true })
  }

  return json({ error: 'unknown action' }, 400)
})
/* eslint-enable @typescript-eslint/no-explicit-any */
