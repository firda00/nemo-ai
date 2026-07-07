import { useState, useRef } from 'react'
import { Sparkles, Users2, BarChart3, Loader2, Search, Wand2, Info, Upload } from 'lucide-react'
import { supabase, isSupabaseEnabled } from '../../lib/supabase'
import { Markdown } from '../ui/Markdown'
import { AutonomousRunner } from './AutonomousRunner'
import { Button } from '../ui/Button'
import { cn } from '../../lib/cn'
import { useI18n } from '../../i18n'

/**
 * Autonomous COMPETITOR / VIRAL analysis. Drop a profile/video link (+ its subtitles,
 * caption, metrics) and a goal — a crew runs on its own: Analyst breaks it down, a
 * Retention predictor estimates the attention curve (AI prediction), a Strategist turns
 * it into a ready plan for YOUR business. Then generate the content from that plan.
 */
const CREW = [
  { n: 'crewAnalyst', r: 'crewAnalystRole' },
  { n: 'crewRetention', r: 'crewRetentionRole' },
  { n: 'crewStrategist', r: 'crewStrategistRole' },
]
const PLATFORMS = ['Instagram', 'TikTok', 'YouTube', 'Другое']
const pill = (on: boolean) => cn('rounded-pill border px-3 py-1.5 text-xs font-medium transition', on ? 'border-violet/60 bg-violet/10 text-text' : 'border-ice/10 text-muted hover:border-ice/25')

export function ContentAnalyzePanel({ model }: { model?: string }) {
  const { t } = useI18n()
  const [platform, setPlatform] = useState('Instagram')
  const [url, setUrl] = useState('')
  const [handle, setHandle] = useState('')
  const [transcript, setTranscript] = useState('')
  const [caption, setCaption] = useState('')
  const [metrics, setMetrics] = useState('')
  const [goal, setGoal] = useState('')
  const [imageFrame, setImageFrame] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [res, setRes] = useState<{ analysis: string; retention: string; plan: string } | null>(null)
  const [makeFromPlan, setMakeFromPlan] = useState(false)
  const frameRef = useRef<HTMLInputElement>(null)

  const canRun = isSupabaseEnabled && (transcript.trim() || caption.trim() || url.trim() || handle.trim() || imageFrame.trim()) && !busy

  const run = async () => {
    if (!supabase || !canRun) return
    setBusy(true); setErr(''); setRes(null); setMakeFromPlan(false)
    try {
      const { data } = await supabase.functions.invoke('analyze-content', {
        body: { platform, url: url.trim(), handle: handle.trim(), transcript: transcript.trim(), caption: caption.trim(), metrics: metrics.trim(), goal: goal.trim(), image_url: imageFrame.trim() },
      })
      const p = data as { ok?: boolean; analysis?: string; retention?: string; plan?: string; message?: string; error?: string } | null
      if (p?.ok) setRes({ analysis: p.analysis ?? '', retention: p.retention ?? '', plan: p.plan ?? '' })
      else setErr(p?.message || p?.error || t('contentAnalyzePanel.analyzeFailed'))
    } catch { setErr(t('contentAnalyzePanel.analyzeError')) } finally { setBusy(false) }
  }

  const createBrief = res
    ? `Создай ГОТОВЫЙ контент строго по этому плану (сценарий/посты), на русском.\n\nПЛАН:\n${res.plan}`
    : ''

  return (
    <>
      <div className="card flex flex-wrap items-center gap-2 rounded-2xl px-4 py-3">
        <span className="mr-1 flex items-center gap-1.5 text-xs font-medium text-muted"><Users2 size={14} className="text-violet" /> {t('contentAnalyzePanel.crewWorkLabel')}</span>
        {CREW.map((m) => <span key={m.n} className="rounded-pill border border-ice/[0.08] bg-white/[0.03] px-2.5 py-1 text-[11px] text-text">{t(`contentAnalyzePanel.${m.n}`)} · {t(`contentAnalyzePanel.${m.r}`)}</span>)}
      </div>

      <div className="card mt-4 flex items-start gap-2 rounded-2xl border border-cyan/15 bg-cyan/[0.04] p-4 text-[12.5px] leading-relaxed text-muted">
        <BarChart3 size={15} className="mt-0.5 shrink-0 text-cyan" />
        <span>{t('contentAnalyzePanel.infoStart')}<b className="text-text">{t('contentAnalyzePanel.infoBold1')}</b>{t('contentAnalyzePanel.infoMid')}<b className="text-text">{t('contentAnalyzePanel.infoBold2')}</b>{t('contentAnalyzePanel.infoEnd')}</span>
      </div>

      <div className="card mt-4 space-y-5 rounded-3xl p-6">
        <div>
          <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted">{t('contentAnalyzePanel.platformLabel')}</p>
          <div className="flex flex-wrap gap-2">{PLATFORMS.map((p) => <button key={p} onClick={() => setPlatform(p)} className={pill(platform === p)}>{p}</button>)}</div>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <label className="space-y-1.5"><span className="block text-xs font-medium uppercase tracking-wide text-muted">{t('contentAnalyzePanel.urlLabel')}</span><input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://instagram.com/reel/…" className="glass w-full rounded-xl px-3 py-2 text-sm text-text outline-none placeholder:text-fog focus:border-violet/50" /></label>
          <label className="space-y-1.5"><span className="block text-xs font-medium uppercase tracking-wide text-muted">{t('contentAnalyzePanel.handleLabel')}</span><input value={handle} onChange={(e) => setHandle(e.target.value)} placeholder="@blogger" className="glass w-full rounded-xl px-3 py-2 text-sm text-text outline-none placeholder:text-fog focus:border-violet/50" /></label>
        </div>
        <label className="block space-y-1.5">
          <span className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-muted">{t('contentAnalyzePanel.transcriptLabel')} <Info size={12} className="text-cyan" /></span>
          <textarea value={transcript} onChange={(e) => setTranscript(e.target.value)} rows={5} placeholder={t('contentAnalyzePanel.transcriptPh')} className="glass w-full resize-y rounded-xl px-3 py-2.5 text-sm text-text outline-none placeholder:text-fog focus:border-violet/50" />
        </label>
        <div className="grid gap-4 sm:grid-cols-2">
          <label className="space-y-1.5"><span className="block text-xs font-medium uppercase tracking-wide text-muted">{t('contentAnalyzePanel.captionLabel')}</span><input value={caption} onChange={(e) => setCaption(e.target.value)} placeholder={t('contentAnalyzePanel.captionPh')} className="glass w-full rounded-xl px-3 py-2 text-sm text-text outline-none placeholder:text-fog focus:border-violet/50" /></label>
          <label className="space-y-1.5"><span className="block text-xs font-medium uppercase tracking-wide text-muted">{t('contentAnalyzePanel.metricsLabel')}</span><input value={metrics} onChange={(e) => setMetrics(e.target.value)} placeholder={t('contentAnalyzePanel.metricsPh')} className="glass w-full rounded-xl px-3 py-2 text-sm text-text outline-none placeholder:text-fog focus:border-violet/50" /></label>
        </div>
        <div className="space-y-1.5">
          <span className="block text-xs font-medium uppercase tracking-wide text-muted">{t('contentAnalyzePanel.frameLabel')}</span>
          {imageFrame.startsWith('data:') ? (
            <div className="flex items-center gap-3"><img src={imageFrame} alt={t('contentAnalyzePanel.frameAlt')} className="h-14 w-14 rounded-lg border border-ice/10 object-cover" /><span className="text-xs text-teal">{t('contentAnalyzePanel.frameLoaded')}</span><button onClick={() => setImageFrame('')} className="text-xs text-muted hover:text-danger">{t('contentAnalyzePanel.removeBtn')}</button></div>
          ) : (
            <div className="flex flex-col gap-2 sm:flex-row">
              <input value={imageFrame} onChange={(e) => setImageFrame(e.target.value)} placeholder={t('contentAnalyzePanel.framePh')} className="glass flex-1 rounded-xl px-3 py-2 text-sm text-text outline-none placeholder:text-fog focus:border-violet/50" />
              <input ref={frameRef} type="file" accept="image/*" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (!f) return; const r = new FileReader(); r.onload = () => setImageFrame(String(r.result || '')); r.readAsDataURL(f) }} />
              <Button size="sm" variant="subtle" onClick={() => frameRef.current?.click()}><Upload size={14} /> {t('contentAnalyzePanel.uploadFrameBtn')}</Button>
            </div>
          )}
        </div>
        <label className="block space-y-1.5"><span className="block text-xs font-medium uppercase tracking-wide text-muted">{t('contentAnalyzePanel.goalLabel')}</span><input value={goal} onChange={(e) => setGoal(e.target.value)} placeholder={t('contentAnalyzePanel.goalPh')} className="glass w-full rounded-xl px-3 py-2 text-sm text-text outline-none placeholder:text-fog focus:border-violet/50" /></label>

        <Button onClick={run} disabled={!canRun}>{busy ? <><Loader2 size={15} className="animate-spin" /> {t('contentAnalyzePanel.analyzing')}</> : <><Search size={15} /> {t('contentAnalyzePanel.analyzeBtn')}</>}</Button>
        {err && <p className="rounded-lg bg-danger/10 px-3 py-2 text-xs text-danger">{err}</p>}
      </div>

      {res && (
        <div className="mt-5 space-y-4">
          <div className="card rounded-2xl p-6">
            <h3 className="mb-2 flex items-center gap-2 text-sm font-bold text-text"><BarChart3 size={15} className="text-cyan" /> {t('contentAnalyzePanel.analysisTitle')}</h3>
            <Markdown content={res.analysis} />
          </div>
          <div className="card rounded-2xl border border-amber/20 bg-amber/[0.04] p-6">
            <h3 className="mb-2 flex items-center gap-2 text-sm font-bold text-text"><Sparkles size={15} className="text-amber" /> {t('contentAnalyzePanel.retentionTitle')}</h3>
            <Markdown content={res.retention} />
          </div>
          <div className="card rounded-2xl border border-violet/20 bg-violet/[0.04] p-6">
            <h3 className="mb-2 flex items-center gap-2 text-sm font-bold text-text"><Wand2 size={15} className="text-violet" /> {t('contentAnalyzePanel.planTitle')}</h3>
            <Markdown content={res.plan} />
          </div>

          {!makeFromPlan ? (
            <button onClick={() => setMakeFromPlan(true)} className="inline-flex items-center gap-2 rounded-xl bg-brand px-4 py-2 text-sm font-medium text-white transition">
              <Wand2 size={15} /> {t('contentAnalyzePanel.createContentBtn')}
            </button>
          ) : (
            <div>
              <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted">{t('contentAnalyzePanel.teamCreating')}</p>
              <AutonomousRunner key={createBrief} defaultGoal={createBrief} contextHint="Ты — контент-команда Nemo. Создай готовый к публикации контент строго по присланному плану, на русском." model={model} postActions placeholder={t('contentAnalyzePanel.runnerPlaceholder')} />
            </div>
          )}
        </div>
      )}

      {!res && !busy && (
        <div className="card mt-4 flex items-center gap-3 rounded-2xl p-5 text-sm text-muted"><Sparkles size={16} className="text-violet" /> {t('contentAnalyzePanel.emptyHint')}</div>
      )}
    </>
  )
}
