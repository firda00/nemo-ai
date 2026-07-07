import { useEffect, useState } from 'react'
import { Rocket, Loader2, Check, ChevronRight, Search, PenLine, Image as ImageIcon, Send, CircleDashed, X } from 'lucide-react'
import { supabase, isSupabaseEnabled } from '../../lib/supabase'
import { Markdown } from '../ui/Markdown'
import { Button } from '../ui/Button'
import { cn } from '../../lib/cn'
import { useI18n } from '../../i18n'

/**
 * Factory Autopilot — the whole content factory in ONE run. Give a brief (+ optional
 * competitor link/subtitles), press one button, and the agents do everything themselves,
 * end to end: analyze the competitor → write the content → generate the visual → optionally
 * publish to Telegram. No manual step-by-step. Progress is shown live.
 */
type Fmt = 'post' | 'reels'
type Status = 'idle' | 'running' | 'done' | 'skip' | 'error'
interface Stage { id: string; label: string; icon: typeof Search; status: Status; note?: string }
interface Bot { id: string; label: string | null; username: string | null }

const CONTENT_TEAM = [
  { role: 'writer', name: 'Стратег', task: 'выбери угол, структуру и ключевое сообщение под задачу', system: 'You are "Стратег", контент-стратег. Определи угол, структуру и ключевое сообщение. Чётко, по делу, без воды.' },
  { role: 'writer', name: 'Копирайтер', task: 'напиши заголовок, тело и призыв на языке задачи', system: 'You are "Копирайтер". Пиши живо и убедительно, конкретика, без клише.' },
  { role: 'analyst', name: 'Редактор', task: 'улучши ясность и ритм, убери штампы, проверь соответствие задаче', system: 'You are "Редактор". Требовательно улучшай текст, сохраняя смысл, не удлиняй.' },
  { role: 'analyst', name: 'SMM', task: 'подбери хэштеги и короткую идею визуала под платформу', system: 'You are "SMM". Практично, под формат и платформу.' },
]
const VIDEO_TEAM = [
  { role: 'writer', name: 'Стратег', task: 'идея и структура ролика, крючок и CTA', system: 'You are "Стратег" для видео. Думай форматом коротких видео/Reels.' },
  { role: 'writer', name: 'Сценарист', task: 'сценарий: хук (0–3 сек), сцены с таймкодами, закадровый текст, текст на экране, CTA', system: 'You are "Сценарист" видео/Reels. Динамично, по кадрам, держи внимание с первой секунды.' },
  { role: 'analyst', name: 'Редактор', task: 'проверь темп, ясность реплик и хронометраж', system: 'You are "Редактор" сценария. Требовательно, держи длину в рамках.' },
  { role: 'analyst', name: 'SMM', task: 'заголовок, описание, хэштеги и идея обложки под платформу', system: 'You are "SMM" видео. Практично, под платформу.' },
]

export function FactoryAutopilotPanel({ model }: { model?: string }) {
  const { t } = useI18n()
  const [goal, setGoal] = useState('')
  const [fmt, setFmt] = useState<Fmt>('post')
  const [competitorUrl, setCompetitorUrl] = useState('')
  const [transcript, setTranscript] = useState('')
  const [publish, setPublish] = useState(false)
  const [pubPlatform, setPubPlatform] = useState<'telegram' | 'instagram' | 'facebook'>('telegram')
  const [bots, setBots] = useState<Bot[]>([])
  const [botId, setBotId] = useState('')
  const [target, setTarget] = useState('')

  const [running, setRunning] = useState(false)
  const [stages, setStages] = useState<Stage[]>([])
  const [content, setContent] = useState('')
  const [image, setImage] = useState('')
  const [err, setErr] = useState('')

  useEffect(() => {
    if (!isSupabaseEnabled || !supabase) return
    ;(async () => {
      try {
        // credentials (bot token) and label are not client-granted columns; selecting them 403s.
        const { data } = await supabase!.from('channels').select('id, type').eq('type', 'telegram')
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const list = ((data as any[]) ?? []).map((c, i) => ({ id: c.id, label: t('factoryAutopilotPanel.telegramBot', { n: i + 1 }), username: null }))
        setBots(list); if (list[0]) setBotId(list[0].id)
      } catch { /* ignore */ }
    })()
  }, [])

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const invoke = async (fn: string, body: Record<string, unknown>): Promise<any> => {
    if (!supabase) return null
    const { data, error } = await supabase.functions.invoke(fn, { body })
    if (error) return null
    return data
  }
  const set = (id: string, status: Status, note?: string) => setStages((prev) => prev.map((s) => (s.id === id ? { ...s, status, note } : s)))

  const run = async () => {
    if (!goal.trim() || running || !supabase) return
    setRunning(true); setErr(''); setContent(''); setImage('')
    const hasCompetitor = Boolean(competitorUrl.trim() || transcript.trim())
    setStages([
      { id: 'analyze', label: t('factoryAutopilotPanel.stageAnalyze'), icon: Search, status: 'idle' },
      { id: 'write', label: t('factoryAutopilotPanel.stageWrite'), icon: PenLine, status: 'idle' },
      { id: 'visual', label: t('factoryAutopilotPanel.stageVisual'), icon: ImageIcon, status: 'idle' },
      { id: 'publish', label: t('factoryAutopilotPanel.stagePublish'), icon: Send, status: 'idle' },
    ])
    try {
      // 1) analyze competitor (optional)
      let plan = ''
      if (hasCompetitor) {
        set('analyze', 'running')
        const a = await invoke('analyze-content', { platform: 'Instagram', url: competitorUrl.trim(), transcript: transcript.trim(), goal: goal.trim() })
        if (a?.ok) { plan = String(a.plan ?? ''); set('analyze', 'done', t('factoryAutopilotPanel.noteAnalyzed')) }
        else set('analyze', 'error', a?.message || t('factoryAutopilotPanel.noteAnalyzeFailed'))
      } else set('analyze', 'skip', t('factoryAutopilotPanel.noteNoCompetitor'))

      // 2) content team writes it (autonomous chain)
      set('write', 'running')
      const brief = plan
        ? `Создай ГОТОВЫЙ к публикации контент строго по этому плану, на русском.\n\nПЛАН:\n${plan}\n\nДоп. задача: ${goal.trim()}`
        : goal.trim()
      const team = fmt === 'reels' ? VIDEO_TEAM : CONTENT_TEAM
      const steps: { role: string; task: string; output: string }[] = []
      let ctx = ''
      for (const sp of team) {
        const r = await invoke('orchestrate', { action: 'step', goal: brief, role: sp.role, task: sp.task, system: sp.system, context: ctx.slice(-4000), lang: 'ru', ...(model ? { model } : {}) })
        const out = String(r?.output ?? '')
        steps.push({ role: sp.name, task: sp.task, output: out })
        ctx += `\n[${sp.name}] ${out}`
        set('write', 'running', t('factoryAutopilotPanel.noteMemberReady', { name: sp.name }))
      }
      const synth = await invoke('orchestrate', { action: 'synth', goal: brief, steps, sources: [], lang: 'ru', ...(model ? { model } : {}) })
      const finalContent = String(synth?.result ?? '')
      if (!finalContent) { set('write', 'error', t('factoryAutopilotPanel.noteSynthFailed')); setErr(t('factoryAutopilotPanel.errNoContent')); return }
      setContent(finalContent); set('write', 'done', t('factoryAutopilotPanel.noteTeamSynth', { count: team.length }))
      // hand a Reels script to the «Видео» tab so the user can render it into a real MP4
      if (fmt === 'reels') { try { sessionStorage.setItem('nemo:lastReelsScript', finalContent) } catch { /* ignore */ } }

      // 3) AI generates the visual (and hosts it → public URL for IG/FB)
      set('visual', 'running')
      const cv = await invoke('content-visual', { content: finalContent })
      let mediaUrl = ''
      if (cv?.ok && cv.image) { setImage(String(cv.image)); mediaUrl = String(cv.url ?? ''); set('visual', 'done', t('factoryAutopilotPanel.noteImageReady')) }
      else set('visual', cv?.code === 'PLAN' || cv?.code === 'LIMIT' ? 'skip' : 'error', cv?.message || cv?.error || t('factoryAutopilotPanel.noteNoImage'))

      // 4) publish (optional) — Telegram / Instagram / Facebook
      if (publish) {
        set('publish', 'running')
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const payload: any = { action: 'send_now', platform: pubPlatform, content: finalContent }
        if (pubPlatform === 'telegram') { payload.channel_id = botId || null; payload.target_chat = target.trim() }
        else if (mediaUrl) payload.media_url = mediaUrl
        const p = await invoke('autopost', payload)
        set('publish', p?.ok ? 'done' : 'error', p?.ok ? t('factoryAutopilotPanel.notePublished') : (p?.error || t('factoryAutopilotPanel.noteNotSent')))
      } else set('publish', 'skip', t('factoryAutopilotPanel.noteDisabled'))
    } catch {
      setErr(t('factoryAutopilotPanel.errAutopilot'))
    } finally { setRunning(false) }
  }

  const dot = (s: Status) => s === 'done' ? <Check size={15} className="text-teal" /> : s === 'running' ? <Loader2 size={15} className="animate-spin text-violet" /> : s === 'error' ? <X size={15} className="text-danger" /> : s === 'skip' ? <ChevronRight size={15} className="text-fog" /> : <CircleDashed size={15} className="text-muted" />

  return (
    <>
      <div className="card flex items-start gap-2 rounded-2xl border border-violet/20 bg-violet/[0.05] p-4 text-[12.5px] leading-relaxed text-muted">
        <Rocket size={15} className="mt-0.5 shrink-0 text-violet" />
        <span>{t('factoryAutopilotPanel.heroIntro')} <b className="text-text">{t('factoryAutopilotPanel.heroSteps')}</b>{t('factoryAutopilotPanel.heroOutro')}</span>
      </div>

      <div className="card mt-4 space-y-5 rounded-3xl p-6">
        <div>
          <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted">{t('factoryAutopilotPanel.formatLabel')}</p>
          <div className="flex flex-wrap gap-2">
            {([['post', t('factoryAutopilotPanel.fmtPost')], ['reels', t('factoryAutopilotPanel.fmtReels')]] as [Fmt, string][]).map(([k, l]) => (
              <button key={k} onClick={() => setFmt(k)} className={cn('rounded-pill border px-3 py-1.5 text-xs font-medium transition', fmt === k ? 'border-violet/60 bg-violet/10 text-text' : 'border-ice/10 text-muted hover:border-ice/25')}>{l}</button>
            ))}
          </div>
        </div>
        <label className="block space-y-1.5"><span className="block text-xs font-medium uppercase tracking-wide text-muted">{t('factoryAutopilotPanel.goalLabel')}</span>
          <textarea value={goal} onChange={(e) => setGoal(e.target.value)} rows={2} placeholder={t('factoryAutopilotPanel.goalPlaceholder')} className="glass w-full resize-y rounded-xl px-3 py-2.5 text-sm text-text outline-none placeholder:text-fog focus:border-violet/50" />
        </label>
        <div className="grid gap-4 sm:grid-cols-2">
          <label className="space-y-1.5"><span className="block text-xs font-medium uppercase tracking-wide text-muted">{t('factoryAutopilotPanel.competitorUrlLabel')}</span><input value={competitorUrl} onChange={(e) => setCompetitorUrl(e.target.value)} placeholder="https://instagram.com/reel/…" className="glass w-full rounded-xl px-3 py-2 text-sm text-text outline-none placeholder:text-fog focus:border-violet/50" /></label>
          <label className="space-y-1.5"><span className="block text-xs font-medium uppercase tracking-wide text-muted">{t('factoryAutopilotPanel.transcriptLabel')}</span><input value={transcript} onChange={(e) => setTranscript(e.target.value)} placeholder={t('factoryAutopilotPanel.transcriptPlaceholder')} className="glass w-full rounded-xl px-3 py-2 text-sm text-text outline-none placeholder:text-fog focus:border-violet/50" /></label>
        </div>

        <div className="space-y-3 rounded-xl border border-ice/10 bg-black/20 p-3">
          <label className="flex items-center gap-2 text-sm text-text"><input type="checkbox" checked={publish} onChange={(e) => setPublish(e.target.checked)} className="accent-violet" /> {t('factoryAutopilotPanel.publishToggle')}</label>
          {publish && (
            <>
              <div className="flex flex-wrap gap-2">
                {([['telegram', 'Telegram'], ['instagram', 'Instagram'], ['facebook', 'Facebook']] as ['telegram' | 'instagram' | 'facebook', string][]).map(([k, l]) => (
                  <button key={k} onClick={() => setPubPlatform(k)} className={cn('rounded-pill border px-3 py-1 text-xs font-medium transition', pubPlatform === k ? 'border-violet/60 bg-violet/10 text-text' : 'border-ice/10 text-muted hover:border-ice/25')}>{l}</button>
                ))}
              </div>
              {pubPlatform === 'telegram' ? (
                bots.length ? (
                  <div className="flex flex-wrap gap-2">
                    <select value={botId} onChange={(e) => setBotId(e.target.value)} className="glass rounded-xl px-3 py-1.5 text-sm text-text outline-none focus:border-violet/50">
                      {bots.map((b) => <option key={b.id} value={b.id} className="bg-panel">{b.label || (b.username ? '@' + b.username : t('factoryAutopilotPanel.botFallback'))}</option>)}
                    </select>
                    <input value={target} onChange={(e) => setTarget(e.target.value)} placeholder={t('factoryAutopilotPanel.channelPlaceholder')} className="glass w-40 rounded-xl px-3 py-1.5 text-sm text-text outline-none placeholder:text-fog focus:border-violet/50" />
                  </div>
                ) : <span className="text-[12px] text-amber">{t('factoryAutopilotPanel.connectBotHint')}</span>
              ) : (
                <span className="text-[12px] text-muted">{t('factoryAutopilotPanel.metaPublishInfo', { platform: pubPlatform === 'instagram' ? 'Instagram' : 'Facebook' })} <b className="text-text">{t('factoryAutopilotPanel.autopostSection')}</b>.</span>
              )}
            </>
          )}
        </div>

        <Button onClick={run} disabled={running || goal.trim().length < 4}>{running ? <><Loader2 size={15} className="animate-spin" /> {t('factoryAutopilotPanel.running')}</> : <><Rocket size={15} /> {t('factoryAutopilotPanel.runBtn')}</>}</Button>
        {err && <p className="rounded-lg bg-danger/10 px-3 py-2 text-xs text-danger">{err}</p>}
      </div>

      {stages.length > 0 && (
        <div className="card mt-4 rounded-2xl p-5">
          <div className="space-y-2.5">
            {stages.map((s) => (
              <div key={s.id} className="flex items-center gap-3">
                <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-white/[0.04]">{dot(s.status)}</span>
                <s.icon size={14} className="shrink-0 text-muted" />
                <span className={cn('text-sm', s.status === 'done' ? 'text-text' : s.status === 'skip' ? 'text-fog' : 'text-muted')}>{s.label}</span>
                {s.note && <span className="text-[11px] text-fog">· {s.note}</span>}
              </div>
            ))}
          </div>
        </div>
      )}

      {content && (
        <div className="mt-4 space-y-4">
          <div className="card rounded-2xl p-6"><h3 className="mb-2 text-sm font-bold text-text">{t('factoryAutopilotPanel.readyContentTitle')}</h3><Markdown content={content} /></div>
          {image && (
            <div className="card rounded-2xl p-6">
              <h3 className="mb-2 text-sm font-bold text-text">{t('factoryAutopilotPanel.aiVisualTitle')}</h3>
              <img src={image} alt={t('factoryAutopilotPanel.visualAlt')} className="max-h-96 rounded-2xl border border-ice/10" />
              <a href={image} download="nemo-visual.png" className="mt-2 inline-block text-xs text-violet hover:underline">{t('factoryAutopilotPanel.download')}</a>
            </div>
          )}
        </div>
      )}
    </>
  )
}
