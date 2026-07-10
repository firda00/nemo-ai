import { useEffect, useState } from 'react'
import { PlayCircle, Loader2, Plus, RefreshCw, Trash2, Power, Copy, Check, Bell, Send, Link2 } from 'lucide-react'
import { supabase, isSupabaseEnabled } from '../../lib/supabase'
import { useI18n } from '../../i18n'
import { cn } from '../../lib/cn'

const live = isSupabaseEnabled

const LANGS: { code: string; label: string }[] = [
  { code: 'uz', label: 'Oʻzbek' }, { code: 'ru', label: 'Русский' }, { code: 'en', label: 'English' },
  { code: 'kk', label: 'Qazaq' }, { code: 'ky', label: 'Кыргыз' }, { code: 'tg', label: 'Тоҷикӣ' },
  { code: 'tr', label: 'Türkçe' }, { code: 'ar', label: 'العربية' }, { code: 'es', label: 'Español' },
  { code: 'pt', label: 'Português' }, { code: 'hi', label: 'हिन्दी' }, { code: 'de', label: 'Deutsch' },
]
const PLATFORMS = [
  { id: 'telegram', label: 'Telegram', publish: true },
  { id: 'instagram', label: 'Instagram' }, { id: 'tiktok', label: 'TikTok' },
  { id: 'youtube', label: 'YouTube' }, { id: 'x', label: 'X (Twitter)' }, { id: 'reddit', label: 'Reddit' },
]

interface Source { id: string; url: string; title?: string; languages: string[]; platforms: string[]; auto_publish: boolean; tg_target?: string; active: boolean; last_checked_at?: string }
interface Draft { id: string; source_id: string; video_title?: string; video_url?: string; lang: string; content: string; status: string; published_to?: string; created_at: string }
interface Bot { id: string }

/**
 * Channel watch → auto-localize. Paste a YouTube channel link once; when a new video is
 * published, Nemo reads its title+description (free RSS, no API key) and writes a localized
 * post per chosen language. Telegram auto-publishes; other platforms become ready drafts.
 */
export function ChannelWatchPanel() {
  const { t } = useI18n()
  const [url, setUrl] = useState('')
  const [langs, setLangs] = useState<Set<string>>(new Set(['ru', 'en', 'uz']))
  const [plats, setPlats] = useState<Set<string>>(new Set(['telegram', 'instagram']))
  const [autoTg, setAutoTg] = useState(false)
  const [bots, setBots] = useState<Bot[]>([])
  const [botId, setBotId] = useState('')
  const [tgTarget, setTgTarget] = useState('')
  const [sources, setSources] = useState<Source[]>([])
  const [drafts, setDrafts] = useState<Draft[]>([])
  const [adding, setAdding] = useState(false)
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [copied, setCopied] = useState('')
  const [loading, setLoading] = useState(live)

  const toggle = (set: Set<string>, setter: (s: Set<string>) => void, v: string) => {
    const next = new Set(set)
    if (next.has(v)) next.delete(v)
    else next.add(v)
    setter(next)
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const invoke = async (b: Record<string, unknown>): Promise<any> => {
    if (!live || !supabase) return null
    const { data, error: err } = await supabase.functions.invoke('watch-sources', { body: b })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    if (err) return { ok: false, error: err.message ?? (data as any)?.error }
    return data
  }
  const refresh = async () => {
    const [s, d] = await Promise.all([invoke({ action: 'list' }), invoke({ action: 'drafts' })])
    if (s?.ok) setSources(s.sources); if (d?.ok) setDrafts(d.drafts)
  }
  useEffect(() => {
    if (!live || !supabase) return
    ;(async () => {
      try {
        const { data: chs } = await supabase!.from('channels').select('id, type').eq('type', 'telegram')
        setBots((chs ?? []).map((c: { id: string }) => ({ id: c.id }))); if (chs?.[0]) setBotId(chs[0].id)
      } catch { /* ignore */ }
      await refresh(); setLoading(false)
    })()
  }, [])

  const add = async () => {
    if (adding) return
    setError(''); setNotice('')
    if (!url.trim()) { setError(t('channelWatch.errUrl')); return }
    if (!langs.size) { setError(t('channelWatch.errLangs')); return }
    setAdding(true)
    const r = await invoke({
      action: 'add', url: url.trim(), languages: [...langs], platforms: [...plats],
      auto_publish: autoTg, tg_channel_id: autoTg ? botId : null, tg_target: autoTg ? tgTarget.trim() : null,
    })
    setAdding(false)
    if (!r?.ok) { setError(r?.error ?? t('channelWatch.errGeneric')); return }
    setUrl(''); setNotice(t('channelWatch.added')); await refresh()
  }
  const act = async (b: Record<string, unknown>, id: string, after?: (r: unknown) => void) => {
    setBusy(id); setError(''); setNotice('')
    const r = await invoke(b); setBusy('')
    if (r && !r.ok && r.error) { setError(r.error); return }
    after?.(r); await refresh()
  }
  const runNow = (s: Source) => act({ action: 'run_now', id: s.id }, s.id, (r) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rr = r as any
    setNotice(rr?.skipped === 'no-new' ? t('channelWatch.noNew') : rr?.drafts ? t('channelWatch.generated', { n: rr.drafts, published: rr.published ?? 0 }) : t('channelWatch.noNew'))
  })
  const copy = async (d: Draft) => { try { await navigator.clipboard.writeText(d.content); setCopied(d.id); setTimeout(() => setCopied(''), 1500) } catch { /* ignore */ } }
  const langLabel = (c: string) => LANGS.find((l) => l.code === c)?.label ?? c

  if (!live) return <p className="card rounded-2xl p-4 text-sm text-muted">{t('channelWatch.needLive')}</p>

  return (
    <div className="space-y-4">
      <div className="card rounded-2xl border border-violet/20 bg-violet/[0.04] p-4">
        <p className="flex items-start gap-2 text-[13px] text-muted">
          <Bell size={15} className="mt-0.5 shrink-0 text-violet" />
          <span>{t('channelWatch.intro1')}<b className="text-text">{t('channelWatch.introBold')}</b>{t('channelWatch.intro2')}</span>
        </p>
      </div>

      {/* add form */}
      <div className="card rounded-2xl p-5">
        <label className="block">
          <span className="mb-1 block text-[11px] font-medium uppercase tracking-wide text-muted">{t('channelWatch.urlLabel')}</span>
          <div className="flex items-center gap-2 rounded-xl border border-white/10 bg-black/20 px-3 focus-within:border-violet/50">
            <PlayCircle size={16} className="shrink-0 text-danger" />
            <input value={url} onChange={(e) => setUrl(e.target.value)} disabled={adding} placeholder={t('channelWatch.urlPh')} className="w-full bg-transparent py-2.5 text-sm text-text outline-none placeholder:text-fog" />
          </div>
        </label>

        <div className="mt-4">
          <span className="mb-1.5 block text-[11px] font-medium uppercase tracking-wide text-muted">{t('channelWatch.langs', { count: langs.size })}</span>
          <div className="flex flex-wrap gap-1.5">
            {LANGS.map((l) => (
              <button key={l.code} onClick={() => toggle(langs, setLangs, l.code)} disabled={adding} className={cn('rounded-full border px-2.5 py-1 text-xs transition', langs.has(l.code) ? 'border-violet/60 bg-violet/10 text-text' : 'border-ice/10 text-muted hover:text-text')}>{l.label}</button>
            ))}
          </div>
        </div>
        <div className="mt-3">
          <span className="mb-1.5 block text-[11px] font-medium uppercase tracking-wide text-muted">{t('channelWatch.platforms', { count: plats.size })}</span>
          <div className="flex flex-wrap gap-1.5">
            {PLATFORMS.map((p) => (
              <button key={p.id} onClick={() => toggle(plats, setPlats, p.id)} disabled={adding} className={cn('inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs transition', plats.has(p.id) ? 'border-violet/60 bg-violet/10 text-text' : 'border-ice/10 text-muted hover:text-text')}>
                {p.label}{!p.publish && <span className="text-[9px] text-fog">{t('channelWatch.copyBadge')}</span>}
              </button>
            ))}
          </div>
        </div>

        {/* telegram auto-publish */}
        <label className="mt-4 flex cursor-pointer items-center gap-2 text-[13px] text-muted">
          <input type="checkbox" checked={autoTg} onChange={(e) => setAutoTg(e.target.checked)} className="accent-violet" />
          <Send size={13} className="text-cyan" /> {t('channelWatch.autoTg')}
        </label>
        {autoTg && (
          <div className="mt-2 grid gap-2 sm:grid-cols-2">
            <input value={tgTarget} onChange={(e) => setTgTarget(e.target.value)} placeholder="@my_channel" className="rounded-xl border border-white/10 bg-black/20 px-3 py-2 text-sm text-text outline-none placeholder:text-fog focus:border-violet/50" />
            {bots.length > 0 ? (
              <select value={botId} onChange={(e) => setBotId(e.target.value)} className="rounded-xl border border-white/10 bg-black/20 px-3 py-2 text-sm text-text outline-none focus:border-violet/50">
                {bots.map((b, i) => <option key={b.id} value={b.id} className="bg-panel">{t('channelWatch.botN', { n: i + 1 })}</option>)}
              </select>
            ) : <p className="flex items-center text-[12px] text-amber">{t('channelWatch.noBot')}</p>}
          </div>
        )}

        <div className="mt-4 flex flex-wrap items-center gap-3">
          <button onClick={add} disabled={adding} className="inline-flex items-center gap-2 rounded-xl bg-brand px-4 py-2.5 text-sm font-medium text-white transition disabled:opacity-40">
            {adding ? <Loader2 size={16} className="animate-spin" /> : <Plus size={16} />} {t('channelWatch.addBtn')}
          </button>
          <span className="text-[11px] text-fog">{t('channelWatch.freq')}</span>
        </div>
        {error && <p className="mt-3 rounded-lg bg-danger/10 px-3 py-2 text-xs text-danger">{error}</p>}
        {notice && <p className="mt-3 rounded-lg bg-teal/10 px-3 py-2 text-xs text-teal">{notice}</p>}
      </div>

      {/* watched channels */}
      {loading ? (
        <div className="flex items-center gap-2 text-sm text-muted"><Loader2 size={15} className="animate-spin" /> {t('common.loading')}</div>
      ) : sources.length > 0 && (
        <div className="space-y-2">
          <p className="text-[11px] font-medium uppercase tracking-wide text-muted">{t('channelWatch.watching')}</p>
          {sources.map((s) => (
            <div key={s.id} className="card flex flex-wrap items-center gap-3 rounded-2xl p-4">
              <PlayCircle size={18} className={cn('shrink-0', s.active ? 'text-danger' : 'text-fog')} />
              <div className="min-w-0 flex-1">
                <p className="truncate text-[13.5px] font-medium text-text">{s.title || s.url}</p>
                <p className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[11px] text-fog">
                  <span>{s.languages.map(langLabel).join(', ')}</span>
                  {s.auto_publish && s.tg_target && <span className="inline-flex items-center gap-0.5 text-cyan"><Send size={10} /> {s.tg_target}</span>}
                  {!s.active && <span className="text-amber">· {t('channelWatch.paused')}</span>}
                </p>
              </div>
              <button onClick={() => runNow(s)} disabled={busy === s.id} title={t('channelWatch.checkNow')} className="rounded-lg p-2 text-muted transition hover:text-text disabled:opacity-40">{busy === s.id ? <Loader2 size={15} className="animate-spin" /> : <RefreshCw size={15} />}</button>
              <button onClick={() => act({ action: 'toggle', id: s.id }, s.id)} disabled={busy === s.id} title={t('channelWatch.toggle')} className={cn('rounded-lg p-2 transition', s.active ? 'text-teal hover:text-text' : 'text-fog hover:text-text')}><Power size={15} /></button>
              <button onClick={() => act({ action: 'remove', id: s.id }, s.id)} disabled={busy === s.id} title={t('channelWatch.remove')} className="rounded-lg p-2 text-muted transition hover:text-danger disabled:opacity-40"><Trash2 size={15} /></button>
            </div>
          ))}
        </div>
      )}

      {/* recent drafts */}
      {drafts.length > 0 && (
        <div className="space-y-2">
          <p className="text-[11px] font-medium uppercase tracking-wide text-muted">{t('channelWatch.recentDrafts')}</p>
          <div className="grid gap-3 sm:grid-cols-2">
            {drafts.map((d) => (
              <div key={d.id} className="card flex flex-col rounded-2xl p-4">
                <div className="mb-2 flex items-center gap-2">
                  <span className="inline-flex items-center rounded-full bg-violet/10 px-2 py-0.5 text-[11px] font-medium text-violet">{langLabel(d.lang)}</span>
                  {d.published_to === 'telegram' && <span className="inline-flex items-center gap-0.5 rounded-full bg-cyan/10 px-2 py-0.5 text-[10px] text-cyan"><Send size={9} /> {t('channelWatch.posted')}</span>}
                  <button onClick={() => copy(d)} className="ml-auto rounded-lg p-1.5 text-muted transition hover:text-text">{copied === d.id ? <Check size={13} className="text-teal" /> : <Copy size={13} />}</button>
                </div>
                {d.video_title && <a href={d.video_url} target="_blank" rel="noreferrer" className="mb-1 inline-flex items-center gap-1 truncate text-[11px] text-fog hover:text-violet"><Link2 size={10} /> {d.video_title}</a>}
                <p className="whitespace-pre-wrap text-[13px] leading-relaxed text-muted">{d.content}</p>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
