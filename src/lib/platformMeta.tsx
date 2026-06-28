import { Send, MessageCircle, Camera, Globe, MessagesSquare, Telescope, Workflow, UserCheck, Code2, PenLine, Brain, Hash, Play } from 'lucide-react'
import type { ChannelType, AgentStatus, AgentKind, DialogueStatus } from '../types/platform'

// Channel visual + label metadata — vivid brand-true colors that pop on dark.
// `soon` channels need a persistent worker (Discord gateway / YouTube live chat) —
// not runnable on serverless yet, so they appear but can't be connected.
export const channelMeta: Record<
  ChannelType,
  { Icon: typeof Send; color: string; proper: string | null; soon?: boolean }
> = {
  telegram: { Icon: Send, color: '#3FA9F5', proper: 'Telegram' }, // telegram blue
  whatsapp: { Icon: MessageCircle, color: '#25D366', proper: 'WhatsApp' }, // whatsapp green
  instagram: { Icon: Camera, color: '#E1306C', proper: 'Instagram' }, // instagram magenta
  widget: { Icon: Globe, color: '#22D3EE', proper: null }, // cyan accent
  discord: { Icon: Hash, color: '#5865F2', proper: 'Discord', soon: true }, // discord blurple
  youtube: { Icon: Play, color: '#FF0000', proper: 'YouTube', soon: true }, // youtube red
}

export function channelLabel(type: ChannelType, t: (k: string) => string): string {
  return channelMeta[type].proper ?? t('platform.channels.widget')
}

// agent KIND metadata — icon + accent + i18n key.
//  chat=channels · qualifier=leads · coder=code · content=copy ·
//  learning=memory · research=web report · workflow=department/team
export const agentTypeMeta: Record<AgentKind, { Icon: typeof Send; color: string; key: string }> = {
  chat: { Icon: MessagesSquare, color: '#8B7CF8', key: 'platform.agentTypes.chat' },
  qualifier: { Icon: UserCheck, color: '#5A8DEE', key: 'platform.agentTypes.qualifier' },
  coder: { Icon: Code2, color: '#34D399', key: 'platform.agentTypes.coder' },
  content: { Icon: PenLine, color: '#F4A640', key: 'platform.agentTypes.content' },
  learning: { Icon: Brain, color: '#EC6CB0', key: 'platform.agentTypes.learning' },
  research: { Icon: Telescope, color: '#22D3EE', key: 'platform.agentTypes.research' },
  workflow: { Icon: Workflow, color: '#13C5B4', key: 'platform.agentTypes.workflow' },
}
export const AGENT_KINDS: AgentKind[] = ['chat', 'qualifier', 'coder', 'content', 'learning', 'research', 'workflow']

// agent status pill style — soft tint badges
export const agentStatusStyle: Record<AgentStatus, string> = {
  active: 'bg-forest/10 text-forest',
  paused: 'bg-ember/10 text-ember',
  draft: 'bg-infoblue text-midnight',
}

// dialogue status pill style — soft tint badges
export const dialogueStatusStyle: Record<DialogueStatus, string> = {
  open: 'bg-indigo/10 text-indigo',
  resolved: 'bg-forest/10 text-forest',
  needs_operator: 'bg-ember/10 text-ember',
  error: 'bg-danger/10 text-danger',
}
