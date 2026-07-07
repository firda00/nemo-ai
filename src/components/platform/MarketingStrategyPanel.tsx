import { useState } from 'react'
import { Users2, Sparkles, ArrowRight } from 'lucide-react'
import { AutonomousRunner } from './AutonomousRunner'
import { useI18n } from '../../i18n'
import { cn } from '../../lib/cn'

/**
 * Marketing strategy panel (reused on /app/marketing and inside the Content Factory).
 * A preset marketing team plans by the client's 5-stage funnel, month by month.
 */
const FRAMEWORK =
  'Ты — маркетинговая ИИ-команда Nemo. Работай СТРОГО по этой маркетинговой воронке (стратегия клиента).\n' +
  'ЭТАПЫ ВОРОНКИ: 1) Узнаваемость 2) Доверие 3) Продажи 4) Забота о клиенте 5) Рекомендации.\n' +
  'МЕТОДЫ по этапам:\n' +
  '• Узнаваемость: вирусный, скрытый, PR, статейный, SMM\n' +
  '• Доверие: маркетинг отношений, контент-маркетинг, выставочный, облачный, телемаркетинг\n' +
  '• Продажи: CTA, дефицит (scarcity), транзакционный, нишевый, прямой\n' +
  '• Забота: бесплатный, гуманистический, разнообразие, «за идею» (cause), сезонный\n' +
  '• Рекомендации: культурный, сарафанный, inbound, affinity, партизанский\n' +
  'КАНАЛЫ:\n' +
  '• Онлайн: контекстная реклама, сайты, Instagram, TikTok, Facebook, Telegram, YouTube, e-mail, SMS\n' +
  '• Офлайн: учебные заведения, мероприятия, штендеры/стены, ТВ, радио, газеты/журналы, баннеры, метро/автобусы\n' +
  'Всегда проходи всю воронку и распределяй активности ПО МЕСЯЦАМ: этап → метод → каналы (онлайн+офлайн) → конкретное действие/контент → KPI.'

const MARKETING_TEAM = [
  { role: 'Marketing Strategist', name: 'Стратег', prompt: { role: 'директор по маркетингу: ведёт бизнес по воронке из 5 этапов и распределяет активности по месяцам', tasks: 'для каждого месяца выбрать этап(ы) воронки и подходящий метод из таксономии — по логике матрицы стратегии', tone: 'системно', rules: 'следовать воронке из 5 этапов и списку методов; ничего не выдумывать' } },
  { role: 'Channel Planner', name: 'Каналы', prompt: { role: 'специалист по каналам и медиапланированию', tasks: 'под каждый метод подобрать онлайн и офлайн каналы из таксономии с учётом бизнеса, города и бюджета', tone: 'практично', rules: 'использовать только каналы из списка; отмечать онлайн/офлайн' } },
  { role: 'Content Lead', name: 'Контент', prompt: { role: 'контент-лид: превращает каналы в задачи на контент', tasks: 'для каждого канала/месяца указать формат (пост/reels/статья/email/реклама) и тему/идею', tone: 'конкретно', rules: 'это готовые задачи для контент-команды' } },
  { role: 'Funnel Analyst', name: 'Аналитик', prompt: { role: 'аналитик воронки', tasks: 'на каждый этап задать 1–2 измеримых KPI и что мерить', tone: 'по цифрам', rules: 'метрики измеримые и релевантные этапу' } },
]

const STAGES = [{ n: '1' }, { n: '2' }, { n: '3' }, { n: '4' }, { n: '5' }]
const HORIZONS = [{ k: 3, l: '3 месяца' }, { k: 6, l: '6 месяцев' }, { k: 12, l: '12 месяцев' }]
const BUDGETS = ['низкий', 'средний', 'высокий']
const EXAMPLES = ['IT/языковая академия, Ташкент', 'B2B: система автоматизации склада (WMS)', 'Стоматологическая клиника, новый филиал']
const pill = (on: boolean) => cn('rounded-pill border px-3 py-1.5 text-xs font-medium transition', on ? 'border-violet/60 bg-violet/10 text-text' : 'border-ice/10 text-muted hover:border-ice/25')

export function MarketingStrategyPanel({ model }: { model?: string }) {
  const { t } = useI18n()
  const [business, setBusiness] = useState('')
  const [city, setCity] = useState('')
  const [horizon, setHorizon] = useState(6)
  const [budget, setBudget] = useState('средний')
  const [goal, setGoal] = useState('')

  const b = business.trim()
  const lengthLabel = HORIZONS.find((h) => h.k === horizon)?.l ?? ''
  const brief = b
    ? `Составь маркетинговый план для бизнеса: «${b}»${city.trim() ? `, город: ${city.trim()}` : ''}. Горизонт: ${horizon} месяцев (${lengthLabel}). Бюджет: ${budget}.` +
      (goal.trim() ? ` Главная цель: ${goal.trim()}.` : '') + '\n\n' +
      'Пройди ВСЮ воронку (Узнаваемость → Доверие → Продажи → Забота → Рекомендации) и распредели активности ПО МЕСЯЦАМ. В начале — 3–4 предложения общей стратегии под этот бизнес. Затем для каждого месяца — таблицу строк: | Месяц | Этап воронки | Метод | Каналы (онлайн/офлайн) | Действие / контент | KPI |. Конкретно под этот бизнес. На русском (или языке бизнеса).'
    : ''

  return (
    <>
      <div className="card rounded-2xl p-4">
        <div className="flex flex-wrap items-stretch gap-2">
          {STAGES.map((s, i) => (
            <div key={s.n} className="flex items-center gap-2">
              <div className="rounded-xl border border-ice/[0.08] bg-white/[0.03] px-3 py-2">
                <p className="text-xs font-semibold text-text"><span className="text-violet">{s.n}.</span> {t(`marketingStrategyPanel.stage${s.n}Label`)}</p>
                <p className="text-[10.5px] text-fog">{t(`marketingStrategyPanel.stage${s.n}Hint`)}</p>
              </div>
              {i < STAGES.length - 1 && <ArrowRight size={14} className="shrink-0 text-fog" />}
            </div>
          ))}
        </div>
      </div>

      <div className="card mt-4 flex flex-wrap items-center gap-2 rounded-2xl px-4 py-3">
        <span className="mr-1 flex items-center gap-1.5 text-xs font-medium text-muted"><Users2 size={14} className="text-violet" /> {t('marketingStrategyPanel.teamLabel')}</span>
        {MARKETING_TEAM.map((m) => <span key={m.name} className="rounded-pill border border-ice/[0.08] bg-white/[0.03] px-2.5 py-1 text-[11px] text-text">{m.name} · {m.role}</span>)}
      </div>

      <div className="card mt-4 space-y-5 rounded-3xl p-6">
        <div className="grid gap-4 sm:grid-cols-2">
          <label className="space-y-1.5"><span className="block text-xs font-medium uppercase tracking-wide text-muted">{t('marketingStrategyPanel.businessLabel')}</span><input value={business} onChange={(e) => setBusiness(e.target.value)} placeholder={t('marketingStrategyPanel.businessPh')} className="glass w-full rounded-xl px-3 py-2 text-sm text-text outline-none placeholder:text-fog focus:border-violet/50" /></label>
          <label className="space-y-1.5"><span className="block text-xs font-medium uppercase tracking-wide text-muted">{t('marketingStrategyPanel.cityLabel')}</span><input value={city} onChange={(e) => setCity(e.target.value)} placeholder={t('marketingStrategyPanel.cityPh')} className="glass w-full rounded-xl px-3 py-2 text-sm text-text outline-none placeholder:text-fog focus:border-violet/50" /></label>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <div><p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted">{t('marketingStrategyPanel.horizonLabel')}</p><div className="flex flex-wrap gap-2">{HORIZONS.map((h) => <button key={h.k} onClick={() => setHorizon(h.k)} className={pill(horizon === h.k)}>{h.l}</button>)}</div></div>
          <div><p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted">{t('marketingStrategyPanel.budgetLabel')}</p><div className="flex flex-wrap gap-2">{BUDGETS.map((x) => <button key={x} onClick={() => setBudget(x)} className={pill(budget === x)}>{x}</button>)}</div></div>
        </div>
        <div>
          <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted">{t('marketingStrategyPanel.goalLabel')}</p>
          <textarea value={goal} onChange={(e) => setGoal(e.target.value)} rows={2} placeholder={t('marketingStrategyPanel.goalPh')} className="glass w-full resize-y rounded-xl px-3 py-2.5 text-sm text-text outline-none placeholder:text-fog focus:border-violet/50" />
          <div className="mt-2 flex flex-wrap gap-1.5">{EXAMPLES.map((ex) => <button key={ex} onClick={() => setBusiness(ex)} className="rounded-lg border border-ice/10 px-2 py-1 text-[11px] text-muted hover:text-text">{ex}</button>)}</div>
        </div>
      </div>

      <div className="mt-6">
        {brief ? (
          <AutonomousRunner key={brief} defaultGoal={brief} presetSpecs={MARKETING_TEAM} contextHint={FRAMEWORK} model={model} placeholder={t('marketingStrategyPanel.runnerPlaceholder')} />
        ) : (
          <div className="card flex items-center gap-3 rounded-2xl p-5 text-sm text-muted"><Sparkles size={16} className="text-violet" /> {t('marketingStrategyPanel.emptyHint')}</div>
        )}
      </div>
    </>
  )
}
