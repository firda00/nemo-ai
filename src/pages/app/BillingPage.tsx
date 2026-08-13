import { useEffect, useState } from 'react'
import { Minus, CreditCard, Loader2, Zap, Users, Cpu, Image as ImageIcon, Sparkles, Globe2, Video, Search } from 'lucide-react'
import { supabase, isSupabaseEnabled } from '../../lib/supabase'
import { Button } from '../../components/ui/Button'
import { PLANS, PLAN_ORDER, formatRunRange, teamRunsFromTokens } from '../../lib/plans'
import { cn } from '../../lib/cn'
import { useI18n } from '../../i18n'

/**
 * Billing & limits — real B2B tiers driven by the plan config, with the account's live
 * monthly usage vs quota. Quotas enforced server-side (orchestrate → QUOTA_EXCEEDED).
 */
export default function BillingPage() {
  const { t } = useI18n()
  const [plan, setPlan] = useState('free')
  const [used, setUsed] = useState(0)
  const [quota, setQuota] = useState(150_000)
  const [loading, setLoading] = useState(isSupabaseEnabled)
  const [checkoutBusy, setCheckoutBusy] = useState('')
  // Выставленный счёт с двумя ссылками. Выбор кассы — за покупателем: у Payme и Click разное
  // покрытие карт, и «оплатить» одной кнопкой означало бы отказ половине рынка.
  const [invoice, setInvoice] = useState<{ planId: string; no: number | null; amountUzs: number; payme: string | null; click: string | null } | null>(null)
  const [notice, setNotice] = useState<string | null>(() => (
    new URLSearchParams(window.location.search).get('upgraded') ? t('billingPage.subscribedNotice') : null
  ))

  useEffect(() => {
    if (!isSupabaseEnabled || !supabase) return
    ;(async () => {
      try {
        const { data } = await supabase!.functions.invoke('plan-status', { body: {} })
        const p = data as { plan?: string; used?: number; quota?: number } | null
        if (p) { setPlan(p.plan ?? 'free'); setUsed(p.used ?? 0); setQuota(p.quota ?? 150_000) }
      } catch { /* ignore */ }
      setLoading(false)
    })()
  }, [])

  const pct = quota > 0 ? Math.min(100, Math.round((used / quota) * 100)) : 0
  const choose = async (id: string) => {
    if (id === 'enterprise') {
      setNotice(t('billingPage.enterpriseContact'))
      return
    }
    if (!supabase || checkoutBusy) return
    setCheckoutBusy(id); setNotice(null)
    try {
      // Сначала местные кассы: рынок узбекский, и Stripe здесь картой не оплатят. Счёт
      // выставляется на сервере — браузер присылает только код тарифа, потому что назвать сумму
      // из браузера значит продать Business за тысячу сумов, и проверка платежа честно бы её
      // подтвердила: она сверяет платёж со СЧЁТОМ, а не с прайсом.
      const { data: local } = await supabase.functions.invoke('billing-invoice', { body: { plan_code: id } })
      const invoice = local as { ok?: boolean; invoice_no?: number; payme_url?: string | null; click_url?: string | null; amount_uzs?: number } | null
      if (invoice?.ok && (invoice.payme_url || invoice.click_url)) {
        setInvoice({ planId: id, no: invoice.invoice_no ?? null, amountUzs: invoice.amount_uzs ?? 0, payme: invoice.payme_url ?? null, click: invoice.click_url ?? null })
        setCheckoutBusy('')
        return
      }

      const { data } = await supabase.functions.invoke('create-checkout', { body: { plan: id } })
      const p = data as { ok?: boolean; url?: string; detail?: string } | null
      if (p?.url) { window.location.assign(p.url); return }
      setNotice(p?.detail ? t('billingPage.paymentUnavailable', { detail: p.detail }) : t('billingPage.paymentNotConfigured'))
    } catch { setNotice(t('billingPage.paymentError')) } finally { setCheckoutBusy('') }
  }
  const kfmt = (n: number) =>
    n >= 1_000_000
      ? (n % 1_000_000 === 0 ? String(n / 1_000_000) : (n / 1_000_000).toFixed(1)) + 'M'
      : n >= 1000
        ? Math.round(n / 1000) + 'k'
        : String(n)

  return (
    <div className="container-page max-w-6xl py-8">
      <div className="flex items-center gap-3">
        <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-accent-indigo/15 text-accent-indigo"><CreditCard size={20} /></span>
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-text">{t('billingPage.title')}</h1>
          <p className="text-sm text-muted">{t('billingPage.subtitle')}</p>
        </div>
      </div>

      {/* current usage */}
      <div className="card mt-5 rounded-3xl p-6">
        {loading ? (
          <div className="flex items-center gap-2 text-sm text-muted"><Loader2 size={15} className="animate-spin" /> {t('common.loading')}</div>
        ) : (
          <>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <p className="text-xs uppercase tracking-wide text-muted">{t('billingPage.currentPlan')}</p>
                <p className="mt-1 text-xl font-bold text-text">{(PLANS[plan] ?? PLANS.free).label}</p>
              </div>
              <div className="text-right">
                <p className="text-xs text-muted">{t('billingPage.usedThisMonth')}</p>
                <p className="mt-1 font-mono text-sm text-text">{kfmt(used)} / {kfmt(quota)} {t('billingPage.tokens')} <span className="text-fog">≈ {formatRunRange(teamRunsFromTokens(quota - used))} {t('billingPage.runsLeft')}</span></p>
              </div>
            </div>
            <div className="mt-3 h-2.5 w-full overflow-hidden rounded-full bg-white/[0.06]">
              <div className={cn('h-full rounded-full transition-all', pct >= 90 ? 'bg-danger' : pct >= 70 ? 'bg-amber' : 'bg-flow-gradient')} style={{ width: `${pct}%` }} />
            </div>
            {pct >= 90 && <p className="mt-2 text-xs text-danger">{t('billingPage.limitNearlyReached')}</p>}
          </>
        )}
      </div>

      {notice && <p className="mt-4 rounded-xl bg-accent-indigo/10 px-4 py-2.5 text-sm text-text">{notice}</p>}

      {/* tiers */}
      <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {PLAN_ORDER.map((id) => {
          const p = PLANS[id]
          const current = id === plan
          const popular = id === 'pro'
          return (
            <div key={id} className={cn('relative flex flex-col rounded-3xl border p-6', current ? 'border-teal/50 bg-teal/[0.05]' : popular ? 'border-accent-indigo/50 bg-accent-indigo/[0.07]' : 'border-ice/10 bg-panel/60')}>
              {popular && !current && <span className="absolute -top-3 left-6 rounded-pill bg-gradient-to-r from-accent-cyan to-accent-indigo px-3 py-1 text-[11px] font-semibold text-white">{t('billingPage.popular')}</span>}
              {current && <span className="absolute -top-3 left-6 rounded-pill bg-teal px-3 py-1 text-[11px] font-semibold text-white">{t('billingPage.yourPlan')}</span>}
              <h2 className="text-lg font-bold text-text">{p.label}</h2>
              <p className="mt-2 text-3xl font-extrabold text-text">{id === 'enterprise' ? t('billingPage.customPrice') : `$${p.price}`}<span className="text-sm font-normal text-muted">{id !== 'enterprise' ? t('billingPage.perMonth') : ''}</span></p>
              {/* Included features carry primary text, excluded ones drop to `muted` inside
                  Feat. That step IS the hierarchy — a uniformly dim list makes the reader
                  compare rows one by one to work out what they actually get. */}
              <div className="mt-5 space-y-2.5 text-[13px] text-text">
                <Feat icon={Zap} ok>{formatRunRange(teamRunsFromTokens(p.tokens))} {t('billingPage.runsPerMonth')} <span className="text-muted">({kfmt(p.tokens)} {t('billingPage.tokens')})</span></Feat>
                <Feat icon={Users} ok>{t('billingPage.teamsCount', { count: p.teams })}</Feat>
                <Feat icon={Cpu} ok={p.premium}>{p.premium ? t('billingPage.premiumModel') : t('billingPage.basicModel')}</Feat>
                <Feat icon={ImageIcon} ok={p.media}>{p.mediaIncluded ? t('billingPage.mediaIncludedCount', { count: p.mediaMonthly }) : p.mediaTrialWeekly > 0 ? t('billingPage.mediaTrialCount', { count: p.mediaTrialWeekly }) : t('billingPage.mediaByo')}</Feat>
                <Feat icon={Globe2} ok={p.browserMonthly > 0}>{t('billingPage.browserTasksCount', { count: p.browserMonthly })}</Feat>
                <Feat icon={Video} ok={p.video}>{p.video ? t('billingPage.videoCount', { count: p.videoMonthly }) : t('billingPage.videoNotIncluded')}</Feat>
                <Feat icon={Search} ok>{t('billingPage.competitorsCount', { count: p.competitors })}</Feat>
              </div>
              {current ? (
                <Button fullWidth className="mt-6" variant="outline" disabled>{t('billingPage.current')}</Button>
              ) : (
                <Button fullWidth className="mt-6" variant={popular ? 'primary' : 'outline'} onClick={() => choose(id)} disabled={checkoutBusy === id}>
                  {checkoutBusy === id ? <><Loader2 size={15} className="animate-spin" /> …</> : id === 'enterprise' ? t('billingPage.contactSales') : t('billingPage.subscribe')}
                </Button>
              )}
            </div>
          )
        })}
      </div>

      <section className="mt-8 overflow-hidden rounded-3xl border border-ice/10 bg-panel/50">
        <div className="border-b border-ice/10 px-5 py-5 sm:px-6">
          <h2 className="text-xl font-semibold text-text">{t('billingPage.compareTitle')}</h2>
          <p className="mt-1 text-sm text-muted">{t('billingPage.compareSubtitle')}</p>
          <p className="mt-2 text-xs text-fog lg:hidden">{t('billingPage.tableScrollHint')}</p>
        </div>
        <div className="overflow-x-auto" tabIndex={0} role="region" aria-label={t('billingPage.compareTitle')}>
          <table className="min-w-[900px] w-full border-collapse text-left text-sm">
            <thead>
              <tr className="border-b border-ice/10 bg-panel/70">
                <th className="sticky left-0 z-10 min-w-48 bg-panel px-5 py-4 font-semibold text-text">{t('billingPage.compareFeature')}</th>
                {PLAN_ORDER.map((id) => (
                  <th key={id} className={cn('min-w-32 px-4 py-4 font-semibold', id === 'pro' ? 'text-accent-indigo' : 'text-text')}>{PLANS[id].label}</th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-white/[0.07]">
              <CompareRow label={t('billingPage.comparePrice')} values={PLAN_ORDER.map((id) => id === 'enterprise' ? t('billingPage.customPrice') : `$${PLANS[id].price}${t('billingPage.perMonth')}`)} />
              <CompareRow label={t('billingPage.compareRuns')} values={PLAN_ORDER.map((id) => formatRunRange(teamRunsFromTokens(PLANS[id].tokens)))} />
              <CompareRow label={t('billingPage.compareTokens')} values={PLAN_ORDER.map((id) => kfmt(PLANS[id].tokens))} />
              <CompareRow label={t('billingPage.compareTeams')} values={PLAN_ORDER.map((id) => String(PLANS[id].teams))} />
              <CompareRow label={t('billingPage.compareModel')} values={PLAN_ORDER.map((id) => PLANS[id].premium ? t('billingPage.premiumShort') : t('billingPage.basicShort'))} />
              <CompareRow label={t('billingPage.compareMedia')} values={PLAN_ORDER.map((id) => PLANS[id].mediaIncluded ? String(PLANS[id].mediaMonthly) : PLANS[id].media ? t('billingPage.mediaByoShort') : t('billingPage.notIncluded'))} />
              <CompareRow label={t('billingPage.compareBrowser')} values={PLAN_ORDER.map((id) => String(PLANS[id].browserMonthly))} />
              <CompareRow label={t('billingPage.compareVideos')} values={PLAN_ORDER.map((id) => String(PLANS[id].videoMonthly))} />
              <CompareRow label={t('billingPage.compareCompetitors')} values={PLAN_ORDER.map((id) => String(PLANS[id].competitors))} />
            </tbody>
          </table>
        </div>
      </section>

      <div className="mt-6 flex items-start gap-2 rounded-2xl border border-ice/10 bg-panel/50 p-4 text-[12.5px] leading-relaxed text-muted">
        <Sparkles size={15} className="mt-0.5 shrink-0 text-accent-cyan" />
        <span>{t('billingPage.footer1')}<span className="text-text">{t('billingPage.footerHighlight')}</span>{t('billingPage.footer2')}</span>
      </div>

      {/* Выбор кассы за покупателем: у Payme и Click разное покрытие карт, и одна кнопка
          «оплатить» означала бы отказ половине рынка. Сумма показана до перехода — цена, впервые
          увиденная на чужой странице, читается как подмена. */}
      {invoice && (
        <div className="fixed inset-0 z-[95] flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={() => setInvoice(null)} />
          <div className="card relative w-full max-w-sm rounded-2xl p-6 animate-fadeInUp">
            <h3 className="text-lg font-semibold text-text">{t('billingPagePay.payTitle')}</h3>
            <p className="mt-1 text-sm text-muted">
              {t('billingPagePay.paySubtitle', { amount: invoice.amountUzs.toLocaleString('ru-RU') })}
            </p>
            {/* Номер счёта показан ДО перехода в кассу: если платёж потеряется, продиктовать в
                поддержку «счёт 100042» можно, а uuid из адресной строки — нет. */}
            {invoice.no != null && (
              <p className="mt-2 text-xs text-muted">
                {t('billingPagePay.payInvoiceNo')} <span className="font-mono text-text">{invoice.no}</span>
              </p>
            )}
            <div className="mt-5 space-y-2">
              {invoice.payme && (
                <a href={invoice.payme} target="_blank" rel="noreferrer"
                   className="block w-full rounded-xl bg-brand-gradient px-4 py-3 text-center text-sm font-semibold text-white">
                  {t('billingPagePay.payPayme')}
                </a>
              )}
              {invoice.click && (
                <a href={invoice.click} target="_blank" rel="noreferrer"
                   className="block w-full rounded-xl border border-ice/15 px-4 py-3 text-center text-sm font-medium text-text hover:border-accent-cyan/50">
                  {t('billingPagePay.payClick')}
                </a>
              )}
            </div>
            {/* Доступ открывается по подтверждению кассы, а не по возвращению на страницу: сказать
                это заранее дешевле, чем объяснять потом, почему после оплаты «ничего не изменилось». */}
            <p className="mt-4 text-[11px] leading-relaxed text-muted">{t('billingPagePay.payHint')}</p>
            <button type="button" onClick={() => setInvoice(null)}
                    className="mt-4 w-full text-center text-xs text-muted hover:text-text">
              {t('billingPagePay.payLater')}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

function CompareRow({ label, values }: { label: string; values: string[] }) {
  return (
    <tr className="hover:bg-panel/70 transition-colors">
      <th className="sticky left-0 z-10 bg-panel px-5 py-4 font-medium text-muted">{label}</th>
      {values.map((value, index) => <td key={`${label}-${index}`} className="px-4 py-4 text-text">{value}</td>)}
    </tr>
  )
}

function Feat({ icon: Icon, ok, children }: { icon: typeof Zap; ok?: boolean; children: React.ReactNode }) {
  return (
    <p className="flex items-start gap-2">
      {ok ? <Icon size={15} className="mt-0.5 shrink-0 text-teal" /> : <Minus size={15} className="mt-0.5 shrink-0 text-muted" />}
      {/* Not-included rows stay dimmer than included ones, but at 'muted' rather than 'fog':
         at 13px 'fog' measured 3.13:1, under the 4.5:1 floor for text that still says something. */}
      <span className={ok ? '' : 'text-muted'}>{children}</span>
    </p>
  )
}
