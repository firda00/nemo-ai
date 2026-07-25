import { ArrowRight, BarChart3, Brain, CheckCircle2, DollarSign, GitBranch, ShieldCheck, Sparkles, Users } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { Button } from '../components/ui/Button'
import { MarketingHeader } from '../components/layout/MarketingHeader'
import { MarketingFooter } from '../components/layout/MarketingFooter'

const metrics = [
  ['TAM', '$180B+', 'SMB software + support + sales automation'],
  ['Wedge', 'Sales + Support', 'Clear ROI for small businesses'],
  ['Pricing', '$25-$350/mo', 'Subscription with a monthly token quota'],
  ['Moat', 'AI team data', 'Templates, traces, evaluations, company brain'],
]

const flow = [
  'Business owner describes a goal',
  'Nemo designs a master agent and sub-agents',
  'AI team connects knowledge, channels and CRM',
  'Agent Trace shows every delegation and result',
]

const solutionCards: { icon: LucideIcon; label: string }[] = [
  { icon: GitBranch, label: 'AI Team Architect' },
  { icon: Brain, label: 'Company Brain' },
  { icon: ShieldCheck, label: 'Quality Checks' },
  { icon: BarChart3, label: 'Nemo Score' },
]

export default function PitchPage() {
  return (
    <div className="min-h-screen bg-bg">
      <MarketingHeader />
      <main className="relative overflow-hidden">
        <div className="aurora" />
        <div className="grid-overlay" />
        <section className="container-page relative py-20 sm:py-28">
          <div className="max-w-4xl">
            <span className="inline-flex items-center gap-2 rounded-pill border border-violet/25 bg-violet/10 px-4 py-2 text-xs font-medium text-violet">
              <Sparkles size={14} /> Investor brief
            </span>
            <h1 className="mt-7 text-[clamp(2.7rem,7vw,5.8rem)] font-black leading-[0.96] tracking-tight text-text">
              Nemo AI is the operating system for <span className="text-gradient">AI teams</span> in small businesses.
            </h1>
            <p className="mt-7 max-w-2xl text-lg leading-relaxed text-muted">
              Describe a business goal. Nemo builds and deploys a team of AI agents: a team leader, specialists, tools, channels, memory, trace and quality checks.
            </p>
            <div className="mt-9 flex flex-wrap gap-3">
              <Button to="/demo" size="lg">Run 2-minute demo <ArrowRight size={17} /></Button>
              <Button to="/" variant="outline" size="lg">Open product</Button>
            </div>
          </div>

          <div className="mt-14 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {metrics.map(([label, value, desc]) => (
              <div key={label} className="card rounded-2xl p-5">
                <p className="mono-label">{label}</p>
                <p className="mt-3 text-3xl font-extrabold text-text">{value}</p>
                <p className="mt-2 text-sm leading-relaxed text-muted">{desc}</p>
              </div>
            ))}
          </div>
        </section>

        <section className="container-page py-12">
          <div className="grid gap-5 lg:grid-cols-[0.9fr_1.1fr]">
            <div className="card rounded-3xl p-7">
              <p className="mono-label">Problem</p>
              <h2 className="mt-3 text-3xl font-extrabold text-text">SMBs cannot hire, manage and measure enough operators.</h2>
              <p className="mt-4 text-muted">They need sales follow-up, support, content and admin work, but existing chatbot builders are single-purpose and hard to trust.</p>
            </div>
            <div className="gradient-ring rounded-3xl p-px">
              <div className="rounded-[1.45rem] bg-panel/90 p-7">
                <p className="mono-label">Solution</p>
                <h2 className="mt-3 text-3xl font-extrabold text-text">Hire an AI team in minutes.</h2>
                <div className="mt-5 grid gap-3 sm:grid-cols-2">
                  {solutionCards.map(({ icon: Icon, label }) => (
                    <div key={label} className="rounded-2xl border border-white/10 bg-white/[0.04] p-4">
                      <Icon size={20} className="text-violet" />
                      <p className="mt-3 font-semibold text-text">{label}</p>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </section>

        <section className="container-page py-12">
          <div className="card rounded-3xl p-7">
            <p className="mono-label">Demo flow</p>
            <div className="mt-6 grid gap-3 md:grid-cols-4">
              {flow.map((step, index) => (
                <div key={step} className="rounded-2xl border border-white/10 bg-white/[0.04] p-4">
                  <span className="flex h-8 w-8 items-center justify-center rounded-full bg-violet/15 text-sm font-bold text-violet">{index + 1}</span>
                  <p className="mt-4 text-sm font-medium text-text">{step}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        <section className="container-page py-12 pb-24">
          <div className="grid gap-5 lg:grid-cols-3">
            <div className="card rounded-3xl p-7">
              <Users className="text-cyan" />
              <h3 className="mt-4 text-xl font-bold text-text">Go-to-market</h3>
              <p className="mt-3 text-sm leading-relaxed text-muted">Start with AI Sales + Support Teams for SMBs, then expand into content, clinics, real estate and education.</p>
            </div>
            <div className="card rounded-3xl p-7">
              <DollarSign className="text-teal" />
              <h3 className="mt-4 text-xl font-bold text-text">Business model</h3>
              <p className="mt-3 text-sm leading-relaxed text-muted">Monthly SaaS tiers with an included token quota. Expansion revenue from more teams, channels and usage.</p>
            </div>
            <div className="card rounded-3xl p-7">
              <CheckCircle2 className="text-violet" />
              <h3 className="mt-4 text-xl font-bold text-text">Why now</h3>
              <p className="mt-3 text-sm leading-relaxed text-muted">LLMs make agents possible; businesses now need orchestration, traceability and ROI, not another chat window.</p>
            </div>
          </div>
        </section>
      </main>
      <MarketingFooter />
    </div>
  )
}
