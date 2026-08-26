import { create } from 'zustand'
import { applyNodeChanges, type Node, type NodeChange, type XYPosition } from 'reactflow'
import type { PlatformAgent } from '../types/platform'
import type { AgentNodeData, OperationalAgentStatus } from '../types/orchestrator'

export type TeamOfficeViewMode = 'office' | 'graph'

const SAFE_TASK_LABELS = new Set([
  'brief_analysis',
  'estimate_calculation',
  'video_rendering',
  'awaiting_approval',
  'task_completed',
  'task_failed',
])

const safeTask = (label?: string) => (label && SAFE_TASK_LABELS.has(label) ? label : undefined)
const providerFromModel = (model: string) => model.includes('/') ? model.split('/')[0] : 'configured'

function fromPlatformAgent(agent: PlatformAgent): AgentNodeData {
  return {
    id: agent.id,
    role: agent.role || agent.type,
    name: agent.name,
    avatar: agent.avatarColor,
    status: 'idle',
    tools: [...new Set([...(agent.skills ?? []), ...agent.channels])],
    metrics: { tasksCompleted: Math.max(0, agent.dialoguesToday), avgExecutionTimeMs: 0 },
    model: agent.model,
    provider: providerFromModel(agent.model),
    configurationSummary: agent.status === 'active' ? 'published' : agent.status,
  }
}

interface TeamOfficeStore {
  agents: Record<string, AgentNodeData>
  connected: boolean
  nodePositions: Record<TeamOfficeViewMode, Record<string, XYPosition>>
  syncAgents: (agents: PlatformAgent[]) => void
  setConnected: (connected: boolean) => void
  applyNodeChangesForMode: (mode: TeamOfficeViewMode, changes: NodeChange[], nodes: Node<AgentNodeData>[]) => void
  setRuntimeStatus: (ids: string[], status: OperationalAgentStatus, task?: string) => void
  setPresetRuntimeTeam: (teamKey: string, members: { name: string; role: string; skills?: string[]; model?: string }[], status: OperationalAgentStatus, task?: string) => void
}

export const useTeamOfficeStore = create<TeamOfficeStore>((set) => ({
  agents: {},
  connected: false,
  nodePositions: { office: {}, graph: {} },
  syncAgents: (platformAgents) => set((state) => {
    const next: Record<string, AgentNodeData> = Object.fromEntries(
      Object.entries(state.agents).filter(([id]) => id.startsWith('runtime:')),
    )
    for (const agent of platformAgents) {
      const existing = state.agents[agent.id]
      next[agent.id] = { ...fromPlatformAgent(agent), ...(existing ? {
        status: existing.status,
        currentTask: existing.currentTask,
        events: existing.events,
        metrics: { ...fromPlatformAgent(agent).metrics, ...existing.metrics },
      } : {}) }
    }
    return { agents: next }
  }),
  setConnected: (connected) => set({ connected }),
  applyNodeChangesForMode: (mode, changes, nodes) => set((state) => {
    const changedNodes = applyNodeChanges(changes, nodes)
    const positions = Object.fromEntries(changedNodes.map((node) => [node.id, node.position]))
    return {
      nodePositions: {
        ...state.nodePositions,
        [mode]: positions,
      },
    }
  }),
  setRuntimeStatus: (ids, status, task) => set((state) => {
    const occurredAt = new Date().toISOString()
    const label = safeTask(task)
    const next = { ...state.agents }
    for (const id of ids) {
      const current = next[id]
      if (!current) continue
      next[id] = {
        ...current,
        status,
        currentTask: label,
        metrics: {
          ...current.metrics,
          tasksCompleted: status === 'completed' ? current.metrics.tasksCompleted + 1 : current.metrics.tasksCompleted,
        },
        events: [
          { id: `${id}:${occurredAt}`, status, label: label ?? status, occurredAt },
          ...(current.events ?? []),
        ].slice(0, 8),
      }
    }
    return { agents: next }
  }),
  setPresetRuntimeTeam: (teamKey, members, status, task) => set((state) => {
    if (status === 'idle') return state
    const occurredAt = new Date().toISOString()
    const label = safeTask(task)
    const next = { ...state.agents }
    members.forEach((member, index) => {
      const id = `runtime:${teamKey}:${index}`
      const current = next[id]
      next[id] = {
        id,
        name: member.name,
        role: member.role,
        avatar: 'cyan',
        status,
        currentTask: label,
        tools: member.skills ?? [],
        metrics: {
          tasksCompleted: (current?.metrics.tasksCompleted ?? 0) + (status === 'completed' ? 1 : 0),
          avgExecutionTimeMs: current?.metrics.avgExecutionTimeMs ?? 0,
        },
        model: member.model,
        provider: member.model ? providerFromModel(member.model) : 'runtime',
        configurationSummary: 'runtime',
        parentId: index === 0 ? undefined : `runtime:${teamKey}:0`,
        events: [
          { id: `${id}:${occurredAt}`, status, label: label ?? status, occurredAt },
          ...(current?.events ?? []),
        ].slice(0, 8),
      }
    })
    return { agents: next }
  }),
}))
