import type { AgentColor, Lang } from './index'

// ---- Agent platform (mooonai-style) domain types ----

export type ChannelType = 'telegram' | 'whatsapp' | 'instagram' | 'widget' | 'discord' | 'youtube'
// Agent kind — what the agent DOES.
//  chat      — answers customers on channels
//  qualifier — chats to qualify/score leads and route hot ones to an operator
//  coder     — writes/fixes code and works with files
//  content   — generates texts, posts, descriptions, creatives
//  learning  — chat that remembers past dialogues and improves over time
//  research  — autonomously searches and writes a sourced report
//  workflow  — "department / manager": assembles a team of sub-agents for a task
//  sales     — closer: handles objections, pushes to a decision, closes the deal
//  support   — answers FAQs from the knowledge base, escalates hard cases
//  booking   — schedules appointments: offers slots, books, confirms, reminds
//  analyst   — reads data/metrics and produces reports, digests, insights
//  smm       — plans content, writes posts per platform and schedules them
//  marketplace — e-commerce: researches products, audits listings, reads marketplace rules, builds sized infographics
export type AgentKind = 'chat' | 'qualifier' | 'sales' | 'support' | 'booking' | 'analyst' | 'smm' | 'marketplace' | 'coder' | 'content' | 'learning' | 'research' | 'workflow'
export type AgentStatus = 'active' | 'paused' | 'draft'
export type AgentSchedule = '24/7' | 'work-hours'
// 'auto' replies in the customer's language; otherwise force a base language.
export type AgentLang = 'auto' | Lang | 'en'

export interface AgentPrompt {
  role: string
  tasks: string
  tone: string
  rules: string
}

export interface LeadFormField {
  id: string
  label: string
  type: 'text' | 'phone' | 'select'
  required: boolean
}

export interface LeadFormConfig {
  enabled: boolean
  fields: LeadFormField[]
  trigger: string
  destination: 'crm' | 'table'
}

export interface KnowledgeDoc {
  id: string
  name: string
  source: 'file' | 'faq' | 'link'
  status: 'indexed' | 'indexing' | 'error'
  size: string
}

export interface PlatformAgent {
  id: string
  name: string
  type: AgentKind
  avatarColor: AgentColor
  role: string
  prompt: AgentPrompt
  model: string
  temperature: number
  timezone: string
  schedule: AgentSchedule
  // when schedule = 'work-hours', the agent is active only between these (HH:MM, agent timezone)
  workStart?: string
  workEnd?: string
  language: AgentLang
  // optional detailed settings — tailor the agent + its team to a market/sphere
  country?: string
  purpose?: string
  niche?: string
  // voice (TTS/STT) — config only for now; synthesis activates with a provider key
  voiceEnabled?: boolean
  voiceMode?: 'tts' | 'stt' | 'both'
  voiceId?: string
  // personal-assistant mode: the agent answers in Telegram AS one individual (not the company)
  personaMode?: 'business' | 'personal'
  ownerName?: string
  // selectable capability bundles (e.g. 'data-analysis') — layered on top of type gating
  skills?: string[]
  status: AgentStatus
  channels: ChannelType[]
  knowledge: KnowledgeDoc[]
  leadForm: LeadFormConfig
  lastActivity: string
  dialoguesToday: number
}

// A persistent "department": a manager (workflow) agent's saved team of specialist
// sub-agents, tailored to a sphere. Sub-agents run as the team for a task.
export interface SubAgent {
  id: string
  role: string
  name: string
  prompt: AgentPrompt
  model?: string
  status?: string
}

export interface Department {
  id: string
  name: string
  niche?: string
  mainAgentId?: string
  subAgents: SubAgent[]
}

export type DialogueStatus = 'open' | 'resolved' | 'needs_operator' | 'error'
export type DialogueAuthor = 'customer' | 'agent' | 'operator'

export interface DialogueMessage {
  id: string
  author: DialogueAuthor
  content: string
  time: string
}

export interface Dialogue {
  id: string
  agentId: string
  channel: ChannelType
  customerName: string
  customerContact: string
  status: DialogueStatus
  tags: string[]
  operatorTakeover: boolean
  unread: number
  updatedAt: string
  messages: DialogueMessage[]
}

export interface Template {
  id: string
  industry: string
  name: { uz: string; ru: string; en: string }
  description: { uz: string; ru: string; en: string }
  color: AgentColor
  preset: AgentPrompt
}

export interface LLMModelOption {
  id: string
  label: string
  vendor: string
  tokenRate: number // tokens per dialogue (for the calculator)
}

export interface ModelDef {
  id: string // OpenRouter model id, e.g. openai/gpt-4o-mini
  label: string
  tokenRate: number
  premium?: boolean // gated to Pro+ plans (server enforces via gateModel); shown with a 💎 badge
}

export interface ModelProvider {
  id: string // OpenRouter vendor prefix, e.g. openai | anthropic | google
  name: string
  models: ModelDef[]
}
