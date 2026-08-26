import { useEffect, useMemo, useState } from 'react'
import ReactFlow, { Background, Controls, type Edge, type Node } from 'reactflow'
import 'reactflow/dist/style.css'
import { LayoutGrid, Network, WifiOff } from 'lucide-react'
import type { PlatformAgent } from '../../types/platform'
import type { AgentNodeData } from '../../types/orchestrator'
import { useTeamOfficeStore } from '../../store/useTeamOfficeStore'
import { useI18n } from '../../i18n'
import { AgentDeskNode } from './AgentDeskNode'
import { AgentDrawer } from './AgentDrawer'
import { AgentCardList } from './AgentCardList'
import { cn } from '../../lib/cn'

const nodeTypes = { agentDesk: AgentDeskNode }
const active = (status: AgentNodeData['status']) => status === 'queued' || status === 'working' || status === 'waiting_approval'

function position(index: number, count: number, mode: 'office' | 'graph') {
  if (mode === 'graph') return { x: (index % 3) * 280, y: Math.floor(index / 3) * 230 }
  if (index === 0) return { x: 350, y: 250 }
  const ringCount = Math.max(1, count - 1)
  const angle = (Math.PI * 2 * (index - 1)) / ringCount
  return { x: 350 + Math.cos(angle) * 300, y: 250 + Math.sin(angle) * 190 }
}

export function TeamOfficeView({ platformAgents, loading = false, error }: { platformAgents: PlatformAgent[]; loading?: boolean; error?: string }) {
  const { t } = useI18n()
  const syncAgents = useTeamOfficeStore((state) => state.syncAgents)
  const agentsMap = useTeamOfficeStore((state) => state.agents)
  const connected = useTeamOfficeStore((state) => state.connected)
  const [mode, setMode] = useState<'office' | 'graph'>('office')
  const [selected, setSelected] = useState<AgentNodeData | null>(null)
  useEffect(() => { syncAgents(platformAgents) }, [platformAgents, syncAgents])
  const agents = useMemo(() => Object.values(agentsMap), [agentsMap])
  const nodes = useMemo<Node<AgentNodeData & { onSelect?: () => void }>[]>(() => agents.map((agent, index) => ({ id: agent.id, type: 'agentDesk', position: position(index, agents.length, mode), data: { ...agent, onSelect: () => setSelected(agent) } })), [agents, mode])
  const edges = useMemo<Edge[]>(() => agents.slice(1).map((agent) => {
    const source = agent.parentId && agents.some((candidate) => candidate.id === agent.parentId) ? agent.parentId : agents[0]?.id ?? agent.id
    const sourceAgent = agents.find((candidate) => candidate.id === source)
    return { id: `${source}-${agent.id}`, source, target: agent.id, animated: active(agent.status) || active(sourceAgent?.status ?? 'idle'), style: { stroke: active(agent.status) ? '#22d3ee' : '#64748b', opacity: active(agent.status) ? 0.8 : 0.35 } }
  }), [agents])

  return (
    <section className="mt-7 rounded-3xl border border-ice/10 bg-panel/45 p-4 sm:p-5" aria-labelledby="team-office-heading">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between"><div><h2 id="team-office-heading" className="text-lg font-semibold text-text">{t('teamOffice.title')}</h2><p className="mt-1 text-sm text-muted">{t('teamOffice.subtitle')}</p></div><div className="flex items-center gap-2"><span className="inline-flex items-center gap-1.5 text-xs text-fog"><WifiOff size={13} />{connected ? t('teamOffice.live') : t('teamOffice.local')}</span><div className="flex rounded-xl border border-ice/10 p-1"><button type="button" onClick={() => setMode('office')} aria-pressed={mode === 'office'} className={cn('rounded-lg px-3 py-1.5 text-xs', mode === 'office' ? 'bg-white/8 text-text' : 'text-muted')}><LayoutGrid size={13} className="mr-1 inline" />{t('teamOffice.office')}</button><button type="button" onClick={() => setMode('graph')} aria-pressed={mode === 'graph'} className={cn('rounded-lg px-3 py-1.5 text-xs', mode === 'graph' ? 'bg-white/8 text-text' : 'text-muted')}><Network size={13} className="mr-1 inline" />{t('teamOffice.graph')}</button></div></div></div>
      {loading ? <div className="mt-5 h-64 animate-pulse rounded-2xl bg-white/[0.03]" /> : error ? <p role="alert" className="mt-5 rounded-2xl border border-danger/20 bg-danger/5 p-4 text-sm text-danger">{error}</p> : !agents.length ? <p className="mt-5 rounded-2xl border border-dashed border-ice/15 p-8 text-center text-sm text-muted">{t('teamOffice.empty')}</p> : <><div className="mt-5 md:hidden"><AgentCardList agents={agents} onSelect={setSelected} /></div><div className="mt-5 hidden h-[570px] overflow-hidden rounded-2xl border border-ice/10 bg-bg/70 md:block"><ReactFlow nodes={nodes} edges={edges} nodeTypes={nodeTypes} nodesDraggable={false} nodesConnectable={false} elementsSelectable fitView minZoom={0.55} maxZoom={1.25} onNodeClick={(_, node) => setSelected(node.data)} proOptions={{ hideAttribution: true }}><Background color="#263149" gap={24} size={1} /><Controls showInteractive={false} /></ReactFlow></div></>}
      <AgentDrawer agent={selected} onClose={() => setSelected(null)} />
    </section>
  )
}
