// Shared Google helpers — refresh the account's OAuth access token and append rows to a
// Google Sheet. Used by the task-bot and agent tools.
//
// IMPORTANT: a refresh_token can only be exchanged with the SAME OAuth app that issued it.
// Accounts may connect via their OWN Google app (google_oauth_apps row, set in the UI) or
// via the shared Nemo app (env GOOGLE_CLIENT_ID/SECRET). Always resolve per-account first —
// using env creds for a token issued by a per-account app fails with invalid_client.
import { accountSecretContext, openSecret } from './secretBox.ts'

const ENV_CLIENT_ID = Deno.env.get('GOOGLE_CLIENT_ID') ?? ''
const ENV_CLIENT_SECRET = Deno.env.get('GOOGLE_CLIENT_SECRET') ?? ''

/* eslint-disable @typescript-eslint/no-explicit-any */
export async function googleAppCreds(db: any, accountId: string): Promise<{ id: string; secret: string }> {
  const { data } = await db.from('google_oauth_apps').select('client_id, client_secret').eq('account_id', accountId).maybeSingle()
  if (data?.client_id && data?.client_secret) {
    return {
      id: data.client_id,
      secret: await openSecret(data.client_secret, accountSecretContext(accountId, 'google-client-secret')),
    }
  }
  return { id: ENV_CLIENT_ID, secret: ENV_CLIENT_SECRET }
}

export async function googleAccessToken(db: any, accountId: string): Promise<{ token?: string; email?: string }> {
  const { data } = await db.from('google_accounts').select('refresh_token, google_email').eq('account_id', accountId).maybeSingle()
  if (!data?.refresh_token) return {}
  const creds = await googleAppCreds(db, accountId)
  if (!creds.id || !creds.secret) return {}
  try {
    const r = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: creds.id,
        client_secret: creds.secret,
        refresh_token: await openSecret(data.refresh_token, accountSecretContext(accountId, 'google-refresh-token')),
        grant_type: 'refresh_token',
      }),
    }).then((x) => x.json())
    if (r?.error === 'invalid_grant' || r?.error === 'invalid_client') {
      await db.from('google_accounts').delete().eq('account_id', accountId)
      return {}
    }
    return r?.access_token ? { token: r.access_token, email: data.google_email ?? '' } : {}
  } catch { return {} }
}

// Append one row of values to a sheet. Never throws.
export async function sheetsAppend(token: string, sheetId: string, values: (string | number)[], range = 'A1'): Promise<boolean> {
  try {
    const r = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${encodeURIComponent(range)}:append?valueInputOption=USER_ENTERED`, {
      method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ values: [values] }),
    }).then((x) => x.json())
    return Boolean(r?.updates)
  } catch { return false }
}

// Create a brand-new spreadsheet with a bold+frozen header row, and (optionally) a
// dropdown (data validation) on one column. Returns the new id + shareable edit URL.
export async function createSpreadsheet(
  token: string, title: string, headers: string[],
  opts?: { statusColIndex?: number; statusOptions?: string[] },
): Promise<{ id: string; url: string } | null> {
  try {
    const created = await fetch('https://sheets.googleapis.com/v4/spreadsheets', {
      method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ properties: { title }, sheets: [{ properties: { title: 'Tasks', gridProperties: { frozenRowCount: 1 } } }] }),
    }).then((x) => x.json())
    const id = created?.spreadsheetId
    if (!id) return null
    const sheetId = created?.sheets?.[0]?.properties?.sheetId ?? 0

    // header row values
    await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${id}/values/${encodeURIComponent('Tasks!A1')}?valueInputOption=USER_ENTERED`, {
      method: 'PUT', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ values: [headers] }),
    })

    const requests: any[] = [
      { repeatCell: { range: { sheetId, startRowIndex: 0, endRowIndex: 1 }, cell: { userEnteredFormat: { textFormat: { bold: true }, backgroundColor: { red: 0.85, green: 0.92, blue: 0.83 } } }, fields: 'userEnteredFormat(textFormat,backgroundColor)' } },
    ]
    if (opts?.statusColIndex != null && opts.statusOptions?.length) {
      requests.push({ setDataValidation: { range: { sheetId, startRowIndex: 1, startColumnIndex: opts.statusColIndex, endColumnIndex: opts.statusColIndex + 1 }, rule: { condition: { type: 'ONE_OF_LIST', values: opts.statusOptions.map((v) => ({ userEnteredValue: v })) }, showCustomUi: true, strict: false } } })
    }
    await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${id}:batchUpdate`, {
      method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ requests }),
    })
    return { id, url: `https://docs.google.com/spreadsheets/d/${id}/edit` }
  } catch { return null }
}

// Write values to a specific range (e.g. update a single Status cell). Never throws.
export async function updateSheetValues(token: string, sheetId: string, range: string, values: (string | number)[][]): Promise<boolean> {
  try {
    const r = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${encodeURIComponent(range)}?valueInputOption=USER_ENTERED`, {
      method: 'PUT', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ values }),
    }).then((x) => x.json())
    return Boolean(r?.updatedCells)
  } catch { return false }
}

// Read a rectangular block of a sheet's values (for "understand the sheet the user sent").
export async function readSheetValues(token: string, sheetId: string, range = 'A1:H2000'): Promise<string[][]> {
  try {
    const r = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${encodeURIComponent(range)}`, {
      headers: { Authorization: `Bearer ${token}` },
    }).then((x) => x.json())
    return Array.isArray(r?.values) ? r.values : []
  } catch { return [] }
}

// Pull a spreadsheet id out of a pasted Google Sheets URL (or return the raw id).
export function extractSheetId(text: string): string | null {
  const m = String(text ?? '').match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/)
  if (m) return m[1]
  const bare = String(text ?? '').trim()
  return /^[a-zA-Z0-9-_]{25,}$/.test(bare) ? bare : null
}
/* eslint-enable @typescript-eslint/no-explicit-any */
