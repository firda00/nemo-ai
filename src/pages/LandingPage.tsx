import {
  ArrowRight,
  ArrowUpRight,
  Sparkles,
  Bot,
  Users,
  ShieldCheck,
  MessageSquareText,
  Database,
  PhoneCall,
  BarChart3,
  CheckCircle2,
} from 'lucide-react'
import { useI18n } from '../i18n'
import { MarketingHeader } from '../components/layout/MarketingHeader'
import { MarketingFooter } from '../components/layout/MarketingFooter'
import { Button } from '../components/ui/Button'
import { Accordion } from '../components/ui/Accordion'
import { cn } from '../lib/cn'

const BENEFITS = [
  ['01', 'Real workflow endpoint', 'Run one focused workflow instead of disconnected screens.'],
  ['02', 'Structured agent trace', 'Show what Team Lead and Specialist Agents did before the result.'],
  ['03', 'i18n-ready UI', 'UZ/RU/EN support is visible as part of the product advantage.'],
  ['04', 'Live & connected', 'Outputs are clearly labeled until your real integrations are connected.'],
]

const HOW_STEPS = [
  ['01', 'Create the education sales team', 'Nemo creates a master agent and specialist sales sub-agents from one template.'],
  ['02', 'Paste student leads', 'Add raw leads from Telegram, Instagram, forms, or your manager chat.'],
  ['03', 'Run the workflow', 'Agents qualify intent, recommend course, write follow-up and prepare CRM rows.'],
  ['04', 'Send manager report', 'Get hot/warm/cold leads, next actions, and a daily sales summary.'],
]

const CAPABILITIES = [
  ['Lead qualification', 'Automatically scores every student lead as hot, warm, or cold.', Users],
  ['Personal follow-up', 'Writes contextual messages based on course interest and readiness.', MessageSquareText],
  ['CRM-ready table', 'Turns messy lead notes into structured rows for a manager or CRM.', Database],
  ['Daily sales report', 'Summarizes what happened and who needs a call today.', BarChart3],
  ['Human handoff', 'Flags leads that need a manager instead of pretending to close everything.', PhoneCall],
  ['CRM & Sheets integrations', 'Structured outputs ready to connect to your CRM or Google Sheets.', ShieldCheck],
]

const USE_CASES = [
  ['Education centers', 'Qualify course requests and route hot leads to admissions managers.'],
  ['Online schools', 'Follow up after webinar, trial lesson, or course inquiry.'],
  ['Training academies', 'Track leads by course, schedule, payment readiness and next action.'],
  ['B2B sales teams', 'Reduce manual CRM work and daily reporting overhead.'],
]

const copy = {
  en: {
    badge: 'Live workflow execution, not mock UI',
    title: 'Build AI teams that run business workflows',
    subtitle: 'Create a team lead agent, add specialist agents, and automate sales, support, CRM updates, reporting, and operations — without building internal AI infrastructure.',
    ctaCreate: 'Create AI Team', ctaDemo: 'See how it works',
    chips: ['Telegram-ready', 'CRM-ready', 'UZ/RU/EN', 'Human takeover', 'Live workspace'],
    loopTitle: 'Designed around one clear product loop.',
    loopSub: 'Create AI Team → Run Workflow → Agent Execution → Results. No extra screens unless they support this core product story.',
    templateTitle: 'AI Team Templates',
    templateSub: 'Use practical vertical templates for repeatable workflows until the product is mature.',
    openTemplates: 'Open templates',
    problemTitle: 'Businesses do not need another chatbot.',
    problemSub: 'They need AI workers that finish tasks: qualify leads, write replies, prepare CRM rows and create manager reports.',
    solutionTitle: 'Team Lead + Specialist Agents + Tools + Human takeover.',
    solutionSub: 'Nemo turns repeatable work into a visible workflow with clear agent execution, structured output and clear live states.',
    demoTitle: 'Workflow: education sales team',
    templatesTitle: 'AI Team Templates',
    featuresTitle: 'Everything needed for one credible workflow',
    pricingTitle: 'Pricing for early teams',
    pricingSub: 'Start with one AI team, one workflow and clear integration boundaries before scaling across departments.',
    bookDemo: 'Get started',
  },
  ru: {
    badge: 'Живое выполнение workflow, не mock UI',
    title: 'Создавайте AI-команды для бизнес-процессов',
    subtitle: 'Создайте Team Lead Agent, добавьте Specialist Agents и автоматизируйте продажи, поддержку, CRM-обновления, отчёты и операции — без внутренней AI-инфраструктуры.',
    ctaCreate: 'Создать AI-команду', ctaDemo: 'Как это работает',
    chips: ['Telegram-ready', 'CRM-ready', 'UZ/RU/EN', 'Human takeover', 'Live workspace'],
    loopTitle: 'Собрано вокруг одного понятного продуктового потока.',
    loopSub: 'Create AI Team → Run Workflow → Agent Execution → Results. Без лишних экранов, если они не усиливают основной продуктовый сценарий.',
    templateTitle: 'AI Team Templates',
    templateSub: 'Используйте практичные вертикальные шаблоны для повторяемых workflow, пока core product не созрел.',
    openTemplates: 'Открыть templates',
    problemTitle: 'Бизнесу не нужен ещё один chatbot.',
    problemSub: 'Нужны AI-сотрудники, которые завершают задачи: квалифицируют лиды, пишут ответы, готовят CRM-строки и отчёты менеджеру.',
    solutionTitle: 'Team Lead + Specialist Agents + Tools + Human takeover.',
    solutionSub: 'Nemo превращает повторяемую работу в видимый workflow с agent execution, структурным результатом и понятным live-состоянием.',
    demoTitle: 'Workflow: продажи в образовании',
    templatesTitle: 'AI Team Templates',
    featuresTitle: 'Всё для одного убедительного workflow',
    pricingTitle: 'Цены для ранних команд',
    pricingSub: 'Запустите одну AI-команду, один workflow и прозрачные интеграции перед масштабированием.',
    bookDemo: 'Начать',
  },
  uz: {
    badge: 'Haqiqiy workflow bajarilishi, mock UI emas',
    title: 'Biznes workflowlarni bajaradigan AI-komandalar yarating',
    subtitle: 'Team Lead Agent yarating, Specialist Agentlar qo‘shing va sotuv, support, CRM, hisobot va operatsiyalarni ichki AI-infrastrukturasiz avtomatlashtiring.',
    ctaCreate: 'AI-komanda yaratish', ctaDemo: 'Qanday ishlaydi',
    chips: ['Telegram-ready', 'CRM-ready', 'UZ/RU/EN', 'Human takeover', 'Live workspace'],
    loopTitle: 'Bitta aniq mahsulot loopi atrofida qurilgan.',
    loopSub: 'Create AI Team → Run Workflow → Agent Execution → Results. Core product storyga xizmat qilmaydigan ortiqcha ekranlarsiz.',
    templateTitle: 'AI Team Templates',
    templateSub: 'Product yetilmaguncha repeatable workflowlar uchun amaliy vertikal templatelardan foydalaning.',
    openTemplates: 'Templatelarni ochish',
    problemTitle: 'Biznesga yana bitta chatbot kerak emas.',
    problemSub: 'Biznesga vazifani yakunlaydigan AI-ishchilar kerak: lead qualification, replies, CRM rows va manager reports.',
    solutionTitle: 'Team Lead + Specialist Agents + Tools + Human takeover.',
    solutionSub: 'Nemo takroriy ishlarni ko‘rinadigan workflowga aylantiradi: agent execution, structured output va aniq live holati.',
    demoTitle: 'Workflow: education sales team',
    templatesTitle: 'AI Team Templates',
    featuresTitle: 'Bitta ishonchli workflow uchun kerakli hamma narsa',
    pricingTitle: 'Ilk komandalar uchun narxlar',
    pricingSub: 'Kengaytirishdan oldin bitta AI-komanda, bitta workflow va aniq integration chegaralarini ishga tushiring.',
    bookDemo: 'Boshlash',
  },
}

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

function HeroPreview() {
  const trace = ['Team Lead routed task', 'Lead Qualifier scored leads', 'Follow-up Agent wrote replies', 'CRM Agent prepared rows', 'Report Agent generated summary']

  return (
    <div className="relative mx-auto mt-14 w-full max-w-5xl lg:mt-0">
      <div className="absolute -inset-6 rounded-[2rem] bg-blue/10 blur-3xl" />
      <div className="relative overflow-hidden rounded-[1.8rem] border border-[#24314D] bg-[#090E1D]/95 shadow-2xl shadow-black/35">
        <div className="flex items-center justify-between border-b border-white/8 bg-white/[0.025] px-5 py-4">
          <h3 className="text-base font-semibold text-text">Workflow run #2481</h3>
          <span className="inline-flex items-center gap-2 rounded-pill border border-green-400/30 bg-green-400/10 px-3 py-1 text-xs font-semibold text-green-400">
            <span className="h-2 w-2 rounded-full bg-green-400" /> Completed
          </span>
        </div>
        <div className="grid gap-5 p-5 lg:grid-cols-[0.58fr_1fr]">
          <aside className="rounded-3xl border border-white/10 bg-[#0E1527] p-4">
            <p className="mb-4 text-[11px] font-semibold uppercase tracking-[0.16em] text-muted">AI Team</p>
            {['Team Lead Agent', 'Lead Qualifier', 'Follow-up Agent', 'CRM Agent', 'Report Agent'].map((agent, index) => (
              <div key={agent} className="mb-3 flex items-center gap-3 rounded-2xl border border-white/10 bg-bg/40 px-3 py-3 last:mb-0">
                <span className={cn('h-4 w-4 rounded-full', ['bg-cyan', 'bg-green-400', 'bg-violet', 'bg-amber', 'bg-blue'][index])} />
                <span className="text-xs font-medium text-text">{agent}</span>
              </div>
            ))}
          </aside>

          <div className="space-y-5">
            <div className="rounded-3xl border border-white/10 bg-[#0E1527] p-5">
              <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-muted">Input · Telegram lead</p>
              <p className="mt-3 text-lg font-medium leading-snug text-text">“I want IELTS. Price? Can I start this week?”</p>
            </div>

            <div className="grid gap-5 md:grid-cols-[1.4fr_0.9fr]">
              <div className="rounded-3xl border border-white/10 bg-[#0E1527] p-5">
                <p className="text-base font-semibold text-text">Agent trace</p>
                <div className="mt-4 space-y-3">
                  {trace.map((item, index) => (
                    <div key={item} className="flex items-start gap-3 text-sm text-muted">
                      <span className={cn('mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[10px] text-bg', index % 2 ? 'bg-green-400' : 'bg-cyan')}>
                        <CheckCircle2 size={13} />
                      </span>
                      <span>{item}</span>
                    </div>
                  ))}
                </div>
              </div>

              <div className="rounded-3xl border border-white/10 bg-[#0E1527] p-5">
                <p className="text-base font-semibold text-text">Output</p>
                <div className="mt-4 space-y-3">
                  <div className="rounded-2xl border border-green-400/25 bg-green-400/10 p-3"><p className="text-xs font-semibold text-green-400">Hot leads</p><p className="mt-1 text-3xl font-black text-text">3</p></div>
                  <div className="rounded-2xl border border-amber/30 bg-amber/10 p-3"><p className="text-xs font-semibold text-amber">Warm leads</p><p className="mt-1 text-3xl font-black text-text">2</p></div>
                  <div className="rounded-2xl border border-white/10 bg-white/[0.04] p-3"><p className="text-sm font-semibold text-muted">0 cold</p></div>
                </div>
              </div>
            </div>

            <div className="rounded-3xl border border-cyan/30 bg-cyan/10 p-5">
              <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-cyan">Manager next action</p>
              <p className="mt-3 text-sm font-medium leading-relaxed text-text">Call Aziza, Madina and Nilufar first. CRM-ready rows and daily summary saved.</p>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

export default function LandingPage() {
  const { t, dict, lang } = useI18n()
  const c = copy[lang]

  return (
    <div className="min-h-screen bg-bg">
      <MarketingHeader />

      {/* HERO */}
      <section className="relative overflow-hidden">
        {/* premium animated backdrop: aurora + fading grid + top brand glow */}
        <div className="aurora" />
        <div className="grid-overlay" />
        <div className="pointer-events-none absolute inset-x-0 top-0 h-[640px] bg-brand-radial" />
        <div className="container-page relative grid items-center gap-12 py-20 sm:py-24 lg:grid-cols-[0.9fr_1.1fr] lg:py-28">
          <div className="text-center lg:text-left">
            <PillBadge icon={Sparkles}>{c.badge}</PillBadge>
            <h1 className="mx-auto mt-8 max-w-4xl text-[clamp(2.5rem,5.3vw,4.65rem)] font-black leading-[1.02] tracking-tight text-text lg:mx-0">
              {c.title}
            </h1>
            <p className="mx-auto mt-7 max-w-xl text-lg leading-relaxed text-muted lg:mx-0">{c.subtitle}</p>
            <div className="mt-9 flex flex-wrap items-center justify-center gap-3 lg:justify-start">
              <Button to="/app/create-team" size="lg">{c.ctaCreate} <ArrowRight size={17} /></Button>
              <Button to="/app/run-workflow" variant="outline" size="lg">{c.ctaDemo}</Button>
            </div>
            <div className="mt-6 flex flex-wrap justify-center gap-2 lg:justify-start">
              {c.chips.map((chip) => <PillBadge key={chip}>{chip}</PillBadge>)}
            </div>
          </div>
          <HeroPreview />
        </div>
      </section>

      {/* PROBLEM / SOLUTION */}
      <section id="product" className="container-page pb-10">
        <div className="grid gap-5 lg:grid-cols-2">
          <div className="rounded-[1.75rem] border border-white/10 bg-white/[0.03] p-8">
            <p className="mono-label">Problem</p>
            <h2 className="mt-4 text-3xl font-extrabold tracking-tight text-text">{c.problemTitle}</h2>
            <p className="mt-4 max-w-xl text-base leading-relaxed text-muted">{c.problemSub}</p>
            <div className="mt-6 grid gap-3 sm:grid-cols-2">
              {['Missed leads', 'Forgotten follow-ups', 'Manual CRM updates', 'Manual reports'].map((item) => (
                <div key={item} className="rounded-2xl border border-white/10 bg-bg/45 p-4 text-sm font-medium text-muted">{item}</div>
              ))}
            </div>
          </div>
          <div className="rounded-[1.75rem] border border-cyan/20 bg-cyan/10 p-8">
            <p className="mono-label text-cyan">Solution</p>
            <h2 className="mt-4 text-3xl font-extrabold tracking-tight text-text">{c.solutionTitle}</h2>
            <p className="mt-4 max-w-xl text-base leading-relaxed text-muted">{c.solutionSub}</p>
            <div className="mt-6 flex flex-wrap gap-2">
              {['Team Lead Agent', 'Specialist Agents', 'Tools', 'Human takeover'].map((item) => <PillBadge key={item}>{item}</PillBadge>)}
            </div>
          </div>
        </div>
      </section>

      {/* TRUST CARDS */}
      <section className="container-page py-8">
        <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
          {BENEFITS.map(([value, label, desc]) => (
            <div key={label} className="rounded-[1.35rem] border border-[#24314D] bg-[#0B1020] px-6 py-6 transition-transform duration-200 hover:-translate-y-1">
              <p className="text-sm font-bold text-cyan">{value}</p>
              <p className="mt-4 text-lg font-bold text-text">{label}</p>
              <p className="mt-1 text-xs leading-relaxed text-muted">{desc}</p>
            </div>
          ))}
        </div>
      </section>

      <section id="workflow" className="container-page py-12">
        <div className="grid gap-5 lg:grid-cols-[1.2fr_0.8fr]">
          <div className="rounded-[1.75rem] border border-[#24314D] bg-[#0B1020] p-8">
            <p className="mono-label">Core product loop</p>
            <h2 className="mt-3 text-3xl font-extrabold tracking-tight text-text">{c.loopTitle}</h2>
            <p className="mt-3 max-w-2xl text-sm leading-relaxed text-muted">{c.loopSub}</p>
            <div className="mt-6 flex flex-wrap gap-2">
              {['Create AI Team', 'Run Workflow', 'Agent Execution', 'Results'].map((step, index) => (
                <span key={step} className="inline-flex items-center gap-2 rounded-pill border border-white/10 bg-white/[0.04] px-3 py-1.5 text-xs text-muted">
                  <span className="text-violet">{index + 1}</span>{step}
                </span>
              ))}
            </div>
          </div>
          <div className="rounded-[1.75rem] border border-cyan/20 bg-cyan/10 p-8">
            <p className="mono-label text-cyan">Templates</p>
            <h2 className="mt-3 text-2xl font-extrabold text-text">{c.templateTitle}</h2>
            <p className="mt-3 text-sm leading-relaxed text-muted">{c.templateSub}</p>
            <Button to="/app/templates" variant="outline" size="sm" className="mt-6">{c.openTemplates} <ArrowRight size={15} /></Button>
          </div>
        </div>
      </section>

      {/* HOW IT WORKS */}
      <section id="how" className="container-page py-20">
        <SectionHeader badge="Example workflow" title={c.demoTitle} sub="One focused workflow for education businesses: lead response, qualification, follow-up, CRM-ready output, and daily reporting." />
        <div className="mx-auto mt-10 flex max-w-4xl flex-wrap items-center justify-center gap-2 rounded-3xl border border-white/10 bg-white/[0.03] p-3">
          {['Describe goal', 'AI team assembled', 'Paste leads', 'Workflow results'].map((step, index) => <span key={step} className="inline-flex items-center gap-2 rounded-pill border border-white/10 bg-black/20 px-3 py-1.5 text-xs text-muted"><span className="text-violet">{index + 1}</span>{step}</span>)}
        </div>
        <div className="mt-10 grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
          {HOW_STEPS.map(([k, title, desc]) => (
            <div key={k} className="card group relative p-7">
              <span className="text-sm font-semibold text-violet">{k}</span>
              <h3 className="mt-3 text-2xl font-bold text-text">{title}</h3>
              <p className="mt-2 text-sm leading-relaxed text-muted">{desc}</p>
              <span className="absolute right-5 top-5 flex h-8 w-8 items-center justify-center rounded-full bg-brand text-white shadow-btn">
                <ArrowUpRight size={16} />
              </span>
            </div>
          ))}
        </div>
      </section>

      {/* TEMPLATES */}
      <section id="templates" className="container-page py-20">
        <SectionHeader badge="AI Team Templates" title={c.templatesTitle} sub="Start with a proven AI team template, then customize agents, prompts, tools, and workflow logic." />
        <div className="mt-12 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {['Education Sales Team', 'E-commerce Support Team', 'Clinic Reception Team', 'Real Estate AI Team', 'SaaS Sales Team', 'Restaurant Booking Team'].map((title, index) => (
            <div key={title} className="rounded-[1.35rem] border border-[#24314D] bg-[#0B1020] p-6">
              <p className="text-xs font-bold text-cyan">0{index + 1}</p>
              <h3 className="mt-4 text-xl font-bold text-text">{title}</h3>
              <p className="mt-2 text-sm leading-relaxed text-muted">5 Specialist Agents · Setup 5-12 min · Status: Ready template</p>
              <Button to="/app/templates" variant="outline" size="sm" className="mt-5">Use template <ArrowRight size={14} /></Button>
            </div>
          ))}
        </div>
      </section>

      {/* FEATURES */}
      <section id="features" className="container-page py-20">
        <SectionHeader badge="Product capabilities" title={c.featuresTitle} sub="Not a generic chatbot builder. Nemo is focused on the workflow admissions and sales managers already run every day." />
        <div className="mt-14 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
          {CAPABILITIES.map((item) => {
            const [title, desc, Icon] = item as [string, string, typeof Bot]
            return (
              <div key={title} className="rounded-[1.35rem] border border-[#24314D] bg-[#0B1020] p-7">
                <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-violet/15 text-violet">
                  <Icon size={20} strokeWidth={1.8} />
                </span>
                <h3 className="mt-5 text-xl font-bold text-text">{title}</h3>
                <p className="mt-2 text-sm leading-relaxed text-muted">{desc}</p>
              </div>
            )
          })}
        </div>
      </section>

      {/* USE CASES */}
      <section id="scenarios" className="container-page py-12">
        <div className="rounded-3xl border border-white/10 bg-white/[0.035] p-8">
          <div className="flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
            <div>
              <p className="mono-label">Built for the first wedge</p>
              <h2 className="mt-2 text-3xl font-extrabold text-text">Built for teams with repeatable business workflows</h2>
            </div>
            <p className="max-w-md text-sm leading-relaxed text-muted">This is the focused segment we build for first: teams with repeatable sales and operations workflows.</p>
          </div>
          <div className="mt-6 grid gap-4 md:grid-cols-2 lg:grid-cols-4">
            {USE_CASES.map(([title, desc]) => <div key={title} className="rounded-2xl border border-white/10 bg-black/20 p-4"><p className="font-semibold text-text">{title}</p><p className="mt-2 text-xs leading-relaxed text-muted">{desc}</p></div>)}
          </div>
        </div>
      </section>

      {/* PRICING */}
      <section className="container-page py-16">
        <div className="rounded-[1.75rem] border border-[#24314D] bg-[#0B1020] p-8 lg:flex lg:items-center lg:justify-between">
          <div>
            <p className="mono-label">Pricing</p>
            <h2 className="mt-3 text-3xl font-extrabold text-text">{c.pricingTitle}</h2>
            <p className="mt-3 max-w-2xl text-sm leading-relaxed text-muted">{c.pricingSub}</p>
          </div>
          <div className="mt-6 flex flex-wrap gap-3 lg:mt-0">
            <Button to="/app/billing" variant="outline">Pricing</Button>
            <Button to="/auth?mode=signup" className="!bg-white !bg-none !text-bg shadow-none hover:brightness-95">{c.bookDemo}</Button>
          </div>
        </div>
      </section>

      {/* COMPARISON */}
      <section className="container-page py-16">
        <SectionHeader badge="Why now" title="Manual follow-up does not scale" sub="LLMs are finally strong enough for multi-step workflows. Nemo packages them into AI teams with a Team Lead and Specialist Agents." />
        <div className="mt-14 grid gap-5 lg:grid-cols-2">
          <div className="card p-7"><p className="text-xl font-bold text-text">Before Nemo</p><div className="mt-5 space-y-3 text-sm text-muted"><p>Leads sit in Telegram/Instagram chats.</p><p>Managers forget follow-up and CRM updates.</p><p>Directors do not get a clear daily sales report.</p></div></div>
          <div className="card border-violet/40 bg-violet/10 p-7"><p className="text-xl font-bold text-text">With Nemo AI Sales Team</p><div className="mt-5 space-y-3 text-sm text-muted"><p>Every lead is qualified as hot/warm/cold.</p><p>Personalized follow-up is ready in seconds.</p><p>CRM-ready rows and daily manager report are generated automatically.</p></div></div>
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
            <h2 className="text-[clamp(2rem,4vw,3rem)] font-extrabold tracking-tight text-white">Launch your first AI sales team in minutes</h2>
            <p className="mx-auto mt-4 max-w-lg text-white/85">Create the education sales team, paste leads, and see qualification, follow-up, CRM-ready rows, and a daily report in one workflow.</p>
            <div className="mt-8 flex flex-wrap justify-center gap-3">
              <Button to="/app/create-team" size="lg" className="!bg-white !bg-none !text-bg shadow-none hover:brightness-95">
                Start free <ArrowRight size={17} />
              </Button>
              <Button to="/auth?mode=signup" size="lg" className="!bg-white !bg-none !text-bg shadow-none hover:brightness-95">
                Get started
              </Button>
            </div>
          </div>
        </div>
      </section>

      <MarketingFooter />
    </div>
  )
}
