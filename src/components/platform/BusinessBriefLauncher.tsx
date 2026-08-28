import { useRef, useState } from 'react'
import { Mic, MicOff, Sparkles } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import { Button } from '../ui/Button'
import { BUSINESS_INTENT_STORAGE_KEY, createBusinessIntent } from '../../lib/business-intent'
import type { BusinessIntentSource } from '../../types/business-intent'

type SpeechRecognitionEventLike = { results: ArrayLike<{ 0: { transcript: string } }> }
type SpeechRecognitionLike = {
  lang: string
  interimResults: boolean
  continuous: boolean
  start(): void
  stop(): void
  onresult: ((event: SpeechRecognitionEventLike) => void) | null
  onend: (() => void) | null
  onerror: (() => void) | null
}

type SpeechRecognitionConstructor = new () => SpeechRecognitionLike

export function BusinessBriefLauncher() {
  const navigate = useNavigate()
  const [brief, setBrief] = useState('')
  const [listening, setListening] = useState(false)
  const [clarification, setClarification] = useState<string[]>([])
  const [inputSource, setInputSource] = useState<BusinessIntentSource>('web_text')
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null)

  const launch = () => {
    const clean = brief.trim()
    if (clean.length < 8) return
    const intent = createBusinessIntent(clean, { source: inputSource })
    setClarification(intent.clarificationQuestions)
    if (intent.clarificationRequired) return
    window.sessionStorage.setItem(BUSINESS_INTENT_STORAGE_KEY, JSON.stringify(intent))
    navigate('/app/forge')
  }

  const toggleVoice = () => {
    if (listening) {
      recognitionRef.current?.stop()
      return
    }
    const browser = window as Window & {
      SpeechRecognition?: SpeechRecognitionConstructor
      webkitSpeechRecognition?: SpeechRecognitionConstructor
    }
    const Recognition = browser.SpeechRecognition ?? browser.webkitSpeechRecognition
    if (!Recognition) return
    const recognition = new Recognition()
    recognition.lang = document.documentElement.lang === 'uz' ? 'uz-UZ' : document.documentElement.lang === 'en' ? 'en-US' : 'ru-RU'
    recognition.interimResults = false
    recognition.continuous = false
    recognition.onresult = (event) => {
      const transcript = event.results[0]?.[0]?.transcript?.trim() ?? ''
      if (transcript) {
        setBrief((current) => `${current}${current ? ' ' : ''}${transcript}`)
        setInputSource('web_voice')
        setClarification([])
      }
    }
    recognition.onend = () => setListening(false)
    recognition.onerror = () => setListening(false)
    recognitionRef.current = recognition
    setListening(true)
    recognition.start()
  }

  const voiceAvailable = typeof window !== 'undefined' && ('SpeechRecognition' in window || 'webkitSpeechRecognition' in window)

  return (
    <section className="card mt-6 rounded-3xl p-4 sm:p-6" aria-labelledby="business-brief-title">
      <div className="flex items-start gap-3">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-cyan/10 text-cyan"><Sparkles size={18} /></span>
        <div>
          <h2 id="business-brief-title" className="text-lg font-bold text-text">Поставьте задачу обычными словами</h2>
          <p className="mt-1 text-sm text-muted">Nemo соберёт роли, план и бюджет, а внешние действия остановит на согласовании.</p>
        </div>
      </div>
      <div className="mt-4 flex flex-col gap-2 sm:flex-row">
        <textarea
          value={brief}
          onChange={(event) => { setBrief(event.target.value); setInputSource('web_text'); setClarification([]) }}
          rows={3}
          maxLength={4_000}
          placeholder="Например: сделай акцию на пятницу для постоянных клиентов и подготовь рассылку"
          className="min-h-24 flex-1 resize-y rounded-2xl border border-ice/10 bg-panel/60 px-4 py-3 text-sm leading-6 text-text outline-none placeholder:text-fog focus:border-cyan/40"
        />
        <div className="flex gap-2 sm:w-44 sm:flex-col">
          <Button onClick={launch} disabled={brief.trim().length < 8} className="flex-1"><Sparkles size={15} />Собрать план</Button>
          <Button type="button" variant="outline" onClick={toggleVoice} disabled={!voiceAvailable} className="flex-1" title={voiceAvailable ? 'Продиктовать задачу' : 'Голосовой ввод не поддерживается браузером'}>
            {listening ? <MicOff size={15} /> : <Mic size={15} />}{listening ? 'Стоп' : 'Голосом'}
          </Button>
        </div>
      </div>
      {clarification.length > 0 && (
        <p className="mt-3 text-xs leading-5 text-amber-300">
          Для точного плана Nemo уточнит: {clarification.join(' ')}
        </p>
      )}
    </section>
  )
}
