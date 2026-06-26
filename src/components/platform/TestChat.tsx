import { useEffect, useRef } from 'react'
import { useI18n } from '../../i18n'
import { useAgentChat } from '../../hooks/useAgentChat'
import { ChatComposer } from '../chat/ChatComposer'
import { AgentAvatar } from '../ui/AgentAvatar'
import { cn } from '../../lib/cn'
import type { PlatformAgent } from '../../types/platform'

export function TestChat({ agent }: { agent: PlatformAgent }) {
  const { t } = useI18n()
  const { messages, typing, send } = useAgentChat(agent)
  const agentName = agent.name
  const color = agent.avatarColor
  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' })
  }, [messages.length, typing])

  return (
    <div className="card flex h-[460px] flex-col overflow-hidden rounded-2xl">
      <div className="flex items-center gap-2.5 border-b border-ice/[0.07] px-4 py-3">
        <AgentAvatar color={color} glyph="search" size="sm" />
        <div>
          <p className="text-sm font-normal text-text">{agentName || 'Agent'}</p>
          <p className="text-[11px] text-muted">{t('platform.editor.testHint')}</p>
        </div>
      </div>

      <div ref={scrollRef} className="flex-1 space-y-3 overflow-y-auto p-4">
        {messages.length === 0 && (
          <p className="px-2 py-8 text-center text-xs text-muted">{t('chat.greetingSubtitle')}</p>
        )}
        {messages.map((m) => {
          const isCustomer = m.author === 'customer'
          return (
            <div key={m.id} className={cn('flex', isCustomer ? 'justify-end' : 'justify-start')}>
              <div
                className={cn(
                  'max-w-[80%] whitespace-pre-wrap rounded-2xl px-3.5 py-2.5 text-sm leading-relaxed',
                  isCustomer
                    ? 'rounded-tr-md border border-cobalt/40 bg-cobalt/10 text-text'
                    : 'glass rounded-tl-md text-text',
                )}
              >
                {m.text}
              </div>
            </div>
          )
        })}
        {typing && (
          <div className="flex justify-start">
            <div className="glass flex items-center gap-1 rounded-2xl rounded-tl-md px-4 py-3">
              {[0, 1, 2].map((i) => (
                <span key={i} className="h-1.5 w-1.5 rounded-full bg-muted animate-typing" style={{ animationDelay: `${i * 0.15}s` }} />
              ))}
            </div>
          </div>
        )}
      </div>

      <ChatComposer onSend={send} />
    </div>
  )
}
