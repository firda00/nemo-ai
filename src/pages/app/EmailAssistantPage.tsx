import { useEffect, useState } from 'react'
import { AlertTriangle, CheckCircle2, Inbox, Loader2, Mail, RefreshCw, Sparkles } from 'lucide-react'
import { supabase } from '../../lib/supabase'
import { trackEvent } from '../../lib/telemetry'
import { Button } from '../../components/ui/Button'
import { cn } from '../../lib/cn'

type EmailRow = { id: string; threadId: string; from: string; subject: string; date: string; snippet: string; category: 'urgent' | 'reply' | 'fyi' }
type Suggestion = { summary: string; risk: 'low' | 'review'; draft: string }

export default function EmailAssistantPage() {
  const [emails, setEmails] = useState<EmailRow[]>([])
  const [selected, setSelected] = useState<EmailRow | null>(null)
  const [suggestion, setSuggestion] = useState<Suggestion | null>(null)
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState('')
  const [message, setMessage] = useState('')
  const [connected, setConnected] = useState<boolean | null>(null)
  const [needsReconnect, setNeedsReconnect] = useState(false)

  const load = async () => {
    if (!supabase) return
    setBusy('load'); setMessage('')
    const status = await supabase.functions.invoke('google-oauth', { body: { action: 'status' } })
    const st = status.data as { connected?: boolean; scopes?: string } | null
    setConnected(Boolean(st?.connected))
    setNeedsReconnect(Boolean(st?.connected && !String(st?.scopes ?? '').includes('gmail.readonly')))
    if (!st?.connected || !String(st?.scopes ?? '').includes('gmail.readonly')) { setBusy(''); return }
    const { data, error } = await supabase.functions.invoke('google-tools', { body: { action: 'gmail_inbox', limit: 15 } })
    const result = data as { ok?: boolean; emails?: EmailRow[]; error?: string } | null
    if (error || !result?.ok) setMessage(result?.error ?? error?.message ?? 'Не удалось прочитать Gmail.')
    else { setEmails(result.emails ?? []); void trackEvent('email_inbox_reviewed', { count: result.emails?.length ?? 0 }) }
    setBusy('')
  }

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0)
    return () => window.clearTimeout(timer)
  }, [])

  const reconnect = async () => {
    if (!supabase) return
    setBusy('reconnect')
    const { data } = await supabase.functions.invoke('google-oauth', { body: { action: 'authorize' } })
    const url = (data as { url?: string } | null)?.url
    if (url) window.location.href = url
    else { setMessage('Google OAuth пока не настроен. Откройте «Интеграции».'); setBusy('') }
  }

  const analyze = async (email: EmailRow) => {
    if (!supabase) return
    setSelected(email); setSuggestion(null); setDraft(''); setBusy(email.id); setMessage('')
    const { data, error } = await supabase.functions.invoke('google-tools', { body: { action: 'gmail_suggest', from: email.from, subject: email.subject, snippet: email.snippet } })
    const result = data as { ok?: boolean; suggestion?: Suggestion; error?: string } | null
    if (error || !result?.ok || !result.suggestion) setMessage(result?.error ?? error?.message ?? 'Анализ не выполнен.')
    else { setSuggestion(result.suggestion); setDraft(result.suggestion.draft); void trackEvent('email_reply_suggested', { risk: result.suggestion.risk }) }
    setBusy('')
  }

  const createDraft = async () => {
    if (!supabase || !selected || !draft.trim()) return
    setBusy('draft'); setMessage('')
    const { data, error } = await supabase.functions.invoke('google-tools', { body: { action: 'gmail_create_draft', to: selected.from, subject: selected.subject.startsWith('Re:') ? selected.subject : `Re: ${selected.subject}`, body: draft, thread_id: selected.threadId } })
    const result = data as { ok?: boolean; error?: string } | null
    setMessage(!error && result?.ok ? 'Черновик создан в Gmail. Проверьте его и отправьте вручную.' : result?.error ?? error?.message ?? 'Не удалось создать черновик.')
    if (!error && result?.ok) void trackEvent('email_draft_created')
    setBusy('')
  }

  return (
    <div className="container-page max-w-6xl py-8">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div><h1 className="text-2xl font-medium text-text">Email Assistant</h1><p className="mt-1 max-w-2xl text-sm text-muted">Разбирает входящие, выделяет срочные письма и готовит ответ. Отправка всегда остаётся под вашим контролем.</p></div>
        <Button variant="ghost" onClick={load} disabled={Boolean(busy)}><RefreshCw size={15} className={busy === 'load' ? 'animate-spin' : ''} /> Обновить</Button>
      </div>

      {connected === false && <section className="card mt-6 rounded-2xl p-5"><Mail className="text-violet" /><h2 className="mt-3 font-medium text-text">Сначала подключите Google</h2><p className="mt-1 text-sm text-muted">Nemo запросит только нужные права Gmail. Пароль Google не передаётся Nemo.</p><Button to="/app/settings?tab=integrations&section=services" className="mt-4">Открыть интеграции</Button></section>}
      {needsReconnect && <section className="mt-6 rounded-2xl border border-amber/25 bg-amber/10 p-5"><AlertTriangle className="text-amber" /><h2 className="mt-3 font-medium text-text">Нужно один раз переподключить Google</h2><p className="mt-1 text-sm text-muted">Старое подключение разрешало только отправку. Новому ассистенту нужны чтение входящих и создание черновиков.</p><Button onClick={reconnect} disabled={Boolean(busy)} className="mt-4">{busy === 'reconnect' ? 'Открываю…' : 'Дать новые права'}</Button></section>}
      {message && <div className="mt-5 rounded-xl border border-white/10 bg-white/[0.04] p-3 text-sm text-text">{message}</div>}

      {connected && !needsReconnect && <div className="mt-6 grid gap-5 lg:grid-cols-[1.05fr_.95fr]">
        <section className="card rounded-2xl p-4">
          <div className="flex items-center justify-between"><h2 className="flex items-center gap-2 font-medium text-text"><Inbox size={18} /> Входящие за 30 дней</h2><span className="text-xs text-muted">{emails.length}</span></div>
          <div className="mt-4 max-h-[650px] space-y-2 overflow-y-auto pr-1">
            {busy === 'load' && <div className="grid h-40 place-items-center text-muted"><Loader2 className="animate-spin" /></div>}
            {!busy && emails.length === 0 && <p className="py-12 text-center text-sm text-muted">Новых писем не найдено.</p>}
            {emails.map((email) => <button key={email.id} onClick={() => analyze(email)} className={cn('w-full rounded-xl border p-3 text-left transition-colors', selected?.id === email.id ? 'border-violet bg-violet/10' : 'border-white/10 hover:bg-white/[0.04]')}>
              <div className="flex items-center gap-2"><span className={cn('rounded-full px-2 py-0.5 text-[10px] uppercase', email.category === 'urgent' ? 'bg-rose-400/15 text-rose-300' : email.category === 'reply' ? 'bg-amber/15 text-amber' : 'bg-blue/15 text-blue')}>{email.category === 'urgent' ? 'срочно' : email.category === 'reply' ? 'нужен ответ' : 'к сведению'}</span><span className="truncate text-xs text-muted">{email.from}</span></div>
              <p className="mt-2 truncate text-sm font-medium text-text">{email.subject || '(без темы)'}</p><p className="mt-1 line-clamp-2 text-xs text-muted">{email.snippet}</p>
            </button>)}
          </div>
        </section>

        <section className="card rounded-2xl p-5">
          {!selected && <div className="grid min-h-80 place-items-center text-center"><div><Sparkles className="mx-auto text-violet" /><p className="mt-3 text-sm text-muted">Выберите письмо — агент подготовит краткое резюме и черновик ответа.</p></div></div>}
          {selected && busy === selected.id && <div className="grid min-h-80 place-items-center text-muted"><Loader2 className="animate-spin" /></div>}
          {selected && suggestion && <>
            <div className="flex items-center gap-2"><Sparkles size={18} className="text-violet" /><h2 className="font-medium text-text">Предложение агента</h2></div>
            <div className={cn('mt-4 rounded-xl border p-3 text-sm', suggestion.risk === 'low' ? 'border-teal/20 bg-teal/10 text-teal' : 'border-amber/20 bg-amber/10 text-amber')}>{suggestion.risk === 'low' ? <CheckCircle2 size={15} className="mr-2 inline" /> : <AlertTriangle size={15} className="mr-2 inline" />}{suggestion.summary}</div>
            <label className="mt-5 block text-xs font-medium uppercase tracking-wide text-muted">Черновик — отредактируйте перед сохранением</label>
            <textarea value={draft} onChange={(e) => setDraft(e.target.value)} rows={12} className="mt-2 w-full rounded-xl border border-white/10 bg-bg/60 p-3 text-sm leading-6 text-text outline-none focus:border-violet" />
            <Button onClick={createDraft} disabled={busy === 'draft' || !draft.trim()} fullWidth className="mt-3">{busy === 'draft' ? <Loader2 size={15} className="animate-spin" /> : <Mail size={15} />} Создать черновик в Gmail</Button>
            <p className="mt-2 text-center text-[11px] text-muted">Nemo не отправляет письмо автоматически.</p>
          </>}
        </section>
      </div>}
    </div>
  )
}
