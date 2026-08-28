import { useNavigate } from 'react-router-dom'
import { ArrowRight } from 'lucide-react'
import { useI18n } from '../../i18n'
import { templates } from '../../data/platform'
import { useAgentStore, blankAgent } from '../../store/useAgentStore'
import { useToast } from '../../components/ui/Toast'
import { Button } from '../../components/ui/Button'
import { AgentAvatar } from '../../components/ui/AgentAvatar'
import { mediaLearningTeamTemplate } from '../../data/mediaLearningTeamTemplate'

const TEAM_TEMPLATES = [mediaLearningTeamTemplate,
  {
    id: 'ai-sales-team',
    title: 'AI Sales Team',
    market: 'SMB sales',
    score: '94',
    desc: 'Главный агент квалифицирует запрос, подключает консультанта, обработчика возражений и CRM handoff.',
    agents: ['Team Leader', 'Lead Qualifier', 'Product Expert', 'Objection Handler', 'CRM Handoff'],
    tools: ['research', 'content', 'publishing'],
    roi: 'до 35% больше обработанных лидов',
  },
  {
    id: 'ai-support-team',
    title: 'AI Support Team',
    market: 'E-commerce / SaaS support',
    score: '91',
    desc: 'Команда закрывает FAQ, ищет ответы в знаниях, диагностирует проблему и эскалирует человеку.',
    agents: ['Team Leader', 'FAQ Specialist', 'Knowledge Agent', 'Troubleshooter', 'Escalation Agent'],
    tools: ['research', 'content'],
    roi: 'до 70% диалогов без оператора',
  },
  {
    id: 'ai-content-team',
    title: 'AI Content Team',
    market: 'Creators / SMB marketing',
    score: '89',
    desc: 'AI-команда придумывает идеи, пишет сценарии, готовит посты, планирует публикации и анализирует результат.',
    agents: ['Team Leader', 'Strategist', 'Scriptwriter', 'Copywriter', 'Publishing Agent', 'Analyst'],
    tools: ['research', 'content', 'image', 'publishing'],
    roi: 'контент-план за минуты вместо часов',
  },
  {
    id: 'uzum-review-telegram-followup',
    title: 'Uzum Reviews + Telegram Follow-up',
    market: 'Uzum sellers / E-commerce',
    score: '93',
    desc: 'Классифицирует новый отзыв, готовит grounded-ответ по данным товара и создаёт персональный follow-up в Telegram. Отправка остаётся на согласовании владельца.',
    agents: ['Team Leader', 'Review Classifier', 'Product Knowledge Agent', 'Reply Writer', 'Telegram Follow-up', 'Approval Reviewer'],
    tools: ['uzum', 'knowledge', 'telegram', 'approval'],
    roi: 'быстрее отвечает на отзывы и не теряет повторные продажи',
  },
]

export default function TemplatesPage() {
  const { t, lang } = useI18n()
  const navigate = useNavigate()
  const toast = useToast()
  const addAgent = useAgentStore((s) => s.addAgent)

  const use = async (id: string) => {
    const tpl = templates.find((x) => x.id === id)
    if (!tpl) return
    const result = await addAgent({
      ...blankAgent(),
      name: tpl.name[lang],
      role: tpl.name[lang],
      avatarColor: tpl.color,
      prompt: tpl.preset,
      status: 'draft',
    })
    toast(t('platform.templatesPage.created'))
    navigate(result.id ? `/app/agents/${result.id}` : '/app/agents')
  }

  const createFromTeamTemplate = async (tpl: (typeof TEAM_TEMPLATES)[number]) => {
    const result = await addAgent({
      ...blankAgent(),
      name: tpl.title,
      type: 'workflow',
      role: 'Master AI team leader',
      niche: tpl.market,
      purpose: tpl.desc,
      status: 'draft',
      channels: ['telegram', 'widget'],
      prompt: {
        role: `You are the master agent for ${tpl.title}.`,
        tasks: `${tpl.desc}\n\nTeam roles: ${tpl.agents.join(', ')}. Enabled tools/APIs: ${tpl.tools.join(', ')}.`,
        tone: 'Professional, concise, business-focused.',
        rules: 'Delegate to sub-agents, keep Agent Trace, verify quality and escalate to a human when needed.',
      },
      leadForm: {
        enabled: tpl.id !== 'ai-content-team',
        trigger: 'when customer shows interest, asks price, product, course, service or consultation',
        destination: 'table',
        fields: [
          { id: 'lead_name', label: 'Имя', type: 'text', required: true },
          { id: 'lead_phone', label: 'Телефон', type: 'phone', required: true },
          { id: 'lead_location', label: 'Город / где живёте', type: 'text', required: false },
          { id: 'lead_reason', label: 'Причина обращения', type: 'text', required: true },
          { id: 'lead_interest', label: 'Продукт / курс / услуга', type: 'text', required: true },
        ],
      },
    })
    if (result.id) {
      localStorage.setItem(`nemo-team-blueprint:${result.id}`, JSON.stringify({ goal: tpl.desc, tools: tpl.tools, agents: tpl.agents, template: tpl.title, savedAt: new Date().toISOString() }))
      toast(t('platform.templatesPage.created'))
      navigate(`/app/swarms/${result.id}`)
    }
  }

  return (
    <div className="container-page max-w-5xl py-8">
      <h1 className="text-2xl font-normal tracking-tight text-text">{t('templatesPage.title')}</h1>
      <p className="mt-1 text-sm text-muted">{t('templatesPage.subtitle')}</p>

      <div className="mt-6 grid gap-4 lg:grid-cols-3">
        {TEAM_TEMPLATES.map((tpl) => (
          <div key={tpl.id} className="card flex flex-col rounded-2xl p-5">
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="text-lg font-semibold text-text">{tpl.title}</p>
                <p className="mt-1 text-xs uppercase tracking-[0.14em] text-muted">{tpl.market}</p>
              </div>
              <span className="rounded-2xl border border-teal/20 bg-teal/10 px-3 py-2 text-center">
                <span className="block text-xl font-extrabold text-teal">{tpl.score}</span>
                <span className="block text-[9px] uppercase tracking-wide text-teal/80">Nemo Score</span>
              </span>
            </div>
            <p className="mt-4 text-sm leading-relaxed text-muted">{tpl.desc}</p>
            <div className="mt-4 flex flex-wrap gap-1.5">
              {tpl.agents.map((agent) => (
                <span key={agent} className="rounded-pill border border-white/10 bg-white/[0.04] px-2.5 py-1 text-[11px] text-muted">{agent}</span>
              ))}
            </div>
            <div className="mt-4 rounded-xl border border-violet/20 bg-violet/10 p-3 text-xs text-violet">ROI: {tpl.roi}</div>
            <div className="mt-4 flex flex-wrap gap-1.5">
              {tpl.tools.map((tool) => <span key={tool} className="rounded-pill border border-cyan/20 bg-cyan/10 px-2 py-0.5 text-[10px] text-cyan">{tool}</span>)}
            </div>
            <Button onClick={() => createFromTeamTemplate(tpl)} size="sm" className="mt-4">
              {t('templatesPage.createTeamBtn')} <ArrowRight size={15} />
            </Button>
          </div>
        ))}
      </div>

      <div className="mt-10 flex items-center gap-3 text-xs text-muted">
        <span className="h-px flex-1 bg-white/10" />
        {t('templatesPage.singleAgents')}
        <span className="h-px flex-1 bg-white/10" />
      </div>

      <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {templates.map((tpl) => (
          <div key={tpl.id} className="card flex flex-col rounded-2xl p-5">
            <div className="flex items-center gap-3">
              <AgentAvatar color={tpl.color} glyph="search" size="lg" />
              <div>
                <p className="font-normal text-text">{tpl.name[lang]}</p>
                <p className="text-[10px] uppercase tracking-wide text-muted">{tpl.industry}</p>
              </div>
            </div>
            <p className="mt-3 flex-1 text-sm leading-relaxed text-muted">{tpl.description[lang]}</p>
            <div className="mt-4 rounded-xl border border-ice/[0.07] bg-ice/[0.02] p-3 text-xs text-muted">
              <p className="line-clamp-3">{tpl.preset.role} — {tpl.preset.tasks}</p>
            </div>
            <Button size="sm" className="mt-4" onClick={() => use(tpl.id)}>
              {t('platform.templatesPage.use')} <ArrowRight size={15} />
            </Button>
          </div>
        ))}
      </div>
    </div>
  )
}
