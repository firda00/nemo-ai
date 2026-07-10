import { useEffect, useState, type ReactNode } from 'react'
import { Loader2, Rocket, Send, Share2, Camera, Music2, PlayCircle, Check } from 'lucide-react'
import { supabase, isSupabaseEnabled } from '../../lib/supabase'
import { useI18n } from '../../i18n'
import { cn } from '../../lib/cn'

interface Bot { id: string }
const LANGS: { code: string; label: string }[] = [
  { code: 'uz', label: 'Oʻzbek' }, { code: 'ru', label: 'Русский' }, { code: 'en', label: 'English' },
  { code: 'kk', label: 'Qazaqşa' }, { code: 'tr', label: 'Türkçe' }, { code: 'ar', label: 'العربية' },
]
const CAP = 20

/**
 * Multi-language x multi-platform fan-out: write once, pick languages + platforms, and the
 * backend translates and queues a post per (language, target). Telegram / Facebook / Instagram
 * publish for real; TikTok / YouTube are shown but disabled until their APIs are connected.
 */
export function FanoutComposer({ onQueued }: { onQueued?: () => void }) {
  const { t } = useI18n()
  const [content, setContent] = useState('')
  const [mediaUrl, setMediaUrl] = useState('')
  const [langs, setLangs] = useState<Set<string>>(new Set(['ru']))
  const [when, setWhen] = useState('')
  const [bots, setBots] = useState<Bot[]>([])
  const [botId, setBotId] = useState('')
  const [tgChannel, setTgChannel] = useState('')
  const [tgOn, setTgOn] = useState(true)
  const [fbOn, setFbOn] = useState(false)
  const [igOn, setIgOn] = useState(false)
  const [metaOn, setMetaOn] = useState(false)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)

  useEffect(() => {
    if (!isSupabaseEnabled || !supabase) return
    ;(async () => {
      try {
        const { data: chs } = await supabase!.from('channels').select('id, type').eq('type', 'telegram')
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const list = ((chs as any[]) ?? []).map((c) => ({ id: c.id }))
        setBots(list); if (list[0]) setBotId(list[0].id)
        const { data } = await supabase!.functions.invoke('connect-social', { body: { action: 'status' } })
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        setMetaOn(Boolean((data as any)?.connected))
      } catch { /* ignore */ }
    })()
  }, [])

  const toggleLang = (c: string) => setLangs((prev) => {
    const next = new Set(prev)
    if (next.has(c)) next.delete(c)
    else next.add(c)
    return next
  })

  const targetsCount = (tgOn ? 1 : 0) + (fbOn ? 1 : 0) + (igOn ? 1 : 0)
  const langCount = Math.max(1, langs.size)
  const willPost = Math.min(CAP, langCount * targetsCount)
  const canPost = content.trim().length >= 2 && targetsCount > 0 && (!tgOn || tgChannel.trim().length > 0) && (!igOn || mediaUrl.trim().length > 0)

  const publish = async () => {
    if (!supabase || busy || !canPost) return
    setBusy(true); setMsg(null)
    try {
      const targets: Record<string, unknown>[] = []
      if (tgOn) targets.push({ platform: 'telegram', channel_id: botId || null, target_chat: tgChannel.trim() })
      if (fbOn) targets.push({ platform: 'facebook' })
      if (igOn) targets.push({ platform: 'instagram' })
      const { data } = await supabase.functions.invoke('autopost', {
        body: { action: 'fanout', content: content.trim(), media_url: mediaUrl.trim() || undefined, languages: [...langs], targets, scheduled_at: when ? new Date(when).toISOString() : '' },
      })
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const p = data as any
      if (!p?.ok) { setMsg({ ok: false, text: p?.error || t('fanout.errGeneric') }); return }
      setMsg({ ok: true, text: t('fanout.resultOk', { n: p.queued }) + (p.capped ? t('fanout.cappedNote', { cap: p.cap }) : '') })
      setContent(''); setMediaUrl(''); setWhen('')
      onQueued?.()
    } catch { setMsg({ ok: false, text: t('fanout.errGeneric') }) } finally { setBusy(false) }
  }

  const platBtn = (on: boolean, set: (v: boolean) => void, disabled: boolean, icon: ReactNode, label: string, note?: string) => (
    <button
      type="button"
      onClick={() => !disabled && set(!on)}
      disabled={disabled}
      className={cn('inline-flex items-center gap-1.5 rounded-xl border px-3 py-2 text-sm font-medium transition',
        disabled ? 'cursor-not-allowed border-ice/[0.06] text-fog' : on ? 'border-violet/60 bg-violet/10 text-text' : 'border-ice/12 text-muted hover:text-text')}
    >
      {icon} {label}{note && <span className="ml-1 text-[10px] text-fog">{note}</span>}{on && !disabled && <Check size={13} className="text-violet" />}
    </button>
  )

  return (
    <div className="card rounded-3xl border border-violet/20 bg-violet/[0.04] p-6">
      <div className="flex items-center gap-2">
        <Rocket size={18} className="text-violet" />
        <h2 className="text-lg font-bold text-text">{t('fanout.title')}</h2>
      </div>
      <p className="mt-1.5 text-[13px] leading-relaxed text-muted">{t('fanout.desc', { cap: CAP })}</p>

      <textarea value={content} onChange={(e) => setContent(e.target.value)} rows={3} placeholder={t('fanout.contentPh')} className="mt-4 w-full resize-y rounded-xl border border-white/10 bg-black/20 px-3 py-2.5 text-sm text-text outline-none placeholder:text-fog focus:border-violet/50" />
      <input value={mediaUrl} onChange={(e) => setMediaUrl(e.target.value)} placeholder={t('fanout.mediaPh')} className="mt-2 w-full rounded-xl border border-white/10 bg-black/20 px-3 py-2 text-sm text-text outline-none placeholder:text-fog focus:border-violet/50" />

      {/* languages */}
      <p className="mt-4 text-xs font-semibold uppercase tracking-wide text-muted">{t('fanout.languages')}</p>
      <div className="mt-2 flex flex-wrap gap-2">
        {LANGS.map((l) => (
          <button key={l.code} type="button" onClick={() => toggleLang(l.code)} className={cn('rounded-pill border px-3 py-1.5 text-xs font-medium transition', langs.has(l.code) ? 'border-cyan/50 bg-cyan/10 text-text' : 'border-ice/12 text-muted hover:text-text')}>
            {l.label}
          </button>
        ))}
      </div>

      {/* platforms */}
      <p className="mt-4 text-xs font-semibold uppercase tracking-wide text-muted">{t('fanout.platforms')}</p>
      <div className="mt-2 flex flex-wrap gap-2">
        {platBtn(tgOn, setTgOn, false, <Send size={14} />, 'Telegram')}
        {platBtn(fbOn, setFbOn, !metaOn, <Share2 size={14} />, 'Facebook', metaOn ? undefined : t('fanout.connect'))}
        {platBtn(igOn, setIgOn, !metaOn, <Camera size={14} />, 'Instagram', metaOn ? undefined : t('fanout.connect'))}
        {platBtn(false, () => {}, true, <Music2 size={14} />, 'TikTok', t('fanout.soon'))}
        {platBtn(false, () => {}, true, <PlayCircle size={14} />, 'YouTube', t('fanout.soon'))}
      </div>
      {!metaOn && <p className="mt-2 text-[11px] text-fog">{t('fanout.needMeta')}</p>}

      {/* telegram target */}
      {tgOn && (
        <div className="mt-3 grid gap-2 sm:grid-cols-2">
          <input value={tgChannel} onChange={(e) => setTgChannel(e.target.value)} placeholder="@my_channel" className="rounded-xl border border-white/10 bg-black/20 px-3 py-2 text-sm text-text outline-none placeholder:text-fog focus:border-violet/50" />
          {bots.length > 0 && (
            <select value={botId} onChange={(e) => setBotId(e.target.value)} className="rounded-xl border border-white/10 bg-black/20 px-3 py-2 text-sm text-text outline-none focus:border-violet/50">
              {bots.map((b, i) => <option key={b.id} value={b.id} className="bg-panel">{t('fanout.botN', { n: i + 1 })}</option>)}
            </select>
          )}
        </div>
      )}

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <input type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} className="rounded-xl border border-white/10 bg-black/20 px-3 py-2 text-sm text-text outline-none focus:border-violet/50" />
        <button onClick={publish} disabled={busy || !canPost} className="inline-flex items-center gap-2 rounded-xl bg-brand px-4 py-2 text-sm font-medium text-white transition disabled:opacity-40">
          {busy ? <Loader2 size={15} className="animate-spin" /> : <Rocket size={15} />} {t('fanout.publish')}
        </button>
        {targetsCount > 0 && <span className="text-[12px] text-muted">{t('fanout.willPost', { n: willPost, cap: CAP })}</span>}
      </div>
      {msg && <p className={cn('mt-3 rounded-lg px-3 py-2 text-xs', msg.ok ? 'bg-teal/10 text-teal' : 'bg-danger/10 text-danger')}>{msg.text}</p>}
    </div>
  )
}
