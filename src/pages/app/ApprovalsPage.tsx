import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { AlertCircle, Check, ExternalLink, Loader2, ShieldCheck, X } from 'lucide-react'
import { supabase, isSupabaseEnabled } from '../../lib/supabase'
import { useI18n } from '../../i18n'
import { ContentSalesNav } from '../../components/platform/ContentSalesNav'
import { useTelegramMiniApp } from '../../hooks/useTelegramMiniApp'

type Request = {
  id: string
  source: string
  action_type: string
  summary: string
  evidence: Record<string, unknown>
  related_research_run_id?: string | null
  status: string
  expires_at: string
  created_at: string
}

export default function ApprovalsPage() {
  const { lang, t } = useI18n()
  const [requests, setRequests] = useState<Request[]>([])
  const [loading, setLoading] = useState(isSupabaseEnabled)
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const insideTelegram = useTelegramMiniApp()

  useEffect(() => {
    if (!supabase) return
    let active = true
    void supabase.functions.invoke('approval-queue', { body: { action: 'list' } }).then(({ data, error: invokeError }) => {
      if (!active) return
      const payload = data as { ok?: boolean; requests?: Request[]; error?: string } | null
      if (invokeError || !payload?.ok) setError(payload?.error || t('approvals.loadError'))
      else setRequests(payload.requests ?? [])
      setLoading(false)
    })
    return () => { active = false }
  }, [t])

  const decide = async (id: string, decision: 'approved' | 'rejected') => {
    if (!supabase) return
    setBusy(id)
    setError('')
    const { data, error: invokeError } = await supabase.functions.invoke('approval-queue', { body: { action: 'decide', id, decision } })
    const payload = data as { ok?: boolean; error?: string } | null
    if (invokeError || !payload?.ok) setError(payload?.error || t('approvals.saveError'))
    else setRequests((items) => items.map((item) => item.id === id ? { ...item, status: decision } : item))
    setBusy('')
  }

  const dateLocale = lang === 'uz' ? 'uz-UZ' : lang === 'en' ? 'en-US' : 'ru-RU'

  return <div className="container-page max-w-5xl py-8">
    <ContentSalesNav active="approvals" />
    <div className="flex items-start gap-3">
      <span className="rounded-xl bg-amber/15 p-3 text-amber"><ShieldCheck size={22} /></span>
      <div><h1 className="text-2xl font-semibold text-text">{t('approvals.title')}</h1><p className="mt-1 text-sm text-muted">{t('approvals.subtitle')}</p></div>
    </div>
    {insideTelegram && <div className="mt-4 rounded-2xl border border-cyan/20 bg-cyan/10 px-4 py-3 text-sm text-cyan">Telegram Mini App · решения сохраняются в том же tenant-контексте и требуют вашей активной сессии.</div>}
    {error && <div className="mt-6 flex items-start gap-2 rounded-2xl border border-danger/25 bg-danger/10 p-4 text-sm text-danger"><AlertCircle className="mt-0.5 shrink-0" size={17} />{error}</div>}
    {loading ? <div className="card mt-6 flex items-center gap-2 p-5 text-sm text-muted"><Loader2 className="animate-spin" size={16} />{t('approvals.loading')}</div> : (
      <div className="mt-6 space-y-3">
        {requests.length ? requests.map((item) => {
          const qualityReview = item.source === 'workflow' && item.action_type === 'research_quality_review'
          const sections = Number(item.evidence?.sections) || 0
          return <article key={item.id} className="card rounded-2xl p-5">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0 flex-1">
                <p className="text-xs font-semibold uppercase tracking-wide text-violet">{qualityReview ? t('approvals.qualityReview') : `${item.source} · ${item.action_type}`}</p>
                <h2 className="mt-1 break-words text-base font-semibold text-text">{item.summary}</h2>
                {qualityReview && <p className="mt-2 text-sm text-muted">{t('approvals.reviewFailed', { count: sections || 1 })}</p>}
                <p className="mt-2 text-xs text-muted">{t('approvals.created')}: {new Date(item.created_at).toLocaleString(dateLocale)}{!qualityReview && <> · {t('approvals.expires')}: {new Date(item.expires_at).toLocaleString(dateLocale)}</>}</p>
              </div>
              <span className="rounded-pill bg-white/5 px-3 py-1 text-xs text-muted">{item.status}</span>
            </div>
            <div className="mt-4 flex flex-wrap gap-2">
              {qualityReview && item.related_research_run_id && <Link to={`/app/research?run=${item.related_research_run_id}`} className="inline-flex items-center gap-1 rounded-xl border border-ice/15 px-3 py-2 text-sm font-semibold text-text hover:border-violet/40"><ExternalLink size={15} />{t('approvals.openReport')}</Link>}
              {item.status === 'pending' && <>
                <button disabled={busy === item.id} onClick={() => decide(item.id, 'approved')} className="inline-flex items-center gap-1 rounded-xl bg-teal/15 px-3 py-2 text-sm font-semibold text-teal"><Check size={15} />{qualityReview ? t('approvals.acceptResult') : t('approvals.approve')}</button>
                <button disabled={busy === item.id} onClick={() => decide(item.id, 'rejected')} className="inline-flex items-center gap-1 rounded-xl bg-danger/15 px-3 py-2 text-sm font-semibold text-danger"><X size={15} />{qualityReview ? t('approvals.rejectResult') : t('approvals.reject')}</button>
              </>}
            </div>
          </article>
        }) : <div className="card rounded-2xl p-6 text-sm text-muted">{t('approvals.empty')}</div>}
      </div>
    )}
  </div>
}
