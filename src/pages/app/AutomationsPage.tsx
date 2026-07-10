import { useEffect, useState } from 'react'
import { Workflow, Loader2, Play, Trash2, Sparkles, ChevronDown, Check, X, Bot, Globe, Send, Wrench, Lock } from 'lucide-react'
import { supabase, isSupabaseEnabled } from '../../lib/supabase'
import { useI18n } from '../../i18n'
import { useAgentStore } from '../../store/useAgentStore'
import { cn } from '../../lib/cn'

/* eslint-disable @typescript-eslint/no-explicit-any */
interface Step { type: string; name?: string; instruction?: string; url?: string; method?: string; text?: string }
interface Automation { id: string; name: string; description?: string; steps: Step[]; enabled: boolean; last_run_at?: string; trigger?: string; webhook_url?: string | null }
interface LogEntry { step: string; type: string; ok: boolean; output: string }

const stepMeta: Record<string, { icon: typeof Bot; cls: string }> = {
  agent: { icon: Bot, cls: 'text-violet' }, http: { icon: Globe, cls: 'text-cyan' }, notify: { icon: Send, cls: 'text-teal' },
}

export default function AutomationsPage() {
  const { t } = useI18n()
  const isAdmin = useAgentStore((s) => s.isAdmin)
  const profileResolved = useAgentStore((s) => s.profileResolved)
  const [desc, setDesc] = useState('')
  const [gen, setGen] = useState(false)
  const [list, setList] = useState<Automation[]>([])
  const [loading, setLoading] = useState(isSupabaseEnabled)
  const [running, setRunning] = useState<string | null>(null)
  const [logs, setLogs] = useState<Record<string, LogEntry[]>>({})
  const [open, setOpen] = useState<string | null>(null)
  const [input, setInput] = useState<Record<string, string>>({})
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)

  const refresh = async () => {
    if (!supabase) return
    const { data } = await supabase.functions.invoke('automations', { body: { action: 'list' } })
    setList(((data as any)?.automations ?? []) as Automation[])
  }
  // Automations is admin-only while under construction — regular users see the "coming soon" view,
  // so no data is even loaded for them.
  useEffect(() => { if (!isSupabaseEnabled || !supabase || !isAdmin) return; (async () => { try { await refresh() } catch { /* ignore */ } setLoading(false) })() }, [isAdmin])

  const generate = async () => {
    if (!supabase || gen || desc.trim().length < 8) return
    setGen(true); setMsg(null)
    try {
      const { data } = await supabase.functions.invoke('automations', { body: { action: 'generate', description: desc.trim() } })
      const p = data as any
      if (!p?.ok) { setMsg({ ok: false, text: p?.error || t('automations.errGen') }); return }
      setDesc(''); setMsg({ ok: true, text: t('automations.created') }); await refresh()
      if (p.automation?.id) setOpen(p.automation.id)
    } catch { setMsg({ ok: false, text: t('automations.errGen') }) } finally { setGen(false) }
  }
  const run = async (id: string) => {
    if (!supabase || running) return
    setRunning(id)
    try {
      const { data } = await supabase.functions.invoke('automations', { body: { action: 'run', id, input: input[id] ?? '' } })
      const p = data as any
      if (p?.ok) { setLogs((l) => ({ ...l, [id]: p.log ?? [] })); setOpen(id) }
    } finally { setRunning(null) }
  }
  const del = async (id: string) => { if (!supabase) return; setList((l) => l.filter((x) => x.id !== id)); await supabase.functions.invoke('automations', { body: { action: 'delete', id } }) }
  const enableWebhook = async (id: string) => {
    if (!supabase) return
    const { data } = await supabase.functions.invoke('automations', { body: { action: 'webhook', id } })
    const url = (data as any)?.url
    if (url) setList((l) => l.map((x) => (x.id === id ? { ...x, trigger: 'webhook', webhook_url: url } : x)))
  }
  const copy = (s: string) => { try { navigator.clipboard.writeText(s); setMsg({ ok: true, text: t('automations.copied') }) } catch { /* ignore */ } }

  // Under construction — locked to admins. Regular users get a "coming soon" placeholder.
  if (profileResolved && !isAdmin) {
    return (
      <div className="container-page max-w-3xl py-8">
        <div className="flex items-start gap-3">
          <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-brand text-white shadow-glow"><Workflow size={20} /></span>
          <div>
            <h1 className="text-3xl font-extrabold tracking-tight text-text">{t('automations.title')}</h1>
            <p className="mt-1 max-w-2xl text-sm leading-relaxed text-muted">{t('automations.subtitle')}</p>
          </div>
        </div>
        <div className="card mt-8 flex flex-col items-center gap-3 rounded-3xl border border-violet/20 bg-violet/[0.04] px-6 py-16 text-center">
          <span className="relative flex h-16 w-16 items-center justify-center rounded-2xl bg-violet/15 text-violet">
            <Wrench size={28} /><span className="absolute -bottom-1 -right-1 flex h-6 w-6 items-center justify-center rounded-full border border-line bg-panel text-fog"><Lock size={12} /></span>
          </span>
          <h2 className="mt-2 text-xl font-semibold text-text">{t('automations.devTitle')}</h2>
          <p className="max-w-md text-sm leading-relaxed text-muted">{t('automations.devBody')}</p>
          <span className="mt-1 rounded-full border border-amber/30 bg-amber/10 px-3 py-1 text-xs font-semibold uppercase tracking-wide text-amber">{t('automations.devBadge')}</span>
        </div>
      </div>
    )
  }

  return (
    <div className="container-page max-w-4xl py-8">
      <div className="flex items-start gap-3">
        <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-brand text-white shadow-glow"><Workflow size={20} /></span>
        <div>
          <h1 className="text-3xl font-extrabold tracking-tight text-text">{t('automations.title')}</h1>
          <p className="mt-1 max-w-2xl text-sm leading-relaxed text-muted">{t('automations.subtitle')}</p>
        </div>
      </div>

      {/* AI builder */}
      <div className="card mt-6 rounded-3xl border border-violet/20 bg-violet/[0.04] p-5">
        <p className="flex items-center gap-2 text-sm font-semibold text-text"><Sparkles size={16} className="text-violet" /> {t('automations.describeTitle')}</p>
        <textarea value={desc} onChange={(e) => setDesc(e.target.value)} rows={2} placeholder={t('automations.describePh')} className="mt-3 w-full resize-y rounded-xl border border-white/10 bg-black/20 px-3 py-2.5 text-sm text-text outline-none placeholder:text-fog focus:border-violet/50" />
        <div className="mt-2 flex items-center gap-3">
          <button onClick={generate} disabled={gen || desc.trim().length < 8} className="inline-flex items-center gap-2 rounded-xl bg-brand px-4 py-2 text-sm font-medium text-white transition disabled:opacity-40">
            {gen ? <><Loader2 size={15} className="animate-spin" /> {t('automations.building')}</> : <><Sparkles size={15} /> {t('automations.build')}</>}
          </button>
          {msg && <span className={cn('text-xs', msg.ok ? 'text-teal' : 'text-danger')}>{msg.text}</span>}
        </div>
      </div>

      {/* list */}
      {loading ? (
        <div className="mt-5 h-24 animate-pulse rounded-2xl bg-white/[0.03]" />
      ) : list.length === 0 ? (
        <p className="mt-5 rounded-2xl border border-dashed border-white/10 p-8 text-center text-sm text-muted">{t('automations.empty')}</p>
      ) : (
        <div className="mt-5 space-y-3">
          {list.map((a) => (
            <div key={a.id} className="card rounded-2xl p-4">
              <div className="flex flex-wrap items-center gap-2">
                <Workflow size={16} className="text-violet" />
                <p className="text-sm font-semibold text-text">{a.name}</p>
                <span className="rounded-pill bg-white/[0.06] px-2 py-0.5 text-[10px] text-muted">{a.steps?.length ?? 0} {t('automations.steps')}</span>
                <div className="ml-auto flex items-center gap-2">
                  <button onClick={() => run(a.id)} disabled={running === a.id} className="inline-flex items-center gap-1.5 rounded-lg bg-brand px-3 py-1.5 text-xs font-medium text-white transition disabled:opacity-40">
                    {running === a.id ? <Loader2 size={13} className="animate-spin" /> : <Play size={13} />} {t('automations.run')}
                  </button>
                  <button onClick={() => setOpen(open === a.id ? null : a.id)} className="rounded-lg p-1.5 text-muted hover:text-text"><ChevronDown size={16} className={cn('transition', open === a.id && 'rotate-180')} /></button>
                  <button onClick={() => del(a.id)} className="rounded-lg p-1.5 text-muted hover:text-danger"><Trash2 size={14} /></button>
                </div>
              </div>
              {a.description && <p className="mt-1.5 text-xs text-muted">{a.description}</p>}

              {open === a.id && (
                <div className="mt-3 space-y-2 border-t border-ice/[0.06] pt-3">
                  <input value={input[a.id] ?? ''} onChange={(e) => setInput((s) => ({ ...s, [a.id]: e.target.value }))} placeholder={t('automations.inputPh')} className="w-full rounded-xl border border-white/10 bg-black/20 px-3 py-2 text-sm text-text outline-none placeholder:text-fog focus:border-violet/50" />

                  {/* webhook trigger: run this automation when an external app POSTs to the URL */}
                  <div className="rounded-xl border border-cyan/15 bg-cyan/[0.04] p-2.5">
                    {a.webhook_url ? (
                      <div className="flex items-center gap-2">
                        <Globe size={13} className="shrink-0 text-cyan" />
                        <code className="min-w-0 flex-1 truncate text-[11px] text-muted">{a.webhook_url}</code>
                        <button onClick={() => copy(a.webhook_url!)} className="shrink-0 rounded-lg border border-ice/12 px-2 py-1 text-[11px] text-muted hover:text-text">{t('automations.copy')}</button>
                      </div>
                    ) : (
                      <button onClick={() => enableWebhook(a.id)} className="inline-flex items-center gap-1.5 text-[12px] font-medium text-cyan hover:underline"><Globe size={13} /> {t('automations.enableWebhook')}</button>
                    )}
                    <p className="mt-1 text-[10.5px] text-fog">{t('automations.webhookHint')}</p>
                  </div>
                  {/* steps */}
                  {(a.steps ?? []).map((s, i) => {
                    const m = stepMeta[s.type] ?? stepMeta.agent
                    return (
                      <div key={i} className="flex items-start gap-2 rounded-lg border border-ice/[0.06] bg-white/[0.02] px-3 py-2">
                        <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded bg-white/[0.06] text-[10px] text-muted">{i + 1}</span>
                        <m.icon size={13} className={cn('mt-0.5 shrink-0', m.cls)} />
                        <div className="min-w-0">
                          <p className="text-[12px] font-medium text-text">{s.name || s.type} <span className="text-fog">· {s.type}</span></p>
                          <p className="truncate text-[11px] text-muted">{s.instruction || s.url || s.text || ''}</p>
                        </div>
                      </div>
                    )
                  })}
                  {/* run log */}
                  {logs[a.id] && (
                    <div className="mt-2 rounded-xl border border-teal/15 bg-teal/[0.04] p-3">
                      <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-teal">{t('automations.result')}</p>
                      {logs[a.id].map((e, i) => (
                        <div key={i} className="border-t border-ice/[0.05] py-1.5 first:border-0">
                          <p className="flex items-center gap-1.5 text-[11px] font-medium text-text">{e.ok ? <Check size={11} className="text-teal" /> : <X size={11} className="text-danger" />} {e.step} <span className="text-fog">· {e.type}</span></p>
                          <p className="mt-0.5 whitespace-pre-wrap text-[11px] leading-relaxed text-muted">{e.output}</p>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
