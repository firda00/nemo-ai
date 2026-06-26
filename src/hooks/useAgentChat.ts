import { useCallback, useEffect, useRef, useState } from 'react'
import { useI18n } from '../i18n'
import type { Lang } from '../types'
import type { PlatformAgent } from '../types/platform'
import { supabase, isSupabaseEnabled } from '../lib/supabase'

export interface ChatMsg {
  id: string
  author: 'customer' | 'agent'
  text: string
  time: string
}

let uid = 0
const nid = () => `am_${++uid}`
const now = () => new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })

// Demo fallback (no backend): lightweight keyword-aware simulation.
function buildMockReply(userText: string, lang: Lang): string {
  const g = userText.toLowerCase()
  const priceish = /narx|price|стоим|цена|qancha|сколько/.test(g)
  const hi = /salom|assalom|привет|здрав|hello/.test(g)

  if (lang === 'ru') {
    if (hi) return 'Здравствуйте! Рад помочь. Расскажите, что вас интересует?'
    if (priceish) return 'Стоимость зависит от выбранного варианта. Подскажите, что именно интересует — подберу и пришлю детали.'
    return 'Понял вас. Уточню детали и помогу с этим. Что ещё важно учесть?'
  }
  if (hi) return 'Assalomu alaykum! Yordam berishdan xursandman. Nima qiziqtiradi?'
  if (priceish) return 'Narx tanlangan variantga bog‘liq. Aynan nima qiziqtirayotganini ayting — mosini topib, batafsil yuboraman.'
  return 'Tushundim. Buni aniqlashtirib, yordam beraman. Yana nimani hisobga olaylik?'
}

/**
 * Test-chat hook. When an agent config is supplied AND Supabase is enabled, every
 * message is answered by the REAL model via the `test-agent` Edge Function (the
 * agent's prompt/model/language/temperature, nothing persisted). Otherwise it
 * falls back to the local demo simulation so the UI still works offline.
 */
export function useAgentChat(agent?: PlatformAgent) {
  const { lang, t } = useI18n()
  const [messages, setMessages] = useState<ChatMsg[]>([])
  const [typing, setTyping] = useState(false)
  const langRef = useRef<Lang>(lang)
  const msgsRef = useRef<ChatMsg[]>([])
  const timers = useRef<ReturnType<typeof setTimeout>[]>([])

  useEffect(() => {
    langRef.current = lang
  }, [lang])
  useEffect(() => {
    msgsRef.current = messages
  }, [messages])
  useEffect(() => () => timers.current.forEach(clearTimeout), [])

  const live = isSupabaseEnabled && !!supabase && !!agent

  const send = useCallback(
    async (text: string) => {
      const tt = text.trim()
      if (!tt) return
      const history = msgsRef.current
      setMessages((m) => [...m, { id: nid(), author: 'customer', text: tt, time: now() }])
      setTyping(true)

      if (live && agent && supabase) {
        try {
          const { data, error } = await supabase.functions.invoke('test-agent', {
            body: {
              agent: {
                name: agent.name,
                model: agent.model,
                temperature: agent.temperature,
                prompt: agent.prompt,
                default_lang: agent.language,
              },
              agent_id: agent.id,
              message: tt,
              history: history.map((m) => ({ author: m.author, content: m.text })),
            },
          })
          setTyping(false)
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const reply = (data as any)?.reply as string | undefined
          if (error || !reply) {
            setMessages((m) => [...m, { id: nid(), author: 'agent', text: '⚠️ ' + t('platform.editor.testError'), time: now() }])
            return
          }
          setMessages((m) => [...m, { id: nid(), author: 'agent', text: reply, time: now() }])
        } catch {
          setTyping(false)
          setMessages((m) => [...m, { id: nid(), author: 'agent', text: '⚠️ ' + t('platform.editor.testError'), time: now() }])
        }
        return
      }

      // demo simulation
      const id = setTimeout(() => {
        setTyping(false)
        setMessages((m) => [...m, { id: nid(), author: 'agent', text: buildMockReply(tt, langRef.current), time: now() }])
      }, 950)
      timers.current.push(id)
    },
    [live, agent, t],
  )

  const reset = useCallback(() => {
    timers.current.forEach(clearTimeout)
    timers.current = []
    setMessages([])
    setTyping(false)
  }, [])

  return { messages, typing, send, reset }
}
