import { useEffect, useState } from 'react'
import { Loader2, Sheet, ExternalLink, RotateCcw } from 'lucide-react'
import { supabase, isSupabaseEnabled } from '../../lib/supabase'
import { useI18n } from '../../i18n'
import { cn } from '../../lib/cn'
import { useAgentStore } from '../../store/useAgentStore'

/**
 * One-click "create the structured planerka Google Sheet" for the account, using its already
 * connected Google. Shows the link once it exists; the group task-bot then logs tasks into it.
 */
export function PlanerkaSheetCard() {
  const { lang, t } = useI18n()
  const accountId = useAgentStore((s) => s.accountId)
  const [sheetId, setSheetId] = useState<string | null>(null)
  const [existingUrl, setExistingUrl] = useState('')
  const [showConnect, setShowConnect] = useState(false)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)

  useEffect(() => {
    let alive = true
    ;(async () => {
      if (!isSupabaseEnabled || !supabase) { setLoading(false); return }
      try {
        const { data } = await supabase.from('business_profiles').select('tasks_sheet_id').maybeSingle()
        if (alive) setSheetId((data?.tasks_sheet_id as string) || null)
      } finally { if (alive) setLoading(false) }
    })()
    return () => { alive = false }
  }, [])

  const create = async () => {
    if (!supabase || busy) return
    setBusy(true); setMsg(null)
    try {
      const { data, error } = await supabase.functions.invoke('create-planerka-sheet', { body: {} })
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const p = data as any
      if (error || !p?.ok) {
        setMsg({ ok: false, text: p?.code === 'GOOGLE_NOT_CONNECTED' ? t('planerkaSheetCard.needGoogle') : (p?.error || t('planerkaSheetCard.errGeneric')) })
        return
      }
      setSheetId(p.id as string)
      setMsg({ ok: true, text: t('planerkaSheetCard.created') })
    } catch {
      setMsg({ ok: false, text: t('planerkaSheetCard.errGeneric') })
    } finally { setBusy(false) }
  }

  const connectExisting = async () => {
    if (!supabase || busy || existingUrl.trim().length < 10) return
    setBusy(true); setMsg(null)
    try {
      const idMatch = existingUrl.trim().match(/\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/) || existingUrl.trim().match(/^[a-zA-Z0-9_-]{25,}$/)
      const id = idMatch?.[1] ?? idMatch?.[0]
      if (!id || !accountId) { setMsg({ ok: false, text: copy.connectError }); return }
      const { error } = await supabase.from('business_profiles').upsert({ account_id: accountId, tasks_sheet_id: id }, { onConflict: 'account_id' })
      if (error) { setMsg({ ok: false, text: copy.connectError }); return }
      setSheetId(id); setExistingUrl(''); setShowConnect(false)
      setMsg({ ok: true, text: copy.connected })
    } catch { setMsg({ ok: false, text: copy.connectError }) } finally { setBusy(false) }
  }

  const url = sheetId ? `https://docs.google.com/spreadsheets/d/${sheetId}/edit` : null
  const copy = lang === 'ru' ? {
    ownTitle: 'Уже есть своя таблица?', ownDesc: 'Подключите её — Nemo будет писать задачи туда. Новая таблица не создаётся автоматически.',
    ownPh: 'Вставьте ссылку Google Sheets', connect: 'Подключить свою', connected: 'Существующая таблица подключена.', connectError: 'Не удалось подключить таблицу. Проверьте доступ Google.',
    change: 'Сменить таблицу', createNew: 'Создать новую только по запросу',
  } : lang === 'uz' ? {
    ownTitle: 'O‘z jadvalingiz bormi?', ownDesc: 'Uni ulang — Nemo vazifalarni shu jadvalga yozadi. Yangi jadval avtomatik yaratilmaydi.',
    ownPh: 'Google Sheets havolasini kiriting', connect: 'O‘z jadvalimni ulash', connected: 'Mavjud jadval ulandi.', connectError: 'Jadvalni ulab bo‘lmadi. Google ruxsatlarini tekshiring.',
    change: 'Jadvalni almashtirish', createNew: 'Faqat so‘rov bilan yangi jadval yaratish',
  } : {
    ownTitle: 'Already have a sheet?', ownDesc: 'Connect it and Nemo will write tasks there. A new sheet is never created automatically.',
    ownPh: 'Paste a Google Sheets link', connect: 'Connect existing', connected: 'Existing sheet connected.', connectError: 'Could not connect the sheet. Check Google access.',
    change: 'Change sheet', createNew: 'Create a new one only when requested',
  }

  return (
    <section className="card rounded-3xl p-6">
      <div className="flex items-center gap-2">
        <Sheet size={18} className="text-teal" />
        <h2 className="text-lg font-bold text-text">{t('planerkaSheetCard.title')}</h2>
      </div>
      <p className="mt-2 text-sm leading-relaxed text-muted">{copy.ownDesc}</p>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        {loading ? (
          <span className="inline-flex items-center gap-2 text-sm text-muted"><Loader2 size={15} className="animate-spin" /> …</span>
        ) : url ? (
          <>
            <a href={url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-2 rounded-xl bg-brand px-4 py-2 text-sm font-medium text-white transition hover:opacity-90">
              <ExternalLink size={15} /> {t('planerkaSheetCard.open')}
            </a>
            <button onClick={create} disabled={busy} className="inline-flex items-center gap-1.5 rounded-xl border border-ice/12 px-3 py-2 text-sm font-medium text-muted transition hover:text-text disabled:opacity-40">
              {busy ? <Loader2 size={14} className="animate-spin" /> : <RotateCcw size={14} />} {copy.createNew}
            </button>
            <button onClick={() => setShowConnect((v) => !v)} className="text-xs text-violet hover:underline">{copy.change}</button>
          </>
        ) : (
          <>
            <label className="w-full text-xs font-medium text-muted">{copy.ownTitle}</label>
            <div className="flex w-full flex-wrap gap-2">
              <input value={existingUrl} onChange={(e) => setExistingUrl(e.target.value)} placeholder={copy.ownPh} className="glass min-w-[220px] flex-1 rounded-xl px-3 py-2 text-sm text-text outline-none placeholder:text-fog focus:border-violet/50" />
              <button onClick={() => void connectExisting()} disabled={busy || existingUrl.trim().length < 10} className="inline-flex items-center gap-2 rounded-xl bg-brand px-4 py-2 text-sm font-medium text-white transition disabled:opacity-40">
                {busy ? <Loader2 size={15} className="animate-spin" /> : <ExternalLink size={15} />} {copy.connect}
              </button>
            </div>
            <button onClick={() => void create()} disabled={busy} className="text-xs text-muted hover:text-text">{copy.createNew}</button>
          </>
        )}
      </div>
      {showConnect && url && <div className="mt-3 flex flex-wrap gap-2"><input value={existingUrl} onChange={(e) => setExistingUrl(e.target.value)} placeholder={copy.ownPh} className="glass min-w-[220px] flex-1 rounded-xl px-3 py-2 text-sm text-text outline-none placeholder:text-fog focus:border-violet/50" /><button onClick={() => void connectExisting()} disabled={busy || existingUrl.trim().length < 10} className="rounded-xl bg-brand px-3 py-2 text-xs font-medium text-white disabled:opacity-40">{copy.connect}</button></div>}
      {msg && <p className={cn('mt-3 rounded-lg px-3 py-2 text-xs', msg.ok ? 'bg-teal/10 text-teal' : 'bg-danger/10 text-danger')}>{msg.text}</p>}
    </section>
  )
}
