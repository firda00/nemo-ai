import { useRef, useState } from 'react'
import { Upload, FileText, Download, Loader2, Sparkles, RotateCcw, X } from 'lucide-react'
import { useI18n } from '../../i18n'
import { supabase, isSupabaseEnabled } from '../../lib/supabase'
import { extractText, KNOWLEDGE_ACCEPT } from '../../lib/extractText'
import { Button } from '../ui/Button'
import type { PlatformAgent } from '../../types/platform'

const live = isSupabaseEnabled

/**
 * Agent edits a file: the file is extracted to text in the browser, sent with an
 * instruction to `edit-file` (free models, token-guarded), and the edited result
 * is shown + downloadable. No external keys.
 */
export function FileRunner({ agent }: { agent: PlatformAgent }) {
  const { t } = useI18n()
  const inputRef = useRef<HTMLInputElement>(null)
  const [filename, setFilename] = useState('')
  const [content, setContent] = useState('')
  const [reading, setReading] = useState(false)
  const [instruction, setInstruction] = useState('')
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState('')
  const [error, setError] = useState('')

  const pick = async (file: File) => {
    setError('')
    setResult('')
    setReading(true)
    try {
      const text = await extractText(file)
      setFilename(file.name)
      setContent(text)
    } catch {
      setError(t('platform.files.readError'))
    } finally {
      setReading(false)
    }
  }

  const run = async () => {
    if (!content || instruction.trim().length < 2 || busy) return
    setBusy(true)
    setError('')
    setResult('')
    try {
      if (!live || !supabase) {
        await new Promise((r) => setTimeout(r, 800))
        setResult(`# ${instruction}\n\n${content.slice(0, 500)}`)
        return
      }
      const { data, error: err } = await supabase.functions.invoke('edit-file', {
        body: { instruction: instruction.trim(), filename, content, model: agent.model, agent_id: agent.id },
      })
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const d = data as any
      if (err || !d?.ok) {
        setError(t('platform.files.error'))
        return
      }
      setResult(String(d.result ?? ''))
    } finally {
      setBusy(false)
    }
  }

  const download = () => {
    const blob = new Blob([result], { type: 'text/plain;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `edited-${filename || 'file.txt'}`
    a.click()
    URL.revokeObjectURL(url)
  }

  const reset = () => {
    setFilename('')
    setContent('')
    setInstruction('')
    setResult('')
    setError('')
  }

  return (
    <div className="card space-y-5 rounded-2xl p-6">
      <div>
        <h2 className="flex items-center gap-2 font-normal text-text"><FileText size={16} className="text-violet" /> {t('platform.files.title')}</h2>
        <p className="mt-0.5 text-xs text-muted">{t('platform.files.subtitle')}</p>
      </div>

      {/* file pick */}
      {!filename ? (
        <button
          onClick={() => inputRef.current?.click()}
          className="flex w-full flex-col items-center justify-center gap-2 rounded-2xl border border-dashed border-ice/15 bg-ice/[0.02] py-10 text-muted transition-colors hover:border-violet/40"
        >
          {reading ? <Loader2 size={22} className="animate-spin" /> : <Upload size={22} />}
          <span className="text-sm">{reading ? t('platform.files.reading') : t('platform.files.upload')}</span>
          <span className="text-[11px] text-fog">{t('platform.files.uploadHint')}</span>
        </button>
      ) : (
        <div className="flex items-center gap-3 rounded-xl border border-ice/[0.08] bg-ice/[0.02] px-3 py-2.5">
          <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-ice/[0.06] text-muted"><FileText size={15} /></span>
          <span className="min-w-0 flex-1 truncate text-sm text-text">{filename}</span>
          <span className="text-[11px] text-muted">{content.length.toLocaleString()} ch</span>
          <button onClick={reset} className="rounded-lg p-1.5 text-muted hover:bg-ice/[0.06] hover:text-danger"><X size={15} /></button>
        </div>
      )}
      <input ref={inputRef} type="file" accept={KNOWLEDGE_ACCEPT} className="hidden" onChange={(e) => e.target.files?.[0] && pick(e.target.files[0])} />

      {/* instruction */}
      <label className="block space-y-1.5">
        <span className="block text-xs font-normal text-muted">{t('platform.files.instruction')}</span>
        <textarea
          value={instruction}
          onChange={(e) => setInstruction(e.target.value)}
          rows={2}
          placeholder={t('platform.files.instructionPh')}
          className="glass w-full rounded-xl px-3 py-2.5 text-sm text-text outline-none placeholder:text-muted/70 focus:border-violet/50 focus:shadow-glow"
        />
      </label>

      {error && <p className="rounded-lg bg-danger/10 px-3 py-2 text-center text-xs text-danger">{error}</p>}

      <Button onClick={run} disabled={busy || !content || instruction.trim().length < 2}>
        {busy ? <Loader2 size={16} className="animate-spin" /> : <Sparkles size={16} />} {busy ? t('platform.files.running') : t('platform.files.run')}
      </Button>

      {/* result */}
      {result && (
        <div className="space-y-3 border-t border-ice/10 pt-4">
          <div className="flex items-center justify-between">
            <p className="text-sm font-medium text-text">{t('platform.files.result')}</p>
            <div className="flex items-center gap-2">
              <button onClick={download} className="inline-flex items-center gap-1.5 rounded-lg bg-brand px-2.5 py-1.5 text-xs font-medium text-white">
                <Download size={13} /> {t('platform.files.download')}
              </button>
              <button onClick={() => setResult('')} className="rounded-lg border border-ice/12 p-1.5 text-muted hover:text-text"><RotateCcw size={14} /></button>
            </div>
          </div>
          <pre className="max-h-[420px] overflow-auto whitespace-pre-wrap rounded-xl border border-ice/[0.08] bg-black/30 p-3 text-[12px] leading-relaxed text-text">{result}</pre>
        </div>
      )}
    </div>
  )
}
