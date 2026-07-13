// Create the structured planerka spreadsheet from the PANEL (one click), using the account's
// connected Google. Authenticated: the caller's JWT identifies the account; we then use the
// service role to read the Google token + save tasks_sheet_id. No group bot required.
//   POST /functions/v1/create-planerka-sheet   (Authorization: Bearer <user jwt>)  body { title? }
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { corsPreflight, json } from '../_shared/cors.ts'
import { extractSheetId, googleAccessToken } from '../_shared/google.ts'
import { createPlanerkaSheet } from '../_shared/planerkaSheet.ts'
import { normLang } from '../_shared/planerkaLocale.ts'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

Deno.serve(async (req) => {
  const preflight = corsPreflight(req)
  if (preflight) return preflight
  const authHeader = req.headers.get('Authorization')
  if (!authHeader) return json({ error: 'unauthorized' }, 401)

  const userDb = createClient(SUPABASE_URL, ANON_KEY, { global: { headers: { Authorization: authHeader } } })
  const { data: { user } } = await userDb.auth.getUser()
  if (!user) return json({ error: 'unauthorized' }, 401)
  const { data: profile } = await userDb.from('users').select('account_id').eq('id', user.id).maybeSingle()
  const accountId = profile?.account_id
  if (!accountId) return json({ error: 'no account for user' }, 400)

  // service role: read the account's Google token + persist the sheet id
  const db = createClient(SUPABASE_URL, SERVICE_ROLE)
  const g = await googleAccessToken(db, accountId)
  if (!g.token) return json({ ok: false, code: 'GOOGLE_NOT_CONNECTED', error: 'Google is not connected for this account.' }, 400)

  const { data: bp } = await db.from('business_profiles').select('report_lang').eq('account_id', accountId).maybeSingle()
  const lang = normLang(bp?.report_lang)
  const body = await req.json().catch(() => ({}))
  if (body?.action === 'connect_existing') {
    const sheetId = extractSheetId(String(body?.sheet ?? ''))
    if (!sheetId) return json({ ok: false, code: 'INVALID_SHEET', error: 'Paste a valid Google Sheets URL or spreadsheet id.' }, 400)
    const meta = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${sheetId}?fields=spreadsheetId,properties(title)`, { headers: { Authorization: `Bearer ${g.token}` } }).then((r) => r.json()).catch(() => null)
    if (!meta?.spreadsheetId) return json({ ok: false, code: 'SHEET_NOT_ACCESSIBLE', error: 'The connected Google account cannot access this sheet.' }, 403)
    await db.from('business_profiles').upsert({ account_id: accountId, tasks_sheet_id: sheetId }, { onConflict: 'account_id' })
    return json({ ok: true, id: sheetId, title: meta?.properties?.title ?? '', url: `https://docs.google.com/spreadsheets/d/${sheetId}/edit`, existing: true })
  }
  const title = (typeof body?.title === 'string' && body.title.trim()) ? body.title.trim().slice(0, 120) : `Planerka — ${new Date().toISOString().slice(0, 10)}`

  const made = await createPlanerkaSheet(g.token, lang, title)
  if (!made) return json({ ok: false, error: 'Could not create the sheet (check Google permissions).' }, 500)

  await db.from('business_profiles').upsert({ account_id: accountId, tasks_sheet_id: made.id }, { onConflict: 'account_id' })
  return json({ ok: true, url: made.url, id: made.id })
})
