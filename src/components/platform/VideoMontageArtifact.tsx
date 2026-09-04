import { useEffect, useRef, useState } from 'react'
import { CheckCircle2, Download, Film, Loader2, Subtitles, WandSparkles } from 'lucide-react'
import { isSupabaseEnabled, supabase } from '../../lib/supabase'

type Phase = 'idle' | 'uploading' | 'transcribing' | 'rendering' | 'done' | 'error'

const durationOf = (file: File) => new Promise<number>((resolve) => {
  const video = document.createElement('video')
  const url = URL.createObjectURL(file)
  video.preload = 'metadata'
  video.onloadedmetadata = () => { const value = Number(video.duration) || 0; URL.revokeObjectURL(url); resolve(value) }
  video.onerror = () => { URL.revokeObjectURL(url); resolve(0) }
  video.src = url
})

const phaseLabel: Record<Phase, string> = {
  idle: 'Готов к монтажу', uploading: 'Загружаю исходник…', transcribing: 'Распознаю речь и готовлю субтитры…',
  rendering: 'Монтирую видео, звук и motion-графику…', done: 'Видео готово', error: 'Монтаж не завершён',
}

export function VideoMontageArtifact({ file, prompt }: { file?: File; prompt: string }) {
  const [phase, setPhase] = useState<Phase>('idle')
  const [progress, setProgress] = useState(0)
  const [url, setUrl] = useState('')
  const [error, setError] = useState('')
  const started = useRef(false)

  useEffect(() => {
    if (!file || started.current) return
    started.current = true
    let cancelled = false
    let uploadedPath = ''
    const run = async () => {
      if (!isSupabaseEnabled || !supabase) throw new Error('Nemo Cloud не подключён.')
      if (file.type !== 'video/mp4' && !/\.mp4$/i.test(file.name)) throw new Error('Для первого контура монтажа нужен файл MP4.')
      const duration = await durationOf(file)
      if (duration > 120.5) throw new Error('Сейчас монтаж одного ролика поддерживает видео до 2 минут.')
      const { data: auth } = await supabase.auth.getUser()
      if (!auth.user) throw new Error('Войдите в аккаунт, чтобы смонтировать видео.')
      uploadedPath = `${auth.user.id}/audio/edit-${crypto.randomUUID()}.mp4`
      setPhase('uploading'); setProgress(12)
      const { error: uploadError } = await supabase.storage.from('private-audio').upload(uploadedPath, file, { contentType: 'video/mp4', upsert: false })
      if (uploadError) throw new Error(`Не удалось загрузить видео: ${uploadError.message}`)
      if (cancelled) return

      setPhase('transcribing'); setProgress(34)
      let transcript = ''
      const transcribed = await supabase.functions.invoke('transcribe-file', {
        body: { storage_path: uploadedPath, format: 'video/mp4', duration_seconds: duration, keep_source: true },
      })
      if (!transcribed.error && transcribed.data?.ok) transcript = String(transcribed.data.transcript ?? '').trim()
      // A silent video is still editable. Subtitles are skipped instead of blocking the render.
      if (cancelled) return

      setPhase('rendering'); setProgress(56)
      const created = await supabase.functions.invoke('render-video', {
        body: { action: 'edit', storage_path: uploadedPath, transcript, title: prompt, duration_seconds: duration, ratio: '9:16' },
      })
      if (created.error || !created.data?.ok || !created.data?.job_id) throw new Error(created.data?.message || created.data?.error || 'Не удалось запустить монтаж.')
      const jobId = String(created.data.job_id)
      for (let attempt = 0; attempt < 80 && !cancelled; attempt++) {
        await new Promise((resolve) => window.setTimeout(resolve, 2500))
        const checked = await supabase.functions.invoke('render-video', { body: { action: 'edit_status', job_id: jobId } })
        if (checked.error) continue
        if (checked.data?.status === 'done' && checked.data?.url) {
          setUrl(String(checked.data.url)); setProgress(100); setPhase('done'); return
        }
        if (checked.data?.status === 'error') throw new Error(checked.data?.error || 'Видео-движок не смог завершить монтаж.')
        setProgress(Math.min(94, 58 + attempt))
      }
      if (!cancelled) throw new Error('Монтаж занимает больше обычного. Попробуйте ещё раз через минуту.')
    }
    run().catch((reason) => {
      if (!cancelled) { setError(reason instanceof Error ? reason.message : 'Ошибка монтажа'); setPhase('error') }
    })
    return () => { cancelled = true }
  }, [file, prompt])

  if (!file) return <p className="rounded-xl border border-amber/20 bg-amber/[0.06] p-4 text-xs text-amber">Прикрепите MP4-видео, которое нужно смонтировать.</p>

  return <div className="space-y-4">
    <div className="overflow-hidden rounded-2xl border border-accent-cyan/15 bg-gradient-to-br from-accent-cyan/[0.07] via-transparent to-violet/[0.08] p-4">
      <div className="flex items-center gap-3">
        <span className="flex h-11 w-11 items-center justify-center rounded-2xl bg-flow-gradient text-white"><Film size={20} /></span>
        <div className="min-w-0 flex-1"><p className="truncate text-sm font-bold text-text">{file.name}</p><p className="mt-0.5 text-[11px] text-muted">Базовый монтаж · субтитры · motion-заставка · нормализация звука</p></div>
        {phase === 'done' ? <CheckCircle2 size={20} className="text-teal" /> : phase !== 'error' && <Loader2 size={20} className="animate-spin text-accent-cyan" />}
      </div>
      <div className="mt-4 h-1.5 overflow-hidden rounded-full bg-white/[0.06]"><div className="h-full rounded-full bg-flow-gradient transition-all duration-500" style={{ width: `${progress}%` }} /></div>
      <div className="mt-3 flex items-center justify-between gap-3 text-[11px]"><span className={phase === 'error' ? 'text-red-400' : 'text-muted'}>{error || phaseLabel[phase]}</span><span className="font-semibold text-fog">{progress}%</span></div>
    </div>
    <div className="grid gap-2 sm:grid-cols-3">
      {[['Автосубтитры', Subtitles], ['Motion-заставка', WandSparkles], ['Готовый MP4', Film]].map(([label, Icon]) => <div key={String(label)} className="flex items-center gap-2 rounded-xl border border-ice/[0.07] bg-white/[0.025] px-3 py-2.5 text-[11px] text-muted"><Icon size={14} className="text-accent-cyan" />{String(label)}</div>)}
    </div>
    {url && <div className="space-y-3"><video src={url} controls playsInline className="max-h-[520px] w-full rounded-2xl bg-black object-contain" /><a href={url} download className="inline-flex items-center gap-2 rounded-xl bg-accent-cyan px-4 py-2.5 text-xs font-bold text-bg"><Download size={14} />Скачать MP4</a></div>}
  </div>
}
