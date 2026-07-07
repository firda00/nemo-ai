// Agent tool-use INSIDE a normal reply. Given the user's message, if the account has
// connected tools (Google, GitHub/Slack/CRM, browser) and the message asks to DO something
// a tool can do, the model calls the tool and it is EXECUTED for real — so a channel bot
// actually creates the Google Sheet / sends the email instead of hallucinating a link.
import { PRIMARY_MODEL, callOpenRouter } from './llm.ts'
import { runBrowserTask, looksAbusive } from './browser.ts'
import { googleAccessToken } from './google.ts'
import { safeFetch } from './net.ts'

const NEMO_HB_KEY = Deno.env.get('HYPERBROWSER_API_KEY') ?? ''

/* eslint-disable @typescript-eslint/no-explicit-any */
const TOOLS: Record<string, { provider: string; spec: any }> = {
  github_create_issue: { provider: 'github', spec: { type: 'function', function: { name: 'github_create_issue', description: 'Create a GitHub issue', parameters: { type: 'object', properties: { repo: { type: 'string', description: 'owner/repo' }, title: { type: 'string' }, body: { type: 'string' } }, required: ['repo', 'title'] } } } },
  slack_send_message: { provider: 'slack', spec: { type: 'function', function: { name: 'slack_send_message', description: 'Send a message to a Slack channel', parameters: { type: 'object', properties: { channel: { type: 'string' }, text: { type: 'string' } }, required: ['channel', 'text'] } } } },
  hubspot_create_contact: { provider: 'hubspot', spec: { type: 'function', function: { name: 'hubspot_create_contact', description: 'Create a HubSpot contact', parameters: { type: 'object', properties: { email: { type: 'string' }, firstname: { type: 'string' }, lastname: { type: 'string' }, phone: { type: 'string' } }, required: ['email'] } } } },
  browser_task: { provider: 'hyperbrowser', spec: { type: 'function', function: { name: 'browser_task', description: 'Visit a website and perform a task the user authorized (fill a form, submit an application, look something up)', parameters: { type: 'object', properties: { url: { type: 'string' }, task: { type: 'string' } }, required: ['task'] } } } },
  notion_create_page: { provider: 'notion', spec: { type: 'function', function: { name: 'notion_create_page', description: 'Create a new page in Notion under a parent page or database. Needs the 32-char parent id from the Notion URL — ask the user for their Notion page/database link if you do not have it. The integration must be shared with that page.', parameters: { type: 'object', properties: { parent_id: { type: 'string', description: 'The 32-char id from the Notion page/database URL' }, parent_type: { type: 'string', enum: ['page', 'database'], description: "'page' (default) or 'database'" }, title: { type: 'string' }, content: { type: 'string', description: 'Optional body text' } }, required: ['parent_id', 'title'] } } } },
  airtable_create_record: { provider: 'airtable', spec: { type: 'function', function: { name: 'airtable_create_record', description: 'Add a record (row) to an Airtable table. Needs the base id (starts with app…) and the table name from the Airtable URL. fields is an object of column name -> value.', parameters: { type: 'object', properties: { base_id: { type: 'string' }, table: { type: 'string' }, fields: { type: 'object', description: 'Column name -> value', additionalProperties: true } }, required: ['base_id', 'table', 'fields'] } } } },
  bitrix24_create_lead: { provider: 'bitrix24', spec: { type: 'function', function: { name: 'bitrix24_create_lead', description: 'Create a lead in Bitrix24 CRM. Works when the connected Bitrix24 key is the full incoming-webhook URL.', parameters: { type: 'object', properties: { title: { type: 'string' }, name: { type: 'string' }, phone: { type: 'string' }, comment: { type: 'string' } }, required: ['title'] } } } },
  stripe_create_customer: { provider: 'stripe', spec: { type: 'function', function: { name: 'stripe_create_customer', description: 'Create a customer in Stripe (email required; name/phone optional).', parameters: { type: 'object', properties: { email: { type: 'string' }, name: { type: 'string' }, phone: { type: 'string' } }, required: ['email'] } } } },
}

const GOOGLE_TOOLS: Record<string, any> = {
  gmail_send: { type: 'function', function: { name: 'gmail_send', description: 'Send an email from the connected Gmail', parameters: { type: 'object', properties: { to: { type: 'string' }, subject: { type: 'string' }, body: { type: 'string' } }, required: ['to', 'body'] } } },
  calendar_create_event: { type: 'function', function: { name: 'calendar_create_event', description: 'Create a Google Calendar event', parameters: { type: 'object', properties: { summary: { type: 'string' }, start_iso: { type: 'string' }, end_iso: { type: 'string' }, description: { type: 'string' } }, required: ['summary', 'start_iso'] } } },
  sheets_append: { type: 'function', function: { name: 'sheets_append', description: 'Append one row to an EXISTING Google Sheet you already have the spreadsheet_id for. Use when the user wants to add data to a sheet already created. To make a brand-new sheet, use sheets_create instead. Returns a confirmation.', parameters: { type: 'object', properties: { spreadsheet_id: { type: 'string', description: 'The id from an existing sheet URL (.../spreadsheets/d/<ID>/edit)' }, range: { type: 'string', description: "Sheet/cell range, default 'A1'" }, values: { type: 'array', items: { type: 'string' }, description: 'Cell values for the row, left to right' } }, required: ['spreadsheet_id', 'values'] } } },
  sheets_create: { type: 'function', function: { name: 'sheets_create', description: 'Create a NEW Google Spreadsheet with a title and optional rows, and return its shareable link. Use when the user asks to make/create a table or spreadsheet and no sheet exists yet. To add rows to an existing sheet, use sheets_append instead.', parameters: { type: 'object', properties: { title: { type: 'string' }, rows: { type: 'array', items: { type: 'array', items: { type: 'string' } }, description: 'Rows of cells; the first row is usually the header' } }, required: ['title'] } } },
  docs_create: { type: 'function', function: { name: 'docs_create', description: 'Create a NEW Google Doc with a title and text content, and return its shareable link. Use when the user asks to write/create a document.', parameters: { type: 'object', properties: { title: { type: 'string' }, content: { type: 'string' } }, required: ['title'] } } },
}

// ALWAYS-available web tools — no per-account key needed (use Nemo's shared LLM key /
// SSRF-guarded fetch). Offered only when the message actually looks web-ish (see wantsWeb),
// so a plain "hi" doesn't pay for a tool-check pass.
const ALWAYS_TOOLS: Record<string, any> = {
  read_webpage: { type: 'function', function: { name: 'read_webpage', description: 'Open a PUBLIC web page (a marketplace rules page, a competitor listing, an article, a price) and return its readable text. Use when the user gives a URL or asks what a specific page says.', parameters: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] } } },
  web_search: { type: 'function', function: { name: 'web_search', description: 'Search the live web for current information (prices, facts, rules, competitors, news) and return a short answer with sources. Use when you need up-to-date info you do not already have.', parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } } },
}

// Run the always-tools. read_webpage is a pure SSRF-guarded fetch (no tokens); web_search
// asks a Perplexity online model via the same OpenRouter key (returns tokens to account).
async function execAlways(name: string, args: any, orKey: string): Promise<{ ok: boolean; result: string; tokens?: number }> {
  if (name === 'read_webpage') {
    const url = String(args.url ?? '').trim()
    if (!/^https?:\/\//i.test(url)) return { ok: false, result: 'Дайте полный URL (со https://).' }
    try {
      const { body } = await safeFetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; NemoBot/1.0)' } }, { maxBytes: 600_000, timeoutMs: 12_000 })
      const text = body.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&[a-z]+;/gi, ' ').replace(/\s+/g, ' ').trim().slice(0, 4000)
      return text ? { ok: true, result: `Текст страницы ${url}:\n${text}` } : { ok: false, result: `Страница ${url} пустая или её нельзя прочитать напрямую (нужен браузер-агент).` }
    } catch (e) { return { ok: false, result: `Не смог открыть ${url} (${String(e).slice(0, 120)}).` } }
  }
  if (name === 'web_search') {
    const query = String(args.query ?? '').trim()
    if (!query) return { ok: false, result: 'Пустой запрос.' }
    try {
      // OpenRouter ':online' suffix adds live web search to a known-good base model (the old
      // perplexity sonar-online ids were decommissioned). Fallback to the plain model so a
      // search never hard-fails to nothing.
      const r = await callOpenRouter({ apiKey: orKey, model: 'openai/gpt-4o-mini:online', fallbackModel: PRIMARY_MODEL, temperature: 0.2, maxTokens: 700, messages: [{ role: 'user', content: query }] })
      const cites = (r.citations ?? []).slice(0, 5).join('\n')
      return { ok: true, result: (r.content ?? '').trim() + (cites ? `\n\nИсточники:\n${cites}` : ''), tokens: r.tokens }
    } catch (e) { return { ok: false, result: `Поиск не удался (${String(e).slice(0, 120)}).` } }
  }
  return { ok: false, result: 'unknown tool' }
}

function buildRawEmail(from: string, to: string, subject: string, body: string): string {
  const enc = (s: string) => `=?UTF-8?B?${btoa(String.fromCharCode(...new TextEncoder().encode(s)))}?=`
  const mime = `From: ${from}\r\nTo: ${to}\r\nSubject: ${enc(subject)}\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset="UTF-8"\r\nContent-Transfer-Encoding: base64\r\n\r\n` + btoa(String.fromCharCode(...new TextEncoder().encode(body)))
  return btoa(String.fromCharCode(...new TextEncoder().encode(mime))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

async function execGoogle(name: string, args: any, token: string, email: string): Promise<{ ok: boolean; result: string }> {
  const H = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
  if (name === 'gmail_send') {
    const raw = buildRawEmail(email || 'me', String(args.to ?? ''), String(args.subject ?? '').slice(0, 300), String(args.body ?? ''))
    const r = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', { method: 'POST', headers: H, body: JSON.stringify({ raw }) }).then((x) => x.json())
    return r?.id ? { ok: true, result: `Письмо отправлено на ${args.to}` } : { ok: false, result: `Не смог отправить письмо (${r?.error?.message ?? 'ошибка Gmail'}). Проверьте, что Google подключён с доступом к Gmail в разделе «Интеграции».` }
  }
  if (name === 'calendar_create_event') {
    const ev = { summary: String(args.summary ?? ''), description: String(args.description ?? ''), start: { dateTime: String(args.start_iso ?? '') }, end: { dateTime: String(args.end_iso ?? args.start_iso ?? '') } }
    const r = await fetch('https://www.googleapis.com/calendar/v3/calendars/primary/events', { method: 'POST', headers: H, body: JSON.stringify(ev) }).then((x) => x.json())
    return r?.id ? { ok: true, result: `Событие создано: ${r.htmlLink ?? r.id}` } : { ok: false, result: `Не смог создать событие (${r?.error?.message ?? 'ошибка Calendar'}). Проверьте, что даты в формате ISO и Google подключён с доступом к Календарю.` }
  }
  if (name === 'sheets_append') {
    const id = String(args.spreadsheet_id ?? ''); const range = String(args.range ?? 'A1')
    const values = Array.isArray(args.values) ? (Array.isArray(args.values[0]) ? args.values : [args.values]) : []
    const r = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${id}/values/${encodeURIComponent(range)}:append?valueInputOption=USER_ENTERED`, { method: 'POST', headers: H, body: JSON.stringify({ values }) }).then((x) => x.json())
    return r?.updates ? { ok: true, result: 'Строка добавлена в таблицу' } : { ok: false, result: `Не смог добавить строку (${r?.error?.message ?? 'ошибка Sheets'}). Проверьте spreadsheet_id — или создайте новую таблицу через sheets_create.` }
  }
  if (name === 'sheets_create') {
    const cr = await fetch('https://sheets.googleapis.com/v4/spreadsheets', { method: 'POST', headers: H, body: JSON.stringify({ properties: { title: String(args.title ?? 'Nemo Sheet') } }) }).then((x) => x.json())
    if (!cr?.spreadsheetId) return { ok: false, result: `Не смог создать таблицу (${cr?.error?.message ?? 'ошибка Sheets'}). Проверьте, что Google подключён с доступом к Google Таблицам в разделе «Интеграции».` }
    const link = cr.spreadsheetUrl ?? `https://docs.google.com/spreadsheets/d/${cr.spreadsheetId}/edit`
    const rows = Array.isArray(args.rows) ? args.rows.map((r: any) => (Array.isArray(r) ? r : [String(r)])) : []
    if (rows.length) await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${cr.spreadsheetId}/values/A1:append?valueInputOption=USER_ENTERED`, { method: 'POST', headers: H, body: JSON.stringify({ values: rows }) })
    return { ok: true, result: `Таблица создана: ${link}` }
  }
  if (name === 'docs_create') {
    const cr = await fetch('https://docs.googleapis.com/v1/documents', { method: 'POST', headers: H, body: JSON.stringify({ title: String(args.title ?? 'Nemo Doc') }) }).then((x) => x.json())
    if (!cr?.documentId) return { ok: false, result: `Не смог создать документ (${cr?.error?.message ?? 'ошибка Docs'}). Проверьте, что Google подключён с доступом к Google Документам в разделе «Интеграции».` }
    const content = String(args.content ?? '')
    if (content) await fetch(`https://docs.googleapis.com/v1/documents/${cr.documentId}:batchUpdate`, { method: 'POST', headers: H, body: JSON.stringify({ requests: [{ insertText: { location: { index: 1 }, text: content } }] }) })
    return { ok: true, result: `Документ создан: https://docs.google.com/document/d/${cr.documentId}/edit` }
  }
  return { ok: false, result: 'unknown google tool' }
}

async function execProvider(name: string, args: any, key: string): Promise<{ ok: boolean; result: string }> {
  try {
    if (name === 'github_create_issue') {
      const r = await fetch(`https://api.github.com/repos/${args.repo}/issues`, { method: 'POST', headers: { Authorization: `Bearer ${key}`, Accept: 'application/vnd.github+json', 'User-Agent': 'nemo-ai' }, body: JSON.stringify({ title: args.title, body: args.body ?? '' }) }).then((x) => x.json())
      return r?.html_url ? { ok: true, result: `Issue создан: ${r.html_url}` } : { ok: false, result: `GitHub не принял запрос (${r?.message ?? 'ошибка'}). Проверьте, что repo указан как «owner/repo» и токен имеет доступ.` }
    }
    if (name === 'slack_send_message') {
      const r = await fetch('https://slack.com/api/chat.postMessage', { method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ channel: args.channel, text: args.text }) }).then((x) => x.json())
      return r?.ok ? { ok: true, result: `Отправлено в Slack ${args.channel}` } : { ok: false, result: `Slack не принял сообщение (${r?.error ?? 'ошибка'}). Проверьте название канала (например #general) и права бота.` }
    }
    if (name === 'hubspot_create_contact') {
      const props: any = { email: args.email }; if (args.firstname) props.firstname = args.firstname; if (args.lastname) props.lastname = args.lastname; if (args.phone) props.phone = args.phone
      const r = await fetch('https://api.hubapi.com/crm/v3/objects/contacts', { method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ properties: props }) }).then((x) => x.json())
      return r?.id ? { ok: true, result: `Контакт создан в HubSpot (id ${r.id})` } : { ok: false, result: `HubSpot не создал контакт (${r?.message ?? 'ошибка'}). Проверьте, что email корректный и токен имеет доступ к CRM.` }
    }
    if (name === 'browser_task') {
      if (looksAbusive(String(args.task ?? ''))) return { ok: false, result: 'Задача нарушает правила сайтов — не выполняем.' }
      const task = (args.url ? `Open ${args.url}. ` : '') + String(args.task ?? '') + '\nRules: only this task, only user-provided data, no extra accounts, no CAPTCHA bypass.'
      const out = await runBrowserTask(key, task, 50000)
      if (out.pending) return { ok: true, result: `Агент работает в браузере (job ${out.jobId}).` }
      return out.ok ? { ok: true, result: out.result ?? 'Готово' } : { ok: false, result: out.error ?? 'Не выполнено' }
    }
    if (name === 'notion_create_page') {
      const H = { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', 'Notion-Version': '2022-06-28' }
      const isDb = String(args.parent_type ?? 'page') === 'database'
      const pid = String(args.parent_id ?? '').replace(/-/g, '')
      const parent = isDb ? { database_id: pid } : { page_id: pid }
      // a page parent uses the built-in 'title' prop; a database uses its title column (commonly 'Name')
      const properties = isDb
        ? { Name: { title: [{ text: { content: String(args.title ?? '') } }] } }
        : { title: { title: [{ text: { content: String(args.title ?? '') } }] } }
      const children = args.content ? [{ object: 'block', type: 'paragraph', paragraph: { rich_text: [{ type: 'text', text: { content: String(args.content).slice(0, 1800) } }] } }] : []
      const r = await fetch('https://api.notion.com/v1/pages', { method: 'POST', headers: H, body: JSON.stringify({ parent, properties, children }) }).then((x) => x.json())
      return r?.id ? { ok: true, result: `Страница создана в Notion: ${r.url ?? r.id}` } : { ok: false, result: `Notion не создал страницу (${r?.message ?? 'ошибка'}). Проверьте parent_id и что интеграция добавлена в нужную страницу/базу.` }
    }
    if (name === 'airtable_create_record') {
      const base = String(args.base_id ?? ''); const table = String(args.table ?? '')
      const fields = (args.fields && typeof args.fields === 'object' && !Array.isArray(args.fields)) ? args.fields : {}
      const r = await fetch(`https://api.airtable.com/v0/${base}/${encodeURIComponent(table)}`, { method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ fields }) }).then((x) => x.json())
      return r?.id ? { ok: true, result: `Запись добавлена в Airtable (${table})` } : { ok: false, result: `Airtable не принял запись (${r?.error?.message ?? r?.error?.type ?? 'ошибка'}). Проверьте base_id, имя таблицы и имена колонок.` }
    }
    if (name === 'bitrix24_create_lead') {
      const base = key.replace(/\/+$/, '')
      if (!/^https?:\/\//i.test(base)) return { ok: false, result: 'Для Bitrix24 вставьте в «Интеграции» полный URL входящего вебхука (https://portal.bitrix24.ru/rest/1/xxxx/).' }
      const fields: any = { TITLE: String(args.title ?? 'Nemo lead') }
      if (args.name) fields.NAME = String(args.name)
      if (args.comment) fields.COMMENTS = String(args.comment)
      if (args.phone) fields.PHONE = [{ VALUE: String(args.phone), VALUE_TYPE: 'WORK' }]
      const r = await fetch(`${base}/crm.lead.add.json`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ fields }) }).then((x) => x.json())
      return r?.result ? { ok: true, result: `Лид создан в Bitrix24 (id ${r.result})` } : { ok: false, result: `Bitrix24 не создал лид (${r?.error_description ?? r?.error ?? 'ошибка'}). Проверьте URL вебхука и права.` }
    }
    if (name === 'stripe_create_customer') {
      const form = new URLSearchParams()
      if (args.email) form.set('email', String(args.email))
      if (args.name) form.set('name', String(args.name))
      if (args.phone) form.set('phone', String(args.phone))
      const r = await fetch('https://api.stripe.com/v1/customers', { method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/x-www-form-urlencoded' }, body: form.toString() }).then((x) => x.json())
      return r?.id ? { ok: true, result: `Клиент создан в Stripe (id ${r.id})` } : { ok: false, result: `Stripe не создал клиента (${r?.error?.message ?? 'ошибка'}).` }
    }
    return { ok: false, result: 'unknown tool' }
  } catch (e) { return { ok: false, result: String(e).slice(0, 200) } }
}

// Dispatch a single tool call to the right executor (web / Google OAuth / keyed provider).
async function execAnyTool(
  name: string,
  args: any,
  ctx: { orKey: string; db: any; accountId: string; keyByProvider: Record<string, string> },
): Promise<{ ok: boolean; result: string; tokens?: number }> {
  if (ALWAYS_TOOLS[name]) return await execAlways(name, args, ctx.orKey)
  if (GOOGLE_TOOLS[name]) {
    const gt = await googleAccessToken(ctx.db, ctx.accountId)
    return gt.token
      ? await execGoogle(name, args, gt.token, gt.email ?? '')
      : { ok: false, result: 'Чтобы создавать Google-Таблицы и Документы или отправлять письма, подключите Google в разделе «Интеграции».' }
  }
  const provider = TOOLS[name]?.provider
  const key = provider === 'hyperbrowser' ? (ctx.keyByProvider['hyperbrowser'] || NEMO_HB_KEY) : ctx.keyByProvider[provider]
  return key
    ? await execProvider(name, args, key)
    : { ok: false, result: `Инструмент «${provider}» не подключён. Добавьте ключ в разделе «Интеграции», чтобы я мог выполнить это действие.` }
}

/**
 * Agentic tool-use loop. The model may call tools over SEVERAL steps (e.g. search the web,
 * then create a sheet, then email the link) — each tool result is fed back so it can decide
 * the next action, and it ends with a short natural-language reply. Returns { ran:true, result }
 * if any tool executed, { ran:false } if none were needed, or null if no tools are connected.
 */
export async function runAgentTools(db: any, orKey: string, accountId: string, userText: string, history?: any[], agentType?: string): Promise<{ ran: boolean; tool?: string; result?: string; tokens: number } | null> {
  const { data: keysRows } = await db.from('provider_keys').select('provider, api_key').eq('account_id', accountId)
  const keyByProvider: Record<string, string> = {}
  for (const r of keysRows ?? []) keyByProvider[r.provider] = r.api_key
  const { data: gRow } = await db.from('google_accounts').select('refresh_token').eq('account_id', accountId).maybeSingle()
  const googleConnected = Boolean(gRow?.refresh_token)
  // In an auto reply we only offer tools the account explicitly connected (a key), so the
  // bot doesn't grab the always-on browser for Google/email tasks. The browser agent stays
  // available via its own tester (browser-task) on Nemo's included key.
  // Web tools are scoped by AGENT TYPE, not by keyword — a support/sales bot must answer from
  // its own knowledge base, never from the public web. Only research-style agents may SEARCH
  // the web; any agent may READ a URL the customer explicitly pasted.
  const hasUrl = /https?:\/\//i.test(userText)
  const webAgent = ['research', 'marketplace', 'analyst', 'smm'].includes(agentType ?? '')
  const alwaysSpecs: unknown[] = []
  if (hasUrl || webAgent) alwaysSpecs.push(ALWAYS_TOOLS.read_webpage)
  if (webAgent) alwaysSpecs.push(ALWAYS_TOOLS.web_search)
  const specs = [
    ...Object.entries(TOOLS).filter(([, t]) => keyByProvider[t.provider]).map(([, t]) => t.spec),
    ...(googleConnected ? Object.values(GOOGLE_TOOLS) : []),
    ...alwaysSpecs,
  ]
  if (!specs.length) return null // nothing connected + no web scope -> normal conversational reply

  const ctx = { orKey, db, accountId, keyByProvider }
  try {
    const msgs: any[] = [
      { role: 'system', content: "You are an assistant with connected tools. If the user asks you to DO something a tool can do (create a Google Sheet/Doc, send an email, add a calendar event, append data, create a CRM contact, read a specific web page, search the live web, or browse/act on a website), CALL the correct tool with correct arguments. You may call tools over SEVERAL steps: use one tool, read its result, then call the next (e.g. search the web, then put the findings into a new sheet, then email the link). Use read_webpage to fetch a given URL; use web_search for current facts/prices you do not know; use browser_task ONLY when you must ACT on a site (fill a form, submit). Never use browser_task for Google Sheets/Docs/Gmail/Calendar (those have dedicated tools). If the needed tool is NOT in the provided tools list, do NOT call any tool. When the task is complete, reply with a SHORT natural-language message in the user's language that says what you did and includes any links. Never claim to have done something you did not do." },
      ...(history ?? []).slice(-6).map((m: any) => ({ role: m.author === 'customer' ? 'user' : 'assistant', content: String(m.content ?? '') })),
      { role: 'user', content: userText },
    ]
    const MAX_STEPS = 5
    let totalTokens = 0
    let ranAny = false
    let lastTool: string | undefined
    let lastResult = ''
    for (let step = 0; step < MAX_STEPS; step++) {
      const r = await fetch('https://openrouter.ai/api/v1/chat/completions', { method: 'POST', headers: { Authorization: `Bearer ${orKey}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ model: PRIMARY_MODEL, temperature: 0, tools: specs, tool_choice: 'auto', messages: msgs }) }).then((x) => x.json())
      const choice = r?.choices?.[0]?.message
      totalTokens += r?.usage?.total_tokens ?? 0
      const call = choice?.tool_calls?.[0]
      if (!call) {
        // model produced a plain message -> final answer (or no tool was needed at all)
        if (!ranAny) return { ran: false, tokens: totalTokens }
        const content = String(choice?.content ?? '').trim()
        return { ran: true, tool: lastTool, result: content || lastResult || 'Готово.', tokens: totalTokens }
      }
      const name = call.function?.name
      const args = (() => { try { return JSON.parse(call.function?.arguments ?? '{}') } catch { return {} } })()
      const out = await execAnyTool(name, args, ctx)
      totalTokens += out.tokens ?? 0
      ranAny = true
      lastTool = name
      lastResult = out.result
      await db.from('tool_runs').insert({ account_id: accountId, tool: name, args, result: String(out.result).slice(0, 1000), ok: out.ok })
      // feed the call + its result back so the model can chain the next action or finish
      msgs.push({ role: 'assistant', content: choice.content ?? '', tool_calls: choice.tool_calls })
      msgs.push({ role: 'tool', tool_call_id: call.id, name, content: String(out.result).slice(0, 2000) })
    }
    // step budget exhausted -> return the last real result we produced
    return ranAny ? { ran: true, tool: lastTool, result: lastResult || 'Готово.', tokens: totalTokens } : { ran: false, tokens: totalTokens }
  } catch { return { ran: false, tokens: 0 } }
}
/* eslint-enable @typescript-eslint/no-explicit-any */
