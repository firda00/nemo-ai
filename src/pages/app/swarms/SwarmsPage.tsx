import { Button } from '../../../components/ui/Button'
import { Card } from '../../../components/ui/Card'
import { Plus, Cpu, Layers, ArrowRight, Sparkles, Workflow, ShieldCheck, Image, Search, PenLine, Megaphone, KeyRound } from 'lucide-react'
import { Link, useNavigate } from 'react-router-dom'
import { blankAgent, useAgentStore } from '../../../store/useAgentStore'
import { useMemo, useState } from 'react'
import { useI18n } from '../../../i18n'

const toolOptions = [
  { id: 'image', label: 'Image generation', desc: 'swarmsPage.toolImageDesc', Icon: Image, providers: ['OpenAI Images', 'Stability AI', 'Google Imagen'] },
  { id: 'research', label: 'Deep research', desc: 'swarmsPage.toolResearchDesc', Icon: Search, providers: ['Perplexity', 'Tavily', 'Google Search'] },
  { id: 'content', label: 'Content creation', desc: 'swarmsPage.toolContentDesc', Icon: PenLine, providers: ['OpenAI', 'Anthropic', 'Google AI'] },
  { id: 'publishing', label: 'Publishing', desc: 'swarmsPage.toolPublishingDesc', Icon: Megaphone, providers: ['Telegram', 'Meta', 'WordPress'] },
]

const demoTeams = [
  {
    id: 'content-os',
    name: 'swarmsPage.demoContentName',
    desc: 'swarmsPage.demoContentDesc',
    status: 'swarmsPage.statusActive',
    statusCls: 'bg-teal/10 text-teal border-teal/20',
    initials: ['M', 'S', 'P', 'A'],
    Icon: Cpu,
    iconCls: 'bg-violet/10 text-violet',
  },
  {
    id: 'sales-os',
    name: 'swarmsPage.demoSalesName',
    desc: 'swarmsPage.demoSalesDesc',
    status: 'swarmsPage.statusDraft',
    statusCls: 'bg-amber/10 text-amber border-amber/20',
    initials: ['M', 'Q', 'C'],
    Icon: Layers,
    iconCls: 'bg-cyan/10 text-cyan',
  },
]

export default function SwarmsPage() {
  const navigate = useNavigate()
  const { t } = useI18n()
  const agents = useAgentStore((s) => s.agents)
  const workflowAgents = useMemo(() => agents.filter((agent) => agent.type === 'workflow'), [agents])
  const addAgent = useAgentStore((s) => s.addAgent)
  const [goal, setGoal] = useState(() => t('swarmsPage.goalDefault'))
  const [selectedTools, setSelectedTools] = useState<string[]>(['research', 'content', 'image', 'publishing'])
  const [apiKeys, setApiKeys] = useState<Record<string, string>>({})
  const teams = [
    ...workflowAgents.map((agent) => ({
      id: agent.id,
      name: agent.name || 'Custom AI Team',
      desc: agent.purpose || agent.prompt.tasks || t('swarmsPage.teamDefaultDesc'),
      status: agent.status === 'active' ? t('swarmsPage.statusActive') : agent.status === 'paused' ? t('swarmsPage.statusPaused') : t('swarmsPage.statusDraft'),
      statusCls: agent.status === 'active' ? 'bg-teal/10 text-teal border-teal/20' : 'bg-amber/10 text-amber border-amber/20',
      initials: ['M', 'A', 'Q'],
      Icon: Cpu,
      iconCls: 'bg-violet/10 text-violet',
    })),
    ...demoTeams.map((team) => ({ ...team, name: t(team.name), desc: t(team.desc), status: t(team.status) })),
  ]

  const createTeam = async (opts: { kind: 'sales' | 'support' | 'content' | 'custom'; goal?: string; tools?: string[] }) => {
    const base = blankAgent()
    const presets = {
      sales: {
        name: 'AI Sales Team',
        niche: 'Sales / SMB',
        purpose: 'Квалифицировать лидов, отвечать на вопросы о продукте, закрывать заявки и передавать горячих клиентов оператору/CRM.',
        tasks: 'Master agent routes every request to lead qualifier, product consultant, objection handler and CRM handoff agent. Capture phone, city, reason, interaction count and exact product/course/service interest.',
      },
      support: {
        name: 'AI Support Team',
        niche: 'Customer Support',
        purpose: 'Отвечать клиентам 24/7, искать ответы в Company Brain и передавать сложные случаи оператору.',
        tasks: 'Master agent routes requests to FAQ specialist, knowledge agent, troubleshooting agent and escalation agent. Keep Agent Trace and Quality Checks.',
      },
      content: {
        name: 'AI Content Team',
        niche: 'Content / Marketing',
        purpose: 'Создавать контент-план, сценарии, посты и рекомендации по улучшению публикаций.',
        tasks: 'Master agent delegates to strategist, scriptwriter, copywriter, publisher and analyst. Return final content package and Nemo Score.',
      },
      custom: {
        name: 'Custom AI Team',
        niche: 'Custom automation',
        purpose: opts.goal || goal,
        tasks: opts.goal || goal,
      },
    }[opts.kind]
    const tools = opts.tools ?? (opts.kind === 'content' ? ['research', 'content', 'image', 'publishing'] : opts.kind === 'support' ? ['research', 'content'] : opts.kind === 'sales' ? ['content', 'research', 'publishing'] : selectedTools)
    const selectedToolLabels = toolOptions.filter((tool) => tools.includes(tool.id)).map((tool) => tool.label).join(', ')

    const result = await addAgent({
      ...base,
      name: presets.name,
      type: 'workflow',
      role: 'Master AI team leader',
      niche: presets.niche,
      purpose: presets.purpose,
      status: 'active',
      channels: ['telegram', 'widget'],
      prompt: {
        role: 'You are the master agent for a business AI team. Delegate tasks to specialist sub-agents, verify quality and escalate when needed.',
        tasks: `${presets.tasks}\n\nEnabled tools/APIs: ${selectedToolLabels || 'core chat only'}. Use only connected tools and ask to connect missing API keys when required.`,
        tone: 'Professional, concise, trustworthy.',
        rules: 'Do not act as a single chatbot. Always decompose work, delegate, verify and explain the outcome clearly.',
      },
      leadForm: {
        enabled: opts.kind !== 'content',
        trigger: 'when the customer shows interest, asks price, product, course, service or requests consultation',
        destination: 'table',
        fields: [
          { id: 'lead_name', label: 'Имя', type: 'text', required: true },
          { id: 'lead_phone', label: 'Телефон', type: 'phone', required: true },
          { id: 'lead_location', label: 'Город / где живёте', type: 'text', required: false },
          { id: 'lead_reason', label: 'Причина обращения', type: 'text', required: true },
          { id: 'lead_interactions', label: 'Количество взаимодействий', type: 'text', required: false },
          { id: 'lead_interest', label: 'Продукт / курс / услуга', type: 'text', required: true },
        ],
      },
    })
    if (result.id) {
      localStorage.setItem(`nemo-team-blueprint:${result.id}`, JSON.stringify({
        goal: presets.purpose,
        tools,
        apiKeys: Object.fromEntries(Object.entries(apiKeys).filter(([, value]) => value.trim()).map(([key]) => [key, 'encrypted-demo-placeholder'])),
        savedAt: new Date().toISOString(),
      }))
      navigate(`/app/swarms/${result.id}`)
    }
  }

  const quickCreate = (kind: 'sales' | 'support' | 'content') => createTeam({ kind })

  const toggleTool = (id: string) => {
    setSelectedTools((items) => (items.includes(id) ? items.filter((item) => item !== id) : [...items, id]))
  }

  return (
    <div className="p-6 space-y-8">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold text-text tracking-tight">{t('swarmsPage.title')}</h1>
          <p className="text-muted">{t('swarmsPage.subtitle')}</p>
        </div>
        <Button to="/onboarding" className="bg-gradient-to-r from-violet to-cyan text-white shadow-lg shadow-violet/20">
          <Plus className="w-4 h-4 mr-2" />
          {t('swarmsPage.createTeamBtn')}
        </Button>
      </div>

      <div className="grid gap-4 lg:grid-cols-[1.3fr_0.7fr]">
        <div className="rounded-3xl border border-violet/20 bg-gradient-to-br from-violet/10 via-white/[0.03] to-cyan/10 p-6">
          <div className="flex items-start gap-4">
            <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-brand text-white shadow-glow">
              <Workflow className="h-5 w-5" />
            </span>
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.18em] text-cyan">Nemo AI Workforce</p>
              <h2 className="mt-2 text-2xl font-semibold text-text">{t('swarmsPage.heroHeading')}</h2>
              <p className="mt-2 max-w-3xl text-sm leading-relaxed text-muted">
                {t('swarmsPage.heroBody')}
              </p>
            </div>
          </div>
          <div className="mt-5 grid gap-3 sm:grid-cols-3">
            {[
              ['Master agent', t('swarmsPage.pillMasterDesc')],
              ['Subagents', t('swarmsPage.pillSubagentsDesc')],
              ['Agent Trace', t('swarmsPage.pillTraceDesc')],
            ].map(([title, desc]) => (
              <div key={title} className="rounded-2xl border border-white/10 bg-black/15 p-3">
                <p className="text-sm font-medium text-text">{title}</p>
                <p className="mt-1 text-xs text-muted">{desc}</p>
              </div>
            ))}
          </div>
        </div>
        <div className="rounded-3xl border border-ice/10 bg-panel/70 p-5">
          <p className="flex items-center gap-2 text-sm font-semibold text-text"><ShieldCheck className="h-4 w-4 text-teal" /> Production checklist</p>
          <div className="mt-4 space-y-3 text-sm text-muted">
            <p>{t('swarmsPage.checklistStep1')}</p>
            <p>{t('swarmsPage.checklistStep2')}</p>
            <p>{t('swarmsPage.checklistStep3')}</p>
          </div>
          <Button to="/onboarding?team=AI Sales Team" fullWidth className="mt-5">
            <Sparkles className="h-4 w-4" /> {t('swarmsPage.createViaArchitect')}
          </Button>
        </div>
      </div>

      <div className="rounded-3xl border border-cyan/20 bg-panel/80 p-5 shadow-xl shadow-black/20">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-cyan">Create working team</p>
            <h2 className="mt-2 text-xl font-semibold text-text">{t('swarmsPage.oneRequestHeading')}</h2>
            <p className="mt-1 text-sm text-muted">{t('swarmsPage.oneRequestBody')}</p>
          </div>
          <Button onClick={() => createTeam({ kind: 'custom', goal, tools: selectedTools })} disabled={goal.trim().length < 12 || selectedTools.length === 0}>
            <Sparkles className="h-4 w-4" /> {t('swarmsPage.createAndOpenTest')}
          </Button>
        </div>
        <textarea
          value={goal}
          onChange={(e) => setGoal(e.target.value)}
          rows={4}
          className="mt-4 w-full resize-y rounded-2xl border border-ice/10 bg-white/[0.04] px-4 py-3 text-sm leading-relaxed text-text outline-none placeholder:text-muted focus:border-cyan/40"
          placeholder={t('swarmsPage.goalPlaceholder')}
        />
        <div className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-4">
          {toolOptions.map((tool) => {
            const on = selectedTools.includes(tool.id)
            return (
              <button key={tool.id} type="button" onClick={() => toggleTool(tool.id)} className={`rounded-2xl border p-4 text-left transition ${on ? 'border-cyan/50 bg-cyan/10' : 'border-ice/10 bg-white/[0.02] hover:border-ice/25'}`}>
                <span className="flex items-center gap-2 text-sm font-semibold text-text">
                  <tool.Icon className="h-4 w-4 text-cyan" /> {tool.label}
                  {on && <ShieldCheck className="ml-auto h-4 w-4 text-teal" />}
                </span>
                <span className="mt-1 block text-xs leading-relaxed text-muted">{t(tool.desc)}</span>
                <span className="mt-2 block text-[10px] text-muted">{tool.providers.join(' · ')}</span>
              </button>
            )
          })}
        </div>
        <div className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-4">
          {toolOptions.filter((tool) => selectedTools.includes(tool.id)).map((tool) => (
            <label key={tool.id} className="block rounded-2xl border border-ice/10 bg-black/15 p-3">
              <span className="flex items-center gap-1.5 text-xs font-medium text-muted"><KeyRound className="h-3.5 w-3.5" /> {tool.label} API key</span>
              <input
                type="password"
                value={apiKeys[tool.id] ?? ''}
                onChange={(e) => setApiKeys((keys) => ({ ...keys, [tool.id]: e.target.value }))}
                className="mt-2 w-full rounded-xl border border-ice/10 bg-white/[0.04] px-3 py-2 text-sm text-text outline-none focus:border-cyan/40"
                placeholder="optional now, encrypted later"
              />
            </label>
          ))}
        </div>
      </div>

      <div className="grid gap-3 md:grid-cols-3">
        {[
          ['sales', t('swarmsPage.quickSalesTitle'), t('swarmsPage.quickSalesDesc')],
          ['support', t('swarmsPage.quickSupportTitle'), t('swarmsPage.quickSupportDesc')],
          ['content', t('swarmsPage.quickContentTitle'), t('swarmsPage.quickContentDesc')],
        ].map(([kind, title, desc]) => (
          <button key={kind} type="button" onClick={() => quickCreate(kind as 'sales' | 'support' | 'content')} className="rounded-2xl border border-ice/10 bg-ice/[0.03] p-4 text-left transition hover:border-violet/40 hover:bg-white/[0.06]">
            <p className="text-sm font-semibold text-text">{title}</p>
            <p className="mt-1 text-xs leading-relaxed text-muted">{desc}</p>
          </button>
        ))}
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
        {teams.map((team) => {
          const Icon = team.Icon
          return (
            <Link key={team.id} to={`/app/swarms/${team.id}`} className="block focus:outline-none focus:ring-2 focus:ring-violet/60 rounded-2xl">
              <Card className="p-5 group hover:border-violet/50 transition-all cursor-pointer relative overflow-hidden h-full">
                <div className="absolute top-0 right-0 p-3">
                  <ArrowRight className="w-4 h-4 text-muted group-hover:text-text transition-colors" />
                </div>
                <div className="flex items-start gap-4">
                  <div className={`p-3 rounded-2xl ${team.iconCls}`}>
                    <Icon className="w-6 h-6" />
                  </div>
                  <div className="space-y-1 pr-4">
                    <h3 className="text-lg font-semibold text-text">{team.name}</h3>
                    <p className="text-sm text-muted line-clamp-2">{team.desc}</p>
                  </div>
                </div>

                <div className="mt-6 flex items-center justify-between">
                  <div className="flex -space-x-2">
                    {team.initials.map((i) => (
                      <div key={i} className="w-6 h-6 rounded-full border-2 border-panel bg-gray-700 flex items-center justify-center text-[10px] text-text">
                        {i}
                      </div>
                    ))}
                  </div>
                  <span className={`text-xs font-medium px-2 py-1 rounded-full border ${team.statusCls}`}>{team.status}</span>
                </div>
              </Card>
            </Link>
          )
        })}
      </div>
    </div>
  )
}
