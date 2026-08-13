import { useState } from 'react'
import { MessageCircle, ThumbsDown, ThumbsUp, X } from 'lucide-react'
import { submitFeedback } from '../../lib/telemetry'
import { useI18n } from '../../i18n'

export function FeedbackWidget() {
  const { t } = useI18n()
  const [open, setOpen] = useState(false)
  const [rating, setRating] = useState<-1 | 1 | null>(null)
  const [comment, setComment] = useState('')
  const [sent, setSent] = useState(false)
  const [busy, setBusy] = useState(false)
  const send = async () => {
    if (!rating) return
    setBusy(true)
    const ok = await submitFeedback(rating, rating < 0 ? 'bug' : 'product', comment)
    setBusy(false)
    if (ok) setSent(true)
  }
  if (!open) return <button onClick={() => setOpen(true)} className="fixed bottom-5 right-5 z-40 flex h-12 w-12 items-center justify-center rounded-full bg-brand text-white shadow-btn" title={t('feedback.title')} aria-label={t('feedback.title')}><MessageCircle size={20} /></button>
  return (
    <div className="card fixed bottom-5 right-5 z-40 w-[min(360px,calc(100vw-2rem))] rounded-2xl p-4 shadow-2xl">
      <div className="flex items-start justify-between gap-3">
        <div><p className="font-medium text-text">{t('feedback.heading')}</p><p className="mt-1 text-xs text-muted">{t('feedback.subtitle')}</p></div>
        <button onClick={() => setOpen(false)} className="text-muted hover:text-text" aria-label={t('feedback.close')}><X size={18} /></button>
      </div>
      {sent ? <p className="mt-4 rounded-xl bg-teal/10 p-3 text-sm text-teal">{t('feedback.thanks')}</p> : <>
        <div className="mt-4 flex gap-2">
          <button onClick={() => setRating(1)} className={`flex flex-1 items-center justify-center gap-2 rounded-xl border p-2 text-sm ${rating === 1 ? 'border-teal bg-teal/10 text-teal' : 'border-white/10 text-muted'}`}><ThumbsUp size={16} /> {t('feedback.helpful')}</button>
          <button onClick={() => setRating(-1)} className={`flex flex-1 items-center justify-center gap-2 rounded-xl border p-2 text-sm ${rating === -1 ? 'border-rose-400 bg-rose-400/10 text-rose-300' : 'border-white/10 text-muted'}`}><ThumbsDown size={16} /> {t('feedback.problem')}</button>
        </div>
        <textarea value={comment} onChange={(e) => setComment(e.target.value)} rows={3} maxLength={2000} placeholder={t('feedback.placeholder')} className="mt-3 w-full rounded-xl border border-white/10 bg-bg/60 p-3 text-sm text-text outline-none focus:border-violet" />
        <button onClick={send} disabled={!rating || busy} className="mt-3 w-full rounded-xl bg-brand px-4 py-2 text-sm text-white disabled:opacity-40">{busy ? t('feedback.saving') : t('feedback.send')}</button>
      </>}
    </div>
  )
}
