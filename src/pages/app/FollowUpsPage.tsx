import { useEffect, useState, useCallback } from 'react'
import { Repeat, Loader2, Send, Mail, Play, Square, Sparkles, Clock, CheckCircle2, XCircle, MessageSquare } from 'lucide-react'
import { useSearchParams } from 'react-router-dom'
import { supabase, isSupabaseEnabled } from '../../lib/supabase'
import { useI18n } from '../../i18n'
import { cn } from '../../lib/cn'

const live = isSupabaseEnabled

interface FollowUp {
  id: string
  channel: 'telegram' | 'email'
  target: string | null
  goal: string
  status: 'active' | 'processing' | 'done' | 'stopped' | 'converted'
  step: number
  max_steps: number
  next_run_at: string
  last_sent_at: string | null
  last_message: string | null
  created_at: string
}

interface DialogueOption {
  id: string
  customer_name: string | null
  external_id: string | null
  updated_at: string
}

const CADENCE_PRESETS: { id: string; hours: number[] }[] = [
  { id: 'fast', hours: [1, 24, 72] },
  { id: 'std', hours: [24, 72, 168] },
  { id: 'slow', hours: [48, 120, 240] },
]

const STATUS_META: Record<FollowUp['status'], { cls: string; icon: typeof Clock }> = {
  active: { cls: 'text-violet bg-violet/10', icon: Clock },
  processing: { cls: 'text-cyan bg-cyan/10', icon: Clock },
  done: { cls: 'text-muted bg-white/5', icon: CheckCircle2 },
  stopped: { cls: 'text-danger bg-danger/10', icon: XCircle },
  converted: { cls: 'text-teal bg-teal/10', icon: MessageSquare },
}

export default function FollowUpsPage() {
  const { t, lang } = useI18n()
  const [params] = useSearchParams()
  const [items, setItems] = useState<FollowUp[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [running, setRunning] = useState(false)
  const [runNote, setRunNote] = useState('')
  const [dialogues, setDialogues] = useState<DialogueOption[]>([])
  const [dialogueId, setDialogueId] = useState(() => params.get('dialogue') ?? '')
  const leadId = params.get('lead') ?? ''

  const [channel, setChannel] = useState<'telegram' | 'email'>('telegram')
  const [target, setTarget] = useState('')
  const [goal, setGoal] = useState('')
  const [cadenceId, setCadenceId] = useState('std')

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const call = useCallback(async (body: Record<string, unknown>): Promise<any> => {
    if (!live || !supabase) return null
    const { data, error: err } = await supabase.functions.invoke('follow-up', { body })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    if (err || !(data as any)?.ok) return { ok: false, error: err?.message ?? (data as any)?.error ?? t('followUpsPage.errorGeneric') }
    return data
  }, [t])

  // apply a list response to state (shared by the mount effect and manual refreshes)
  const apply = useCallback((r: { ok?: boolean; items?: FollowUp[]; error?: string } | null) => {
    if (r === null) { setError(t('followUpsPage.errLiveAccount')); setItems([]) }
    else if (r.ok) { setItems(r.items ?? []); setError('') }
    else setError(r.error ?? t('followUpsPage.errLoad'))
    setLoading(false)
  }, [t])
  const load = useCallback(async () => { apply(await call({ action: 'list' })) }, [call, apply])
  const loadDialogues = useCallback(async () => {
    if (!supabase) return
    const { data } = await supabase.from('dialogues').select('id, customer_name, external_id, updated_at').eq('channel', 'telegram').order('updated_at', { ascending: false }).limit(50)
    setDialogues((data ?? []) as DialogueOption[])
  }, [])

  // Fetch on mount inside an async callback (setState runs after the await, the
  // pattern the react-hooks rule allows), with a cleanup guard against unmount.
  useEffect(() => {
    let alive = true
    ;(async () => {
      const r = await call({ action: 'list' })
      if (alive) { apply(r); await loadDialogues() }
    })()
    return () => { alive = false }
  }, [call, apply, loadDialogues])

  const create = async () => {
    if (busy) return
    if (!target.trim() && !dialogueId) { setError(channel === 'telegram' ? t('followUpsPage.errNeedChatId') : t('followUpsPage.errNeedEmail')); return }
    if (goal.trim().length < 3) { setError(t('followUpsPage.errNeedGoal')); return }
    setBusy(true); setError('')
    const preset = CADENCE_PRESETS.find((p) => p.id === cadenceId) ?? CADENCE_PRESETS[1]
    const selected = dialogues.find((d) => d.id === dialogueId)
    const r = await call({ action: 'enqueue', channel, target: target.trim() || selected?.external_id || '', dialogue_id: dialogueId || undefined, lead_id: leadId || undefined, goal: goal.trim(), cadence_hours: preset.hours, max_steps: preset.hours.length })
    if (r?.ok) { setTarget(''); setGoal(''); setDialogueId(''); await load() }
    else setError(r?.error ?? t('followUpsPage.errCreate'))
    setBusy(false)
  }

  const stop = async (id: string) => {
    await call({ action: 'stop', id })
    await load()
  }

  const runNow = async () => {
    if (running) return
    const confirmed = window.confirm(lang === 'ru' ? 'Отправить следующее сообщение всем активным воронкам сейчас?' : lang === 'uz' ? 'Barcha faol voronkalarga keyingi xabarni hozir yuborilsinmi?' : 'Send the next message for every active funnel now?')
    if (!confirmed) return
    setRunning(true); setRunNote('')
    const r = await call({ action: 'run_mine', force: true })
    if (r?.ok) { setRunNote(t('followUpsPage.processedNow', { count: r.processed }) + (r.results ?? []).map((x: { status: string }) => x.status).join(', ')) }
    else setRunNote(r?.error ?? t('followUpsPage.errRun'))
    await load()
    setRunning(false)
  }

  const fmt = (iso: string | null) => {
    if (!iso) return '—'
    try { return new Date(iso).toLocaleString('ru-RU', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) } catch { return iso }
  }

  const active = items.filter((i) => i.status === 'active')

  return (
    <div className="container-page max-w-4xl py-8">
      <div className="flex flex-wrap items-center gap-3">
        <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-violet/15 text-violet"><Repeat size={20} /></span>
        <div className="flex-1">
          <h1 className="text-2xl font-semibold tracking-tight text-text">{t('followUpsPage.title')}</h1>
          <p className="text-sm text-muted">{t('followUpsPage.subtitle')}</p>
        </div>
        {active.length > 0 && (
          <button onClick={runNow} disabled={running} className="inline-flex items-center gap-2 rounded-xl border border-ice/12 px-3.5 py-2 text-sm font-medium text-muted transition hover:text-text disabled:opacity-40">
            {running ? <Loader2 size={15} className="animate-spin" /> : <Play size={15} />} {t('followUpsPage.runNowBtn')}
          </button>
        )}
      </div>

      <div className="mt-5 grid gap-2 sm:grid-cols-4">
        {(lang === 'ru'
          ? ['1. Выберите диалог', '2. Укажите цель', '3. Агент отправляет касания', '4. Ответ останавливает серию']
          : lang === 'uz'
            ? ['1. Dialogni tanlang', '2. Maqsadni kiriting', '3. Agent xabar yuboradi', '4. Javob seriyani toʻxtatadi']
            : ['1. Choose a dialogue', '2. Set the goal', '3. Agent sends touches', '4. A reply stops the sequence']
        ).map((step) => <div key={step} className="rounded-xl border border-ice/10 bg-white/[0.02] px-3 py-2 text-xs text-muted">{step}</div>)}
      </div>

      {/* create */}
      <div className="card mt-6 rounded-2xl p-5">
        <p className="mb-3 text-sm font-medium text-text">{t('followUpsPage.newFunnel')}</p>
        <div className="flex flex-wrap gap-2">
          <button onClick={() => setChannel('telegram')} className={cn('inline-flex items-center gap-2 rounded-xl border px-3.5 py-2 text-sm transition', channel === 'telegram' ? 'border-violet/60 bg-violet/10 text-text' : 'border-ice/10 text-muted hover:text-text')}>
            <Send size={15} /> Telegram
          </button>
          <button onClick={() => setChannel('email')} className={cn('inline-flex items-center gap-2 rounded-xl border px-3.5 py-2 text-sm transition', channel === 'email' ? 'border-violet/60 bg-violet/10 text-text' : 'border-ice/10 text-muted hover:text-text')}>
            <Mail size={15} /> Email
          </button>
        </div>
        {channel === 'telegram' && dialogues.length > 0 && (
          <label className="mt-3 block">
            <span className="mb-1 block text-[11px] font-medium uppercase tracking-wide text-muted">{lang === 'ru' ? 'Клиентский диалог' : lang === 'uz' ? 'Mijoz dialogi' : 'Customer dialogue'}</span>
            <select value={dialogueId} onChange={(e) => { const id = e.target.value; setDialogueId(id); const d = dialogues.find((x) => x.id === id); setTarget(d?.external_id ?? '') }} className="glass w-full rounded-xl px-3 py-2.5 text-sm text-text outline-none focus:border-violet/50">
              <option value="" className="bg-panel">{lang === 'ru' ? 'Выберите диалог — рекомендуется' : lang === 'uz' ? 'Dialogni tanlang — tavsiya etiladi' : 'Choose a dialogue — recommended'}</option>
              {dialogues.map((d) => <option key={d.id} value={d.id} className="bg-panel">{d.customer_name || d.external_id || d.id}</option>)}
            </select>
            <span className="mt-1 block text-[11px] text-teal">{lang === 'ru' ? 'Так воронка автоматически остановится, когда клиент ответит.' : lang === 'uz' ? 'Shunda mijoz javob berganda voronka avtomatik toʻxtaydi.' : 'This lets the funnel stop automatically when the customer replies.'}</span>
          </label>
        )}
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <label className="block">
            <span className="mb-1 block text-[11px] font-medium uppercase tracking-wide text-muted">{channel === 'telegram' ? t('followUpsPage.chatIdLabel') : t('followUpsPage.emailLabel')}</span>
            <input value={target} onChange={(e) => { setTarget(e.target.value); if (channel === 'telegram') setDialogueId('') }} placeholder={channel === 'telegram' ? '123456789' : 'client@example.com'} className="glass w-full rounded-xl px-3 py-2.5 text-sm text-text outline-none placeholder:text-fog focus:border-violet/50" />
            {channel === 'telegram' && !dialogueId && <span className="mt-1 block text-[10px] text-amber">{lang === 'ru' ? 'Ручной chat_id не позволяет надёжно определить ответ клиента.' : lang === 'uz' ? 'Qoʻlda kiritilgan chat_id mijoz javobini ishonchli aniqlamaydi.' : 'A manual chat_id cannot reliably detect the customer reply.'}</span>}
          </label>
          <label className="block">
            <span className="mb-1 block text-[11px] font-medium uppercase tracking-wide text-muted">{t('followUpsPage.cadenceLabel')}</span>
            <select value={cadenceId} onChange={(e) => setCadenceId(e.target.value)} className="glass w-full rounded-xl px-3 py-2.5 text-sm text-text outline-none focus:border-violet/50">
              {CADENCE_PRESETS.map((p) => <option key={p.id} value={p.id} className="bg-panel">{t(`followUpsPage.cadence_${p.id}`)}</option>)}
            </select>
          </label>
        </div>
        <label className="mt-3 block">
          <span className="mb-1 block text-[11px] font-medium uppercase tracking-wide text-muted">{t('followUpsPage.goalLabel')}</span>
          <textarea value={goal} onChange={(e) => setGoal(e.target.value)} rows={2} placeholder={t('followUpsPage.goalPlaceholder')} className="glass w-full resize-none rounded-xl px-3 py-2.5 text-sm text-text outline-none placeholder:text-fog focus:border-violet/50" />
        </label>
        <button onClick={create} disabled={busy} className="mt-4 inline-flex items-center gap-2 rounded-xl bg-brand px-4 py-2.5 text-sm font-medium text-white transition disabled:opacity-40">
          {busy ? <Loader2 size={16} className="animate-spin" /> : <Sparkles size={16} />} {t('followUpsPage.startBtn')}
        </button>
        {error && <p className="mt-3 rounded-lg bg-danger/10 px-3 py-2 text-xs text-danger">{error}</p>}
        {runNote && <p className="mt-3 rounded-lg bg-violet/10 px-3 py-2 text-xs text-violet">{runNote}</p>}
      </div>

      {/* list */}
      <div className="mt-6">
        <p className="mb-3 text-sm font-medium text-text">{t('followUpsPage.yourFunnels')} {items.length > 0 && <span className="text-muted">({items.length})</span>}</p>
        {loading ? (
          <div className="space-y-2">{[0, 1, 2].map((i) => <div key={i} className="h-20 animate-pulse rounded-2xl bg-white/[0.03]" />)}</div>
        ) : items.length === 0 ? (
          <div className="card flex flex-col items-center rounded-2xl p-10 text-center">
            <span className="mb-3 flex h-12 w-12 items-center justify-center rounded-xl bg-white/5 text-muted"><Repeat size={22} /></span>
            <p className="text-sm font-medium text-text">{t('followUpsPage.emptyTitle')}</p>
            <p className="mt-1 max-w-sm text-xs text-muted">{t('followUpsPage.emptyDesc')}</p>
          </div>
        ) : (
          <div className="space-y-2">
            {items.map((it) => {
              const sm = STATUS_META[it.status]
              return (
                <div key={it.id} className="card rounded-2xl p-4">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className={cn('inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-medium', sm.cls)}><sm.icon size={12} /> {it.status === 'processing' ? (lang === 'ru' ? 'Выполняется' : lang === 'uz' ? 'Bajarilmoqda' : 'Processing') : t(`followUpsPage.status_${it.status}`)}</span>
                    <span className="inline-flex items-center gap-1 rounded-full bg-white/5 px-2.5 py-1 text-[11px] text-muted">{it.channel === 'telegram' ? <Send size={11} /> : <Mail size={11} />} {it.target || t('followUpsPage.dialogFallback')}</span>
                    <span className="text-[11px] text-fog">{t('followUpsPage.touch', { step: it.step, max: it.max_steps })}</span>
                    <span className="ml-auto text-[11px] text-fog">{it.status === 'active' ? t('followUpsPage.nextLabel', { time: fmt(it.next_run_at) }) : t('followUpsPage.lastLabel', { time: fmt(it.last_sent_at) })}</span>
                    {it.status === 'active' && (
                      <button onClick={() => stop(it.id)} className="inline-flex items-center gap-1 rounded-lg border border-ice/12 px-2 py-1 text-[11px] text-muted transition hover:text-danger"><Square size={11} /> {t('followUpsPage.stopBtn')}</button>
                    )}
                  </div>
                  <p className="mt-2 text-[13px] text-muted"><span className="text-fog">{t('followUpsPage.goalPrefix')}</span> {it.goal || '—'}</p>
                  {it.last_message && <p className="mt-1.5 rounded-lg bg-black/20 px-3 py-2 text-[12px] text-muted"><span className="text-fog">{t('followUpsPage.lastMsgPrefix')}</span> {it.last_message}</p>}
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
