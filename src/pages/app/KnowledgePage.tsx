import { useState } from 'react'
import { BookOpen, Plus } from 'lucide-react'
import { useI18n } from '../../i18n'
import { useAgentStore } from '../../store/useAgentStore'
import { Button } from '../../components/ui/Button'
import { EmptyState } from '../../components/ui/EmptyState'
import { KnowledgeManager } from '../../components/platform/KnowledgeManager'

export default function KnowledgePage() {
  const { t } = useI18n()
  const agents = useAgentStore((s) => s.agents)
  const [agentId, setAgentId] = useState('')
  const selectedAgentId = agentId || agents[0]?.id || ''

  return (
    <div className="container-page max-w-4xl py-8">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-2xl font-normal tracking-tight text-text">{t('platform.nav.knowledge')}</h1>
          <p className="mt-1 text-sm text-muted">{t('platform.knowledge.subtitle')}</p>
        </div>
        {agents.length > 0 && (
          <label className="flex items-center gap-2 text-sm">
            <span className="text-muted">{t('platform.knowledge.agentLabel')}</span>
            <select value={selectedAgentId} onChange={(e) => setAgentId(e.target.value)} className="glass rounded-lg px-3 py-2 text-sm text-text outline-none">
              {agents.map((a) => (
                <option key={a.id} value={a.id} className="bg-panel">
                  {a.name}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>

      {agents.length === 0 ? (
        <div className="mt-8">
          <EmptyState
            icon={BookOpen}
            title={t('platform.knowledge.noAgent')}
            action={
              <Button to="/onboarding" size="sm">
                <Plus size={15} /> {t('platform.agents.create')}
              </Button>
            }
          />
        </div>
      ) : (
        selectedAgentId && (
          <div className="mt-6 card rounded-2xl p-6">
            {/* keyed so switching agents reloads the manager's doc list */}
            <KnowledgeManager key={selectedAgentId} agentId={selectedAgentId} />
          </div>
        )
      )}
    </div>
  )
}
