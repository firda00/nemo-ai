import { useEffect, useState } from 'react'
import { PlayCircle, ClipboardList, Wrench } from 'lucide-react'
import { supabase, isSupabaseEnabled } from '../../lib/supabase'
import { useI18n } from '../../i18n'
import { cn } from '../../lib/cn'

interface Item { kind: 'run' | 'task' | 'tool'; title: string; sub: string; at: number; ok?: boolean }
const ACTIVITY_REFERENCE_TIME = Date.now()

/**
 * Real recent-activity feed for the dashboard: the account's latest team runs, created tasks
 * and tool calls, merged by time. Replaces the old hard-coded demo list so the dashboard shows
 * the user's own live work (with a proper empty state).
 */
export function RecentActivity() {
  const { t } = useI18n()
  const [items, setItems] = useState<Item[]>([])
  const [loading, setLoading] = useState(isSupabaseEnabled)

  useEffect(() => {
    if (!isSupabaseEnabled || !supabase) return
    let alive = true
    ;(async () => {
      try {
        const [runs, tasks, tools] = await Promise.all([
          supabase!.from('research_runs').select('task, kind, created_at').order('created_at', { ascending: false }).limit(5),
          supabase!.from('tasks').select('title, created_at').order('created_at', { ascending: false }).limit(5),
          supabase!.from('tool_runs').select('tool, ok, created_at').order('created_at', { ascending: false }).limit(5),
        ])
        const merged: Item[] = []
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        for (const r of (runs.data ?? []) as any[]) merged.push({ kind: 'run', title: String(r.task ?? '').slice(0, 90), sub: String(r.kind ?? ''), at: Date.parse(r.created_at) })
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        for (const tk of (tasks.data ?? []) as any[]) merged.push({ kind: 'task', title: String(tk.title ?? '').slice(0, 90), sub: '', at: Date.parse(tk.created_at) })
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        for (const tl of (tools.data ?? []) as any[]) merged.push({ kind: 'tool', title: String(tl.tool ?? ''), sub: '', at: Date.parse(tl.created_at), ok: Boolean(tl.ok) })
        merged.sort((a, b) => b.at - a.at)
        if (alive) setItems(merged.filter((m) => !isNaN(m.at)).slice(0, 6))
      } catch { /* ignore */ } finally { if (alive) setLoading(false) }
    })()
    return () => { alive = false }
  }, [])

  const rel = (ms: number) => {
    const d = ACTIVITY_REFERENCE_TIME - ms
    if (d < 60_000) return t('recentActivity.justNow')
    if (d < 3_600_000) return t('recentActivity.minAgo', { n: Math.floor(d / 60_000) })
    if (d < 86_400_000) return t('recentActivity.hourAgo', { n: Math.floor(d / 3_600_000) })
    return t('recentActivity.dayAgo', { n: Math.floor(d / 86_400_000) })
  }
  const META = {
    run: { icon: PlayCircle, label: t('recentActivity.run'), cls: 'text-violet' },
    task: { icon: ClipboardList, label: t('recentActivity.task'), cls: 'text-cyan' },
    tool: { icon: Wrench, label: t('recentActivity.tool'), cls: 'text-teal' },
  }

  if (loading) return <div className="mt-5 h-24 animate-pulse rounded-2xl bg-white/[0.03]" />
  if (!items.length) return <p className="mt-5 rounded-2xl border border-dashed border-white/10 p-6 text-center text-sm text-muted">{t('recentActivity.empty')}</p>

  return (
    <div className="mt-5 space-y-3">
      {items.map((it, i) => {
        const m = META[it.kind]
        return (
          <div key={i} className="rounded-2xl border border-white/10 bg-white/[0.04] p-4">
            <div className="flex items-start justify-between gap-3">
              <div className="flex min-w-0 items-start gap-2.5">
                <m.icon size={16} className={cn('mt-0.5 shrink-0', m.cls)} />
                <div className="min-w-0">
                  <p className="truncate text-sm font-semibold text-text">{it.title || m.label}</p>
                  <p className="mt-0.5 text-xs text-muted">{m.label}{it.sub ? ` · ${it.sub}` : ''}{it.kind === 'tool' ? ` · ${it.ok ? 'ok' : 'fail'}` : ''}</p>
                </div>
              </div>
              <span className="shrink-0 text-[11px] text-muted">{rel(it.at)}</span>
            </div>
          </div>
        )
      })}
    </div>
  )
}
