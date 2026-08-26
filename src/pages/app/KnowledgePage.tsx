import { useEffect, useState } from 'react'
import { BookOpen, Plus } from 'lucide-react'
import { useI18n } from '../../i18n'
import { useAgentStore } from '../../store/useAgentStore'
import { Button } from '../../components/ui/Button'
import { EmptyState } from '../../components/ui/EmptyState'
import { KnowledgeManager } from '../../components/platform/KnowledgeManager'
import { supabase, isSupabaseEnabled } from '../../lib/supabase'
import { KnowledgeIntegrationNav } from '../../components/platform/KnowledgeIntegrationNav'

export default function KnowledgePage() {
  const { t } = useI18n()
  const agents = useAgentStore((s) => s.agents)
  // target is either an agent's own base ("agent:<id>") or a team's SHARED base
  // ("team:<departmentId>") — team docs are visible to the lead and every specialist
  const [target, setTarget] = useState('')
  const [teams, setTeams] = useState<{ id: string; name: string }[]>([])

  useEffect(() => {
    if (!isSupabaseEnabled || !supabase) return
    let on = true
    supabase
      .from('departments')
      .select('id, name')
      .order('created_at', { ascending: false })
      .limit(50)
      .then(({ data }) => {
        if (on) setTeams((data ?? []) as { id: string; name: string }[])
      })
    return () => {
      on = false
    }
  }, [])

  const selected = target || (agents[0]?.id ? `agent:${agents[0].id}` : '')
  const [kind, ownerId] = selected.split(':')

  return (
    <div className="container-page max-w-4xl py-8">
      <KnowledgeIntegrationNav active="knowledge" />
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-2xl font-normal tracking-tight text-text">{t('platform.nav.knowledge')}</h1>
          <p className="mt-1 text-sm text-muted">{t('platform.knowledge.subtitle')}</p>
        </div>
        {agents.length > 0 && (
          <label className="flex items-center gap-2 text-sm">
            <span className="text-muted">{t('platform.knowledge.agentLabel')}</span>
            <select value={selected} onChange={(e) => setTarget(e.target.value)} className="glass rounded-lg px-3 py-2 text-sm text-text outline-none">
              <optgroup label={t('platform.knowledge.groupAgents')}>
                {agents.map((a) => (
                  <option key={a.id} value={`agent:${a.id}`} className="bg-panel">
                    {a.name}
                  </option>
                ))}
              </optgroup>
              {teams.length > 0 && (
                <optgroup label={t('platform.knowledge.groupTeams')}>
                  {teams.map((d) => (
                    <option key={d.id} value={`team:${d.id}`} className="bg-panel">
                      {d.name}
                    </option>
                  ))}
                </optgroup>
              )}
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
        ownerId && (
          <div className="mt-6 card rounded-2xl p-6">
            {kind === 'team' && <p className="mb-4 rounded-xl border border-teal/15 bg-teal/[0.05] px-3 py-2 text-xs leading-relaxed text-muted">{t('platform.knowledge.teamSharedNote')}</p>}
            {/* keyed so switching targets reloads the manager's doc list */}
            <KnowledgeManager key={selected} agentId={ownerId} ownerType={kind === 'team' ? 'team' : 'agent'} />
          </div>
        )
      )}
    </div>
  )
}
