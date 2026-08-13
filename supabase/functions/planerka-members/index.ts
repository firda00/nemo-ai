// Connect a company's OWN Google Sheet as the planerka team roster.
//   POST /functions/v1/planerka-members  (Bearer jwt)
//   { action:'status' }                                  -> { connected, sheet_id, tab, map, count, sample }
//   { action:'preview', url, tab }                       -> { ok, headers, rows, detected }  (read + auto-map)
//   { action:'save', url, tab, map }                     -> { ok, sheet_id, count }
//   { action:'disconnect' }                              -> { ok }
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.108.2'
import { corsPreflight, json } from '../_shared/cors.ts'
import { googleAccessToken, readSheetValues, extractSheetId } from '../_shared/google.ts'
import { parseRoster } from '../_shared/planerkaRoster.ts'

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
  const { data: prof } = await userDb.from('users').select('account_id').maybeSingle()
  const accountId = prof?.account_id
  if (!accountId) return json({ error: 'no account' }, 403)
  const admin = createClient(SUPABASE_URL, SERVICE_ROLE)

  const body = await req.json().catch(() => ({}))
  const action = String(body?.action ?? '')

  if (action === 'status') {
    const { data: bp } = await admin.from('business_profiles').select('planerka_members_sheet_id, planerka_members_tab, planerka_members_map').eq('account_id', accountId).maybeSingle()
    const sheetId = bp?.planerka_members_sheet_id
    if (!sheetId) return json({ ok: true, connected: false })
    const g = await googleAccessToken(admin, accountId)
    let count = 0, sample: unknown[] = []
    if (g?.token) {
      const tab = String(bp?.planerka_members_tab ?? '').trim()
      const rows = await readSheetValues(g.token, sheetId, tab ? `${tab}!A1:Z3000` : 'A1:Z3000')
      const roster = parseRoster(rows, bp?.planerka_members_map)
      count = roster.length; sample = roster.slice(0, 5)
    }
    return json({ ok: true, connected: true, sheet_id: sheetId, tab: bp?.planerka_members_tab ?? '', map: bp?.planerka_members_map ?? {}, count, sample })
  }

  // Google must be connected to read a sheet
  const g = await googleAccessToken(admin, accountId)
  if (!g?.token && (action === 'preview' || action === 'save')) {
    return json({ ok: false, code: 'NO_GOOGLE', message: 'Сначала подключите Google в разделе «Интеграции» — чтобы читать ваш Google-щит.' }, 200)
  }

  if (action === 'preview') {
    const sheetId = extractSheetId(String(body?.url ?? ''))
    if (!sheetId) return json({ ok: false, error: 'Вставьте ссылку на Google-таблицу.' }, 200)
    const tab = String(body?.tab ?? '').trim()
    const rows = await readSheetValues(g.token!, sheetId, tab ? `${tab}!A1:Z50` : 'A1:Z50')
    if (!rows?.length) return json({ ok: false, error: 'Не удалось прочитать лист — проверьте ссылку/название вкладки и доступ.' }, 200)
    const headers = (rows[0] ?? []).map((h) => String(h ?? ''))
    // auto-detected mapping (indexes) via a no-override parse: reflect what we'd pick
    const detectedRoster = parseRoster(rows.slice(0, 6), null)
    return json({ ok: true, sheet_id: sheetId, headers, rows: rows.slice(1, 6), detectedCount: detectedRoster.length, sample: detectedRoster })
  }

  if (action === 'save') {
    const sheetId = extractSheetId(String(body?.url ?? ''))
    if (!sheetId) return json({ ok: false, error: 'Вставьте ссылку на Google-таблицу.' }, 200)
    const tab = String(body?.tab ?? '').trim() || null
    // map: { name, chatId, username, dept } -> 0-based column indexes (optional overrides)
    const rawMap = (body?.map && typeof body.map === 'object') ? body.map : {}
    const map: Record<string, number> = {}
    for (const k of ['name', 'chatId', 'username', 'dept']) {
      const v = Number(rawMap[k])
      if (Number.isInteger(v) && v >= 0) map[k] = v
    }
    // validate we can read + parse at least one member
    const rows = await readSheetValues(g.token!, sheetId, tab ? `${tab}!A1:Z3000` : 'A1:Z3000')
    const roster = parseRoster(rows, map)
    await admin.from('business_profiles').upsert(
      { account_id: accountId, planerka_members_sheet_id: sheetId, planerka_members_tab: tab, planerka_members_map: map },
      { onConflict: 'account_id' },
    )
    return json({ ok: true, sheet_id: sheetId, count: roster.length, sample: roster.slice(0, 5) })
  }

  if (action === 'disconnect') {
    await admin.from('business_profiles').update({ planerka_members_sheet_id: null, planerka_members_tab: null, planerka_members_map: {} }).eq('account_id', accountId)
    return json({ ok: true })
  }

  return json({ error: 'unknown action' }, 400)
})
