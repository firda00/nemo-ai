import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react'
import {
  AudioLines, BookOpenText, CheckCircle2, FileAudio, FileText,
  FileVideo, Link2, ListChecks, Loader2, Pause, Play, PlayCircle, Plus, Quote, ShieldCheck,
  Sparkles, Trash2, UploadCloud, Users,
} from 'lucide-react'
import { useI18n } from '../../i18n'
import { cn } from '../../lib/cn'
import { getAccessToken, isSupabaseEnabled, supabase } from '../../lib/supabase'
import { extractText } from '../../lib/extractText'
import { useAgentStore } from '../../store/useAgentStore'
import {
  ResearchNotebookOutputSchema,
  type ResearchEvidence,
  type ResearchNotebookOutput,
  type SourceIngestion,
} from '../../../supabase/functions/_shared/researchNotebook'

type SourceKind = SourceIngestion['kind']
type SourceStatus = 'ready' | 'processing' | 'failed'

interface NotebookSource {
  id: string
  kind: SourceKind
  title: string
  detail: string
  status: SourceStatus
  normalized?: SourceIngestion
}

const DEMO_WORKSPACE_ID = '11111111-1111-4111-8111-111111111111'
const MAX_UPLOAD_BYTES = 180 * 1024 * 1024
const ALLOWED_EXTENSIONS = new Set(['mp3', 'm4a', 'wav', 'mp4', 'pdf', 'docx', 'xlsx', 'csv', 'txt', 'md', 'json'])
const WAVEFORM = [10, 18, 29, 22, 39, 31, 17, 25, 42, 33, 21, 37, 26, 14, 30, 41, 24, 36, 18, 27, 44, 31, 20, 35, 16, 28, 40, 23, 32, 19, 38, 25]
const MAX_CONTINUE_CALLS = 30

function mediaDuration(file: File): Promise<number> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file)
    const media = document.createElement(file.type.startsWith('video/') ? 'video' : 'audio')
    media.preload = 'metadata'
    media.onloadedmetadata = () => { const duration = Number(media.duration); URL.revokeObjectURL(url); resolve(Number.isFinite(duration) && duration > 0 ? duration : 1) }
    media.onerror = () => { URL.revokeObjectURL(url); resolve(1) }
    media.src = url
  })
}

function hms(totalSeconds: number) {
  return new Date(Math.max(0, Math.min(totalSeconds, 359_999)) * 1000).toISOString().slice(11, 19)
}

function hmsSeconds(value: string) {
  const [hours, minutes, seconds] = value.split(':').map(Number)
  return hours * 3600 + minutes * 60 + seconds
}

function transcriptToSegments(transcript: string, durationSeconds: number) {
  const matches = [...transcript.matchAll(/(?:^|\n)\s*\[?(\d{2}:[0-5]\d:[0-5]\d)\]?\s*(?:[-–—:]\s*)?([^\n]+)/g)]
  if (!matches.length) {
    const chunks = transcript.match(/[\s\S]{1,3800}(?=\s|$)/g) ?? [transcript.slice(0, 3800)]
    return chunks.slice(0, 150).map((text, index) => ({
      start: hms(Math.floor((durationSeconds * index) / chunks.length)),
      end: hms(Math.max(1, Math.ceil((durationSeconds * (index + 1)) / chunks.length))),
      speaker: 'Unknown',
      text: text.trim(),
    }))
  }
  return matches.slice(0, 2000).map((match, index) => {
    const next = matches[index + 1]?.[1]
    const raw = match[2].trim()
    const speakerMatch = raw.match(/^([^:]{1,120}):\s+(.+)$/)
    const finalEnd = hms(Math.max(hmsSeconds(match[1]) + 1, Math.round(durationSeconds)))
    return { start: match[1], end: next ?? finalEnd, speaker: speakerMatch?.[1] ?? 'Unknown', text: (speakerMatch?.[2] ?? raw).slice(0, 4000) }
  })
}

function sourceIcon(kind: SourceKind) {
  if (kind === 'youtube_url') return PlayCircle
  if (kind === 'media_audio') return FileAudio
  if (kind === 'media_video') return FileVideo
  return FileText
}

function statusClass(status: SourceStatus) {
  if (status === 'ready') return 'border-teal/20 bg-teal/[0.07] text-teal'
  if (status === 'failed') return 'border-danger/20 bg-danger/[0.07] text-danger'
  return 'border-amber/20 bg-amber/[0.07] text-amber'
}

function buildPreview(t: (path: string, vars?: Record<string, string | number>) => string) {
  const ingestedAt = '2026-08-30T12:00:00+05:00'
  const quote1 = t('researchHub.sampleQuote1')
  const quote2 = t('researchHub.sampleQuote2')
  const transcriptSegments = [
    { start: '00:04:12', end: '00:04:32', speaker: 'Aliya Karimova', text: quote1 },
    { start: '00:18:40', end: '00:19:02', speaker: 'Bekzod Rahimov', text: quote2 },
  ]
  const meeting: SourceIngestion = {
    source_id: 'meeting-demo', workspace_id: DEMO_WORKSPACE_ID, kind: 'media_audio', title: t('researchHub.sampleMeeting'),
    language: 'ru', size_bytes: 4_820_000, ingested_at: ingestedAt, storage_path: 'demo/research/pilot-meeting.m4a',
    mime_type: 'audio/mp4', duration_seconds: 1840, transcript_segments: transcriptSegments,
  }
  const pdf: SourceIngestion = {
    source_id: 'pilot-terms-demo', workspace_id: DEMO_WORKSPACE_ID, kind: 'pdf_document', title: t('researchHub.samplePdf'),
    language: 'ru', size_bytes: 286_000, ingested_at: ingestedAt, storage_path: 'demo/research/pilot-terms.pdf',
    mime_type: 'application/pdf', pages: [{ page: 3, text: `${quote1} ${quote2}` }],
  }
  const evidence1: ResearchEvidence = { source_id: meeting.source_id, timestamp: '00:04:12', page: null, paragraph: null, quote: quote1 }
  const evidence2: ResearchEvidence = { source_id: meeting.source_id, timestamp: '00:18:40', page: null, paragraph: null, quote: quote2 }
  const output: ResearchNotebookOutput = {
    meeting_intelligence: {
      tl_dr: t('researchHub.sampleTlDr'),
      key_decisions: [
        { id: 'decision-1', decision: t('researchHub.sampleDecision1'), timestamp: '00:04:12', speaker: 'Aliya Karimova', evidence: [evidence1] },
        { id: 'decision-2', decision: t('researchHub.sampleDecision2'), timestamp: '00:18:40', speaker: 'Bekzod Rahimov', evidence: [evidence2] },
      ],
      action_items: [
        { id: 'action-1', task: t('researchHub.sampleAction1'), owner: 'Aliya Karimova', deadline: '2026-08-31', timestamp: '00:04:12', discussion_context: t('researchHub.sampleContext1'), evidence: [evidence1] },
        { id: 'action-2', task: t('researchHub.sampleAction2'), owner: 'Bekzod Rahimov', deadline: '2026-08-31', timestamp: '00:18:40', discussion_context: t('researchHub.sampleContext2'), evidence: [evidence2] },
      ],
      speaker_insights: [
        { speaker: 'Aliya Karimova', key_points: [t('researchHub.samplePoint1')], evidence: [evidence1] },
        { speaker: 'Bekzod Rahimov', key_points: [t('researchHub.samplePoint2')], evidence: [evidence2] },
      ],
    },
    audio_overview_script: {
      title: t('researchHub.sampleAudioTitle'), target_duration_seconds: 120,
      dialogue: [
        { sequence: 1, host: 'Host A', text: t('researchHub.sampleAudio1'), evidence: [evidence1] },
        { sequence: 2, host: 'Host B', text: t('researchHub.sampleAudio2'), evidence: [evidence2] },
        { sequence: 3, host: 'Host A', text: t('researchHub.sampleAudio3'), evidence: [evidence2] },
        { sequence: 4, host: 'Host B', text: t('researchHub.sampleAudio4'), evidence: [evidence1] },
      ],
    },
  }
  const sources: NotebookSource[] = [
    { id: meeting.source_id, kind: meeting.kind, title: meeting.title, detail: 'M4A / 30:40', status: 'ready', normalized: meeting },
    { id: pdf.source_id, kind: pdf.kind, title: pdf.title, detail: 'PDF / 6 pages', status: 'ready', normalized: pdf },
  ]
  return { sources, output }
}

function evidenceLocator(evidence: ResearchEvidence, t: (path: string) => string) {
  if (evidence.timestamp) return `${t('researchHub.timestamp')} ${evidence.timestamp}`
  if (evidence.page) return `${t('researchHub.page')} ${evidence.page}`
  return `${t('researchHub.paragraph')} ${evidence.paragraph}`
}

function ResearchNotebookWorkspace({ initialFiles, autoAnalyze = false }: { initialFiles?: File[]; autoAnalyze?: boolean }) {
  const { t, lang } = useI18n()
  const accountId = useAgentStore((state) => state.accountId)
  const preview = useMemo(() => buildPreview(t), [t])
  const embeddedUpload = Boolean(initialFiles?.length)
  const [sources, setSources] = useState<NotebookSource[]>(embeddedUpload ? [] : preview.sources)
  const [analysis, setAnalysis] = useState<ResearchNotebookOutput | null>(embeddedUpload ? null : preview.output)
  const [selectedEvidence, setSelectedEvidence] = useState<ResearchEvidence | null>(embeddedUpload ? null : preview.output.meeting_intelligence.key_decisions[0].evidence[0])
  const [youtubeUrl, setYoutubeUrl] = useState('')
  const [note, setNote] = useState('')
  const [showNote, setShowNote] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [playing, setPlaying] = useState(false)
  const [activeLine, setActiveLine] = useState(0)
  const [autoAnalyzePending, setAutoAnalyzePending] = useState(false)
  const fileInput = useRef<HTMLInputElement>(null)
  const initialFilesKey = useRef('')

  const stopPlayback = useCallback(() => {
    if (typeof window !== 'undefined' && 'speechSynthesis' in window) window.speechSynthesis.cancel()
    setPlaying(false)
  }, [])

  useEffect(() => () => {
    if (typeof window !== 'undefined' && 'speechSynthesis' in window) window.speechSynthesis.cancel()
  }, [])

  const speakFrom = useCallback((start: number) => {
    if (!analysis || typeof window === 'undefined' || !('speechSynthesis' in window)) return
    window.speechSynthesis.cancel()
    const lines = analysis.audio_overview_script.dialogue
    const voices = window.speechSynthesis.getVoices()
    const run = (index: number) => {
      if (index >= lines.length) { setPlaying(false); setActiveLine(0); return }
      setActiveLine(index)
      setPlaying(true)
      const utterance = new SpeechSynthesisUtterance(lines[index].text)
      utterance.lang = lang === 'uz' ? 'uz-UZ' : lang === 'en' ? 'en-US' : 'ru-RU'
      const voicePrefix = lang === 'uz' ? 'uz' : lang
      const matching = voices.filter((voice) => voice.lang.toLowerCase().startsWith(voicePrefix))
      utterance.voice = matching[lines[index].host === 'Host A' ? 0 : 1] ?? matching[0] ?? voices[lines[index].host === 'Host A' ? 0 : 1] ?? null
      utterance.rate = lines[index].host === 'Host A' ? 1 : 0.96
      utterance.onend = () => run(index + 1)
      utterance.onerror = () => setPlaying(false)
      window.speechSynthesis.speak(utterance)
    }
    run(start)
  }, [analysis, lang])

  const chooseEvidence = (evidence?: ResearchEvidence) => {
    if (evidence) setSelectedEvidence(evidence)
  }

  const addYoutube = () => {
    try {
      const parsed = new URL(youtubeUrl.trim())
      if (!['youtube.com', 'www.youtube.com', 'youtu.be', 'm.youtube.com'].includes(parsed.hostname.toLowerCase())) throw new Error('host')
      const id = `youtube-${Date.now()}`
      setSources((current) => [...current, { id, kind: 'youtube_url', title: parsed.hostname, detail: youtubeUrl.trim(), status: 'processing' }])
      setYoutubeUrl('')
      setError(isSupabaseEnabled ? t('researchHub.liveNeedsProcessing') : '')
    } catch {
      setError(t('researchHub.invalidYoutube'))
    }
  }

  const addNote = () => {
    const text = note.trim()
    if (!text) return
    const id = `note-${Date.now()}`
    const workspaceId = accountId && accountId !== 'demo' ? accountId : DEMO_WORKSPACE_ID
    const normalized: SourceIngestion = {
      source_id: id, workspace_id: workspaceId, kind: 'plain_text', title: t('researchHub.note'), language: lang,
      size_bytes: new Blob([text]).size || 1, ingested_at: new Date().toISOString(), text,
    }
    setSources((current) => [...current, { id, kind: 'plain_text', title: t('researchHub.note'), detail: t('researchHub.characters', { count: text.length }), status: 'ready', normalized }])
    setNote('')
    setShowNote(false)
    setError('')
  }

  const acceptFiles = useCallback(async (input: FileList | File[] | null) => {
    const selected = input ? Array.from(input) : []
    if (!selected.length) return
    for (const file of selected) {
      const extension = file.name.split('.').pop()?.toLowerCase() ?? ''
      if (!ALLOWED_EXTENSIONS.has(extension)) { setError(t('researchHub.unsupportedFile')); continue }
      if (file.size > MAX_UPLOAD_BYTES) { setError(t('researchHub.fileTooLarge')); continue }
      const id = `file-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`
      const detail = `${Math.max(1, Math.round(file.size / 1024 / 1024))} MB`
      const isMedia = ['mp3', 'm4a', 'wav', 'mp4'].includes(extension)
      setSources((current) => [...current, { id, kind: extension === 'mp4' ? 'media_video' : isMedia ? 'media_audio' : 'plain_text', title: file.name, detail, status: 'processing' }])
      try {
        if (!isMedia) {
          const text = (await extractText(file)).trim()
          if (!text) throw new Error('empty')
          const workspaceId = accountId && accountId !== 'demo' ? accountId : DEMO_WORKSPACE_ID
          const normalized: SourceIngestion = { source_id: id, workspace_id: workspaceId, kind: 'plain_text', title: file.name, language: lang, size_bytes: Math.max(1, Math.min(file.size, 8 * 1024 * 1024)), ingested_at: new Date().toISOString(), text }
          setSources((current) => current.map((source) => source.id === id ? { ...source, detail: t('researchHub.characters', { count: text.length }), status: 'ready', normalized } : source))
          continue
        }
        if (!supabase || !isSupabaseEnabled) throw new Error('auth')
        const { data: { user } } = await supabase.auth.getUser()
        if (!user) throw new Error('auth')
        const duration = await mediaDuration(file)
        const path = `${user.id}/audio/${Date.now()}-${file.name.replace(/[^a-z0-9.]/gi, '_').slice(0, 60)}`
        const contentType = extension === 'mp4' ? 'video/mp4' : extension === 'm4a' ? 'audio/mp4' : extension === 'wav' ? 'audio/wav' : 'audio/mpeg'
        const upload = await supabase.storage.from('private-audio').upload(path, file, { contentType })
        if (upload.error) throw upload.error
        const body = { storage_path: path, format: contentType, language: lang || 'auto', duration_seconds: Math.round(duration) }
        let invoked = await supabase.functions.invoke('transcribe-file', { body })
        let response = invoked.data as { ok?: boolean; pending?: boolean; job_id?: string; transcript?: string; message?: string; error?: string } | null
        for (let call = 0; call < MAX_CONTINUE_CALLS && response?.ok && response.pending && response.job_id; call++) {
          invoked = await supabase.functions.invoke('transcribe-file', { body: { action: 'continue', job_id: response.job_id } })
          response = invoked.data as typeof response
        }
        if (!response?.ok || !response.transcript) throw new Error(response?.message || response?.error || 'transcription')
        const kind = extension === 'mp4' ? 'media_video' : 'media_audio'
        const mimeType = kind === 'media_video' ? 'video/mp4' : extension === 'm4a' ? 'audio/mp4' : extension === 'wav' ? 'audio/wav' : 'audio/mpeg'
        const workspaceId = accountId && accountId !== 'demo' ? accountId : DEMO_WORKSPACE_ID
        const normalized = {
          source_id: id, workspace_id: workspaceId, kind, title: file.name, language: lang,
          size_bytes: file.size, ingested_at: new Date().toISOString(), storage_path: path,
          mime_type: mimeType, duration_seconds: Math.max(1, Math.round(duration)),
          transcript_segments: transcriptToSegments(response.transcript, duration),
        } as SourceIngestion
        setSources((current) => current.map((source) => source.id === id ? { ...source, detail: `${kind === 'media_video' ? 'VIDEO' : 'AUDIO'} / ${hms(duration)}`, status: 'ready', normalized } : source))
        setError('')
      } catch {
        setSources((current) => current.map((source) => source.id === id ? { ...source, status: 'failed' } : source))
        setError(t('researchHub.mediaProcessingError'))
      }
    }
    if (autoAnalyze) setAutoAnalyzePending(true)
  }, [accountId, autoAnalyze, lang, t])

  const analyze = async () => {
    const normalized = sources.flatMap((source) => source.status === 'ready' && source.normalized ? [source.normalized] : [])
    if (!normalized.length) { setError(t('researchHub.needSource')); return }
    setError('')
    setLoading(true)
    stopPlayback()
    try {
      if (!isSupabaseEnabled) {
        await new Promise((resolve) => setTimeout(resolve, 700))
        setAnalysis(preview.output)
        setSelectedEvidence(preview.output.meeting_intelligence.key_decisions[0].evidence[0])
        return
      }
      const token = await getAccessToken()
      if (!token || !accountId || accountId === 'demo') throw new Error('auth')
      const scoped = normalized.map((source) => ({ ...source, workspace_id: accountId }))
      const response = await fetch('/api/research/analyze-multimodal', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ workspace_id: accountId, locale: lang, sources: scoped, objective: t('researchHub.subtitle') }),
      })
      const body = await response.json().catch(() => null)
      const parsed = ResearchNotebookOutputSchema.safeParse(body?.analysis)
      if (!response.ok || !parsed.success) throw new Error('analysis')
      setAnalysis(parsed.data)
      setSelectedEvidence(parsed.data.meeting_intelligence.key_decisions[0]?.evidence[0] ?? null)
    } catch {
      setError(t('researchHub.analysisError'))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    if (!initialFiles?.length) return
    const key = initialFiles.map((file) => `${file.name}:${file.size}:${file.lastModified}`).join('|')
    if (initialFilesKey.current === key) return
    initialFilesKey.current = key
    void acceptFiles(initialFiles)
  }, [acceptFiles, initialFiles])

  useEffect(() => {
    if (!autoAnalyzePending || sources.some((source) => source.status === 'processing')) return
    const timer = window.setTimeout(() => {
      setAutoAnalyzePending(false)
      void analyze()
    }, 0)
    return () => window.clearTimeout(timer)
    // analyze intentionally runs once after the files supplied by the chat are normalized.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoAnalyzePending, sources])

  const sourceMap = useMemo(() => new Map(sources.map((source) => [source.id, source])), [sources])
  const selectedSource = selectedEvidence ? sourceMap.get(selectedEvidence.source_id) : null
  const readyCount = sources.filter((source) => source.status === 'ready').length

  return (
    <div className="container-page max-w-[1540px] !px-3 py-6 sm:!px-6 sm:py-8">
      <header className="flex flex-col gap-4 border-b border-ice/[0.08] pb-6 md:flex-row md:items-end md:justify-between">
        <div className="min-w-0">
          <p className="mono-label">{t('researchHub.eyebrow')}</p>
          <h1 className="mt-2 text-2xl font-extrabold tracking-tight text-text sm:text-3xl">{t('researchHub.title')}</h1>
          <p className="mt-2 max-w-3xl text-sm leading-6 text-muted">{t('researchHub.subtitle')}</p>
        </div>
        {!isSupabaseEnabled && <span className="inline-flex w-fit items-center gap-2 rounded-lg border border-amber/20 bg-amber/[0.06] px-3 py-2 text-xs font-semibold text-amber"><Sparkles size={14} />{t('researchHub.demo')}</span>}
      </header>

      <div className="mt-6 grid min-w-0 gap-5 xl:grid-cols-[280px_minmax(0,1fr)_320px]">
        <aside className="min-w-0 rounded-3xl border border-ice/[0.08] bg-panel/55 p-4 xl:sticky xl:top-24 xl:max-h-[calc(100dvh-7.5rem)] xl:self-start xl:overflow-y-auto" aria-labelledby="notebook-sources-title">
          <div className="flex items-start gap-3">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-accent-cyan/10 text-accent-cyan"><BookOpenText size={17} /></span>
            <div className="min-w-0"><h2 id="notebook-sources-title" className="font-bold text-text">{t('researchHub.sources')}</h2><p className="mt-1 text-xs leading-5 text-muted">{t('researchHub.sourcesHint')}</p></div>
          </div>
          <label className="mt-5 block text-[11px] font-semibold text-muted">{t('researchHub.youtube')}</label>
          <div className="mt-2 flex min-w-0 gap-2">
            <input value={youtubeUrl} onChange={(event) => setYoutubeUrl(event.target.value)} placeholder={t('researchHub.youtubePlaceholder')} className="min-w-0 flex-1 rounded-xl border border-ice/[0.09] bg-bg/45 px-3 py-2.5 text-xs text-text outline-none placeholder:text-fog focus:border-accent-cyan/40" />
            <button type="button" onClick={addYoutube} disabled={!youtubeUrl.trim()} className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-accent-indigo text-white transition hover:brightness-110 active:scale-[0.98] disabled:opacity-40" aria-label={t('researchHub.add')}><Plus size={16} /></button>
          </div>
          <button type="button" onClick={() => fileInput.current?.click()} className="mt-3 flex w-full items-center gap-3 rounded-xl border border-dashed border-ice/[0.12] bg-bg/25 px-3 py-3 text-left transition hover:border-accent-cyan/35 hover:bg-accent-cyan/[0.025]">
            <UploadCloud size={18} className="shrink-0 text-accent-cyan" />
            <span className="min-w-0"><span className="block text-xs font-semibold text-text">{t('researchHub.upload')}</span><span className="mt-0.5 block text-[10px] text-fog">{t('researchHub.uploadHint')}</span></span>
          </button>
          <input ref={fileInput} type="file" multiple accept=".mp3,.m4a,.wav,.mp4,.pdf,.docx,.xlsx,.csv,.txt,.md,.json,audio/mpeg,audio/mp4,audio/wav,video/mp4,application/pdf,text/plain" className="hidden" onChange={(event: ChangeEvent<HTMLInputElement>) => { void acceptFiles(event.target.files); event.target.value = '' }} />
          <button type="button" onClick={() => setShowNote((value) => !value)} className="mt-2 flex w-full items-center gap-3 rounded-xl border border-ice/[0.08] bg-card/[0.025] px-3 py-3 text-left text-xs font-semibold text-text transition hover:bg-card/[0.06]"><FileText size={17} className="text-muted" />{t('researchHub.note')}</button>
          {showNote && <div className="mt-2 rounded-xl border border-ice/[0.08] bg-bg/30 p-2"><textarea value={note} onChange={(event) => setNote(event.target.value)} rows={4} placeholder={t('researchHub.notePlaceholder')} className="w-full resize-y bg-transparent px-1 py-1 text-xs leading-5 text-text outline-none placeholder:text-fog" /><button type="button" onClick={addNote} disabled={!note.trim()} className="mt-2 inline-flex w-full items-center justify-center gap-2 rounded-lg bg-accent-indigo px-3 py-2 text-xs font-bold text-white disabled:opacity-40"><Plus size={14} />{t('researchHub.addNote')}</button></div>}
          <div className="mt-5 space-y-2">
            {sources.length === 0 && <p className="rounded-xl border border-dashed border-ice/[0.1] p-4 text-center text-xs leading-5 text-muted">{t('researchHub.emptySources')}</p>}
            {sources.map((source) => {
              const Icon = sourceIcon(source.kind)
              return <article key={source.id} className="group min-w-0 rounded-xl border border-ice/[0.07] bg-bg/25 p-3">
                <div className="flex min-w-0 items-start gap-2.5">
                  <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-card text-muted"><Icon size={15} /></span>
                  <div className="min-w-0 flex-1"><p className="truncate text-xs font-semibold text-text" title={source.title}>{source.title}</p><p className="mt-1 truncate text-[10px] text-fog">{source.detail}</p></div>
                  <button type="button" onClick={() => setSources((current) => current.filter((item) => item.id !== source.id))} className="rounded-lg p-1.5 text-fog opacity-70 transition hover:bg-danger/[0.08] hover:text-danger sm:opacity-0 sm:group-hover:opacity-100" aria-label={t('researchHub.remove')}><Trash2 size={13} /></button>
                </div>
                <span className={cn('mt-2 inline-flex rounded-md border px-2 py-1 text-[9px] font-semibold', statusClass(source.status))}>{t(`researchHub.${source.status}`)}</span>
              </article>
            })}
          </div>
          {error && <p role="alert" className="mt-3 rounded-xl border border-amber/20 bg-amber/[0.06] px-3 py-2 text-[11px] leading-5 text-amber">{error}</p>}
          <button type="button" onClick={() => void analyze()} disabled={loading || readyCount === 0} className="mt-4 inline-flex w-full items-center justify-center gap-2 rounded-xl bg-flow-gradient px-4 py-3 text-xs font-bold text-white shadow-btn transition hover:brightness-105 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-45">
            {loading ? <Loader2 size={15} className="animate-spin motion-reduce:animate-none" /> : <Sparkles size={15} />}{loading ? t('researchHub.analyzing') : t('researchHub.analyze')}
          </button>
          <p className="mt-2 text-center text-[10px] text-fog">{t('researchHub.selected', { count: readyCount })}</p>
        </aside>

        <main className="min-w-0 space-y-5">
          {!analysis ? <section className="grid min-h-96 place-items-center rounded-3xl border border-dashed border-ice/[0.1] p-8 text-center"><div><BookOpenText size={30} className="mx-auto text-fog" /><p className="mt-3 max-w-sm text-sm text-muted">{t('researchHub.needSource')}</p></div></section> : <>
            <section className="rounded-3xl border border-ice/[0.08] bg-panel/45 p-4 sm:p-6" aria-labelledby="meeting-intelligence-title">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between"><div><p className="mono-label">{t('researchHub.tldr')}</p><h2 id="meeting-intelligence-title" className="mt-1 text-xl font-bold text-text">{t('researchHub.meeting')}</h2></div><span className="inline-flex w-fit items-center gap-1.5 rounded-lg border border-teal/20 bg-teal/[0.06] px-2.5 py-1.5 text-[10px] font-semibold text-teal"><ShieldCheck size={12} />{t('researchHub.strictGrounding')}</span></div>
              <p className="mt-5 text-sm leading-7 text-text/90">{analysis.meeting_intelligence.tl_dr}</p>
            </section>
            <section className="grid min-w-0 gap-5 lg:grid-cols-2">
              <div className="min-w-0 rounded-3xl border border-ice/[0.08] bg-card/[0.025] p-4 sm:p-5"><div className="flex items-center gap-2"><CheckCircle2 size={17} className="text-teal" /><h3 className="font-bold text-text">{t('researchHub.decisions')}</h3></div><div className="mt-4 space-y-2">{analysis.meeting_intelligence.key_decisions.map((item) => <button type="button" key={item.id} onClick={() => chooseEvidence(item.evidence[0])} className={cn('w-full rounded-xl border p-3 text-left transition', selectedEvidence === item.evidence[0] ? 'border-accent-cyan/35 bg-accent-cyan/[0.05]' : 'border-ice/[0.07] bg-bg/20 hover:border-ice/[0.14]')}><span className="font-mono text-[10px] font-semibold text-accent-cyan">[{item.timestamp}]</span><p className="mt-2 text-sm font-semibold leading-5 text-text">{item.decision}</p><p className="mt-2 text-[10px] text-fog">{item.speaker}</p></button>)}</div></div>
              <div className="min-w-0 rounded-3xl border border-ice/[0.08] bg-card/[0.025] p-4 sm:p-5"><div className="flex items-center gap-2"><ListChecks size={17} className="text-accent-indigo" /><h3 className="font-bold text-text">{t('researchHub.actions')}</h3></div><div className="mt-4 space-y-2">{analysis.meeting_intelligence.action_items.map((item) => <button type="button" key={item.id} onClick={() => chooseEvidence(item.evidence[0])} className={cn('w-full rounded-xl border p-3 text-left transition', selectedEvidence === item.evidence[0] ? 'border-accent-cyan/35 bg-accent-cyan/[0.05]' : 'border-ice/[0.07] bg-bg/20 hover:border-ice/[0.14]')}><div className="flex items-start gap-3"><span className="font-mono text-[10px] font-semibold text-accent-cyan">[{item.timestamp}]</span><span className="ml-auto text-[10px] text-fog">{item.deadline ?? t('researchHub.noDeadline')}</span></div><p className="mt-2 text-sm font-semibold leading-5 text-text">{item.task}</p><p className="mt-2 text-[11px] leading-5 text-muted">{item.discussion_context}</p><p className="mt-2 text-[10px] text-fog">{t('researchHub.owner')}: {item.owner}</p></button>)}</div></div>
            </section>
            <section className="rounded-3xl border border-ice/[0.08] bg-panel/35 p-4 sm:p-5"><div className="flex items-center gap-2"><Users size={17} className="text-accent-cyan" /><h3 className="font-bold text-text">{t('researchHub.speakers')}</h3></div><div className="mt-4 grid gap-3 md:grid-cols-2">{analysis.meeting_intelligence.speaker_insights.map((speaker) => <button type="button" key={speaker.speaker} onClick={() => chooseEvidence(speaker.evidence[0])} className="rounded-2xl border border-ice/[0.07] bg-bg/20 p-4 text-left transition hover:border-accent-cyan/30"><div className="flex items-center gap-3"><span className="flex h-9 w-9 items-center justify-center rounded-xl bg-accent-indigo/10 text-sm font-bold text-accent-indigo">{speaker.speaker.charAt(0)}</span><p className="font-semibold text-text">{speaker.speaker}</p></div><ul className="mt-3 space-y-2">{speaker.key_points.map((point) => <li key={point} className="text-xs leading-5 text-muted">{point}</li>)}</ul></button>)}</div></section>
            <section className="overflow-hidden rounded-3xl border border-ice/[0.09] bg-panel/65 p-4 sm:p-6" aria-labelledby="audio-overview-title">
              <div className="flex flex-col gap-4 sm:flex-row sm:items-center"><button type="button" onClick={() => playing ? stopPlayback() : speakFrom(activeLine)} className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-accent-indigo text-white shadow-btn transition hover:brightness-110 active:scale-[0.97]" aria-label={playing ? t('researchHub.pause') : t('researchHub.play')}>{playing ? <Pause size={20} /> : <Play size={20} className="translate-x-px" />}</button><div className="min-w-0 flex-1"><div className="flex items-center gap-2"><AudioLines size={16} className="text-accent-cyan" /><h2 id="audio-overview-title" className="truncate font-bold text-text">{analysis.audio_overview_script.title}</h2></div><p className="mt-1 text-xs text-muted">{t('researchHub.audioHint')} / {t('researchHub.minutes', { count: Math.round(analysis.audio_overview_script.target_duration_seconds / 60) })}</p></div></div>
              <div className="mt-5 flex h-14 items-center gap-1 overflow-hidden rounded-xl bg-bg/35 px-3" aria-hidden="true">{WAVEFORM.map((height, index) => <span key={index} className={cn('w-1 flex-1 rounded-full bg-accent-cyan/25 transition-[height,opacity] duration-300', playing && 'animate-pulse bg-accent-cyan/60 motion-reduce:animate-none')} style={{ height: `${height}px`, animationDelay: `${index * 35}ms` }} />)}</div>
              <div className="mt-4 grid gap-2">{analysis.audio_overview_script.dialogue.map((line, index) => <button type="button" key={line.sequence} onClick={() => { stopPlayback(); setActiveLine(index); chooseEvidence(line.evidence[0]) }} className={cn('grid min-w-0 grid-cols-[72px_minmax(0,1fr)] gap-3 rounded-xl border px-3 py-3 text-left transition', activeLine === index ? 'border-accent-cyan/30 bg-accent-cyan/[0.05]' : 'border-transparent hover:bg-white/[0.025]')}><span className={cn('text-[10px] font-bold', line.host === 'Host A' ? 'text-accent-cyan' : 'text-violet')}>{line.host === 'Host A' ? t('researchHub.hostA') : t('researchHub.hostB')}</span><span className="min-w-0 text-xs leading-5 text-muted">{line.text}</span></button>)}</div>
            </section>
          </>}
        </main>

        <aside className="min-w-0 rounded-3xl border border-ice/[0.08] bg-panel/55 p-4 sm:p-5 xl:sticky xl:top-24 xl:self-start" aria-labelledby="grounding-inspector-title">
          <div className="flex items-center gap-2"><Quote size={17} className="text-accent-cyan" /><h2 id="grounding-inspector-title" className="font-bold text-text">{t('researchHub.grounding')}</h2></div>
          <p className="mt-2 text-xs leading-5 text-muted">{t('researchHub.groundingHint')}</p>
          {!selectedEvidence ? <div className="mt-5 rounded-2xl border border-dashed border-ice/[0.1] p-5 text-center"><Link2 size={22} className="mx-auto text-fog" /><p className="mt-2 text-xs leading-5 text-muted">{t('researchHub.nothingSelected')}</p></div> : <div className="mt-5 space-y-4">
            <div className="rounded-2xl border border-accent-cyan/20 bg-accent-cyan/[0.04] p-4"><p className="text-[10px] font-semibold text-fog">{t('researchHub.source')}</p><div className="mt-2 flex items-center gap-2"><span className="flex h-8 w-8 items-center justify-center rounded-lg bg-bg/40 text-accent-cyan">{selectedSource ? (() => { const Icon = sourceIcon(selectedSource.kind); return <Icon size={15} /> })() : <FileText size={15} />}</span><p className="min-w-0 flex-1 truncate text-xs font-semibold text-text">{selectedSource?.title ?? selectedEvidence.source_id}</p></div></div>
            <div><p className="text-[10px] font-semibold text-fog">{evidenceLocator(selectedEvidence, t)}</p><blockquote className="mt-2 rounded-2xl border border-ice/[0.08] bg-bg/30 p-4 text-sm leading-6 text-text">“{selectedEvidence.quote}”</blockquote></div>
          </div>}
        </aside>
      </div>
    </div>
  )
}

export function ResearchNotebookHub({ initialFiles, autoAnalyze = false }: { initialFiles?: File[]; autoAnalyze?: boolean } = {}) {
  const { lang } = useI18n()
  return <ResearchNotebookWorkspace key={lang} initialFiles={initialFiles} autoAnalyze={autoAnalyze} />
}
