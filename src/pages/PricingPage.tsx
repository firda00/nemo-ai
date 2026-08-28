import { Minus, MessagesSquare, Users, Cpu, Image as ImageIcon, Sparkles, Globe2, Video, Search, Phone } from 'lucide-react'
import { MarketingHeader } from '../components/layout/MarketingHeader'
import { MarketingFooter } from '../components/layout/MarketingFooter'
import { Button } from '../components/ui/Button'
import { PLANS, PLAN_ORDER, formatUzs, planLabelKey } from '../lib/plans'
import { useAuth } from '../context/AuthContext'
import { cn } from '../lib/cn'
import { useI18n } from '../i18n'

/**
 * Public pricing page — reachable without login. Renders the same plan config
 * (src/lib/plans.ts) as the in-app Billing page so public prices and limits can
 * never drift from what the server enforces. No checkout here: CTAs lead to
 * signup (or the in-app billing page when already authenticated).
 *
 * Витрина считает в ДИАЛОГАХ и в СУМАХ — ровно как /app/billing. Расхождение между
 * публичной и внутренней страницей читается как подмена цены, поэтому обе берут одни
 * и те же поля из src/lib/plans.ts и показывают их одинаково:
 *   • сумма крупно — её реально списывает Payme/Click;
 *   • доллар мелкой подписью — ориентир, а не то, что уйдёт с карты;
 *   • диалоги вместо токенов — «2 000 000 токенов» владельцу бизнеса не с чем сравнить;
 *   • голос отдельной строкой — он не входит ни в один тариф (voiceMinutes: 0 везде).
 */
export default function PricingPage() {
  const { t } = useI18n()
  const { isAuthed } = useAuth()
  const kfmt = (n: number) =>
    n >= 1_000_000
      ? (n % 1_000_000 === 0 ? String(n / 1_000_000) : (n / 1_000_000).toFixed(1)) + 'M'
      : n >= 1000
        ? Math.round(n / 1000) + 'k'
        : String(n)

  return (
    /*
     * theme-dark-scope ОБЯЗАТЕЛЕН РЯДОМ С ТЁМНЫМ ФОНОМ.
     *
     * Здесь фон задавался константой #060b14, а класса не было. Цвета текста при этом брались из
     * ТОКЕНОВ, а токены следуют теме посетителя: у человека со светлой темой text-text — тёмно-синий,
     * то есть тёмный текст на почти чёрном фоне.
     *
     * Измерено: контраст названий тарифов и цен в светлой теме 1.17 при норме 4.5 (единица означает
     * «цвет текста совпал с фоном»). В тёмной теме все 113 элементов страницы проходили — поэтому
     * дефект и не был виден тому, кто его сделал.
     *
     * Класс переводит ВСЮ страницу на тёмную палитру независимо от темы системы, и фон берётся
     * тем же токеном, что и цвета: одна причина вместо двух несогласованных.
     */
    <div className="theme-dark-scope min-h-screen bg-bg">
      <MarketingHeader />
      <main className="container-page max-w-6xl pb-16 pt-10">
        <div className="mx-auto max-w-2xl text-center">
          <span className="inline-flex items-center gap-2 rounded-pill border border-ice/10 px-3 py-1 text-[11px] font-semibold uppercase tracking-widest text-cyan">
            <Sparkles size={12} /> {t('pricingPage.heroBadge')}
          </span>
          <h1 className="mt-5 text-3xl font-bold tracking-tight text-text sm:text-4xl">{t('pricingPage.heroTitle')}</h1>
          <p className="mt-3 text-sm leading-relaxed text-muted sm:text-base">{t('pricingPage.heroSubtitle')}</p>
        </div>

        <div className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {PLAN_ORDER.map((id) => {
            const p = PLANS[id]
            const popular = id === 'pro'
            return (
              <div key={id} className={cn('relative flex flex-col rounded-3xl border p-6', popular ? 'border-violet/50 bg-violet/[0.07] shadow-btn' : 'border-white/10 bg-white/[0.035]')}>
                {popular && <span className="absolute -top-3 left-6 rounded-pill bg-brand px-3 py-1 text-[11px] font-semibold text-white">{t('billingPage.popular')}</span>}
                <h2 className="text-lg font-bold text-text">{t(planLabelKey(id))}</h2>
                {/* Сумма крупно — списывается именно она. Доллар мелкой подписью: он ориентир,
                    а не то, что уйдёт с карты. Тот же порядок, что на /app/billing. */}
                <p className="mt-2 text-3xl font-extrabold text-text">
                  {id === 'enterprise' ? t('billingPage.customPrice') : `${formatUzs(p.priceUzs)} ${t('billingPage.soum')}`}
                  <span className="text-sm font-normal text-muted">{id !== 'enterprise' ? t('billingPage.perMonth') : ''}</span>
                </p>
                {id !== 'enterprise' && <p className="mt-0.5 text-xs text-fog">≈ ${p.price}{t('billingPage.perMonth')}</p>}
                {/* Включённое идёт основным цветом, невключённое падает до `muted` внутри Feat.
                    Этот перепад И ЕСТЬ иерархия: равномерно тусклый список заставляет читателя
                    разбирать строку за строкой, чтобы понять, что он вообще получает. */}
                <div className="mt-5 flex-1 space-y-2.5 text-[13px] text-text">
                  <Feat icon={MessagesSquare} ok>{t('billingPage.dialoguesCount', { count: p.dialogues })}</Feat>
                  <Feat icon={Users} ok>{t('billingPage.teamsCount', { count: p.teams })}</Feat>
                  <Feat icon={Cpu} ok={p.premium}>{p.premium ? t('billingPage.premiumModel') : t('billingPage.basicModel')}</Feat>
                  <Feat icon={ImageIcon} ok={p.media}>{p.mediaIncluded ? t('billingPage.mediaIncludedCount', { count: p.mediaMonthly }) : p.mediaTrialWeekly > 0 ? t('billingPage.mediaTrialCount', { count: p.mediaTrialWeekly }) : t('billingPage.mediaByo')}</Feat>
                  <Feat icon={Globe2} ok={p.browserMonthly > 0}>{t('billingPage.browserTasksCount', { count: p.browserMonthly })}</Feat>
                  <Feat icon={Video} ok={p.video}>{p.video ? t('billingPage.videoCount', { count: p.videoMonthly }) : t('billingPage.videoNotIncluded')}</Feat>
                  <Feat icon={Search} ok>{t('billingPage.competitorsCount', { count: p.competitors })}</Feat>
                  {/* Голос честно помечен как не входящий в подписку: при $0,07–0,345 за минуту
                      любой «включённый» пакет минут стоил бы дороже самого тарифа. */}
                  <Feat icon={Phone} ok={false}>{t('billingPage.voiceSeparate')}</Feat>
                </div>
                {isAuthed ? (
                  <Button fullWidth className="mt-6" variant={popular ? 'primary' : 'outline'} to="/app/billing">{t('nav.openApp')}</Button>
                ) : id === 'enterprise' ? (
                  <Button fullWidth className="mt-6" variant="outline" to="/waitlist">{t('billingPage.contactSales')}</Button>
                ) : (
                  <Button fullWidth className="mt-6" variant={popular ? 'primary' : 'outline'} to="/auth?mode=signup">{t('pricingPage.start')}</Button>
                )}
              </div>
            )
          })}
        </div>

        <section className="mt-10 overflow-hidden rounded-3xl border border-white/10 bg-white/[0.025]">
          <div className="border-b border-white/10 px-5 py-5 sm:px-6">
            <h2 className="text-xl font-semibold text-text">{t('billingPage.compareTitle')}</h2>
            <p className="mt-1 text-sm text-muted">{t('billingPage.compareSubtitle')}</p>
            <p className="mt-2 text-xs text-fog lg:hidden">{t('billingPage.tableScrollHint')}</p>
          </div>
          <div className="overflow-x-auto" tabIndex={0} role="region" aria-label={t('billingPage.compareTitle')}>
            <table className="min-w-[900px] w-full border-collapse text-left text-sm">
              <thead>
                <tr className="border-b border-white/10 bg-white/[0.025]">
                  <th className="sticky left-0 z-10 min-w-48 bg-[#111526] px-5 py-4 font-semibold text-text">{t('billingPage.compareFeature')}</th>
                  {PLAN_ORDER.map((id) => (
                    <th key={id} className={cn('min-w-32 px-4 py-4 font-semibold', id === 'pro' ? 'text-violet' : 'text-text')}>{t(planLabelKey(id))}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-white/[0.07]">
                <CompareRow label={t('billingPage.comparePrice')} values={PLAN_ORDER.map((id) => id === 'enterprise' ? t('billingPage.customPrice') : `${formatUzs(PLANS[id].priceUzs)} ${t('billingPage.soum')}${t('billingPage.perMonth')}`)} />
                <CompareRow label={t('billingPage.comparePriceUsd')} values={PLAN_ORDER.map((id) => id === 'enterprise' ? '—' : `$${PLANS[id].price}${t('billingPage.perMonth')}`)} />
                <CompareRow label={t('billingPage.compareDialogues')} values={PLAN_ORDER.map((id) => kfmt(PLANS[id].dialogues))} />
                <CompareRow label={t('billingPage.compareVoice')} values={PLAN_ORDER.map(() => t('billingPage.voiceSeparateShort'))} />
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

        <div className="mt-6 flex items-start gap-2 rounded-2xl border border-ice/[0.08] bg-white/[0.02] p-4 text-[12.5px] leading-relaxed text-muted">
          <Sparkles size={15} className="mt-0.5 shrink-0 text-violet" />
          <span>{t('billingPage.footer1')}<span className="text-text">{t('billingPage.footerHighlight')}</span>{t('billingPage.footer2')}</span>
        </div>
      </main>
      <MarketingFooter />
    </div>
  )
}

function CompareRow({ label, values }: { label: string; values: string[] }) {
  return (
    <tr className="hover:bg-white/[0.02]">
      <th className="sticky left-0 z-10 bg-[#111526] px-5 py-4 font-medium text-muted">{label}</th>
      {values.map((value, index) => <td key={`${label}-${index}`} className="px-4 py-4 text-text">{value}</td>)}
    </tr>
  )
}

function Feat({ icon: Icon, ok, children }: { icon: typeof MessagesSquare; ok?: boolean; children: React.ReactNode }) {
  return (
    <p className="flex items-start gap-2">
      {ok ? <Icon size={15} className="mt-0.5 shrink-0 text-teal" /> : <Minus size={15} className="mt-0.5 shrink-0 text-muted" />}
      {/* Невключённые строки остаются тусклее включённых, но на 'muted', а не 'fog':
          на 13px 'fog' даёт 3.13:1 — ниже порога 4.5:1 для текста, который всё же
          что-то сообщает (та же правка, что в BillingPage). */}
      <span className={ok ? '' : 'text-muted'}>{children}</span>
    </p>
  )
}
