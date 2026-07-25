import { useState } from 'react'
import { Clapperboard, Loader2, Wand2, Film, Image as ImageIcon, Download, X, Check, Mic } from 'lucide-react'
import { supabase } from '../../lib/supabase'
import { useI18n } from '../../i18n'
import { Button } from '../ui/Button'

/**
 * Video render — turns a short-video script into a real 1080×1920 MP4. The scriptwriter
 * agent breaks the idea into on-screen scenes; optionally the media engine draws an image
 * per scene; then the VPS render worker (Remotion) assembles captions + Ken-Burns + fades
 * into a downloadable reel. Included in the subscription (fair-use gated server-side).
 */
type Scene = { caption: string; durationSec: number; imageUrl?: string }
type Phase = 'idle' | 'scenes' | 'images' | 'render' | 'done' | 'error'
// 'auto' lets the SERVER pick the plan-aware default (1080p on Pro+, 720p below)
// so a Starter user never hits a plan rejection without explicitly asking for hi-res
type Quality = 'auto' | '720p' | '1080p' | '4k'

// display only — the server maps the enum to dimensions and enforces the plan
const QUALITY_DIMS: Record<Quality, string> = { auto: '', '720p': '720×1280', '1080p': '1080×1920', '4k': '2160×3840' }
const HI_RES: Quality[] = ['1080p', '4k']

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function invoke(fn: string, body: Record<string, unknown>): Promise<any> {
  if (!supabase) return null
  const { data, error } = await supabase.functions.invoke(fn, { body })
  if (error) return null
  return data
}

function parseScenes(text: string): Scene[] {
  try {
    const s = text.indexOf('['); const e = text.lastIndexOf(']')
    if (s === -1 || e === -1) return []
    const arr = JSON.parse(text.slice(s, e + 1))
    if (!Array.isArray(arr)) return []
    return arr
      .map((r) => ({ caption: String(r?.caption ?? '').slice(0, 140), durationSec: Math.min(6, Math.max(1.5, Number(r?.durationSec) || 3)) }))
      .filter((r) => r.caption)
      .slice(0, 6)
  } catch { return [] }
}

export function VideoRenderPanel({ model, initialScript = '' }: { model?: string; initialScript?: string }) {
  const { lang, t } = useI18n()
  const [title, setTitle] = useState('')
  const [brand, setBrand] = useState('')
  // pick up a Reels script produced by the Autopilot tab, if the user came from there
  const [script, setScript] = useState(() => initialScript || (typeof sessionStorage !== 'undefined' ? sessionStorage.getItem('nemo:lastReelsScript') || '' : ''))
  // Natural-first defaults: synthetic images and voices are opt-in because they can make
  // short videos feel obviously AI-generated. The renderer still creates a polished
  // caption-led video with an editorial gradient when both options are off.
  const [genImages, setGenImages] = useState(false)
  const [voice, setVoice] = useState(false)
  const [quality, setQuality] = useState<Quality>('auto')
  const [scenes, setScenes] = useState<Scene[]>([])
  const [phase, setPhase] = useState<Phase>('idle')
  const [note, setNote] = useState('')
  const [videoUrl, setVideoUrl] = useState('')
  const [err, setErr] = useState('')

  const busy = phase === 'scenes' || phase === 'images' || phase === 'render'

  const applyNemoPilot = () => {
    const pilot = lang === 'ru'
      ? ['Опишите задачу Nemo', 'AI-команда выполнит и проверит работу', 'Подключите сервис только когда он понадобится']
      : lang === 'uz'
        ? ['Nemo uchun vazifani yozing', 'AI jamoa ishni bajaradi va tekshiradi', 'Xizmatni faqat kerak bo\u2018lganda ulang']
        : ['Describe the task to Nemo', 'The AI team executes and reviews the work', 'Connect a service only when the task needs it']
    setTitle('Nemo AI')
    setBrand('Nemo AI')
    setScript(pilot.join('. '))
    setScenes(pilot.map((caption) => ({ caption, durationSec: 2.5 })))
    setPhase('idle')
    setErr('')
    setNote(lang === 'ru' ? 'Короткий пилот готов: 3 сцены, около 7 секунд.' : lang === 'uz' ? 'Qisqa pilot tayyor: 3 sahna, taxminan 7 soniya.' : 'Short pilot ready: 3 scenes, about 7 seconds.')
  }

  const breakScenes = async () => {
    if (!script.trim() || busy) return
    setPhase('scenes'); setErr(''); setVideoUrl(''); setNote(t('videoRenderPanel.storyboarding'))
    const r = await invoke('orchestrate', {
      action: 'step', goal: script.trim(), role: 'writer',
      task: 'Разбей сценарий короткого вертикального видео (Reels/Shorts) на 3–6 кадров.',
      system: 'Ты вирусный сценарист коротких видео. Верни СТРОГО JSON-массив кадров без пояснений: [{"caption": "короткая ёмкая фраза на экран, до 90 символов", "durationSec": 2-4}]. Первый кадр — сильный хук. Каждый кадр двигает историю. Язык — как в сценарии.',
      lang: 'ru', ...(model ? { model } : {}),
    })
    const parsed = parseScenes(String(r?.output ?? ''))
    if (!parsed.length) { setPhase('error'); setErr(t('videoRenderPanel.storyboardErr')); return }
    setScenes(parsed); setPhase('idle'); setNote(t('videoRenderPanel.scenesReady', { count: parsed.length }))
  }

  const editScene = (i: number, caption: string) => setScenes((p) => p.map((s, idx) => (idx === i ? { ...s, caption } : s)))
  const removeScene = (i: number) => setScenes((p) => p.filter((_, idx) => idx !== i))

  const render = async () => {
    if (!scenes.length || busy) return
    setErr(''); setVideoUrl('')
    const finalScenes: Scene[] = scenes.map((s) => ({ ...s }))

    // optional: draw an image per scene via the media engine (public URL for the renderer)
    if (genImages) {
      setPhase('images')
      for (let i = 0; i < finalScenes.length; i++) {
        setNote(t('videoRenderPanel.drawingImage', { n: i + 1, total: finalScenes.length }))
        const cv = await invoke('content-visual', { content: `${title ? title + '. ' : ''}${finalScenes[i].caption}` })
        if (cv?.ok && cv.url) finalScenes[i].imageUrl = String(cv.url)
        else if (cv?.code === 'PLAN' || cv?.code === 'LIMIT') { setNote(t('videoRenderPanel.imgLimit')); break }
      }
    }

    setPhase('render'); setNote(t('videoRenderPanel.renderingServer'))
    // narration script → the server synthesizes a voiceover (ElevenLabs) and mixes it in
    const narration = voice ? (script.trim() || finalScenes.map((s) => s.caption).join('. ')) : ''
    const started = await invoke('render-video', { action: 'render', quality: quality === 'auto' ? undefined : quality, voiceText: narration || undefined, props: { title: title.trim() || undefined, brand: brand.trim() || undefined, accent: '#8B7CF8', scenes: finalScenes } })
    if (!started?.ok || !started.job_id) {
      // PLAN_HIRES = the selected resolution needs Pro+; the server message says so explicitly
      setPhase('error'); setErr(started?.message || started?.error || t('videoRenderPanel.renderStartErr')); return
    }
    if (started.voiceRequested && !started.voiced) setNote(t('videoRenderPanel.voiceNoKey'))
    // poll status — 4K renders get a longer budget than the worker's 300s timeout
    const jobId = started.job_id
    const maxPolls = quality === '4k' ? 95 : 60
    for (let i = 0; i < maxPolls; i++) {
      await new Promise((r) => setTimeout(r, 4000))
      const st = await invoke('render-video', { action: 'status', job_id: jobId })
      if (st?.status === 'done' && st.url) { setVideoUrl(String(st.url)); setPhase('done'); setNote(t('videoRenderPanel.done')); return }
      if (st?.status === 'error') { setPhase('error'); setErr(st.error || t('videoRenderPanel.renderFailed')); return }
      setNote(t('videoRenderPanel.rendering', { sec: i * 4 }))
    }
    setPhase('error'); setErr(t('videoRenderPanel.renderTimeout'))
  }

  return (
    <>
      <div className="card flex items-start gap-2 rounded-2xl border border-violet/20 bg-violet/[0.05] p-4 text-[12.5px] leading-relaxed text-muted">
        <Film size={15} className="mt-0.5 shrink-0 text-violet" />
        <span>{t('videoRenderPanel.introA')} <b className="text-text">{quality === 'auto' ? t('videoRenderPanel.qualityAuto') : QUALITY_DIMS[quality]}</b> {t('videoRenderPanel.introB')}</span>
      </div>

      <div className="card mt-4 space-y-5 rounded-3xl p-6">
        <div className="grid gap-4 sm:grid-cols-2">
          <label className="space-y-1.5"><span className="block text-xs font-medium uppercase tracking-wide text-muted">{t('videoRenderPanel.titleLabel')}</span><input value={title} onChange={(e) => setTitle(e.target.value)} placeholder={t('videoRenderPanel.titlePh')} className="glass w-full rounded-xl px-3 py-2 text-sm text-text outline-none placeholder:text-fog focus:border-violet/50" /></label>
          <label className="space-y-1.5"><span className="block text-xs font-medium uppercase tracking-wide text-muted">{t('videoRenderPanel.brandLabel')}</span><input value={brand} onChange={(e) => setBrand(e.target.value)} placeholder={t('videoRenderPanel.brandPh')} className="glass w-full rounded-xl px-3 py-2 text-sm text-text outline-none placeholder:text-fog focus:border-violet/50" /></label>
        </div>
        <label className="block space-y-1.5"><span className="block text-xs font-medium uppercase tracking-wide text-muted">{t('videoRenderPanel.scriptLabel')}</span>
          <textarea value={script} onChange={(e) => setScript(e.target.value)} rows={4} placeholder={t('videoRenderPanel.scriptPh')} className="glass w-full resize-y rounded-xl px-3 py-2.5 text-sm text-text outline-none placeholder:text-fog focus:border-violet/50" />
        </label>
        <div className="flex flex-wrap items-center gap-3">
          <Button variant="outline" onClick={applyNemoPilot} disabled={busy}><Clapperboard size={15} /> Nemo Pilot · 7 sec</Button>
          <Button variant="secondary" onClick={breakScenes} disabled={busy || script.trim().length < 8}>{phase === 'scenes' ? <><Loader2 size={15} className="animate-spin" /> {t('videoRenderPanel.breakingBtn')}</> : <><Wand2 size={15} /> {t('videoRenderPanel.breakBtn')}</>}</Button>
          <label className="flex items-center gap-2 text-sm text-muted"><input type="checkbox" checked={genImages} onChange={(e) => setGenImages(e.target.checked)} className="accent-violet" /><ImageIcon size={14} /> {t('videoRenderPanel.imgPerScene')}</label>
          <label className="flex items-center gap-2 text-sm text-muted"><input type="checkbox" checked={voice} onChange={(e) => setVoice(e.target.checked)} className="accent-violet" /><Mic size={14} /> {t('videoRenderPanel.voiceover')}</label>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs font-medium uppercase tracking-wide text-muted">{t('videoRenderPanel.qualityLabel')}</span>
          {(Object.keys(QUALITY_DIMS) as Quality[]).map((q) => (
            <button
              key={q}
              onClick={() => setQuality(q)}
              disabled={busy}
              className={`rounded-xl border px-3 py-1.5 text-xs font-semibold transition ${quality === q ? 'border-violet/60 bg-violet/15 text-text' : 'border-ice/10 text-muted hover:border-violet/30'}`}
            >
              {q === 'auto' ? t('videoRenderPanel.qualityAuto') : q === '4k' ? '4K' : q}{HI_RES.includes(q) ? ' 💎' : ''}
            </button>
          ))}
          <span className="text-[11px] text-fog">{t('videoRenderPanel.qualityProNote')}</span>
        </div>
        <p className="rounded-xl border border-teal/15 bg-teal/[0.05] px-3 py-2 text-xs leading-relaxed text-muted">
          {lang === 'ru' ? 'Естественный режим включён: видео собирается из ваших кадров и текста. AI-картинки и AI-озвучка добавляются только вручную.' : lang === 'uz' ? 'Tabiiy rejim yoqilgan: video sizning kadrlaringiz va matningizdan yig‘iladi. AI rasmlari va ovozi faqat qo‘lda yoqiladi.' : 'Natural mode is on: the video uses your footage and captions. AI visuals and voice are opt-in.'}
        </p>
      </div>

      {scenes.length > 0 && (
        <div className="card mt-4 space-y-3 rounded-2xl p-5">
          <h3 className="text-sm font-bold text-text">{t('videoRenderPanel.scenesHeading', { count: scenes.length })}</h3>
          {scenes.map((s, i) => (
            <div key={i} className="flex items-start gap-2">
              <span className="mt-2 flex h-6 w-6 shrink-0 items-center justify-center rounded-lg bg-violet/15 text-[11px] font-bold text-violet">{i + 1}</span>
              <div className="min-w-0 flex-1 space-y-2">
                <input value={s.caption} onChange={(e) => editScene(i, e.target.value)} className="glass w-full rounded-xl px-3 py-2 text-sm text-text outline-none focus:border-violet/50" />
                <input value={s.imageUrl ?? ''} onChange={(e) => setScenes((p) => p.map((scene, idx) => idx === i ? { ...scene, imageUrl: e.target.value.trim() || undefined } : scene))} placeholder={lang === 'ru' ? 'Своя фотография: публичная ссылка (необязательно)' : lang === 'uz' ? 'O‘z suratingiz: public havola (ixtiyoriy)' : 'Your photo: public URL (optional)'} className="glass w-full rounded-xl px-3 py-1.5 text-[11px] text-text outline-none placeholder:text-fog focus:border-violet/50" />
              </div>
              <span className="mt-2 text-[11px] text-fog">{s.durationSec}{t('videoRenderPanel.secShort')}</span>
              <button onClick={() => removeScene(i)} className="mt-1.5 text-fog hover:text-danger"><X size={15} /></button>
            </div>
          ))}
          <Button onClick={render} disabled={busy}>{phase === 'images' || phase === 'render' ? <><Loader2 size={15} className="animate-spin" /> {note}</> : <><Clapperboard size={15} /> {t('videoRenderPanel.assembleBtn')}</>}</Button>
        </div>
      )}

      {(busy || note) && phase !== 'done' && (
        <div className="card mt-4 flex items-center gap-3 rounded-2xl p-4 text-sm text-muted">
          {busy ? <Loader2 size={15} className="animate-spin text-violet" /> : <Check size={15} className="text-teal" />}<span>{note}</span>
        </div>
      )}
      {err && <p className="mt-4 rounded-lg bg-danger/10 px-3 py-2 text-xs text-danger">{err}</p>}

      {videoUrl && (
        <div className="card mt-4 rounded-2xl p-6">
          <h3 className="mb-3 flex items-center gap-2 text-sm font-bold text-text"><Check size={15} className="text-teal" /> {t('videoRenderPanel.videoReady')}</h3>
          <video src={videoUrl} controls className="mx-auto max-h-[70vh] rounded-2xl border border-ice/10" />
          <a href={videoUrl} download="nemo-reel.mp4" className="mt-3 inline-flex items-center gap-1.5 text-xs text-violet hover:underline"><Download size={13} /> {t('videoRenderPanel.downloadMp4')}</a>
        </div>
      )}
    </>
  )
}
