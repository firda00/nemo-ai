import { useNavigate } from 'react-router-dom'
import { ArrowRight } from 'lucide-react'
import { useI18n } from '../../i18n'
import { templates } from '../../data/platform'
import { useAgentStore, blankAgent } from '../../store/useAgentStore'
import { useToast } from '../../components/ui/Toast'
import { Button } from '../../components/ui/Button'
import { AgentAvatar } from '../../components/ui/AgentAvatar'

export default function TemplatesPage() {
  const { t, lang } = useI18n()
  const navigate = useNavigate()
  const toast = useToast()
  const addAgent = useAgentStore((s) => s.addAgent)

  const use = (id: string) => {
    const tpl = templates.find((x) => x.id === id)
    if (!tpl) return
    addAgent({
      ...blankAgent(),
      name: tpl.name[lang],
      role: tpl.name[lang],
      avatarColor: tpl.color,
      prompt: tpl.preset,
      status: 'active',
    })
    toast(t('platform.templatesPage.created'))
    navigate('/app/agents')
  }

  return (
    <div className="container-page max-w-5xl py-8">
      <h1 className="text-2xl font-normal tracking-tight text-text">{t('platform.nav.templates')}</h1>
      <p className="mt-1 text-sm text-muted">{t('platform.templatesPage.subtitle')}</p>

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
