// Agent tool execution. Given a natural-language instruction, the model (function-calling)
// picks a tool from the account's CONNECTED integrations and executes it against the real
// provider API (GitHub / Slack / HubSpot). Result is logged. This is how a connected
// integration becomes a real tool the agent uses.
//   POST /functions/v1/agent-tool  (Bearer jwt)  { instruction } -> { ok, tool, args, result }
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { resolveOpenRouterKey } from '../_shared/keys.ts'
import { PRIMARY_MODEL } from '../_shared/llm.ts'
import { runBrowserTask, looksAbusive } from '../_shared/browser.ts'
import { googleAccessToken } from '../_shared/google.ts'
import { corsHeaders, json } from '../_shared/cors.ts'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const OPENROUTER_API_KEY = Deno.env.get('OPENROUTER_API_KEY') ?? ''
const GOOGLE_CLIENT_ID = Deno.env.get('GOOGLE_CLIENT_ID') ?? ''
const GOOGLE_CLIENT_SECRET = Deno.env.get('GOOGLE_CLIENT_SECRET') ?? ''
const NEMO_HB_KEY = Deno.env.get('HYPERBROWSER_API_KEY') ?? '' // browser agent included in subscription

/* eslint-disable @typescript-eslint/no-explicit-any */
// tool specs (OpenAI function-calling), grouped by the provider that powers them
const TOOLS: Record<string, { provider: string; spec: any }> = {
  github_create_issue: { provider: 'github', spec: { type: 'function', function: { name: 'github_create_issue', description: 'Create a GitHub issue in a repository', parameters: { type: 'object', properties: { repo: { type: 'string', description: 'owner/repo' }, title: { type: 'string' }, body: { type: 'string' } }, required: ['repo', 'title'] } } } },
  github_list_repos: { provider: 'github', spec: { type: 'function', function: { name: 'github_list_repos', description: "List the user's GitHub repositories", parameters: { type: 'object', properties: {} } } } },
  slack_send_message: { provider: 'slack', spec: { type: 'function', function: { name: 'slack_send_message', description: 'Send a message to a Slack channel', parameters: { type: 'object', properties: { channel: { type: 'string', description: '#channel or channel id' }, text: { type: 'string' } }, required: ['channel', 'text'] } } } },
  hubspot_create_contact: { provider: 'hubspot', spec: { type: 'function', function: { name: 'hubspot_create_contact', description: 'Create a contact in HubSpot CRM', parameters: { type: 'object', properties: { email: { type: 'string' }, firstname: { type: 'string' }, lastname: { type: 'string' }, phone: { type: 'string' } }, required: ['email'] } } } },
  browser_task: { provider: 'hyperbrowser', spec: { type: 'function', function: { name: 'browser_task', description: 'Visit a website and perform a task the user authorized (fill a form, submit an application, post a listing, look something up). Use only data the user provided.', parameters: { type: 'object', properties: { url: { type: 'string', description: 'target website' }, task: { type: 'string', description: 'what to do on the site, with the exact data to enter' } }, required: ['task'] } } } },
}

async function execTool(name: string, args: any, key: string): Promise<{ ok: boolean; result: string }> {
  try {
    if (name === 'github_create_issue') {
      const r = await fetch(`https://api.github.com/repos/${args.repo}/issues`, { method: 'POST', headers: { Authorization: `Bearer ${key}`, Accept: 'application/vnd.github+json', 'User-Agent': 'nemo-ai' }, body: JSON.stringify({ title: args.title, body: args.body ?? '' }) }).then((x) => x.json())
      return r?.html_url ? { ok: true, result: `Issue создан: ${r.html_url}` } : { ok: false, result: r?.message ?? 'GitHub error' }
    }
    if (name === 'github_list_repos') {
      const r = await fetch('https://api.github.com/user/repos?per_page=20&sort=updated', { headers: { Authorization: `Bearer ${key}`, Accept: 'application/vnd.github+json', 'User-Agent': 'nemo-ai' } }).then((x) => x.json())
      if (Array.isArray(r)) return { ok: true, result: 'Репозитории: ' + r.map((x: any) => x.full_name).join(', ') }
      return { ok: false, result: r?.message ?? 'GitHub error' }
    }
    if (name === 'slack_send_message') {
      const r = await fetch('https://slack.com/api/chat.postMessage', { method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ channel: args.channel, text: args.text }) }).then((x) => x.json())
      return r?.ok ? { ok: true, result: `Отправлено в Slack ${args.channel}` } : { ok: false, result: r?.error ?? 'Slack error' }
    }
    if (name === 'hubspot_create_contact') {
      const props: any = { email: args.email }; if (args.firstname) props.firstname = args.firstname; if (args.lastname) props.lastname = args.lastname; if (args.phone) props.phone = args.phone
      const r = await fetch('https://api.hubapi.com/crm/v3/objects/contacts', { method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ properties: props }) }).then((x) => x.json())
      return r?.id ? { ok: true, result: `Контакт создан в HubSpot (id ${r.id})` } : { ok: false, result: r?.message ?? 'HubSpot error' }
    }
    if (name === 'browser_task') {
      if (looksAbusive(String(args.task ?? ''))) return { ok: false, result: 'Задача нарушает правила сайтов (массовая регистрация / обход защит) — не выполняем.' }
      const task = (args.url ? `Open ${args.url}. ` : '') + String(args.task ?? '') + '\nRules: only this task, only user-provided data, do not create extra accounts, do not bypass CAPTCHAs.'
      const out = await runBrowserTask(key, task, 55000)
      if (out.pending) return { ok: true, result: `Агент работает в браузере (job ${out.jobId}) — результат появится позже.` }
      return out.ok ? { ok: true, result: out.result ?? 'Готово' } : { ok: false, result: out.error ?? 'Не выполнено' }
    }
    return { ok: false, result: 'unknown tool' }
  } catch (e) { return { ok: false, result: String(e).slice(0, 200) } }
}

// ---- Google ecosystem (Gmail / Calendar / Sheets) — via the account's OAuth (not an api key) ----
const GOOGLE_TOOLS: Record<string, any> = {
  gmail_send: { type: 'function', function: { name: 'gmail_send', description: 'Send an email from the connected Google/Gmail account', parameters: { type: 'object', properties: { to: { type: 'string' }, subject: { type: 'string' }, body: { type: 'string' } }, required: ['to', 'body'] } } },
  calendar_create_event: { type: 'function', function: { name: 'calendar_create_event', description: 'Create an event in the connected Google Calendar', parameters: { type: 'object', properties: { summary: { type: 'string' }, start_iso: { type: 'string', description: 'ISO 8601 datetime' }, end_iso: { type: 'string' }, description: { type: 'string' } }, required: ['summary', 'start_iso'] } } },
  sheets_append: { type: 'function', function: { name: 'sheets_append', description: 'Append a row of values to an EXISTING Google Sheet', parameters: { type: 'object', properties: { spreadsheet_id: { type: 'string' }, range: { type: 'string', description: 'e.g. A1' }, values: { type: 'array', items: { type: 'string' } } }, required: ['spreadsheet_id', 'values'] } } },
  sheets_create: { type: 'function', function: { name: 'sheets_create', description: 'Create a NEW Google Spreadsheet with a title, optionally filled with rows of data', parameters: { type: 'object', properties: { title: { type: 'string' }, rows: { type: 'array', items: { type: 'array', items: { type: 'string' } }, description: 'optional rows (each row is a list of cell values, first row can be headers)' } }, required: ['title'] } } },
  docs_create: { type: 'function', function: { name: 'docs_create', description: 'Create a NEW Google Doc with a title and text content', parameters: { type: 'object', properties: { title: { type: 'string' }, content: { type: 'string' } }, required: ['title'] } } },
}

// token refresh MUST use the same OAuth app that issued the refresh_token — the shared
// googleAccessToken resolves per-account creds (google_oauth_apps) first, env fallback.
const googleToken = googleAccessToken

function buildRawEmail(from: string, to: string, subject: string, body: string): string {
  const enc = (s: string) => `=?UTF-8?B?${btoa(String.fromCharCode(...new TextEncoder().encode(s)))}?=`
  const mime = `From: ${from}\r\nTo: ${to}\r\nSubject: ${enc(subject)}\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset="UTF-8"\r\nContent-Transfer-Encoding: base64\r\n\r\n` + btoa(String.fromCharCode(...new TextEncoder().encode(body)))
  return btoa(String.fromCharCode(...new TextEncoder().encode(mime))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

async function execGoogle(name: string, args: any, token: string, email: string): Promise<{ ok: boolean; result: string }> {
  try {
    if (name === 'gmail_send') {
      const raw = buildRawEmail(email || 'me', String(args.to ?? ''), String(args.subject ?? '').slice(0, 300), String(args.body ?? ''))
      const r = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ raw }) }).then((x) => x.json())
      return r?.id ? { ok: true, result: `Письмо отправлено на ${args.to}` } : { ok: false, result: r?.error?.message ?? 'Gmail error' }
    }
    if (name === 'calendar_create_event') {
      const ev = { summary: String(args.summary ?? ''), description: String(args.description ?? ''), start: { dateTime: String(args.start_iso ?? '') }, end: { dateTime: String(args.end_iso ?? args.start_iso ?? '') } }
      const r = await fetch('https://www.googleapis.com/calendar/v3/calendars/primary/events', { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(ev) }).then((x) => x.json())
      return r?.id ? { ok: true, result: `Событие создано: ${r.htmlLink ?? r.id}` } : { ok: false, result: r?.error?.message ?? 'Calendar error' }
    }
    if (name === 'sheets_append') {
      const id = String(args.spreadsheet_id ?? ''); const range = String(args.range ?? 'A1')
      const values = Array.isArray(args.values) ? (Array.isArray(args.values[0]) ? args.values : [args.values]) : []
      const r = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${id}/values/${encodeURIComponent(range)}:append?valueInputOption=USER_ENTERED`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ values }) }).then((x) => x.json())
      return r?.updates ? { ok: true, result: `Строка добавлена в таблицу (${r.updates.updatedCells ?? '?'} ячеек)` } : { ok: false, result: r?.error?.message ?? 'Sheets error' }
    }
    if (name === 'sheets_create') {
      const cr = await fetch('https://sheets.googleapis.com/v4/spreadsheets', { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ properties: { title: String(args.title ?? 'Nemo Sheet') } }) }).then((x) => x.json())
      if (!cr?.spreadsheetId) return { ok: false, result: cr?.error?.message ?? 'Sheets create error' }
      const link = cr.spreadsheetUrl ?? `https://docs.google.com/spreadsheets/d/${cr.spreadsheetId}/edit`
      const rows = Array.isArray(args.rows) ? args.rows.map((r: any) => (Array.isArray(r) ? r : [String(r)])) : []
      if (rows.length) await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${cr.spreadsheetId}/values/A1:append?valueInputOption=USER_ENTERED`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ values: rows }) })
      return { ok: true, result: `Таблица создана: ${link}` }
    }
    if (name === 'docs_create') {
      const cr = await fetch('https://docs.googleapis.com/v1/documents', { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ title: String(args.title ?? 'Nemo Doc') }) }).then((x) => x.json())
      if (!cr?.documentId) return { ok: false, result: cr?.error?.message ?? 'Docs create error' }
      const content = String(args.content ?? '')
      if (content) await fetch(`https://docs.googleapis.com/v1/documents/${cr.documentId}:batchUpdate`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ requests: [{ insertText: { location: { index: 1 }, text: content } }] }) })
      return { ok: true, result: `Документ создан: https://docs.google.com/document/d/${cr.documentId}/edit` }
    }
    return { ok: false, result: 'unknown google tool' }
  } catch (e) { return { ok: false, result: String(e).slice(0, 200) } }
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

  const body = await req.json().catch(() => ({}))
  const instruction = String(body?.instruction ?? '').trim()
  if (instruction.length < 3) return json({ ok: false, error: 'Опишите задачу для агента.' }, 200)

  // which integrations are connected -> which tools are available
  const { data: keysRows } = await admin.from('provider_keys').select('provider, api_key').eq('account_id', accountId)
  const keyByProvider: Record<string, string> = {}
  for (const r of keysRows ?? []) keyByProvider[r.provider] = r.api_key
  // Google is connected via OAuth (google_accounts), not an api key
  const { data: gRow } = await admin.from('google_accounts').select('refresh_token').eq('account_id', accountId).maybeSingle()
  const googleConnected = Boolean(gRow?.refresh_token)
  const availableTools = [
    ...Object.entries(TOOLS).filter(([, t]) => keyByProvider[t.provider] || (t.provider === 'hyperbrowser' && NEMO_HB_KEY)).map(([, t]) => t.spec),
    ...(googleConnected ? Object.values(GOOGLE_TOOLS) : []),
  ]
  if (!availableTools.length) return json({ ok: false, code: 'NO_TOOLS', message: 'Нет подключённых интеграций. Подключите GitHub / Slack / CRM / Google в разделе «Интеграции».' }, 200)

  const orKey = await resolveOpenRouterKey(admin, accountId, OPENROUTER_API_KEY)
  try {
    const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST', headers: { Authorization: `Bearer ${orKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: PRIMARY_MODEL, temperature: 0, tools: availableTools, tool_choice: 'auto', messages: [{ role: 'system', content: 'You are an agent that uses connected tools to complete the task. Call the most appropriate tool with correct arguments. If no tool fits, answer briefly.' }, { role: 'user', content: instruction }] }),
    }).then((x) => x.json())
    const choice = r?.choices?.[0]?.message
    const call = choice?.tool_calls?.[0]
    if (!call) return json({ ok: true, tool: null, result: choice?.content ?? 'Не нашёл подходящий инструмент.' })
    const name = call.function?.name
    const args = (() => { try { return JSON.parse(call.function?.arguments ?? '{}') } catch { return {} } })()
    // Google tools use the account's OAuth token
    if (GOOGLE_TOOLS[name]) {
      const gt = await googleToken(admin, accountId)
      if (!gt.token) return json({ ok: false, error: 'Google не подключён.' }, 200)
      const out = await execGoogle(name, args, gt.token, gt.email ?? '')
      await admin.from('tool_runs').insert({ account_id: accountId, tool: name, args, result: out.result.slice(0, 1000), ok: out.ok })
      return json({ ok: out.ok, tool: name, args, result: out.result })
    }
    const def = TOOLS[name]
    const toolKey = def && def.provider === 'hyperbrowser' ? (keyByProvider['hyperbrowser'] || NEMO_HB_KEY) : (def ? keyByProvider[def.provider] : '')
    if (!def || !toolKey) return json({ ok: false, error: 'Инструмент недоступен.' }, 200)
    const out = await execTool(name, args, toolKey)
    await admin.from('tool_runs').insert({ account_id: accountId, tool: name, args, result: out.result.slice(0, 1000), ok: out.ok })
    return json({ ok: out.ok, tool: name, args, result: out.result })
  } catch (e) {
    return json({ ok: false, error: `Ошибка: ${String(e).slice(0, 200)}` }, 502)
  }
})
