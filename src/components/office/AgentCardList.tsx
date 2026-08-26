import type { AgentNodeData } from '../../types/orchestrator'
import { useI18n } from '../../i18n'

export function AgentCardList({ agents, onSelect }: { agents: AgentNodeData[]; onSelect: (agent: AgentNodeData) => void }) {
  const { t } = useI18n()
  return <div className="grid gap-3 sm:grid-cols-2">{agents.map((agent) => <button key={agent.id} type="button" onClick={() => onSelect(agent)} className="rounded-2xl border border-ice/10 bg-panel p-4 text-left transition hover:border-cyan/30 focus:outline-none focus:ring-2 focus:ring-cyan/40"><div className="flex items-center justify-between gap-3"><div className="min-w-0"><p className="truncate font-medium text-text">{agent.name}</p><p className="truncate text-xs text-muted">{agent.role}</p></div><span className="text-xs text-cyan">{t(`teamOffice.status.${agent.status}`)}</span></div>{agent.currentTask && <p className="mt-3 text-xs text-muted">{t(`teamOffice.tasks.${agent.currentTask}`)}</p>}</button>)}</div>
}

