import { useEffect, useState } from 'react'
import { Loader2, Sheet, ExternalLink, RotateCcw, Plus } from 'lucide-react'
import { supabase, isSupabaseEnabled } from '../../lib/supabase'
import { useI18n } from '../../i18n'
import { cn } from '../../lib/cn'

/**
 * One-click "create the structured planerka Google Sheet" for the account, using its already
 * connected Google. Shows the link once it exists; the group task-bot then logs tasks into it.
 */
export function PlanerkaSheetCard() {
  const { t } = useI18n()
  const [sheetId, setSheetId] = useState<string | null>(null)
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

  const url = sheetId ? `https://docs.google.com/spreadsheets/d/${sheetId}/edit` : null

  return (
    <section className="card rounded-3xl p-6">
      <div className="flex items-center gap-2">
        <Sheet size={18} className="text-teal" />
        <h2 className="text-lg font-bold text-text">{t('planerkaSheetCard.title')}</h2>
      </div>
      <p className="mt-2 text-sm leading-relaxed text-muted">{t('planerkaSheetCard.desc')}</p>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        {loading ? (
          <span className="inline-flex items-center gap-2 text-sm text-muted"><Loader2 size={15} className="animate-spin" /> …</span>
        ) : url ? (
          <>
            <a href={url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-2 rounded-xl bg-brand px-4 py-2 text-sm font-medium text-white transition hover:opacity-90">
              <ExternalLink size={15} /> {t('planerkaSheetCard.open')}
            </a>
            <button onClick={create} disabled={busy} className="inline-flex items-center gap-1.5 rounded-xl border border-ice/12 px-3 py-2 text-sm font-medium text-muted transition hover:text-text disabled:opacity-40">
              {busy ? <Loader2 size={14} className="animate-spin" /> : <RotateCcw size={14} />} {t('planerkaSheetCard.recreate')}
            </button>
          </>
        ) : (
          <button onClick={create} disabled={busy} className="inline-flex items-center gap-2 rounded-xl bg-brand px-4 py-2 text-sm font-medium text-white transition disabled:opacity-40">
            {busy ? <Loader2 size={15} className="animate-spin" /> : <Plus size={15} />} {t('planerkaSheetCard.create')}
          </button>
        )}
      </div>
      {msg && <p className={cn('mt-3 rounded-lg px-3 py-2 text-xs', msg.ok ? 'bg-teal/10 text-teal' : 'bg-danger/10 text-danger')}>{msg.text}</p>}
    </section>
  )
}
