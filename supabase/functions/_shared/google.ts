// Shared Google helpers — refresh the account's OAuth access token and append rows to a
// Google Sheet. Used by the task-bot and agent tools.
//
// IMPORTANT: a refresh_token can only be exchanged with the SAME OAuth app that issued it.
// Accounts may connect via their OWN Google app (google_oauth_apps row, set in the UI) or
// via the shared Nemo app (env GOOGLE_CLIENT_ID/SECRET). Always resolve per-account first —
// using env creds for a token issued by a per-account app fails with invalid_client.
const ENV_CLIENT_ID = Deno.env.get('GOOGLE_CLIENT_ID') ?? ''
const ENV_CLIENT_SECRET = Deno.env.get('GOOGLE_CLIENT_SECRET') ?? ''

/* eslint-disable @typescript-eslint/no-explicit-any */
export async function googleAppCreds(db: any, accountId: string): Promise<{ id: string; secret: string }> {
  const { data } = await db.from('google_oauth_apps').select('client_id, client_secret').eq('account_id', accountId).maybeSingle()
  if (data?.client_id && data?.client_secret) return { id: data.client_id, secret: data.client_secret }
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
      body: new URLSearchParams({ client_id: creds.id, client_secret: creds.secret, refresh_token: data.refresh_token, grant_type: 'refresh_token' }),
    }).then((x) => x.json())
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
/* eslint-enable @typescript-eslint/no-explicit-any */
