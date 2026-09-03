import { useEffect, useState } from 'react'
import { Image as ImageIcon, Video, UserSquare2, Volume2, ExternalLink, Info, Loader2, CheckCircle2, KeyRound, Unplug, Sparkles, ShieldCheck } from 'lucide-react'
import { supabase, isSupabaseEnabled } from '../../lib/supabase'
import { Button } from '../ui/Button'
import { cn } from '../../lib/cn'
import { useI18n } from '../../i18n'
import { VIDEO_MODEL_CATALOG, DEFAULT_VIDEO_MODEL, IMAGE_MODEL_CATALOG, DEFAULT_IMAGE_MODEL } from '../../lib/models'

/**
 * Media tab — connect your OWN generative provider (key stored server-only, write-only)
 * and generate. Images work now on a connected OpenAI key; video/avatars/voice connect
 * the same way and their generation lights up next.
 */
interface Cap { id: string; icon: typeof ImageIcon; color: string; providers: string; steps: string[]; link: string; live?: boolean }
const CAPS: Cap[] = [
  { id: 'openrouter', icon: Sparkles, color: '#22D3EE', providers: 'OpenRouter · Chat, Nano Banana, GPT Image, Veo, Kling, Seedance, TTS', link: 'https://openrouter.ai/settings/keys', live: true,
    steps: ['openaiStep1', 'openaiStep2', 'openaiStep3'] },
  { id: 'heygen', icon: UserSquare2, color: '#13C5B4', providers: 'HeyGen · D-ID', link: 'https://app.heygen.com',
    steps: ['heygenStep1', 'heygenStep2', 'heygenStep3'] },
  { id: 'elevenlabs', icon: Volume2, color: '#F59F00', providers: 'ElevenLabs', link: 'https://elevenlabs.io/app/settings/api-keys',
    steps: ['elevenlabsStep1', 'elevenlabsStep2', 'elevenlabsStep3'] },
]

/* eslint-disable @typescript-eslint/no-explicit-any */
export function MediaConnectPanel() {
  const { t } = useI18n()
  const [connected, setConnected] = useState<string[]>([])
  const [loading, setLoading] = useState(isSupabaseEnabled)
  const [keyIn, setKeyIn] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState<string | null>(null)
  const [msg, setMsg] = useState<Record<string, { ok: boolean; text: string }>>({})
  // image tester
  const [imgPrompt, setImgPrompt] = useState('')
  const [imgModel, setImgModel] = useState(DEFAULT_IMAGE_MODEL)
  const [imgBusy, setImgBusy] = useState(false)
  const [img, setImg] = useState<string | null>(null)
  const [imgErr, setImgErr] = useState('')
  // voice tester
  const [voiceText, setVoiceText] = useState('')
  const [voiceBusy, setVoiceBusy] = useState(false)
  const [audio, setAudio] = useState<string | null>(null)
  const [voiceErr, setVoiceErr] = useState('')
  // async video/avatar testers
  const [vidText, setVidText] = useState('')
  const [vidModel, setVidModel] = useState(DEFAULT_VIDEO_MODEL)
  const [vidAspect, setVidAspect] = useState('16:9')
  const [vidResolution, setVidResolution] = useState('720p')
  const [vidDuration, setVidDuration] = useState(6)
  const [vidAudio, setVidAudio] = useState(true)
  const [vidState, setVidState] = useState<{ busy: boolean; url?: string; err?: string; note?: string }>({ busy: false })
  const [avaText, setAvaText] = useState('')
  const [avaState, setAvaState] = useState<{ busy: boolean; url?: string; err?: string; note?: string }>({ busy: false })

  const refresh = async () => {
    if (!supabase) return
    const { data } = await supabase.functions.invoke('connect-provider', { body: { action: 'status' } })
    const p = data as { connected?: string[] } | null
    if (p?.connected) setConnected(p.connected)
  }
  useEffect(() => { if (!isSupabaseEnabled || !supabase) return; (async () => { try { await refresh() } catch { /* ignore */ } setLoading(false) })() }, [])

  const connect = async (id: string) => {
    if (!supabase || busy) return
    setBusy(id); setMsg((m) => ({ ...m, [id]: undefined as any }))
    try {
      const { data } = await supabase.functions.invoke('connect-provider', { body: { action: 'connect', provider: id, api_key: (keyIn[id] ?? '').trim() } })
      const p = data as { ok?: boolean; error?: string } | null
      if (!p?.ok) { setMsg((m) => ({ ...m, [id]: { ok: false, text: p?.error ?? t('mediaConnectPanel.connectFailed') } })); return }
      setKeyIn((k) => ({ ...k, [id]: '' })); setMsg((m) => ({ ...m, [id]: { ok: true, text: t('mediaConnectPanel.connectedOk') } })); await refresh()
    } catch { setMsg((m) => ({ ...m, [id]: { ok: false, text: t('mediaConnectPanel.error') } })) } finally { setBusy(null) }
  }
  const disconnect = async (id: string) => {
    if (!supabase || busy) return
    setBusy(id)
    try { await supabase.functions.invoke('connect-provider', { body: { action: 'disconnect', provider: id } }); await refresh() } finally { setBusy(null) }
  }
  const genImage = async () => {
    if (!supabase || imgBusy || imgPrompt.trim().length < 3) return
    setImgBusy(true); setImgErr(''); setImg(null)
    try {
      const { data } = await supabase.functions.invoke('generate-image', { body: { prompt: imgPrompt.trim(), image_model: imgModel } })
      const p = data as { ok?: boolean; image?: string; url?: string; message?: string; error?: string } | null
      if (p?.ok) setImg(p.image || p.url || null)
      else setImgErr(p?.message || p?.error || t('mediaConnectPanel.imgFailed'))
    } catch { setImgErr(t('mediaConnectPanel.genError')) } finally { setImgBusy(false) }
  }
  const genVoice = async () => {
    if (!supabase || voiceBusy || voiceText.trim().length < 2) return
    setVoiceBusy(true); setVoiceErr(''); setAudio(null)
    try {
      const { data } = await supabase.functions.invoke('generate-voice', { body: { text: voiceText.trim() } })
      const p = data as { ok?: boolean; audio?: string; message?: string; error?: string } | null
      if (p?.ok && p.audio) setAudio(p.audio)
      else setVoiceErr(p?.message || p?.error || t('mediaConnectPanel.voiceFailed'))
    } catch { setVoiceErr(t('mediaConnectPanel.voiceError')) } finally { setVoiceBusy(false) }
  }
  // async: create a job, then poll until done (cron also finalizes into the Library if you leave)
  const runAsync = async (fn: string, payload: Record<string, unknown>, set: (s: { busy: boolean; url?: string; err?: string; note?: string }) => void) => {
    if (!supabase) return
    set({ busy: true, note: t('mediaConnectPanel.sendingJob') })
    try {
      const { data } = await supabase.functions.invoke(fn, { body: payload })
      const p = data as { ok?: boolean; job_id?: string; message?: string; error?: string } | null
      if (!p?.ok || !p.job_id) { set({ busy: false, err: p?.message || p?.error || t('mediaConnectPanel.runFailed') }); return }
      const jobId = p.job_id
      let tries = 0
      const tick = async () => {
        tries++
        try {
          const { data: sd } = await supabase!.functions.invoke('media-poll', { body: { action: 'status', job_id: jobId } })
          const s = sd as { status?: string; url?: string; error?: string } | null
          if (s?.status === 'done') { set({ busy: false, url: s.url }); return }
          if (s?.status === 'failed') { set({ busy: false, err: s.error || t('mediaConnectPanel.genError') }); return }
        } catch { /* keep polling */ }
        if (tries > 90) { set({ busy: false, note: t('mediaConnectPanel.longNote') }); return }
        set({ busy: true, note: t('mediaConnectPanel.generatingNote', { sec: tries * 5 }) })
        window.setTimeout(tick, 5000)
      }
      window.setTimeout(tick, 4000)
    } catch { set({ busy: false, err: t('mediaConnectPanel.launchError') }) }
  }

  return (
    <>
      <div className="card flex items-start gap-2 rounded-2xl border border-amber/20 bg-amber/[0.06] p-4 text-[12.5px] leading-relaxed text-muted">
        <Info size={15} className="mt-0.5 shrink-0 text-amber" />
        <span><b className="text-text">{t('mediaConnectPanel.infoBold1')}</b>{t('mediaConnectPanel.infoText1')}<b className="text-text">{t('mediaConnectPanel.infoBold2')}</b>{t('mediaConnectPanel.infoText2')}</span>
      </div>

      {loading ? (
        <div className="card mt-4 flex items-center gap-2 rounded-3xl p-6 text-sm text-muted"><Loader2 size={15} className="animate-spin" /> {t('common.loading')}</div>
      ) : (
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          {CAPS.map((c) => {
            const on = connected.includes(c.id)
            const m = msg[c.id]
            return (
              <div key={c.id} className="card rounded-3xl p-5">
                <div className="flex items-center gap-2">
                  <span className="flex h-10 w-10 items-center justify-center rounded-xl" style={{ background: `${c.color}22`, color: c.color }}><c.icon size={18} /></span>
                  <div className="flex-1">
                    <h3 className="text-sm font-bold text-text">{t(`mediaConnectPanel.${c.id}Title`)}</h3>
                    <p className="text-[11px] text-fog">{c.providers}</p>
                  </div>
                  {on
                    ? <span className="inline-flex items-center gap-1 rounded-pill bg-teal/10 px-2 py-0.5 text-[10px] text-teal"><CheckCircle2 size={11} /> {t('mediaConnectPanel.capConnected')}</span>
                    : <span className="rounded-pill bg-amber/10 px-2 py-0.5 text-[10px] text-amber">{c.live ? t('mediaConnectPanel.worksAfterKey') : t('common.soon')}</span>}
                </div>
                <p className="mt-3 text-[13px] text-muted">{t(`mediaConnectPanel.${c.id}What`)}</p>

                {on ? (
                  <div className="mt-3 flex items-center gap-2">
                    <span className="inline-flex items-center gap-1.5 rounded-xl border border-teal/20 bg-teal/[0.06] px-3 py-1.5 text-xs text-text"><KeyRound size={13} className="text-teal" /> {t('mediaConnectPanel.keyConnected')}</span>
                    <Button size="sm" variant="ghost" onClick={() => disconnect(c.id)} disabled={busy === c.id}>{busy === c.id ? <Loader2 size={13} className="animate-spin" /> : <Unplug size={13} />} {t('mediaConnectPanel.disconnect')}</Button>
                  </div>
                ) : (
                  <>
                    <ol className="mt-3 space-y-1 text-[12px] text-muted">{c.steps.map((s, i) => <li key={i} className="flex gap-2"><span className="text-violet">{i + 1}.</span> {t(`mediaConnectPanel.${s}`)}</li>)}</ol>
                    <div className="mt-3 flex flex-col gap-2 sm:flex-row">
                      <input value={keyIn[c.id] ?? ''} onChange={(e) => setKeyIn((k) => ({ ...k, [c.id]: e.target.value }))} type="password" placeholder={t('mediaConnectPanel.keyPlaceholder')} className="flex-1 rounded-xl border border-ice/10 bg-black/20 px-3 py-2 text-sm text-text outline-none placeholder:text-fog focus:border-violet/50" />
                      <Button size="sm" onClick={() => connect(c.id)} disabled={busy === c.id || (keyIn[c.id] ?? '').trim().length < 10}>{busy === c.id ? <Loader2 size={13} className="animate-spin" /> : <KeyRound size={13} />} {t('mediaConnectPanel.connectBtn')}</Button>
                    </div>
                  </>
                )}
                {m && <p className={cn('mt-2 rounded-lg px-3 py-1.5 text-xs', m.ok ? 'bg-teal/10 text-teal' : 'bg-danger/10 text-danger')}>{m.text}</p>}
                <a href={c.link} target="_blank" rel="noopener noreferrer" className="mt-3 inline-flex items-center gap-1 text-[12px] text-violet hover:underline">{t('mediaConnectPanel.openProvider')} <ExternalLink size={11} /></a>
              </div>
            )
          })}
        </div>
      )}

      {/* image generation tester (works on connected OpenAI) */}
      <div className="card mt-4 rounded-3xl p-6">
        <h3 className="flex items-center gap-2 text-sm font-bold text-text"><Sparkles size={15} className="text-violet" /> {t('mediaConnectPanel.testImageTitle')}</h3>
        <select value={imgModel} onChange={(e) => setImgModel(e.target.value)} className="mt-3 w-full rounded-xl border border-ice/10 bg-black/20 px-3 py-2 text-sm text-text outline-none focus:border-violet/50">
          {IMAGE_MODEL_CATALOG.map((m) => <option key={m.id} value={m.id} className="bg-panel">{m.label}</option>)}
        </select>
        <div className="mt-3 flex flex-col gap-2 sm:flex-row">
          <input value={imgPrompt} onChange={(e) => setImgPrompt(e.target.value)} placeholder={t('mediaConnectPanel.imagePromptPlaceholder')} className="flex-1 rounded-xl border border-ice/10 bg-black/20 px-3 py-2 text-sm text-text outline-none placeholder:text-fog focus:border-violet/50" />
          <Button onClick={genImage} disabled={imgBusy || imgPrompt.trim().length < 3}>{imgBusy ? <><Loader2 size={15} className="animate-spin" /> {t('mediaConnectPanel.generatingImg')}</> : <><ImageIcon size={15} /> {t('mediaConnectPanel.generateBtn')}</>}</Button>
        </div>
        {imgErr && <p className="mt-2 rounded-lg bg-danger/10 px-3 py-2 text-xs text-danger">{imgErr}</p>}
        {img && <img src={img} alt={t('mediaConnectPanel.generatedAlt')} className="mt-3 max-h-96 rounded-2xl border border-ice/10" />}
      </div>

      {/* voice generation tester (works on connected ElevenLabs) */}
      <div className="card mt-4 rounded-3xl p-6">
        <h3 className="flex items-center gap-2 text-sm font-bold text-text"><Volume2 size={15} className="text-violet" /> {t('mediaConnectPanel.testVoiceTitle')}</h3>
        <div className="mt-3 flex flex-col gap-2 sm:flex-row">
          <input value={voiceText} onChange={(e) => setVoiceText(e.target.value)} placeholder={t('mediaConnectPanel.voicePlaceholder')} className="flex-1 rounded-xl border border-ice/10 bg-black/20 px-3 py-2 text-sm text-text outline-none placeholder:text-fog focus:border-violet/50" />
          <Button onClick={genVoice} disabled={voiceBusy || voiceText.trim().length < 2}>{voiceBusy ? <><Loader2 size={15} className="animate-spin" /> {t('mediaConnectPanel.voicing')}</> : <><Volume2 size={15} /> {t('mediaConnectPanel.voiceBtn')}</>}</Button>
        </div>
        {voiceErr && <p className="mt-2 rounded-lg bg-danger/10 px-3 py-2 text-xs text-danger">{voiceErr}</p>}
        {audio && <audio controls src={audio} className="mt-3 w-full" />}
      </div>

      {/* video generation tester (OpenRouter, async) */}
      <div className="card mt-4 rounded-3xl p-6">
        <h3 className="flex items-center gap-2 text-sm font-bold text-text"><Video size={15} className="text-violet" /> {t('mediaConnectPanel.testVideoTitle')}</h3>
        <div className="mt-3 space-y-2">
          <select value={vidModel} onChange={(e) => setVidModel(e.target.value)} className="w-full rounded-xl border border-ice/10 bg-black/20 px-3 py-2 text-sm text-text outline-none focus:border-violet/50">
            {VIDEO_MODEL_CATALOG.map((m) => <option key={m.id} value={m.id} className="bg-panel">{m.label}</option>)}
          </select>
          <div className="grid gap-2 sm:grid-cols-4">
            <select value={vidAspect} onChange={(e) => setVidAspect(e.target.value)} className="rounded-xl border border-ice/10 bg-black/20 px-3 py-2 text-sm text-text"><option>16:9</option><option>9:16</option><option>1:1</option></select>
            <select value={vidResolution} onChange={(e) => setVidResolution(e.target.value)} className="rounded-xl border border-ice/10 bg-black/20 px-3 py-2 text-sm text-text"><option>720p</option><option>1080p</option><option>2K</option></select>
            <select value={vidDuration} onChange={(e) => setVidDuration(Number(e.target.value))} className="rounded-xl border border-ice/10 bg-black/20 px-3 py-2 text-sm text-text"><option value={4}>4 сек</option><option value={6}>6 сек</option><option value={8}>8 сек</option></select>
            <label className="flex items-center gap-2 rounded-xl border border-ice/10 bg-black/20 px-3 py-2 text-sm text-text"><input type="checkbox" checked={vidAudio} onChange={(e) => setVidAudio(e.target.checked)} /> Со звуком</label>
          </div>
          <div className="flex flex-col gap-2 sm:flex-row">
            <input value={vidText} onChange={(e) => setVidText(e.target.value)} placeholder={t('mediaConnectPanel.videoPlaceholder')} className="flex-1 rounded-xl border border-ice/10 bg-black/20 px-3 py-2 text-sm text-text outline-none placeholder:text-fog focus:border-violet/50" />
            <Button onClick={() => runAsync('generate-video', { prompt: vidText.trim(), model: vidModel, aspect_ratio: vidAspect, resolution: vidResolution, duration: vidDuration, generate_audio: vidAudio }, setVidState)} disabled={vidState.busy || vidText.trim().length < 3}>{vidState.busy ? <><Loader2 size={15} className="animate-spin" /> …</> : <><Video size={15} /> {t('mediaConnectPanel.generateBtn')}</>}</Button>
          </div>
        </div>
        {vidState.note && <p className="mt-2 text-xs text-muted">{vidState.note}</p>}
        {vidState.err && <p className="mt-2 rounded-lg bg-danger/10 px-3 py-2 text-xs text-danger">{vidState.err}</p>}
        {vidState.url && <video controls src={vidState.url} className="mt-3 max-h-96 w-full rounded-2xl border border-ice/10" />}
      </div>

      {/* avatar video tester (HeyGen, async) */}
      <div className="card mt-4 rounded-3xl p-6">
        <h3 className="flex items-center gap-2 text-sm font-bold text-text"><UserSquare2 size={15} className="text-violet" /> {t('mediaConnectPanel.testAvatarTitle')}</h3>
        <div className="mt-3 flex flex-col gap-2 sm:flex-row">
          <input value={avaText} onChange={(e) => setAvaText(e.target.value)} placeholder={t('mediaConnectPanel.avatarPlaceholder')} className="flex-1 rounded-xl border border-ice/10 bg-black/20 px-3 py-2 text-sm text-text outline-none placeholder:text-fog focus:border-violet/50" />
          <Button onClick={() => runAsync('generate-avatar', { text: avaText.trim() }, setAvaState)} disabled={avaState.busy || avaText.trim().length < 2}>{avaState.busy ? <><Loader2 size={15} className="animate-spin" /> …</> : <><UserSquare2 size={15} /> {t('mediaConnectPanel.generateBtn')}</>}</Button>
        </div>
        {avaState.note && <p className="mt-2 text-xs text-muted">{avaState.note}</p>}
        {avaState.err && <p className="mt-2 rounded-lg bg-danger/10 px-3 py-2 text-xs text-danger">{avaState.err}</p>}
        {avaState.url && <video controls src={avaState.url} className="mt-3 max-h-96 w-full rounded-2xl border border-ice/10" />}
      </div>

      <p className="mt-4 flex items-center gap-1.5 text-[11px] text-fog"><ShieldCheck size={13} className="text-teal" /> {t('mediaConnectPanel.keysSecurityNote')}</p>
    </>
  )
}
