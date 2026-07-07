import { useState } from 'react'
import { ArrowRight, Bot, Building2, GraduationCap, HeartPulse, Home, Loader2, ShoppingBag, Utensils } from 'lucide-react'
import { Button } from '../../components/ui/Button'
import { useI18n } from '../../i18n'
import { useNavigate } from 'react-router-dom'
import { useAgentStore } from '../../store/useAgentStore'
import { useToast } from '../../components/ui/Toast'
import { createUstudyOperationsTeam } from '../../lib/ustudyTeam'

const templates = [
  { kind: 'agent', icon: Bot, title: 'Course Consultant', market: 'Single Agent', setup: '3 min', agents: 1, tools: ['test chat', 'knowledge'], desc: 'Standalone course consultant that recommends courses and collects student next actions.' },
  { kind: 'team', icon: GraduationCap, title: 'Sales Team', market: 'Education sales', setup: '6 min', agents: 5, tools: ['qualification', 'follow-up', 'crm rows'], desc: 'Student leads, follow-ups, CRM-ready rows and daily sales report for IT Academy.' },
  { kind: 'team', icon: Building2, title: 'Operations Team', market: 'Education operations', setup: '8 min', agents: 6, tools: ['payments', 'admin escalation', 'meeting analysis', 'task management', 'reports'], desc: 'Routine admin and operations automation: payment reminders, admin escalation, meeting-to-tasks, weekly follow-up and manager reports.' },
  { kind: 'team', icon: Building2, title: 'Education Admin Team', market: 'Education ops', setup: '8 min', agents: 6, tools: ['attendance', 'payments', 'risk report'], desc: 'Attendance, payment reminders, student risk, mentor quality and daily education admin report.' },
  { kind: 'team', icon: ShoppingBag, title: 'Content Team', market: 'Marketing', setup: '7 min', agents: 5, tools: ['telegram', 'instagram', 'campaigns'], desc: 'Telegram/Instagram posts, course marketing ideas, content calendar and campaign briefs.' },
  { kind: 'team', icon: HeartPulse, title: 'Student Support Team', market: 'Support', setup: '7 min', agents: 4, tools: ['faq', 'handoff', 'summary'], desc: 'Student questions, FAQ responses, issue triage and human handoff summaries.' },
  { kind: 'team', icon: Home, title: 'HR Recruiting Team', market: 'HR', setup: '10 min', agents: 5, tools: ['screening', 'interviews', 'report'], desc: 'Candidate screening, interview prep, scoring and recruiter summaries.' },
  { kind: 'team', icon: Utensils, title: 'Custom Team', market: 'Custom workflow', setup: '5 min', agents: 4, tools: ['custom', 'trace', 'results'], desc: 'Describe any repeatable workflow and configure Team Lead plus Specialist Agents.' },
]

export default function MarketplacePage() {
  const { t } = useI18n()
  const navigate = useNavigate()
  const addAgent = useAgentStore((s) => s.addAgent)
  const toast = useToast()
  const [seeding, setSeeding] = useState('')

  const applyTemplate = async (tpl: (typeof templates)[number]) => {
    if (tpl.kind === 'agent') {
      localStorage.setItem('nemo-selected-agent-template', JSON.stringify({
        name: tpl.title,
        type: 'qualifier',
        role: 'AI course consultant for IT Academy',
        tasks: tpl.desc,
        tone: 'Friendly, practical, admissions-focused.',
      }))
      navigate('/app/create-agent')
      return
    }
    // Operations Team — create the REAL team (lead agent + department + 6 sub-agents)
    if (tpl.title === 'Operations Team') {
      setSeeding(tpl.title)
      const res = await createUstudyOperationsTeam(addAgent)
      setSeeding('')
      if (res.agentId) navigate(`/app/teams/${res.agentId}`)
      else toast(res.error ?? 'Could not create team', 'error')
      return
    }
    const market = tpl.market.toLowerCase()
    const type = market.includes('admin') || market.includes('ops') ? 'education-admin' : market.includes('sales') || market.includes('education') ? 'sales' : market.includes('support') ? 'support' : market.includes('marketing') ? 'content' : 'custom'
    localStorage.setItem('nemo-selected-template', JSON.stringify({
      teamName: tpl.title,
      teamType: type,
      goal: tpl.desc,
      tools: tpl.tools,
      template: tpl.title,
      selectedAt: new Date().toISOString(),
    }))
    navigate('/app/create-team')
  }

  return (
    <div className="container-page max-w-7xl py-8">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="mono-label">AI Team Templates</p>
          <h1 className="mt-2 text-3xl font-extrabold text-text">{t('marketplacePage.title')}</h1>
          <p className="mt-2 max-w-2xl text-sm leading-relaxed text-muted">{t('marketplacePage.subtitle')}</p>
        </div>
        <Button to="/app/create-team">{t('marketplacePage.custom')}</Button>
      </div>

      <div className="mt-8 grid gap-5 md:grid-cols-2 xl:grid-cols-3">
        {templates.map((tpl) => (
          <div key={tpl.title} className="card flex flex-col rounded-3xl p-6">
            <div className="flex items-start justify-between gap-3">
              <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-violet/15 text-violet"><tpl.icon size={22} /></span>
              <span className="rounded-pill border border-amber/25 bg-amber/10 px-3 py-1 text-xs font-medium text-amber">{tpl.kind === 'agent' ? 'Single agent' : 'Demo template'}</span>
            </div>
            <h2 className="mt-5 text-xl font-bold text-text">{tpl.title}</h2>
            <p className="mt-1 text-xs uppercase tracking-[0.14em] text-muted">{tpl.market} · {tpl.agents} {t('marketplacePage.agents')}</p>
            <p className="mt-4 flex-1 text-sm leading-relaxed text-muted">{tpl.desc}</p>
            <div className="mt-5 grid grid-cols-3 gap-2 text-center">
              <Mini label={t('marketplacePage.status')} value={t('mvp.templates.ready')} />
              <Mini label={t('marketplacePage.setup')} value={tpl.setup} />
              <Mini label={t('marketplacePage.type')} value={t('mvp.templates.vertical')} />
            </div>
            <div className="mt-4 flex flex-wrap gap-1.5">
              {tpl.tools.map((tool) => <span key={tool} className="rounded-pill border border-cyan/20 bg-cyan/10 px-2 py-0.5 text-[10px] text-cyan">{tool}</span>)}
            </div>
            <Button onClick={() => applyTemplate(tpl)} disabled={!!seeding} size="sm" className="mt-5">
              {seeding === tpl.title ? <><Loader2 size={15} className="animate-spin" /> …</> : <>{t('marketplacePage.use')} <ArrowRight size={15} /></>}
            </Button>
          </div>
        ))}
      </div>
    </div>
  )
}

function Mini({ label, value }: { label: string; value: string }) {
  return <div className="rounded-xl border border-white/10 bg-white/[0.04] p-2"><p className="font-bold text-text">{value}</p><p className="text-[10px] text-muted">{label}</p></div>
}
