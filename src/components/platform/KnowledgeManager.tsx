import { useEffect, useRef, useState } from 'react'
import { FileText, HelpCircle, Link2, Plus, Trash2, X, Upload, Loader2 } from 'lucide-react'
import { useI18n } from '../../i18n'
import { useToast } from '../ui/Toast'
import { Button } from '../ui/Button'
import { supabase, isSupabaseEnabled } from '../../lib/supabase'
import { extractText, KNOWLEDGE_ACCEPT } from '../../lib/extractText'
import { cn } from '../../lib/cn'

type Source = 'file' | 'faq' | 'link'
interface Doc {
  id: string
  source: Source
  name: string
  content: string
  status: string
}

const live = isSupabaseEnabled
const srcIcon: Record<Source, typeof FileText> = { file: FileText, faq: HelpCircle, link: Link2 }
const inputCls =
  'glass w-full rounded-xl px-3 py-2.5 text-sm text-text outline-none placeholder:text-muted/70 focus:border-violet/50 focus:shadow-glow'

let demoId = 0

/**
 * Per-agent knowledge base (RAG). Files (PDF/Word/Excel/TXT/CSV) are parsed to
 * text IN THE BROWSER, then the extracted text is stored in knowledge_docs.content
 * — the agent runtime injects it into the prompt. FAQ = pasted text; link = a URL
 * whose public text is fetched server-side (covers shared Google Drive/Docs links).
 */
export function KnowledgeManager({ agentId }: { agentId: string }) {
  const { t } = useI18n()
  const toast = useToast()
  const [docs, setDocs] = useState<Doc[]>([])
  const [loading, setLoading] = useState(live)
  const [uploading, setUploading] = useState(false)
  const [form, setForm] = useState<{ source: 'faq' | 'link'; name: string; content: string } | null>(null)
  const [savingForm, setSavingForm] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    let on = true
    if (live && supabase && agentId) {
      supabase
        .from('knowledge_docs')
        .select('id, source, name, content, status')
        .eq('owner_id', agentId)
        .order('created_at', { ascending: false })
        .then(({ data }) => {
          if (on) {
            setDocs((data ?? []) as Doc[])
            setLoading(false)
          }
        })
    } else {
      window.setTimeout(() => setLoading(false), 0)
    }
    return () => {
      on = false
    }
  }, [agentId])

  const insertDoc = async (source: Source, name: string, content: string): Promise<Doc | null> => {
    if (live && supabase) {
      const { data, error } = await supabase
        .from('knowledge_docs')
        .insert({ owner_type: 'agent', owner_id: agentId, source, name, content, status: 'indexing' })
        .select('id, source, name, content, status')
        .single()
      if (error || !data) {
        toast(error?.message ?? 'error')
        return null
      }
      // Real RAG: chunk + embed the doc into vectors so the agent can retrieve it semantically.
      try {
        const { data: idx } = await supabase.functions.invoke('knowledge-index', { body: { action: 'index', doc_id: data.id } })
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const chunks = (idx as any)?.chunks
        return { ...(data as Doc), status: chunks ? 'indexed' : 'error' }
      } catch {
        return { ...(data as Doc), status: 'indexed' } // stored; retrieval falls back to raw text
      }
    }
    return { id: `kd${++demoId}`, source, name, content, status: 'indexed' }
  }

  const onFiles = async (files: FileList | null) => {
    if (!files || !files.length) return
    setUploading(true)
    try {
      for (const file of Array.from(files)) {
        try {
          const content = await extractText(file)
          if (!content.trim()) {
            toast(t('platform.knowledge.extractError'))
            continue
          }
          const doc = await insertDoc('file', file.name, content)
          if (doc) setDocs((d) => [doc, ...d])
        } catch {
          toast(t('platform.knowledge.extractError'))
        }
      }
    } finally {
      setUploading(false)
      if (fileRef.current) fileRef.current.value = ''
    }
  }

  const submitForm = async () => {
    if (!form || !form.name.trim()) return
    setSavingForm(true)
    try {
      let content = form.content
      if (form.source === 'link' && live && supabase) {
        // try to ingest the URL's text server-side; fall back to storing the URL
        const { data } = await supabase.functions.invoke('fetch-url', { body: { url: form.content } })
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const fetched = (data as any)?.content as string | undefined
        if (fetched && fetched.trim()) content = fetched
        else toast(t('platform.knowledge.fetchError'))
      }
      const doc = await insertDoc(form.source, form.name, content)
      if (doc) setDocs((d) => [doc, ...d])
      setForm(null)
    } finally {
      setSavingForm(false)
    }
  }

  const removeDoc = async (id: string) => {
    setDocs((d) => d.filter((x) => x.id !== id))
    if (live && supabase) await supabase.from('knowledge_docs').delete().eq('id', id)
    toast(t('platform.toast.deleted'))
  }

  return (
    <div className="space-y-4">
      <div>
        <h2 className="font-normal text-text">{t('platform.editor.knowledgeTitle')}</h2>
        <p className="mt-0.5 text-xs text-muted">{t('platform.knowledge.uploadHint')}</p>
      </div>

      <input ref={fileRef} type="file" accept={KNOWLEDGE_ACCEPT} multiple className="hidden" onChange={(e) => onFiles(e.target.files)} />
      <div className="flex flex-wrap gap-2">
        <Button size="sm" onClick={() => fileRef.current?.click()} disabled={uploading}>
          {uploading ? <Loader2 size={14} className="animate-spin" /> : <Upload size={14} />}
          {uploading ? t('platform.knowledge.indexing') : t('platform.knowledge.uploadFile')}
        </Button>
        <Button size="sm" variant="subtle" onClick={() => setForm({ source: 'faq', name: '', content: '' })}>
          <Plus size={14} /> {t('platform.knowledge.addFaq')}
        </Button>
        <Button size="sm" variant="subtle" onClick={() => setForm({ source: 'link', name: '', content: '' })}>
          <Plus size={14} /> {t('platform.knowledge.addLink')}
        </Button>
      </div>

      {loading ? (
        <p className="py-8 text-center text-sm text-muted">{t('common.loading')}</p>
      ) : docs.length === 0 ? (
        <p className="rounded-xl border border-dashed border-ice/10 py-10 text-center text-sm text-muted">{t('platform.knowledge.empty')}</p>
      ) : (
        <ul className="space-y-2">
          {docs.map((d) => {
            const Icon = srcIcon[d.source] ?? FileText
            return (
              <li key={d.id} className="flex items-center gap-3 rounded-xl border border-ice/[0.07] bg-ice/[0.02] px-3 py-2.5">
                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-ice/[0.06] text-muted">
                  <Icon size={15} />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-text">{d.name}</p>
                  <p className="text-[11px] text-muted">
                    {d.content ? `${d.content.replace(/\s+/g, ' ').trim().slice(0, 64)}${d.content.length > 64 ? '…' : ''}` : t('platform.knowledge.src.' + d.source)}
                  </p>
                </div>
                <span className="shrink-0 rounded-full bg-teal/15 px-2 py-0.5 text-[10px] font-normal text-teal">{t('platform.knowledge.indexed')}</span>
                <button onClick={() => removeDoc(d.id)} className="rounded-lg p-1.5 text-muted hover:bg-ice/[0.06] hover:text-danger">
                  <Trash2 size={15} />
                </button>
              </li>
            )
          })}
        </ul>
      )}

      {/* FAQ / link modal */}
      {form && (
        <div className="fixed inset-0 z-[90] flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={() => setForm(null)} />
          <div className="card relative w-full max-w-md rounded-2xl p-6 animate-fadeInUp">
            <div className="flex items-center justify-between">
              <h3 className="font-medium text-text">{t('platform.knowledge.src.' + form.source)}</h3>
              <button onClick={() => setForm(null)} className="rounded-lg p-1.5 text-muted hover:bg-ice/[0.06] hover:text-text">
                <X size={18} />
              </button>
            </div>
            <div className="mt-4 space-y-3">
              <input autoFocus value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder={t('platform.knowledge.namePh')} className={inputCls} />
              {form.source === 'link' ? (
                <>
                  <input value={form.content} onChange={(e) => setForm({ ...form, content: e.target.value })} placeholder={t('platform.knowledge.urlPh')} className={inputCls} />
                  <p className="text-[11px] leading-snug text-muted">{t('platform.knowledge.urlNote')}</p>
                </>
              ) : (
                <textarea value={form.content} onChange={(e) => setForm({ ...form, content: e.target.value })} rows={5} placeholder={t('platform.knowledge.contentPh')} className={cn(inputCls, 'resize-none')} />
              )}
            </div>
            <div className="mt-5 flex justify-end gap-2">
              <Button size="sm" variant="ghost" onClick={() => setForm(null)}>
                {t('common.cancel')}
              </Button>
              <Button size="sm" onClick={submitForm} disabled={savingForm || !form.name.trim() || (form.source === 'link' && !form.content.trim())}>
                {savingForm ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />} {t('platform.knowledge.add')}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
