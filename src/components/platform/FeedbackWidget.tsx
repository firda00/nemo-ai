import { useState } from 'react'
import { Check, Lightbulb, MessageCircle, Send, ThumbsDown, ThumbsUp, X } from 'lucide-react'
import { submitFeedback, type FeedbackTopic } from '../../lib/telemetry'
import { useI18n } from '../../i18n'
import { cn } from '../../lib/cn'

type Intent = 'problem' | 'idea' | 'helpful'

const COPY = {
  ru: {
    title: 'Обратная связь', heading: 'Связаться с командой Nemo', subtitle: 'Жалоба, идея или удачный результат — сообщение увидит администратор.',
    problem: 'Сообщить о проблеме', idea: 'Предложить идею', helpful: 'Всё получилось',
    topic: 'Что именно произошло?', topics: { agent_quality: 'Неверный ответ', speed: 'Медленная работа', technical: 'Ошибка интерфейса', billing: 'Оплата и лимиты', onboarding: 'Первый запуск', other: 'Другое' },
    placeholder: 'Опишите, что произошло и какого результата вы ожидали…', contact: 'Можно связаться со мной по email аккаунта', send: 'Отправить', saving: 'Отправляем…',
    required: 'Добавьте хотя бы несколько слов, чтобы мы могли разобраться.', failed: 'Не удалось отправить. Проверьте соединение и повторите.',
    thanks: 'Обращение принято', ticket: 'Номер обращения', close: 'Закрыть', another: 'Отправить ещё одно',
  },
  uz: {
    title: 'Fikr-mulohaza', heading: 'Nemo jamoasi bilan bog‘lanish', subtitle: 'Shikoyat, g‘oya yoki yaxshi natija — xabarni administrator ko‘radi.',
    problem: 'Muammo haqida yozish', idea: 'G‘oya taklif qilish', helpful: 'Hammasi ishladi',
    topic: 'Nima sodir bo‘ldi?', topics: { agent_quality: 'Noto‘g‘ri javob', speed: 'Sekin ishlash', technical: 'Interfeys xatosi', billing: 'To‘lov va limitlar', onboarding: 'Birinchi ishga tushirish', other: 'Boshqa' },
    placeholder: 'Nima sodir bo‘lganini va qanday natija kutganingizni yozing…', contact: 'Akkaunt emaili orqali men bilan bog‘lanish mumkin', send: 'Yuborish', saving: 'Yuborilmoqda…',
    required: 'Muammoni tushunishimiz uchun bir necha so‘z yozing.', failed: 'Yuborilmadi. Internetni tekshirib, qayta urinib ko‘ring.',
    thanks: 'Murojaat qabul qilindi', ticket: 'Murojaat raqami', close: 'Yopish', another: 'Yana yuborish',
  },
  en: {
    title: 'Feedback', heading: 'Contact the Nemo team', subtitle: 'Report a problem, share an idea, or tell us what worked. An administrator will see it.',
    problem: 'Report a problem', idea: 'Suggest an idea', helpful: 'It worked',
    topic: 'What happened?', topics: { agent_quality: 'Wrong answer', speed: 'Slow response', technical: 'Interface error', billing: 'Billing and limits', onboarding: 'First-time setup', other: 'Other' },
    placeholder: 'Describe what happened and what you expected…', contact: 'You may contact me at my account email', send: 'Send', saving: 'Sending…',
    required: 'Add a few words so we can investigate.', failed: 'Could not send. Check your connection and try again.',
    thanks: 'Message received', ticket: 'Reference', close: 'Close', another: 'Send another',
  },
} as const

export function FeedbackWidget() {
  const { lang } = useI18n()
  const copy = COPY[lang]
  const [open, setOpen] = useState(false)
  const [intent, setIntent] = useState<Intent>('problem')
  const [topic, setTopic] = useState<FeedbackTopic>('agent_quality')
  const [comment, setComment] = useState('')
  const [contactRequested, setContactRequested] = useState(false)
  const [ticket, setTicket] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const reset = () => { setTicket(''); setComment(''); setError(''); setContactRequested(false) }
  const send = async () => {
    if (comment.trim().length < 5) { setError(copy.required); return }
    setBusy(true); setError('')
    const rating = intent === 'problem' ? -1 : 1
    const category = intent === 'idea' ? 'idea' : intent === 'helpful' ? 'product' : topic === 'agent_quality' ? 'agent_result' : 'bug'
    const result = await submitFeedback(rating, category, comment, { topic: intent === 'problem' ? topic : undefined, contactRequested })
    setBusy(false)
    if (result.ok) setTicket(result.id?.slice(0, 8).toUpperCase() ?? 'OK')
    else setError(copy.failed)
  }

  if (!open) return <button onClick={() => setOpen(true)} className="fixed bottom-5 right-5 z-40 flex h-12 w-12 items-center justify-center rounded-2xl bg-brand text-white shadow-btn transition duration-200 hover:-translate-y-0.5 hover:shadow-lg active:translate-y-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-cyan/60" title={copy.title} aria-label={copy.title}><MessageCircle size={20} /></button>

  return (
    <section role="dialog" aria-modal="false" aria-label={copy.heading} className="fixed bottom-5 right-5 z-40 w-[min(420px,calc(100vw-2rem))] overflow-hidden rounded-3xl border border-ice/[0.12] bg-panel/95 shadow-[0_24px_80px_-24px_rgba(15,23,42,0.75)] backdrop-blur-xl animate-fadeIn">
      <header className="flex items-start justify-between gap-3 border-b border-ice/[0.08] px-5 py-4">
        <div><h2 className="font-semibold tracking-tight text-text">{copy.heading}</h2><p className="mt-1 max-w-[38ch] text-xs leading-5 text-muted">{copy.subtitle}</p></div>
        <button onClick={() => setOpen(false)} className="rounded-lg p-1.5 text-muted transition hover:bg-card/10 hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-cyan/50" aria-label={copy.close}><X size={17} /></button>
      </header>

      {ticket ? <div className="px-5 py-6 text-center">
        <span className="mx-auto flex h-11 w-11 items-center justify-center rounded-2xl bg-teal/10 text-teal"><Check size={21} /></span>
        <p className="mt-3 font-semibold text-text">{copy.thanks}</p>
        <p className="mt-1 font-mono text-xs text-muted">{copy.ticket}: {ticket}</p>
        <button onClick={reset} className="mt-5 text-sm font-medium text-accent-cyan hover:underline">{copy.another}</button>
      </div> : <div className="p-5">
        <div className="grid grid-cols-3 gap-2">
          {([
            ['problem', ThumbsDown, copy.problem],
            ['idea', Lightbulb, copy.idea],
            ['helpful', ThumbsUp, copy.helpful],
          ] as const).map(([id, Icon, label]) => <button key={id} type="button" onClick={() => { setIntent(id); setError('') }} className={cn('flex min-h-20 flex-col items-center justify-center gap-2 rounded-2xl border px-2 py-3 text-center text-[11px] font-medium leading-4 transition duration-200 active:scale-[0.98]', intent === id ? 'border-accent-cyan/35 bg-accent-cyan/[0.08] text-text' : 'border-ice/[0.08] bg-card/[0.025] text-muted hover:bg-card/[0.06] hover:text-text')}><Icon size={17} className={intent === id ? 'text-accent-cyan' : ''} />{label}</button>)}
        </div>

        {intent === 'problem' && <div className="mt-5"><p className="text-xs font-semibold text-text">{copy.topic}</p><div className="mt-2 flex flex-wrap gap-2">{(Object.keys(copy.topics) as FeedbackTopic[]).map((id) => <button key={id} type="button" onClick={() => setTopic(id)} className={cn('rounded-lg border px-2.5 py-1.5 text-xs transition', topic === id ? 'border-violet/35 bg-violet/10 text-text' : 'border-ice/[0.08] text-muted hover:text-text')}>{copy.topics[id]}</button>)}</div></div>}

        <textarea value={comment} onChange={(event) => { setComment(event.target.value); setError('') }} rows={4} maxLength={2000} placeholder={copy.placeholder} className="mt-5 w-full resize-none rounded-2xl border border-ice/[0.1] bg-bg/45 p-3 text-sm leading-5 text-text outline-none transition placeholder:text-fog focus:border-accent-cyan/40 focus:ring-2 focus:ring-accent-cyan/10" />
        <div className="mt-1 flex justify-end font-mono text-[10px] text-fog">{comment.length}/2000</div>
        <label className="mt-3 flex cursor-pointer items-start gap-2.5 text-xs leading-5 text-muted"><input type="checkbox" checked={contactRequested} onChange={(event) => setContactRequested(event.target.checked)} className="mt-0.5 accent-cyan" />{copy.contact}</label>
        {error && <p role="alert" className="mt-3 rounded-xl border border-danger/20 bg-danger/10 px-3 py-2 text-xs leading-5 text-danger">{error}</p>}
        <button onClick={() => void send()} disabled={busy || comment.trim().length < 5} className="mt-4 flex w-full items-center justify-center gap-2 rounded-xl bg-brand px-4 py-2.5 text-sm font-semibold text-white shadow-btn transition hover:-translate-y-0.5 active:translate-y-0 disabled:translate-y-0 disabled:cursor-not-allowed disabled:opacity-40">{busy ? <span className="h-4 w-4 animate-spin rounded-full border-2 border-white/30 border-t-white" /> : <Send size={15} />}{busy ? copy.saving : copy.send}</button>
      </div>}
    </section>
  )
}
