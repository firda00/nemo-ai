import { useCallback, useEffect, useMemo, useState } from 'react'
import ReactFlow, { Background, Controls, MarkerType, useNodesState, type Edge, type Node, type NodeChange, type ReactFlowInstance } from 'reactflow'
import 'reactflow/dist/style.css'
import { Focus, LayoutGrid, Network, WifiOff } from 'lucide-react'
import type { PlatformAgent } from '../../types/platform'
import type { AgentNodeData } from '../../types/orchestrator'
import { useTeamOfficeStore } from '../../store/useTeamOfficeStore'
import { useI18n } from '../../i18n'
import { AgentDeskNode } from './AgentDeskNode'
import { PipelineNode } from './PipelineNode'
import { AgentDrawer } from './AgentDrawer'
import { AgentCardList } from './AgentCardList'
import { cn } from '../../lib/cn'

const nodeTypes = { agentDesk: AgentDeskNode, pipeline: PipelineNode }
const active = (status: AgentNodeData['status']) => status === 'queued' || status === 'working' || status === 'waiting_approval'

function position(index: number, count: number, mode: 'office' | 'graph') {
  if (mode === 'graph') return { x: 80 + (index % 3) * 290, y: 120 + Math.floor(index / 3) * 210 }
  if (index === 0) return { x: 360, y: 230 }
  const ringCount = Math.max(1, count - 1)
  const angle = (Math.PI * 2 * (index - 1)) / ringCount
  return { x: 360 + Math.cos(angle) * 280, y: 260 + Math.sin(angle) * 150 }
}

export function TeamOfficeView({
  platformAgents,
  supplementalAgents,
  loading = false,
  error,
}: {
  platformAgents: PlatformAgent[]
  supplementalAgents?: AgentNodeData[]
  loading?: boolean
  error?: string
}) {
  const { t } = useI18n()
  const syncAgents = useTeamOfficeStore((state) => state.syncAgents)
  const agentsMap = useTeamOfficeStore((state) => state.agents)
  const connected = useTeamOfficeStore((state) => state.connected)
  const nodePositions = useTeamOfficeStore((state) => state.nodePositions)
  const applyNodeChangesForMode = useTeamOfficeStore((state) => state.applyNodeChangesForMode)
  const [mode, setMode] = useState<'office' | 'graph'>('office')
  const [selected, setSelected] = useState<AgentNodeData | null>(null)
  const [flow, setFlow] = useState<ReactFlowInstance | null>(null)
  useEffect(() => { syncAgents(platformAgents) }, [platformAgents, syncAgents])
  const agents = useMemo(() => {
    const syncedAgents = Object.values(agentsMap)
    const platformIds = new Set(platformAgents.map((agent) => agent.id))
    const baseAgents = supplementalAgents === undefined
      ? syncedAgents
      : syncedAgents.filter((agent) => platformIds.has(agent.id))
    const merged = new Map(baseAgents.map((agent) => [agent.id, agent]))
    for (const agent of supplementalAgents ?? []) merged.set(agent.id, agent)
    return [...merged.values()]
  }, [agentsMap, platformAgents, supplementalAgents])
  const generatedNodes = useMemo<Node<AgentNodeData & { onSelect?: () => void }>[]>(() => agents.map((agent, index) => ({
    id: agent.id,
    type: mode === 'office' ? 'agentDesk' : 'pipeline',
    position: nodePositions[mode][agent.id] ?? position(index, agents.length, mode),
    selected: selected?.id === agent.id,
    data: { ...agent, onSelect: () => setSelected(agent) },
  })), [agents, mode, nodePositions, selected?.id])
  const [nodes, setNodes, applyLocalNodeChanges] = useNodesState<AgentNodeData & { onSelect?: () => void }>(generatedNodes)

  useEffect(() => {
    setNodes((current) => generatedNodes.map((generated) => {
      const measured = current.find((node) => node.id === generated.id && node.type === generated.type)
      return measured ? { ...measured, ...generated } : generated
    }))
  }, [generatedNodes, setNodes])
  const edges = useMemo<Edge[]>(() => agents.slice(1).map((agent) => {
    const source = agent.parentId && agents.some((candidate) => candidate.id === agent.parentId) ? agent.parentId : agents[0]?.id ?? agent.id
    const sourceAgent = agents.find((candidate) => candidate.id === source)
    const isActive = active(agent.status) || active(sourceAgent?.status ?? 'idle')
    return {
      id: `${source}-${agent.id}`,
      source,
      target: agent.id,
      type: mode === 'graph' ? 'smoothstep' : 'default',
      animated: mode === 'graph' && isActive,
      markerEnd: mode === 'graph' ? { type: MarkerType.ArrowClosed, color: isActive ? '#22d3ee' : '#64748b' } : undefined,
      style: {
        stroke: isActive ? '#22d3ee' : '#64748b',
        strokeDasharray: mode === 'office' ? '4 8' : undefined,
        opacity: mode === 'office' ? 0.2 : isActive ? 0.85 : 0.42,
      },
    }
  }), [agents, mode])
  const nodeSignature = useMemo(() => nodes.map((node) => node.id).sort().join('|'), [nodes])

  const onNodesChange = useCallback((changes: NodeChange[]) => {
    applyLocalNodeChanges(changes)
    const positionChanges = changes.filter((change) => change.type === 'position')
    if (positionChanges.length > 0) applyNodeChangesForMode(mode, positionChanges, nodes)
  }, [applyLocalNodeChanges, applyNodeChangesForMode, mode, nodes])

  const centerNodes = useCallback(() => {
    if (!flow || nodes.length === 0) return
    const timer = window.setTimeout(() => void flow.fitView({ padding: 0.2, duration: 280 }), 120)
    return timer
  }, [flow, nodes.length])

  useEffect(() => {
    const timer = centerNodes()
    if (timer === undefined) return
    return () => window.clearTimeout(timer)
  }, [centerNodes, mode, nodeSignature])

  return (
    <section className="mt-7 rounded-3xl border border-ice/10 bg-panel/45 p-4 sm:p-5" aria-labelledby="team-office-heading">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between"><div><h2 id="team-office-heading" className="text-lg font-semibold text-text">{t('teamOffice.title')}</h2><p className="mt-1 text-sm text-muted">{t('teamOffice.subtitle')}</p></div><div className="flex flex-wrap items-center gap-2"><span className="inline-flex items-center gap-1.5 text-xs text-fog"><WifiOff size={13} />{connected ? t('teamOffice.live') : t('teamOffice.local')}</span>{agents.length > 0 && <button type="button" onClick={() => centerNodes()} className="inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs text-muted transition hover:bg-white/5 hover:text-text" aria-label={t('teamOffice.center')}><Focus size={13} />{t('teamOffice.center')}</button>}<div className="flex rounded-xl border border-ice/10 p-1"><button type="button" onClick={() => setMode('office')} aria-pressed={mode === 'office'} className={cn('rounded-lg px-3 py-1.5 text-xs', mode === 'office' ? 'bg-white/8 text-text' : 'text-muted')}><LayoutGrid size={13} className="mr-1 inline" />{t('teamOffice.office')}</button><button type="button" onClick={() => setMode('graph')} aria-pressed={mode === 'graph'} className={cn('rounded-lg px-3 py-1.5 text-xs', mode === 'graph' ? 'bg-white/8 text-text' : 'text-muted')}><Network size={13} className="mr-1 inline" />{t('teamOffice.graph')}</button></div></div></div>
      {loading ? <div className="mt-5 h-64 animate-pulse rounded-2xl bg-white/[0.03]" /> : error ? <p role="alert" className="mt-5 rounded-2xl border border-danger/20 bg-danger/5 p-4 text-sm text-danger">{error}</p> : !agents.length ? <p className="mt-5 rounded-2xl border border-dashed border-ice/15 p-8 text-center text-sm text-muted">{t('teamOffice.empty')}</p> : <><div className="mt-5 md:hidden"><AgentCardList agents={agents} onSelect={setSelected} /></div><div className="mt-5 hidden h-[600px] overflow-hidden rounded-2xl border border-ice/10 bg-bg/70 md:block"><ReactFlow key={`${mode}:${nodeSignature}`} nodes={nodes} edges={edges} nodeTypes={nodeTypes} onInit={setFlow} onNodesChange={onNodesChange} fitView fitViewOptions={{ padding: 0.2 }} nodesDraggable nodesConnectable={false} elementsSelectable panOnDrag zoomOnScroll minZoom={0.55} maxZoom={1.25} onNodeClick={(_, node) => setSelected(node.data)} proOptions={{ hideAttribution: true }}><Background color="#263149" gap={24} size={1} /><Controls showInteractive={false} /></ReactFlow></div></>}
      <AgentDrawer agent={selected} onClose={() => setSelected(null)} />
    </section>
  )
}
