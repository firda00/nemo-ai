// Domain types — mirror the TZ data model (section 10) and agent config (9.3).

export type Lang = 'uz' | 'ru' | 'en'

export type Role = 'guest' | 'user' | 'admin'

export interface User {
  id: string
  email: string
  name: string
  lang: Lang
  role: Role
  createdAt: string
  quotaUsed: number
  quotaLimit: number
  onboardingCompleted?: boolean
}

/** Agent config schema — exactly as TZ 9.3 (code/JSON, not user-built). */
export interface AgentConfig {
  id: string
  name: { uz: string; ru: string }
  role: { uz: string; ru: string }
  instruction: string
  tools: string[]
  model: string
  enabled: boolean
  /** UI-only: avatar accent color from the brand palette. */
  color: AgentColor
  /** UI-only: icon key (mapped to a lucide icon in AgentAvatar). */
  glyph: AgentGlyph
}

export type AgentGlyph = 'search' | 'pen' | 'chart' | 'check' | 'plug'

export type AgentColor = 'violet' | 'blue' | 'cyan' | 'teal' | 'amber'

export type AgentRuntimeStatus = 'idle' | 'waiting' | 'working' | 'done' | 'error'

/** A live instance of an agent within a running task. */
export interface AgentInstance {
  configId: string
  status: AgentRuntimeStatus
}

export type StepStatus = 'running' | 'done' | 'error'

/** One streamed line in the activity log (run_steps). */
export interface RunStep {
  id: string
  agentId: string
  text: string
  status: StepStatus
  time: string
}

export type MessageAuthor = 'user' | 'nemo' | 'agent' | 'system'

export interface Message {
  id: string
  author: MessageAuthor
  text: string
  time: string
  /** Optional reference to the agent that produced it. */
  agentId?: string
}

export type TaskStatus = 'planning' | 'running' | 'reviewing' | 'done' | 'error'

export interface Task {
  id: string
  goal: string
  status: TaskStatus
  team: AgentInstance[]
  steps: RunStep[]
  result?: TaskResult
}

export interface TaskResult {
  title: string
  body: string
  approved?: boolean
}

export interface Conversation {
  id: string
  title: string
  createdAt: string
  updatedAt: string
  preview: string
  messageCount: number
  status: 'done' | 'draft'
}

// Admin view models -------------------------------------------------

export interface AdminUserRow {
  id: string
  email: string
  lang: Lang
  role: Role
  joined: string
  runs: number
  quota: string
}

export interface UsageLogRow {
  id: string
  time: string
  user: string
  action: string
  tokens: number
  status: 'ok' | 'error'
}
