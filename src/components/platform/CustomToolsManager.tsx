import { useEffect, useState } from 'react'
import { Wrench, Plus, Trash2, Loader2, Server, Globe, CheckCircle2, X } from 'lucide-react'
import { supabase, isSupabaseEnabled } from '../../lib/supabase'
import { Button } from '../ui/Button'
import { cn } from '../../lib/cn'
import { useI18n } from '../../i18n'

interface Tool {
  id: string; kind: 'http' | 'mcp'; name: string; description: string; enabled: boolean
  method?: string; url?: string; paramNames?: string[]; toolCount?: number
}
/* eslint-disable @typescript-eslint/no-explicit-any */
const inputCls = 'glass w-full rounded-xl px-3 py-2.5 text-sm text-text outline-none transition-colors placeholder:text-muted/60 focus:border-violet/50 focus:shadow-glow'

/**
 * "My tools" — the user teaches an agent a NEW skill without code: a plain HTTP endpoint
 * (URL + auth + parameters) or a whole MCP server. Enabled tools become callable inside
 * the agent's reply (see the custom-tools edge function + runAgentTools).
 */
export function CustomToolsManager() {
  const { t } = useI18n()
  const [tools, setTools] = useState<Tool[]>([])
  const [loading, setLoading] = useState(isSupabaseEnabled)
  const [mode, setMode] = useState<'none' | 'http' | 'mcp'>('none')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const [probe, setProbe] = useState<{ name: string; description: string }[] | null>(null)
  const [f, setF] = useState<Record<string, string>>({ method: 'POST', headerName: 'Authorization' })
  const set = (k: string, v: string) => setF((s) => ({ ...s, [k]: v }))
  const resetForm = () => { setF({ method: 'POST', headerName: 'Authorization' }); setProbe(null); setMsg(null) }

  const refresh = async () => {
    if (!supabase) return
    const { data } = await supabase.functions.invoke('custom-tools', { body: { action: 'list' } })
    setTools(((data as { tools?: Tool[] } | null)?.tools) ?? [])
  }
  useEffect(() => {
    if (!isSupabaseEnabled || !supabase) return // loading starts false when the backend is off
    let alive = true
    ;(async () => { try { await refresh() } catch { /* ignore */ } if (alive) setLoading(false) })()
    return () => { alive = false }
  }, [])

  const headersObj = () => (f.headerValue ? { [f.headerName || 'Authorization']: f.headerValue } : {})

  const testMcp = async () => {
    if (!supabase || busy || !(f.mcpUrl ?? '').trim()) return
    setBusy(true); setMsg(null); setProbe(null)
    try {
      const { data } = await supabase.functions.invoke('custom-tools', { body: { action: 'test_mcp', mcp_url: f.mcpUrl.trim(), mcp_headers: headersObj() } })
      const p = data as any
      if (p?.ok) { setProbe(p.tools ?? []); setMsg({ ok: true, text: t('customTools.foundTools', { count: (p.tools ?? []).length }) }) }
      else setMsg({ ok: false, text: p?.error ?? t('customTools.mcpFailed') })
    } catch { setMsg({ ok: false, text: t('customTools.mcpFailed') }) } finally { setBusy(false) }
  }

  const save = async () => {
    if (!supabase || busy || (f.name ?? '').trim().length < 2) return
    setBusy(true); setMsg(null)
    try {
      const payload: any = mode === 'http'
        ? { action: 'create', kind: 'http', name: f.name.trim(), description: f.description ?? '', method: f.method, url: (f.url ?? '').trim(), headers: headersObj(), params: (f.params ?? '').split(',').map((s) => s.trim()).filter(Boolean).map((name) => ({ name, type: 'string', required: false })), body_template: f.bodyTemplate ?? '' }
        : { action: 'create', kind: 'mcp', name: f.name.trim(), description: f.description ?? '', mcp_url: (f.mcpUrl ?? '').trim(), mcp_headers: headersObj() }
      const { data } = await supabase.functions.invoke('custom-tools', { body: payload })
      const p = data as any
      if (p?.ok) { setMode('none'); resetForm(); await refresh() }
      else setMsg({ ok: false, text: p?.error ?? t('customTools.saveFailed') })
    } catch { setMsg({ ok: false, text: t('customTools.saveFailed') }) } finally { setBusy(false) }
  }

  const del = async (id: string) => {
    if (!supabase) return
    setTools((ts) => ts.filter((x) => x.id !== id))
    await supabase.functions.invoke('custom-tools', { body: { action: 'delete', id } })
  }
  const toggle = async (tl: Tool) => {
    if (!supabase) return
    setTools((ts) => ts.map((x) => (x.id === tl.id ? { ...x, enabled: !x.enabled } : x)))
    await supabase.functions.invoke('custom-tools', { body: { action: 'toggle', id: tl.id, enabled: !tl.enabled } })
  }

  return (
    <div className="card rounded-2xl p-5">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2.5">
          <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-violet/15 text-violet"><Wrench size={17} /></span>
          <div>
            <h3 className="text-sm font-semibold text-text">{t('customTools.title')}</h3>
            <p className="text-xs text-muted">{t('customTools.subtitle')}</p>
          </div>
        </div>
        {mode === 'none' && (
          <div className="flex gap-2">
            <Button size="sm" variant="subtle" onClick={() => { resetForm(); setMode('http') }}><Globe size={14} /> {t('customTools.addHttp')}</Button>
            <Button size="sm" variant="subtle" onClick={() => { resetForm(); setMode('mcp') }}><Server size={14} /> {t('customTools.addMcp')}</Button>
          </div>
        )}
      </div>

      {/* existing tools */}
      {loading ? (
        <div className="mt-4 h-16 animate-pulse rounded-xl bg-white/[0.03]" />
      ) : tools.length > 0 ? (
        <div className="mt-4 space-y-2">
          {tools.map((tl) => (
            <div key={tl.id} className="flex items-center gap-3 rounded-xl border border-ice/10 bg-ice/[0.02] px-3 py-2.5">
              <span className={cn('rounded-md px-1.5 py-0.5 text-[10px] font-medium', tl.kind === 'mcp' ? 'bg-cyan/10 text-cyan' : 'bg-violet/10 text-violet')}>{tl.kind === 'mcp' ? 'MCP' : 'HTTP'}</span>
              <div className="min-w-0 flex-1">
                <p className="truncate text-[13px] font-medium text-text">{tl.name}{tl.kind === 'mcp' && tl.toolCount ? ` · ${t('customTools.toolsN', { count: tl.toolCount })}` : ''}</p>
                <p className="truncate text-[11px] text-muted">{tl.description || tl.url}</p>
              </div>
              <button onClick={() => toggle(tl)} className={cn('rounded-full px-2 py-0.5 text-[10px] font-medium', tl.enabled ? 'bg-teal/10 text-teal' : 'bg-white/5 text-fog')}>{tl.enabled ? t('common.enabled') : t('common.disabled')}</button>
              <button onClick={() => del(tl.id)} className="rounded-lg p-1.5 text-muted hover:bg-white/5 hover:text-danger" aria-label={t('common.close')}><Trash2 size={14} /></button>
            </div>
          ))}
        </div>
      ) : mode === 'none' ? (
        <p className="mt-4 rounded-xl border border-dashed border-ice/10 px-3 py-6 text-center text-xs text-muted">{t('customTools.empty')}</p>
      ) : null}

      {/* add form */}
      {mode !== 'none' && (
        <div className="mt-4 space-y-3 rounded-2xl border border-violet/20 bg-violet/[0.03] p-4">
          <div className="flex items-center justify-between">
            <p className="text-xs font-semibold text-text">{mode === 'http' ? t('customTools.newHttp') : t('customTools.newMcp')}</p>
            <button onClick={() => { setMode('none'); resetForm() }} className="rounded-lg p-1 text-muted hover:text-text"><X size={16} /></button>
          </div>
          <div className="grid gap-2.5 sm:grid-cols-2">
            <input className={inputCls} placeholder={t('customTools.phName')} value={f.name ?? ''} onChange={(e) => set('name', e.target.value)} />
            <input className={inputCls} placeholder={t('customTools.phDesc')} value={f.description ?? ''} onChange={(e) => set('description', e.target.value)} />
          </div>

          {mode === 'http' ? (
            <>
              <div className="flex gap-2.5">
                <select className={cn(inputCls, 'w-28 shrink-0')} value={f.method ?? 'POST'} onChange={(e) => set('method', e.target.value)}>
                  {['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].map((m) => <option key={m} value={m} className="bg-panel">{m}</option>)}
                </select>
                <input className={inputCls} placeholder="https://api.example.com/endpoint" value={f.url ?? ''} onChange={(e) => set('url', e.target.value)} />
              </div>
              <input className={inputCls} placeholder={t('customTools.phParams')} value={f.params ?? ''} onChange={(e) => set('params', e.target.value)} />
              <textarea className={cn(inputCls, 'min-h-[64px] font-mono text-[12px]')} placeholder={t('customTools.phBody')} value={f.bodyTemplate ?? ''} onChange={(e) => set('bodyTemplate', e.target.value)} />
            </>
          ) : (
            <>
              <input className={inputCls} placeholder="https://mcp.example.com/mcp" value={f.mcpUrl ?? ''} onChange={(e) => set('mcpUrl', e.target.value)} />
              {probe && (
                <div className="rounded-xl border border-teal/20 bg-teal/[0.05] p-2.5">
                  <p className="mb-1 flex items-center gap-1.5 text-[11px] text-teal"><CheckCircle2 size={12} /> {t('customTools.foundTools', { count: probe.length })}</p>
                  <div className="flex flex-wrap gap-1.5">{probe.slice(0, 12).map((x) => <span key={x.name} className="rounded-md bg-white/5 px-1.5 py-0.5 font-mono text-[10px] text-muted">{x.name}</span>)}</div>
                </div>
              )}
            </>
          )}

          <div className="grid gap-2.5 sm:grid-cols-2">
            <input className={inputCls} placeholder={t('customTools.phHeaderName')} value={f.headerName ?? ''} onChange={(e) => set('headerName', e.target.value)} />
            <input className={inputCls} type="password" placeholder={t('customTools.phHeaderValue')} value={f.headerValue ?? ''} onChange={(e) => set('headerValue', e.target.value)} />
          </div>

          {msg && <p className={cn('text-xs', msg.ok ? 'text-teal' : 'text-danger')}>{msg.text}</p>}

          <div className="flex justify-end gap-2">
            {mode === 'mcp' && <Button size="sm" variant="subtle" onClick={testMcp} disabled={busy || !(f.mcpUrl ?? '').trim()}>{busy ? <Loader2 size={14} className="animate-spin" /> : <Server size={14} />} {t('customTools.testMcp')}</Button>}
            <Button size="sm" onClick={save} disabled={busy || (f.name ?? '').trim().length < 2 || (mode === 'http' && !(f.url ?? '').trim()) || (mode === 'mcp' && !probe)}>
              {busy ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />} {t('customTools.save')}
            </Button>
          </div>
          {mode === 'mcp' && !probe && <p className="text-[11px] text-fog">{t('customTools.testFirst')}</p>}
        </div>
      )}
    </div>
  )
}
