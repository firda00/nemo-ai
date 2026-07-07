import { useEffect, useState } from 'react'
import { Bot, Brain, CheckCircle2, Database, GitBranch, Play, RefreshCw, ShieldCheck, UserPlus, Zap } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { Button } from '../ui/Button'
import { cn } from '../../lib/cn'

const agents = [
  { id: 'leader', name: 'Team Leader', role: 'Routes intent', icon: Bot, color: 'text-violet', bg: 'bg-violet/15' },
  { id: 'brain', name: 'Knowledge Agent', role: 'Reads Company Brain', icon: Brain, color: 'text-cyan', bg: 'bg-cyan/15' },
  { id: 'sales', name: 'Sales Qualifier', role: 'Captures need + budget', icon: UserPlus, color: 'text-teal', bg: 'bg-teal/15' },
  { id: 'crm', name: 'CRM Handoff', role: 'Creates lead row', icon: Database, color: 'text-blue', bg: 'bg-blue/15' },
  { id: 'quality', name: 'Quality Reviewer', role: 'Checks final answer', icon: ShieldCheck, color: 'text-amber', bg: 'bg-amber/15' },
]

const trace = [
  'Team Leader detected buying intent',
  'Knowledge Agent checked pricing and schedule',
  'Sales Qualifier asked for phone number',
  'CRM Handoff prepared lead payload',
  'Quality Reviewer approved tone and policy',
]

export function AgentOrchestrationDemo({ compact = false }: { compact?: boolean }) {
  const [active, setActive] = useState(-1)
  const [running, setRunning] = useState(false)

  const run = () => {
    setActive(0)
    setRunning(true)
  }

  useEffect(() => {
    if (!running) return
    if (active >= agents.length - 1) {
      const done = window.setTimeout(() => setRunning(false), 700)
      return () => window.clearTimeout(done)
    }
    const id = window.setTimeout(() => setActive((v) => v + 1), 850)
    return () => window.clearTimeout(id)
  }, [active, running])

  const complete = active >= agents.length - 1 && !running

  return (
    <div className="gradient-ring rounded-3xl p-px">
      <div className="relative overflow-hidden rounded-[1.45rem] bg-panel/90 p-5 shadow-lg">
        <div className="absolute inset-0 dot-field opacity-30" />
        <div className="relative flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <p className="mono-label">Live orchestration</p>
            <h2 className="mt-2 text-2xl font-extrabold text-text">Multi-agent team run</h2>
            <p className="mt-2 max-w-2xl text-sm leading-relaxed text-muted">
              One customer message is routed through a team: leader, knowledge, qualifier, CRM and quality reviewer.
            </p>
          </div>
          <Button onClick={run} size="sm" disabled={running} leftIcon={running ? <RefreshCw size={15} className="animate-spin" /> : <Play size={15} />}>
            {running ? 'Running agents' : complete ? 'Run again' : 'Run demo'}
          </Button>
        </div>

        <div className={cn('relative mt-6 grid gap-4', compact ? 'lg:grid-cols-1' : 'lg:grid-cols-[1fr_0.9fr]')}>
          <div className="rounded-3xl border border-white/10 bg-bg/65 p-4">
            <div className="grid gap-3 sm:grid-cols-5">
              {agents.map((agent, index) => {
                const Icon = agent.icon
                const isActive = index === active && running
                const isDone = index <= active && active !== -1
                return (
                  <div key={agent.id} className={cn('rounded-2xl border p-3 transition-all', isActive ? 'border-cyan/60 bg-cyan/10 shadow-glow' : isDone ? 'border-teal/30 bg-teal/5' : 'border-white/10 bg-white/[0.035]')}>
                    <span className={cn('flex h-10 w-10 items-center justify-center rounded-xl', agent.bg, agent.color)}>
                      {isDone && !isActive ? <CheckCircle2 size={18} /> : <Icon size={18} />}
                    </span>
                    <p className="mt-3 text-sm font-semibold text-text">{agent.name}</p>
                    <p className="mt-1 text-[11px] leading-snug text-muted">{agent.role}</p>
                  </div>
                )
              })}
            </div>

            <div className="mt-4 rounded-2xl border border-violet/20 bg-violet/10 p-4">
              <p className="flex items-center gap-2 text-sm font-semibold text-text"><GitBranch size={16} className="text-violet" /> Agent Trace</p>
              <div className="mt-3 space-y-2">
                {trace.map((item, index) => (
                  <div key={item} className={cn('flex items-center gap-2 rounded-xl px-3 py-2 text-xs transition', index <= active ? 'bg-white/10 text-text' : 'bg-transparent text-muted/60')}>
                    <span className={cn('h-2 w-2 rounded-full', index <= active ? 'bg-teal' : 'bg-white/20')} />
                    {item}
                  </div>
                ))}
              </div>
            </div>
          </div>

          {!compact && (
            <div className="space-y-4">
              <div className="rounded-3xl border border-white/10 bg-bg/65 p-4">
                <p className="text-sm font-semibold text-text">Customer conversation</p>
                <div className="mt-4 space-y-3">
                  <div className="max-w-[88%] rounded-2xl rounded-tl-md border border-white/10 bg-white/[0.05] px-4 py-3 text-sm text-text">How much is the course and can I start this week?</div>
                  <div className={cn('ml-auto max-w-[92%] rounded-2xl rounded-tr-md border px-4 py-3 text-sm leading-relaxed transition', active >= 4 ? 'border-violet/30 bg-violet/10 text-text' : 'border-white/10 bg-white/[0.03] text-muted')}>
                    Yes. The next cohort starts Monday. The standard plan is $199/month. Please share your phone number and our advisor will confirm your schedule.
                  </div>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <Mini icon={Zap} label="Nemo Score" value={active >= 4 ? '94' : '--'} tone="text-teal bg-teal/10" />
                <Mini icon={Database} label="Lead status" value={active >= 3 ? 'Created' : 'Waiting'} tone="text-cyan bg-cyan/10" />
                <Mini icon={ShieldCheck} label="Quality" value={active >= 4 ? 'Pass' : 'Pending'} tone="text-violet bg-violet/10" />
                <Mini icon={Brain} label="Brain hits" value={active >= 1 ? '3 docs' : '--'} tone="text-amber bg-amber/10" />
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function Mini({ icon: Icon, label, value, tone }: { icon: LucideIcon; label: string; value: string; tone: string }) {
  return (
    <div className="rounded-2xl border border-white/10 bg-white/[0.04] p-4">
      <span className={cn('flex h-9 w-9 items-center justify-center rounded-xl', tone)}><Icon size={16} /></span>
      <p className="mt-3 text-xl font-bold text-text">{value}</p>
      <p className="text-[11px] text-muted">{label}</p>
    </div>
  )
}
