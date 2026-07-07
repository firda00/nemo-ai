// Google tools for agents/workflows: send Gmail, read/append Sheets, create Calendar
// events — using the account's connected Google (refresh_token, server-only).
//   POST /functions/v1/google-tools  (Bearer user jwt)
//   { action:'gmail_send', to, subject, body }
//   { action:'sheets_read', spreadsheet_id, range }
//   { action:'sheets_append', spreadsheet_id, range, values:[...] }
//   { action:'calendar_create', summary, start_iso, end_iso, description? }
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { googleAccessToken } from '../_shared/google.ts'
import { corsHeaders, json } from '../_shared/cors.ts'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

// token refresh MUST use the same OAuth app that issued the refresh_token — resolved
// per-account (google_oauth_apps) with env fallback by the shared helper.
async function accessTokenFor(admin: ReturnType<typeof createClient>, accountId: string): Promise<{ token?: string; email?: string; error?: string }> {
  const g = await googleAccessToken(admin, accountId)
  if (!g.token) return { error: 'google_not_connected_or_refresh_failed' }
  return { token: g.token, email: g.email ?? '' }
}

// RFC822 -> base64url (Gmail raw). Handles UTF-8 subjects/bodies.
function buildRawEmail(from: string, to: string, subject: string, body: string): string {
  const enc = (s: string) => `=?UTF-8?B?${btoa(String.fromCharCode(...new TextEncoder().encode(s)))}?=`
  const mime =
    `From: ${from}\r\nTo: ${to}\r\nSubject: ${enc(subject)}\r\n` +
    'MIME-Version: 1.0\r\nContent-Type: text/plain; charset="UTF-8"\r\nContent-Transfer-Encoding: base64\r\n\r\n' +
    btoa(String.fromCharCode(...new TextEncoder().encode(body)))
  return btoa(String.fromCharCode(...new TextEncoder().encode(mime))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  const authHeader = req.headers.get('Authorization')
  if (!authHeader) return json({ error: 'unauthorized' }, 401)
  const userDb = createClient(SUPABASE_URL, ANON_KEY, { global: { headers: { Authorization: authHeader } } })
  const { data: { user } } = await userDb.auth.getUser()
  if (!user) return json({ error: 'unauthorized' }, 401)
  const { data: prof } = await userDb.from('users').select('account_id').maybeSingle()
  const accountId = prof?.account_id
  if (!accountId) return json({ error: 'no account' }, 403)

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE)
  const at = await accessTokenFor(admin, accountId)
  if (at.error) return json({ ok: false, code: at.error, message: 'Connect Google first in Integrations.' }, 400)
  const token = at.token!

  const body = await req.json().catch(() => ({}))
  const action = String(body?.action ?? '')
  try {
    if (action === 'gmail_send') {
      const to = String(body.to ?? '').trim(); const subject = String(body.subject ?? '').slice(0, 300); const text = String(body.body ?? '')
      if (!to) return json({ error: 'to required' }, 400)
      const raw = buildRawEmail(at.email || 'me', to, subject, text)
      const r = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
        method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ raw }),
      }).then((x) => x.json())
      if (r.error) return json({ ok: false, error: r.error?.message ?? 'gmail_failed' }, 502)
      return json({ ok: true, id: r.id })
    }

    if (action === 'sheets_read') {
      const id = String(body.spreadsheet_id ?? ''); const range = String(body.range ?? 'A1:Z1000')
      if (!id) return json({ error: 'spreadsheet_id required' }, 400)
      const r = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${id}/values/${encodeURIComponent(range)}`, { headers: { Authorization: `Bearer ${token}` } }).then((x) => x.json())
      if (r.error) return json({ ok: false, error: r.error?.message ?? 'sheets_failed' }, 502)
      return json({ ok: true, values: r.values ?? [] })
    }

    if (action === 'sheets_append') {
      const id = String(body.spreadsheet_id ?? ''); const range = String(body.range ?? 'A1'); const values = Array.isArray(body.values) ? body.values : []
      if (!id || !values.length) return json({ error: 'spreadsheet_id and values required' }, 400)
      const rows = Array.isArray(values[0]) ? values : [values]
      const r = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${id}/values/${encodeURIComponent(range)}:append?valueInputOption=USER_ENTERED`, {
        method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ values: rows }),
      }).then((x) => x.json())
      if (r.error) return json({ ok: false, error: r.error?.message ?? 'sheets_failed' }, 502)
      return json({ ok: true, updates: r.updates ?? null })
    }

    if (action === 'calendar_create') {
      const summary = String(body.summary ?? '').slice(0, 300)
      const start = String(body.start_iso ?? ''); const end = String(body.end_iso ?? start)
      if (!summary || !start) return json({ error: 'summary and start_iso required' }, 400)
      const ev = { summary, description: String(body.description ?? ''), start: { dateTime: start }, end: { dateTime: end } }
      const r = await fetch('https://www.googleapis.com/calendar/v3/calendars/primary/events', {
        method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(ev),
      }).then((x) => x.json())
      if (r.error) return json({ ok: false, error: r.error?.message ?? 'calendar_failed' }, 502)
      return json({ ok: true, id: r.id, link: r.htmlLink })
    }

    return json({ error: 'unknown action' }, 400)
  } catch (e) {
    return json({ ok: false, error: String(e) }, 502)
  }
})
