import { useEffect, useState } from 'react'
import { Archive, ChevronDown, FileText, ImageIcon, Music2, RefreshCw } from 'lucide-react'
import { supabase, isSupabaseEnabled } from '../../lib/supabase'
import { useI18n } from '../../i18n'
import { Markdown } from '../../components/ui/Markdown'
import { modelLabel } from '../../lib/models'
import { cn } from '../../lib/cn'
import { SkeletonRow } from '../../components/ui/Skeleton'

/**
 * Library — a saved history of everything the AI created: every team run (content,
 * strategy, analysis, ops) with its full output, plus generated media. Nothing is lost.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
export default function LibraryPage() {
  const { t } = useI18n()
  const [runs, setRuns] = useState<any[]>([])
  const [media, setMedia] = useState<any[]>([])
  const [loading, setLoading] = useState(isSupabaseEnabled)
  const [tab, setTab] = useState<'runs' | 'media'>('runs')
  const [open, setOpen] = useState<string | null>(null)

  const load = async () => {
    if (!supabase) return
    setLoading(true)
    try {
      const { data } = await supabase.functions.invoke('library', { body: {} })
      const p = data as { runs?: any[]; media?: any[] } | null
      if (p) { setRuns(p.runs ?? []); setMedia(p.media ?? []) }
    } catch { /* ignore */ }
    setLoading(false)
  }
  // eslint-disable-next-line react-hooks/set-state-in-effect -- mount fetch; loading inits from isSupabaseEnabled
  useEffect(() => { if (isSupabaseEnabled && supabase) load() }, [])

  const fmt = (iso: string) => { try { return new Date(iso).toLocaleString('ru-RU', { dateStyle: 'medium', timeStyle: 'short' }) } catch { return iso } }

  return (
    <div className="container-page max-w-4xl py-8">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-violet/15 text-violet"><Archive size={20} /></span>
          <div>
            <h1 className="text-2xl font-semibold tracking-tight text-text">{t('libraryPage.title')}</h1>
            <p className="text-sm text-muted">{t('libraryPage.subtitle')}</p>
          </div>
        </div>
        <button onClick={load} className="inline-flex items-center gap-1.5 rounded-xl border border-ice/12 px-3 py-2 text-xs font-medium text-muted hover:text-text"><RefreshCw size={14} /> {t('libraryPage.refresh')}</button>
      </div>

      <div className="mt-5 flex gap-2">
        <button onClick={() => setTab('runs')} className={cn('inline-flex items-center gap-1.5 rounded-pill border px-3.5 py-1.5 text-xs font-medium transition', tab === 'runs' ? 'border-violet/60 bg-violet/10 text-text' : 'border-ice/10 text-muted hover:border-ice/25')}><FileText size={13} /> {t('libraryPage.tabRuns', { count: runs.length })}</button>
        <button onClick={() => setTab('media')} className={cn('inline-flex items-center gap-1.5 rounded-pill border px-3.5 py-1.5 text-xs font-medium transition', tab === 'media' ? 'border-violet/60 bg-violet/10 text-text' : 'border-ice/10 text-muted hover:border-ice/25')}><ImageIcon size={13} /> {t('libraryPage.tabMedia', { count: media.length })}</button>
      </div>

      {loading ? (
        <div className="mt-4 space-y-2" aria-label={t('common.loading')}>{[0, 1, 2].map((i) => <SkeletonRow key={i} />)}</div>
      ) : tab === 'runs' ? (
        <div className="mt-4 space-y-2">
          {runs.length === 0 ? (
            <div className="card rounded-3xl p-8 text-center text-sm text-muted">{t('libraryPage.emptyRuns')}</div>
          ) : runs.map((r) => (
            <div key={r.id} className="card rounded-2xl">
              <button onClick={() => setOpen(open === r.id ? null : r.id)} className="flex w-full items-center gap-3 p-4 text-left">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-text">{r.task || t('libraryPage.defaultTask')}</p>
                  <p className="mt-0.5 text-[11px] text-muted">{fmt(r.created_at)}{r.tokens ? ` ${t('libraryPage.tokensSuffix', { count: r.tokens })}` : ''}{r.model ? ` · ${modelLabel(r.model)}` : ''}</p>
                </div>
                {r.kind && <span className="shrink-0 rounded-md bg-violet/10 px-1.5 py-0.5 text-[10px] text-violet">{r.kind}</span>}
                <ChevronDown size={16} className={cn('shrink-0 text-muted transition-transform', open === r.id && 'rotate-180')} />
              </button>
              {open === r.id && <div className="border-t border-ice/[0.07] px-4 py-4"><div className="overflow-x-auto"><Markdown content={r.report || '—'} /></div></div>}
            </div>
          ))}
        </div>
      ) : (
        <div className="mt-4">
          {media.length === 0 ? (
            <div className="card rounded-3xl p-8 text-center text-sm text-muted">{t('libraryPage.emptyMedia')}</div>
          ) : (
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
              {media.map((m) => (
                <div key={m.id} className="card overflow-hidden rounded-2xl">
                  {(m.kind === 'video' || m.kind === 'avatar') && (m.url || m.data) ? (
                    <video controls src={m.url || m.data} className="aspect-square w-full bg-black object-cover" />
                  ) : m.kind === 'audio' && m.data ? (
                    <div className="flex aspect-square w-full flex-col items-center justify-center gap-2 bg-violet/[0.05] p-3">
                      <Music2 size={26} className="text-violet" />
                      <audio controls src={m.data} className="w-full" />
                    </div>
                  ) : (m.data || m.url) && m.kind === 'image' ? (
                    <img src={m.data || m.url} alt={m.prompt || ''} className="aspect-square w-full object-cover" />
                  ) : (
                    <div className="flex aspect-square w-full items-center justify-center text-fog"><ImageIcon size={28} /></div>
                  )}
                  <div className="p-2.5"><p className="truncate text-[11px] text-muted" title={m.prompt}>{m.prompt || m.kind}</p><p className="text-[10px] text-fog">{m.provider} · {fmt(m.created_at)}</p></div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
