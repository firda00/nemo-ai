// Reddit posting via a "script" app (BYO credentials): client_id + client_secret from
// reddit.com/prefs/apps (type: script) plus the bot account's username + password. We exchange
// them for an access token (password grant) and submit a self (text) post to a subreddit.
// Reddit API is free but rate-limited and dislikes automated posting — bans are a real risk.

export interface RedditKeys { client_id: string; client_secret: string; username: string; password: string; subreddit?: string }

const UA = 'web:nemo.ai:1.0 (by /u/nemo_ai_bot)'

async function accessToken(k: RedditKeys): Promise<string> {
  const basic = btoa(`${k.client_id}:${k.client_secret}`)
  const r = await fetch('https://www.reddit.com/api/v1/access_token', {
    method: 'POST',
    headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': UA },
    body: new URLSearchParams({ grant_type: 'password', username: k.username, password: k.password }),
  })
  const j = await r.json().catch(() => ({}))
  return j?.access_token ?? ''
}

// Verify the script-app credentials by fetching a token.
export async function redditVerify(k: RedditKeys): Promise<{ ok: boolean; error?: string }> {
  try {
    const t = await accessToken(k)
    return t ? { ok: true } : { ok: false, error: 'Reddit отклонил — проверьте client_id/secret, логин/пароль и что приложение типа «script».' }
  } catch (e) { return { ok: false, error: String(e).slice(0, 150) } }
}

// Submit a self (text) post. Title required by Reddit; body optional.
export async function redditPost(k: RedditKeys, title: string, text: string, subreddit?: string): Promise<{ ok: boolean; url?: string; error?: string }> {
  try {
    const sr = String(subreddit || k.subreddit || '').replace(/^\/?r\//, '').trim()
    if (!sr) return { ok: false, error: 'Не указан сабреддит (subreddit).' }
    const token = await accessToken(k)
    if (!token) return { ok: false, error: 'Reddit: не удалось получить токен.' }
    const r = await fetch('https://oauth.reddit.com/api/submit', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': UA },
      body: new URLSearchParams({ sr, kind: 'self', title: title.slice(0, 300), text, api_type: 'json' }),
    })
    const j = await r.json().catch(() => ({}))
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const errs = j?.json?.errors as any[] | undefined
    if (errs && errs.length) return { ok: false, error: errs.map((e) => e.join(' ')).join('; ').slice(0, 200) }
    return { ok: true, url: j?.json?.data?.url }
  } catch (e) { return { ok: false, error: String(e).slice(0, 150) } }
}
