import { useState } from 'react'
import { Languages, Loader2, Sparkles, Copy, Check, Image as ImageIcon, Download, Globe2, Mic } from 'lucide-react'
import { supabase, isSupabaseEnabled } from '../../lib/supabase'
import { useI18n } from '../../i18n'
import { cn } from '../../lib/cn'

const live = isSupabaseEnabled

const LANGS: { code: string; label: string }[] = [
  { code: 'uz', label: 'Oʻzbek' }, { code: 'ru', label: 'Русский' }, { code: 'en', label: 'English' },
  { code: 'kk', label: 'Qazaq' }, { code: 'ky', label: 'Кыргыз' }, { code: 'tg', label: 'Тоҷикӣ' },
  { code: 'tr', label: 'Türkçe' }, { code: 'ar', label: 'العربية' }, { code: 'es', label: 'Español' },
  { code: 'pt', label: 'Português' }, { code: 'hi', label: 'हिन्दी' }, { code: 'id', label: 'Indonesia' },
  { code: 'zh', label: '中文' }, { code: 'fr', label: 'Français' }, { code: 'de', label: 'Deutsch' },
]
const PLATFORMS: { id: string; label: string; publish: boolean }[] = [
  { id: 'telegram', label: 'Telegram', publish: true },
  { id: 'instagram', label: 'Instagram', publish: false },
  { id: 'tiktok', label: 'TikTok', publish: false },
  { id: 'youtube', label: 'YouTube', publish: false },
  { id: 'x', label: 'X (Twitter)', publish: false },
  { id: 'reddit', label: 'Reddit', publish: false },
]
const MAX_CELLS = 30

interface Cell {
  lang: string
  platform: string
  status: 'pending' | 'running' | 'done' | 'error'
  post?: string
  image?: string | null
  imgBusy?: boolean
  imgErr?: string
  audio?: string | null
  voiceBusy?: boolean
  voiceErr?: string
}

/**
 * Multi-language content factory: one source post/script -> a localized, platform-adapted
 * post for each selected language x platform (up to 30 cells — the "30 accounts" vision).
 * Images come from content-visual; Telegram is publishable now, other platforms are
 * copy/download until their publishing integration is connected.
 */
export function MultiLangPanel({ model }: { model?: string }) {
  const { t } = useI18n()
  const [source, setSource] = useState('')
  const [goal, setGoal] = useState('')
  const [langs, setLangs] = useState<Set<string>>(new Set(['ru', 'en', 'uz']))
  const [plats, setPlats] = useState<Set<string>>(new Set(['telegram', 'instagram']))
  const [cells, setCells] = useState<Cell[]>([])
  const [running, setRunning] = useState(false)
  const [error, setError] = useState('')
  const [copied, setCopied] = useState<string>('')

  const toggle = (set: Set<string>, setter: (s: Set<string>) => void, v: string) => {
    const next = new Set(set)
    if (next.has(v)) next.delete(v)
    else next.add(v)
    setter(next)
  }
  const total = langs.size * plats.size
  const key = (c: Cell) => `${c.lang}:${c.platform}`

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const invoke = async (fn: string, b: Record<string, unknown>): Promise<any> => {
    if (!live || !supabase) return null
    const { data, error: err } = await supabase.functions.invoke(fn, { body: b })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    if (err || !(data as any)?.ok) return { ok: false, error: err?.message ?? (data as any)?.message ?? (data as any)?.error ?? t('multiLangPanel.errGeneric') }
    return data
  }

  const run = async () => {
    if (running) return
    if (source.trim().length < 10) { setError(t('multiLangPanel.errSource')); return }
    if (!langs.size || !plats.size) { setError(t('multiLangPanel.errPickLangPlatform')); return }
    if (total > MAX_CELLS) { setError(t('multiLangPanel.errTooMany', { count: total, max: MAX_CELLS })); return }
    if (!live || !supabase) { setError(t('multiLangPanel.errLiveAccount')); return }
    setError(''); setRunning(true)
    const grid: Cell[] = []
    for (const p of plats) for (const l of langs) grid.push({ lang: l, platform: p, status: 'pending' })
    setCells(grid)
    for (let i = 0; i < grid.length; i++) {
      setCells((prev) => prev.map((c, idx) => (idx === i ? { ...c, status: 'running' } : c)))
      const r = await invoke('localize', { source: source.trim(), goal: goal.trim(), lang: grid[i].lang, platform: grid[i].platform, ...(model ? { model } : {}) })
      setCells((prev) => prev.map((c, idx) => (idx === i ? { ...c, status: r?.ok ? 'done' : 'error', post: r?.ok ? r.post : (r?.error ?? t('multiLangPanel.errGeneric')) } : c)))
    }
    setRunning(false)
  }

  const platformSize: Record<string, string> = { instagram: 'portrait', tiktok: 'story', youtube: 'landscape', x: 'landscape', reddit: 'square', telegram: 'square' }
  const makeImage = async (i: number) => {
    const cell = cells[i]
    if (!cell?.post || cell.imgBusy) return
    setCells((prev) => prev.map((c, idx) => (idx === i ? { ...c, imgBusy: true, imgErr: undefined } : c)))
    const r = await invoke('content-visual', { content: cell.post, size: platformSize[cell.platform] ?? 'square' })
    setCells((prev) => prev.map((c, idx) => (idx === i ? { ...c, imgBusy: false, image: r?.ok ? (r.image || r.url || null) : null, imgErr: r?.ok ? undefined : (r?.error ?? t('multiLangPanel.errImage')) } : c)))
  }

  // Dubbing: voice the localized text on this language (ElevenLabs multilingual). Strips
  // hashtags/URLs so the voice reads the message, not the metadata. This is the audio track
  // for "same video, language changes" — the user swaps it onto their video.
  const makeVoice = async (i: number) => {
    const cell = cells[i]
    if (!cell?.post || cell.voiceBusy) return
    setCells((prev) => prev.map((c, idx) => (idx === i ? { ...c, voiceBusy: true, voiceErr: undefined } : c)))
    const clean = cell.post.replace(/#[^\s#]+/g, '').replace(/https?:\/\/\S+/g, '').replace(/\s+/g, ' ').trim().slice(0, 2500)
    const r = await invoke('generate-voice', { text: clean })
    setCells((prev) => prev.map((c, idx) => (idx === i ? { ...c, voiceBusy: false, audio: r?.ok ? r.audio : null, voiceErr: r?.ok ? undefined : (r?.error ?? t('multiLangPanel.errVoiceKey')) } : c)))
  }

  const copy = async (c: Cell) => {
    if (!c.post) return
    try { await navigator.clipboard.writeText(c.post); setCopied(key(c)); setTimeout(() => setCopied(''), 1500) } catch { /* ignore */ }
  }

  const langLabel = (code: string) => LANGS.find((l) => l.code === code)?.label ?? code
  const platLabel = (id: string) => PLATFORMS.find((p) => p.id === id)?.label ?? id
  const doneCount = cells.filter((c) => c.status === 'done').length

  return (
    <div>
      <div className="card rounded-2xl border border-violet/20 bg-violet/[0.04] p-4">
        <p className="flex items-start gap-2 text-[13px] text-muted">
          <Globe2 size={15} className="mt-0.5 shrink-0 text-violet" />
          <span>{t('multiLangPanel.introP1')}<b className="text-text">{t('multiLangPanel.introBold1')}</b>{t('multiLangPanel.introP2')}<b className="text-text">{t('multiLangPanel.introBold2')}</b>{t('multiLangPanel.introP3')}</span>
        </p>
      </div>

      <div className="card mt-4 rounded-2xl p-5">
        <label className="block">
          <span className="mb-1 block text-[11px] font-medium uppercase tracking-wide text-muted">{t('multiLangPanel.sourceLabel')}</span>
          <textarea value={source} onChange={(e) => setSource(e.target.value)} disabled={running} rows={4} placeholder={t('multiLangPanel.sourcePlaceholder')} className="glass w-full resize-none rounded-xl px-3 py-2.5 text-sm text-text outline-none placeholder:text-fog focus:border-violet/50" />
        </label>
        <label className="mt-3 block">
          <span className="mb-1 block text-[11px] font-medium uppercase tracking-wide text-muted">{t('multiLangPanel.goalLabel')} ({t('common.optional')})</span>
          <input value={goal} onChange={(e) => setGoal(e.target.value)} disabled={running} placeholder={t('multiLangPanel.goalPlaceholder')} className="glass w-full rounded-xl px-3 py-2.5 text-sm text-text outline-none placeholder:text-fog focus:border-violet/50" />
        </label>

        <div className="mt-4">
          <span className="mb-1.5 block text-[11px] font-medium uppercase tracking-wide text-muted">{t('multiLangPanel.langs', { count: langs.size })}</span>
          <div className="flex flex-wrap gap-1.5">
            {LANGS.map((l) => (
              <button key={l.code} onClick={() => toggle(langs, setLangs, l.code)} disabled={running} className={cn('rounded-full border px-2.5 py-1 text-xs transition', langs.has(l.code) ? 'border-violet/60 bg-violet/10 text-text' : 'border-ice/10 text-muted hover:text-text')}>{l.label}</button>
            ))}
          </div>
        </div>
        <div className="mt-3">
          <span className="mb-1.5 block text-[11px] font-medium uppercase tracking-wide text-muted">{t('multiLangPanel.platforms', { count: plats.size })}</span>
          <div className="flex flex-wrap gap-1.5">
            {PLATFORMS.map((p) => (
              <button key={p.id} onClick={() => toggle(plats, setPlats, p.id)} disabled={running} className={cn('inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs transition', plats.has(p.id) ? 'border-violet/60 bg-violet/10 text-text' : 'border-ice/10 text-muted hover:text-text')}>
                {p.label}{!p.publish && <span className="text-[9px] text-fog">{t('multiLangPanel.copyBadge')}</span>}
              </button>
            ))}
          </div>
        </div>

        <div className="mt-4 flex flex-wrap items-center gap-3">
          <button onClick={run} disabled={running || total === 0} className="inline-flex items-center gap-2 rounded-xl bg-brand px-4 py-2.5 text-sm font-medium text-white transition disabled:opacity-40">
            {running ? <Loader2 size={16} className="animate-spin" /> : <Sparkles size={16} />} {t('multiLangPanel.generate')}{total > 0 && ` (${total})`}
          </button>
          <span className={cn('text-[11px]', total > MAX_CELLS ? 'text-danger' : 'text-fog')}>
            {t('multiLangPanel.combo', { langs: langs.size, plats: plats.size, total })}{total > MAX_CELLS ? t('multiLangPanel.maxSuffix', { max: MAX_CELLS }) : ''}
          </span>
          {running && <span className="text-[11px] text-muted">{t('multiLangPanel.progress', { done: doneCount, total: cells.length })}</span>}
        </div>
        {error && <p className="mt-3 rounded-lg bg-danger/10 px-3 py-2 text-xs text-danger">{error}</p>}
      </div>

      {cells.length > 0 && (
        <div className="mt-5 grid gap-3 sm:grid-cols-2">
          {cells.map((c, i) => (
            <div key={key(c)} className="card flex flex-col rounded-2xl p-4">
              <div className="mb-2 flex items-center gap-2">
                <span className="inline-flex items-center gap-1 rounded-full bg-violet/10 px-2 py-0.5 text-[11px] font-medium text-violet"><Languages size={11} /> {langLabel(c.lang)}</span>
                <span className="inline-flex items-center rounded-full bg-white/5 px-2 py-0.5 text-[11px] text-muted">{platLabel(c.platform)}</span>
                {c.status === 'running' && <Loader2 size={13} className="ml-auto animate-spin text-violet" />}
                {c.status === 'done' && (
                  <div className="ml-auto flex items-center gap-1">
                    <button onClick={() => copy(c)} title={t('multiLangPanel.copyTitle')} className="rounded-lg p-1.5 text-muted transition hover:text-text">{copied === key(c) ? <Check size={13} className="text-teal" /> : <Copy size={13} />}</button>
                    <button onClick={() => makeImage(i)} disabled={c.imgBusy} title={t('multiLangPanel.imageTitle')} className="rounded-lg p-1.5 text-muted transition hover:text-text disabled:opacity-40">{c.imgBusy ? <Loader2 size={13} className="animate-spin" /> : <ImageIcon size={13} />}</button>
                    <button onClick={() => makeVoice(i)} disabled={c.voiceBusy} title={t('multiLangPanel.voiceTitle')} className="rounded-lg p-1.5 text-muted transition hover:text-text disabled:opacity-40">{c.voiceBusy ? <Loader2 size={13} className="animate-spin" /> : <Mic size={13} />}</button>
                  </div>
                )}
              </div>
              {c.status === 'running' || c.status === 'pending' ? (
                <div className="h-16 animate-pulse rounded-lg bg-white/[0.03]" />
              ) : c.status === 'error' ? (
                <p className="text-xs text-danger">{c.post}</p>
              ) : (
                <p className="whitespace-pre-wrap text-[13px] leading-relaxed text-muted">{c.post}</p>
              )}
              {c.image && (
                <div className="mt-2">
                  <img src={c.image} alt="" className="max-h-56 rounded-xl border border-ice/10" />
                  <a href={c.image} download="nemo-visual.png" className="mt-1 inline-flex items-center gap-1 text-[11px] text-violet hover:underline"><Download size={11} /> {t('multiLangPanel.download')}</a>
                </div>
              )}
              {c.imgErr && <p className="mt-2 text-[11px] text-amber">🖼 {c.imgErr}</p>}
              {c.voiceErr && <p className="mt-2 text-[11px] text-amber">🎙 {c.voiceErr}</p>}
              {c.audio && (
                <div className="mt-2">
                  <audio controls src={c.audio} className="h-9 w-full" />
                  <a href={c.audio} download={`nemo-voice-${c.lang}.mp3`} className="mt-1 inline-flex items-center gap-1 text-[11px] text-violet hover:underline"><Download size={11} /> {t('multiLangPanel.downloadVoice')}</a>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
