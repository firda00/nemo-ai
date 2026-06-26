import { useState } from 'react'
import {
  ArrowRight,
  ArrowUpRight,
  Sparkles,
  Bot,
  Users,
  Activity,
  CheckCircle2,
  Languages,
  ShieldCheck,
  Star,
} from 'lucide-react'
import { useI18n } from '../i18n'
import { MarketingHeader } from '../components/layout/MarketingHeader'
import { MarketingFooter } from '../components/layout/MarketingFooter'
import { Button } from '../components/ui/Button'
import { Accordion } from '../components/ui/Accordion'

const featureIcons = [Bot, Users, Activity, CheckCircle2, Languages, ShieldCheck]
const PARTNERS = ['Ustudy IT', 'EduTech', 'Maktab+', 'IT Park', 'StartupHub', 'Akademiya']

function PillBadge({ children, icon: Icon }: { children: React.ReactNode; icon?: typeof Sparkles }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-pill border border-white/10 bg-white/5 px-3.5 py-1.5 text-xs font-medium text-text backdrop-blur">
      {Icon && <Icon size={13} className="text-violet" />}
      {children}
    </span>
  )
}

function SectionHeader({ badge, title, sub }: { badge: string; title: React.ReactNode; sub?: string }) {
  return (
    <div className="mx-auto max-w-2xl text-center">
      <PillBadge>{badge}</PillBadge>
      <h2 className="mt-6 text-[clamp(2rem,4.5vw,3rem)] font-extrabold leading-[1.1] tracking-tight text-text">{title}</h2>
      {sub && <p className="mt-4 text-base text-muted sm:text-lg">{sub}</p>}
    </div>
  )
}

function PriceCalculator() {
  const { t } = useI18n()
  const [tasks, setTasks] = useState(300)
  const cost = (tasks * 1500).toLocaleString('ru-RU')
  return (
    <div className="card mx-auto max-w-2xl p-8 sm:p-10">
      <div className="text-center">
        <h2 className="text-[clamp(1.75rem,3vw,2.5rem)] font-bold tracking-tight text-text">{t('landing.calc.title')}</h2>
        <p className="mt-3 text-muted">{t('landing.calc.subtitle')}</p>
      </div>
      <div className="mt-8">
        <div className="flex items-center justify-between text-sm">
          <span className="text-muted">{t('landing.calc.tasksLabel')}</span>
          <span className="font-medium text-text">{tasks.toLocaleString('ru-RU')}</span>
        </div>
        <input type="range" min={50} max={2000} step={50} value={tasks} onChange={(e) => setTasks(Number(e.target.value))} aria-label={t('landing.calc.tasksLabel')} className="mt-3 w-full cursor-pointer accent-violet" />
        <div className="mt-1 flex justify-between text-[11px] text-fog"><span>50</span><span>2000</span></div>
      </div>
      <div className="mt-8 flex flex-col items-center justify-between gap-4 rounded-2xl border border-white/10 bg-white/[0.03] p-6 sm:flex-row">
        <div>
          <p className="text-xs text-muted">{t('landing.calc.estimate')}</p>
          <p className="mt-1 text-3xl font-bold text-text">
            {cost} <span className="text-base font-normal text-muted">{t('landing.calc.perMonth')}</span>
          </p>
        </div>
        <Button to="/auth?mode=signup" size="lg">{t('landing.calc.cta')} <ArrowRight size={16} /></Button>
      </div>
      <p className="mt-4 text-center text-xs text-fog">{t('landing.calc.note')}</p>
    </div>
  )
}

export default function LandingPage() {
  const { t, dict } = useI18n()

  return (
    <div className="min-h-screen bg-bg">
      <MarketingHeader />

      {/* HERO */}
      <section className="relative overflow-hidden">
        {/* premium animated backdrop: aurora + fading grid + top brand glow */}
        <div className="aurora" />
        <div className="grid-overlay" />
        <div className="pointer-events-none absolute inset-x-0 top-0 h-[640px] bg-brand-radial" />
        <div className="container-page relative py-24 text-center sm:py-28">
          <PillBadge icon={Sparkles}>{t('landing.badge')}</PillBadge>
          <h1 className="mx-auto mt-8 max-w-4xl text-[clamp(2.75rem,7vw,4.5rem)] font-black leading-[1.05] tracking-tight text-text">
            {t('landing.title')}{' '}
            <span className="bg-brand bg-clip-text text-transparent">{t('landing.titleAccent')}</span>
          </h1>
          <p className="mx-auto mt-7 max-w-xl text-lg leading-relaxed text-muted">{t('landing.subtitle')}</p>
          <div className="mt-9 flex flex-wrap items-center justify-center gap-3">
            <Button to="/auth?mode=signup" size="lg">{t('landing.ctaPrimary')} <ArrowRight size={17} /></Button>
            <Button href="#how" variant="outline" size="lg">{t('landing.ctaSecondary')}</Button>
          </div>
          <p className="mt-6 text-sm text-fog">{t('landing.note')}</p>
        </div>
      </section>

      {/* STATS */}
      <section className="container-page pb-8">
        <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
          {dict.landing.stats.items.map((s) => (
            <div key={s.label} className="card px-5 py-7 text-center transition-transform duration-200 hover:-translate-y-1">
              <p className="text-gradient text-4xl font-extrabold">{s.value}</p>
              <p className="mt-2 text-sm text-muted">{s.label}</p>
            </div>
          ))}
        </div>
      </section>

      {/* HOW IT WORKS */}
      <section id="how" className="container-page py-20">
        <SectionHeader badge={t('nav.howItWorks')} title={t('landing.how.title')} sub={t('landing.how.subtitle')} />
        <div className="mt-14 grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
          {dict.landing.how.steps.map((step) => (
            <div key={step.k} className="card group relative p-7">
              <span className="text-sm font-semibold text-violet">{step.k}</span>
              <h3 className="mt-3 text-2xl font-bold text-text">{step.title}</h3>
              <p className="mt-2 text-sm leading-relaxed text-muted">{step.desc}</p>
              <span className="absolute right-5 top-5 flex h-8 w-8 items-center justify-center rounded-full bg-brand text-white shadow-btn">
                <ArrowUpRight size={16} />
              </span>
            </div>
          ))}
        </div>
      </section>

      {/* FEATURES */}
      <section id="features" className="container-page py-20">
        <SectionHeader badge={t('nav.features')} title={t('landing.features.title')} sub={t('landing.features.subtitle')} />
        <div className="mt-14 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
          {dict.landing.features.items.map((f, i) => {
            const Icon = featureIcons[i % featureIcons.length]
            return (
              <div key={f.title} className="card p-7">
                <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-violet/15 text-violet">
                  <Icon size={20} strokeWidth={1.8} />
                </span>
                <h3 className="mt-5 text-xl font-bold text-text">{f.title}</h3>
                <p className="mt-2 text-sm leading-relaxed text-muted">{f.desc}</p>
              </div>
            )
          })}
        </div>
      </section>

      {/* LOGO STRIP */}
      <section id="scenarios" className="container-page py-12">
        <p className="text-center text-sm text-fog">{t('landing.partners.title')}</p>
        <div className="mt-7 flex flex-wrap items-center justify-center gap-x-12 gap-y-5">
          {PARTNERS.map((p) => (
            <span key={p} className="text-xl font-semibold text-white/30">{p}</span>
          ))}
        </div>
      </section>

      {/* PRICE CALCULATOR */}
      <section id="pricing" className="container-page py-20"><PriceCalculator /></section>

      {/* TESTIMONIALS */}
      <section className="container-page py-16">
        <SectionHeader badge={t('nav.scenarios')} title={t('landing.testimonials.title')} />
        <div className="mt-14 grid gap-5 lg:grid-cols-3">
          {dict.landing.testimonials.items.map((r, i) => (
            <div key={r.name} className="card p-7">
              <div className="flex gap-0.5 text-amber">
                {[0, 1, 2, 3, 4].map((s) => <Star key={s} size={15} fill="currentColor" />)}
              </div>
              <p className="mt-4 text-[15px] leading-relaxed text-text">“{r.text}”</p>
              <div className="mt-6 flex items-center gap-3">
                <span className={`flex h-10 w-10 items-center justify-center rounded-full font-medium text-white ${['bg-violet', 'bg-blue', 'bg-cyan'][i % 3]}`}>{r.name.charAt(0)}</span>
                <div>
                  <p className="font-medium text-text">{r.name}</p>
                  <p className="text-xs text-fog">{r.role}</p>
                </div>
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* FAQ */}
      <section id="faq" className="container-page py-20">
        <SectionHeader badge="FAQ" title={t('landing.faq.title')} />
        <div className="mx-auto mt-12 max-w-3xl">
          <Accordion items={dict.landing.faq.items.map((f) => ({ q: f.q, a: f.a }))} />
        </div>
      </section>

      {/* FINAL CTA */}
      <section className="container-page pb-24">
        <div className="relative overflow-hidden rounded-3xl bg-brand px-8 py-16 text-center shadow-lg sm:px-16">
          <span className="absolute -left-10 -top-10 h-40 w-40 rounded-full bg-white/15 blur-2xl" />
          <span className="absolute -bottom-12 -right-8 h-44 w-44 rounded-full bg-white/10 blur-2xl" />
          <div className="relative">
            <h2 className="text-[clamp(2rem,4vw,3rem)] font-extrabold tracking-tight text-white">{t('landing.finalCta.title')}</h2>
            <p className="mx-auto mt-4 max-w-lg text-white/85">{t('landing.finalCta.desc')}</p>
            <div className="mt-8 flex justify-center">
              <Button to="/auth?mode=signup" size="lg" className="!bg-white !bg-none !text-bg shadow-none hover:brightness-95">
                {t('landing.finalCta.button')} <ArrowRight size={17} />
              </Button>
            </div>
          </div>
        </div>
      </section>

      <MarketingFooter />
    </div>
  )
}
