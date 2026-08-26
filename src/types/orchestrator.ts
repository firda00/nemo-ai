export type OperationalAgentStatus =
  | 'idle'
  | 'queued'
  | 'working'
  | 'waiting_approval'
  | 'completed'
  | 'failed'

export interface AgentOperationalEvent {
  id: string
  status: OperationalAgentStatus
  label: string
  occurredAt: string
}

export interface AgentNodeData {
  id: string
  role: string
  name: string
  avatar: string
  status: OperationalAgentStatus
  currentTask?: string
  tools: string[]
  metrics: {
    tasksCompleted: number
    avgExecutionTimeMs: number
  }
  model?: string
  provider?: string
  configurationSummary?: string
  parentId?: string
  events?: AgentOperationalEvent[]
}

