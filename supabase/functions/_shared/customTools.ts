// User-defined tools: plain HTTP endpoints and MCP servers become callable agent tools.
// Secrets (auth headers) live server-side; the reply bots load enabled rows with the
// service-role key and turn them into function-calling specs for runAgentTools. All egress
// goes through the SSRF-guarded safeFetch so a user-supplied URL cannot hit internal hosts.
/* eslint-disable @typescript-eslint/no-explicit-any */
import { safeFetch, assertSafeUrl } from './net.ts'

export interface CustomToolRow {
  id: string
  kind: 'http' | 'mcp'
  name: string
  description: string
  method: string
  url: string
  headers: any
  params: any
  body_template: string
  mcp_url: string
  mcp_headers: any
}

const clean = (s: string) => String(s ?? '').toLowerCase().replace(/[^a-z0-9_]/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '')
export const httpFnName = (name: string) => ('ct_' + (clean(name) || 'tool')).slice(0, 60)
export const mcpFnName = (server: string, tool: string) => ('mcp_' + (clean(server) || 's') + '_' + (clean(tool) || 't')).slice(0, 60)

const objOf = (v: any): Record<string, any> => (v && typeof v === 'object' && !Array.isArray(v) ? v : {})
const arrOf = (v: any): any[] => (Array.isArray(v) ? v : [])

// Build OpenAI-style function specs + an index (fn name -> how to execute it).
export function buildCustomSpecs(rows: CustomToolRow[]): { specs: any[]; index: Record<string, { row: CustomToolRow; mcpTool?: string }> } {
  const specs: any[] = []
  const index: Record<string, { row: CustomToolRow; mcpTool?: string }> = {}
  for (const row of rows) {
    if (row.kind === 'mcp') {
      for (const t of arrOf(row.params)) {
        if (!t?.name) continue
        const fn = mcpFnName(row.name, t.name)
        const parameters = t.inputSchema && typeof t.inputSchema === 'object' ? t.inputSchema : { type: 'object', properties: {} }
        specs.push({ type: 'function', function: { name: fn, description: String(t.description ?? t.name).slice(0, 300), parameters } })
        index[fn] = { row, mcpTool: t.name }
      }
    } else {
      const props: Record<string, any> = {}
      const required: string[] = []
      for (const p of arrOf(row.params)) {
        if (!p?.name) continue
        props[p.name] = { type: p.type || 'string', description: String(p.description ?? '').slice(0, 200) }
        if (p.required) required.push(p.name)
      }
      const fn = httpFnName(row.name)
      specs.push({ type: 'function', function: { name: fn, description: String(row.description || row.name).slice(0, 300), parameters: { type: 'object', properties: props, required } } })
      index[fn] = { row }
    }
  }
  return { specs, index }
}

const interpolate = (tpl: string, args: Record<string, any>) =>
  String(tpl ?? '').replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_, k) => (k in args ? String(args[k]) : ''))

async function execHttp(row: CustomToolRow, args: Record<string, any>): Promise<{ ok: boolean; result: string }> {
  const method = String(row.method || 'POST').toUpperCase()
  let url = interpolate(row.url, args)
  const headers: Record<string, string> = { 'User-Agent': 'NemoBot/1.0' }
  for (const [k, v] of Object.entries(objOf(row.headers))) headers[k] = String(v)
  let body: string | undefined
  const hasBody = method === 'POST' || method === 'PUT' || method === 'PATCH'
  if (hasBody) {
    body = row.body_template && row.body_template.trim() ? interpolate(row.body_template, args) : JSON.stringify(args ?? {})
    if (!Object.keys(headers).some((h) => h.toLowerCase() === 'content-type')) headers['Content-Type'] = 'application/json'
  } else if (!/\{\{/.test(row.url) && args && typeof args === 'object') {
    const qs = new URLSearchParams()
    for (const [k, v] of Object.entries(args)) qs.set(k, String(v))
    const q = qs.toString()
    if (q) url += (url.includes('?') ? '&' : '?') + q
  }
  try {
    const { res, body: text } = await safeFetch(url, { method, headers, body }, { maxBytes: 200_000, timeoutMs: 15_000 })
    const snippet = String(text).replace(/\s+/g, ' ').trim().slice(0, 1500)
    return res.status < 400 ? { ok: true, result: snippet || `OK (${res.status})` } : { ok: false, result: `Инструмент вернул ${res.status}: ${snippet.slice(0, 300)}` }
  } catch (e) {
    return { ok: false, result: `Не удалось вызвать инструмент (${String(e).slice(0, 150)}).` }
  }
}

function parseRpc(ct: string, raw: string): any {
  if ((ct || '').includes('text/event-stream')) {
    const lines = raw.split(/\r?\n/).filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim())
    for (let i = lines.length - 1; i >= 0; i--) { try { return JSON.parse(lines[i]) } catch { /* keep looking */ } }
    return null
  }
  try { return JSON.parse(raw) } catch { return null }
}

async function mcpRpc(url: string, headers: Record<string, string>, payload: any): Promise<{ res: Response; json: any }> {
  const { res, body } = await safeFetch(url, { method: 'POST', headers, body: JSON.stringify(payload) }, { httpsOnly: true, maxBytes: 300_000, timeoutMs: 20_000 })
  return { res, json: parseRpc(res.headers.get('content-type') ?? '', body) }
}

// Full MCP handshake (initialize -> initialized) then one tools/call.
async function mcpCall(row: CustomToolRow, mcpTool: string, args: Record<string, any>): Promise<{ ok: boolean; result: string }> {
  try {
    const base: Record<string, string> = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }
    for (const [k, v] of Object.entries(objOf(row.mcp_headers))) base[k] = String(v)
    const init = await mcpRpc(row.mcp_url, base, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'nemo', version: '1.0' } } })
    const sid = init.res.headers.get('mcp-session-id')
    const h2 = sid ? { ...base, 'Mcp-Session-Id': sid } : base
    await safeFetch(row.mcp_url, { method: 'POST', headers: h2, body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) }, { httpsOnly: true, maxBytes: 10_000, timeoutMs: 10_000 }).catch(() => {})
    const call = await mcpRpc(row.mcp_url, h2, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: mcpTool, arguments: args ?? {} } })
    if (call.json?.error) return { ok: false, result: `MCP ошибка: ${String(call.json.error?.message ?? 'unknown').slice(0, 200)}` }
    const content = call.json?.result?.content
    const text = Array.isArray(content) ? content.map((c: any) => c?.text ?? '').filter(Boolean).join('\n').trim() : (call.json?.result ? JSON.stringify(call.json.result) : '')
    return { ok: true, result: (text || 'Готово').slice(0, 1500) }
  } catch (e) {
    return { ok: false, result: `MCP-сервер недоступен (${String(e).slice(0, 150)}).` }
  }
}

export async function execCustomTool(index: Record<string, { row: CustomToolRow; mcpTool?: string }>, name: string, args: Record<string, any>): Promise<{ ok: boolean; result: string }> {
  const entry = index[name]
  if (!entry) return { ok: false, result: 'unknown custom tool' }
  return entry.row.kind === 'mcp' && entry.mcpTool ? await mcpCall(entry.row, entry.mcpTool, args) : await execHttp(entry.row, args)
}

// Management-side probe: connect to an MCP server and return its tool list (to cache on add).
export async function probeMcp(mcpUrl: string, mcpHeaders: Record<string, string>): Promise<{ ok: boolean; tools?: any[]; error?: string }> {
  try {
    await assertSafeUrl(mcpUrl, { httpsOnly: true })
    const base: Record<string, string> = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...objOf(mcpHeaders) }
    const init = await mcpRpc(mcpUrl, base, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'nemo', version: '1.0' } } })
    const sid = init.res.headers.get('mcp-session-id')
    const h2 = sid ? { ...base, 'Mcp-Session-Id': sid } : base
    await safeFetch(mcpUrl, { method: 'POST', headers: h2, body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) }, { httpsOnly: true, maxBytes: 10_000, timeoutMs: 10_000 }).catch(() => {})
    const list = await mcpRpc(mcpUrl, h2, { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })
    const tools = list.json?.result?.tools
    if (!Array.isArray(tools)) return { ok: false, error: 'Сервер не вернул список инструментов (tools/list).' }
    const trimmed = tools.slice(0, 40)
      .map((t: any) => ({ name: String(t?.name ?? ''), description: String(t?.description ?? '').slice(0, 300), inputSchema: t?.inputSchema && typeof t.inputSchema === 'object' ? t.inputSchema : { type: 'object', properties: {} } }))
      .filter((t: any) => t.name)
    return { ok: true, tools: trimmed }
  } catch (e) {
    return { ok: false, error: String(e).slice(0, 200) }
  }
}
