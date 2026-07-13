// Manage a customer's "My tools" — user-defined HTTP endpoints and MCP servers that become
// callable agent tools (see _shared/customTools.ts + runAgentTools). Auth headers are stored
// but NEVER returned to the client. Account-scoped via RLS (the anon client carries the user JWT).
//   POST /functions/v1/custom-tools   (Authorization: Bearer <user jwt>)
//   { action:'list' | 'create' | 'delete' | 'toggle' | 'test_mcp', ... }
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { corsPreflight, json } from '../_shared/cors.ts'
import { probeMcp } from '../_shared/customTools.ts'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!

const METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE'])
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const asObj = (v: any): Record<string, string> => (v && typeof v === 'object' && !Array.isArray(v) ? v : {})

Deno.serve(async (req) => {
  const preflight = corsPreflight(req)
  if (preflight) return preflight
  const authHeader = req.headers.get('Authorization')
  if (!authHeader) return json({ error: 'unauthorized' }, 401)
  const db = createClient(SUPABASE_URL, ANON_KEY, { global: { headers: { Authorization: authHeader } } })
  const { data: { user } } = await db.auth.getUser()
  if (!user) return json({ error: 'unauthorized' }, 401)

  const body = await req.json().catch(() => ({}))
  const action = String(body?.action ?? 'list')

  if (action === 'list') {
    // never select the secret headers columns
    const { data } = await db.from('custom_tools').select('id, kind, name, description, method, url, params, enabled, created_at').order('created_at', { ascending: false })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tools = (data ?? []).map((t: any) => ({
      id: t.id, kind: t.kind, name: t.name, description: t.description, enabled: t.enabled,
      method: t.kind === 'http' ? t.method : undefined,
      url: t.kind === 'http' ? t.url : undefined,
      paramNames: t.kind === 'http' && Array.isArray(t.params) ? t.params.map((p: { name?: string }) => p?.name).filter(Boolean) : undefined,
      toolCount: t.kind === 'mcp' && Array.isArray(t.params) ? t.params.length : undefined,
    }))
    return json({ ok: true, tools })
  }

  if (action === 'delete') {
    const id = String(body?.id ?? '')
    if (id) await db.from('custom_tools').delete().eq('id', id)
    return json({ ok: true })
  }

  if (action === 'toggle') {
    const id = String(body?.id ?? '')
    if (id) await db.from('custom_tools').update({ enabled: Boolean(body?.enabled) }).eq('id', id)
    return json({ ok: true })
  }

  if (action === 'test_mcp') {
    const probe = await probeMcp(String(body?.mcp_url ?? ''), asObj(body?.mcp_headers))
    return json(probe.ok
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ? { ok: true, tools: (probe.tools ?? []).map((t: any) => ({ name: t.name, description: t.description })) }
      : { ok: false, error: probe.error })
  }

  if (action === 'create') {
    const kind = body?.kind === 'mcp' ? 'mcp' : 'http'
    const name = String(body?.name ?? '').trim().slice(0, 60)
    const description = String(body?.description ?? '').trim().slice(0, 500)
    if (name.length < 2) return json({ ok: false, error: 'Название слишком короткое.' }, 200)

    if (kind === 'http') {
      const method = METHODS.has(String(body?.method)) ? String(body.method) : 'POST'
      const url = String(body?.url ?? '').trim()
      if (!/^https?:\/\//i.test(url)) return json({ ok: false, error: 'Укажите полный URL (https://…).' }, 200)
      const headers = asObj(body?.headers)
      const params = Array.isArray(body?.params) ? body.params.slice(0, 20) : []
      const body_template = String(body?.body_template ?? '').slice(0, 4000)
      const { error } = await db.from('custom_tools').insert({ kind, name, description, method, url, headers, params, body_template })
      return json(error ? { ok: false, error: error.message } : { ok: true })
    }

    // MCP: connect, discover tools, cache them on the row
    const mcp_url = String(body?.mcp_url ?? '').trim()
    const mcp_headers = asObj(body?.mcp_headers)
    const probe = await probeMcp(mcp_url, mcp_headers)
    if (!probe.ok) return json({ ok: false, error: probe.error ?? 'Не удалось подключиться к MCP-серверу.' }, 200)
    const { error } = await db.from('custom_tools').insert({ kind, name, description, mcp_url, mcp_headers, params: probe.tools })
    return json(error ? { ok: false, error: error.message } : { ok: true, toolCount: probe.tools?.length ?? 0 })
  }

  return json({ error: 'unknown action' }, 400)
})
