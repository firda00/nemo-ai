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

// When the LIVE test-agent call fails (no auth / no tokens / provider error) we
// still show a local mock so the UI works, but we mark it clearly so the operator
// knows it is NOT real inference — otherwise the fallback looks like "just a simulation".
function demoNote(lang: Lang): string {
  if (lang === 'ru') return '⚠️ Демо-ответ (реальная модель недоступна — проверьте вход и баланс токенов).\n\n'
  if (lang === 'en') return '⚠️ Demo reply (live model unavailable — check sign-in and token balance).\n\n'
  return '⚠️ Demo javob (jonli model mavjud emas — kirish va token balansini tekshiring).\n\n'
}

function buildAutonomousOperatorReply(userText: string, agent?: PlatformAgent, history: ChatMsg[] = []): string {
  const text = userText.trim()
  const isLead = /lead|lid|client|customer|phone|telegram|instagram|sales|sell|course|price|demo|trial|consult/i.test(text)
  const isContent = /content|post|telegram post|instagram|reels|caption|script|email|offer|creative/i.test(text)
  const isCode = /code|bug|fix|api|frontend|backend|react|supabase|typescript|repo|deploy/i.test(text)
  const isReport = /report|summary|daily|weekly|manager|crm|table|analytics|kpi/i.test(text)
  const recent = history.filter((m) => m.author === 'customer').slice(-2).map((m) => m.text).join(' | ')
  const leadFields = agent?.leadForm.fields.map((f) => f.label).join(', ') || 'name, phone, interest, next action'
  const routes = [
    isLead ? 'Lead Qualifier: score intent, budget, urgency and fit.' : '',
    isContent ? 'Content Agent: create message variants and a publishing checklist.' : '',
    isCode ? 'Coder Agent: produce implementation steps, risks and a test checklist.' : '',
    isReport ? 'Report Agent: summarize CRM-ready rows and manager next actions.' : '',
  ].filter(Boolean)
  const selectedRoutes = routes.length ? routes : [
    'Analyst Agent: understand the request and extract the business goal.',
    'Action Agent: create a concrete next-step plan.',
    'Reviewer Agent: check missing info and escalation rules.',
  ]
  const nextAction = isLead
    ? `Collect these fields: ${leadFields}. Then classify the lead as hot/warm/cold and prepare CRM handoff.`
    : isContent
      ? 'Collect channel, audience and offer. Then create 3 content variants, CTA and a publishing checklist.'
      : isCode
        ? 'Collect the target file or error text. Then create a fix plan, patch outline and regression test checklist.'
        : 'Collect target outcome, deadline and delivery channel. Then produce structured actions and a final summary.'

  return [
    `Autonomous run started for: "${text}"`,
    '',
    'Agent trace:',
    ...selectedRoutes.map((step, index) => `${index + 1}. ${step}`),
    '',
    'Result:',
    `I will handle this as ${agent?.name || 'Autonomous Business Operator'}: split the goal into specialist tasks, collect missing fields, prepare structured output, and escalate only when a human decision is required.`,
    '',
    'Immediate next action:',
    nextAction,
    recent ? `\nContext remembered from this chat: ${recent}` : '',
  ].filter(Boolean).join('\n')
}

// Demo fallback (no backend): agent-aware simulation. It is not a replacement for
// paid LLM/API runtime, but it should still behave like the configured agent.
function buildMockReply(userText: string, lang: Lang, agent?: PlatformAgent, history: ChatMsg[] = []): string {
  if (agent?.id === 'ag_autonomous_operator' || agent?.type === 'workflow') {
    return buildAutonomousOperatorReply(userText, agent, history)
  }

  const g = userText.toLowerCase()
  const priceish = /narx|price|стоим|цена|qancha|сколько/.test(g)
  const hi = /salom|assalom|привет|здрав|hello/.test(g)
  const contact = /телефон|phone|номер|связ|contact|bog.?lan|aloqa/.test(g)
  const booking = /запис|брон|booking|start|начать|qachon|когда|schedule|распис/.test(g)
  const research = /исслед|research|анализ|рынок|competitor|конкурент|trend|тренд/.test(g)
  const content = /контент|post|пост|reels|script|сценар|email|баннер|image|изображ/.test(g)
  const product = /курс|товар|услуг|product|service|course|mahsulot|xizmat/.test(g)
  const role = agent?.prompt.role || agent?.role || agent?.name || 'AI assistant'
  const tasks = agent?.prompt.tasks || agent?.purpose || ''
  const hasLeadForm = Boolean(agent?.leadForm.enabled)
  const leadFields = agent?.leadForm.fields.map((f) => f.label).slice(0, 4).join(', ')
  const channels = agent?.channels.length ? agent.channels.join(', ') : 'test chat'
  const previous = history.filter((m) => m.author === 'customer').slice(-2).map((m) => m.text).join(' / ')

  const ruLead = hasLeadForm ? `\n\nЧтобы передать вас дальше, мне нужно собрать: ${leadFields}.` : ''
  const uzLead = hasLeadForm ? `\n\nKeyingi bosqich uchun quyidagilar kerak: ${leadFields}.` : ''

  if (lang === 'ru') {
    if (hi) return `Здравствуйте! Я работаю как ${role}. Могу помочь по задаче: ${tasks.slice(0, 120) || 'консультация и обработка запроса'}. Что именно хотите решить?`
    if (priceish) return `Цена зависит от конкретного продукта/услуги и объёма. Напишите, что именно вас интересует${product ? '' : ' — продукт, курс или услуга'}, и я уточню подходящий вариант.${ruLead}`
    if (booking) return `Да, могу помочь с записью/стартом. Уточните желаемую дату, город/часовой пояс и удобный способ связи. Каналы команды: ${channels}.${ruLead}`
    if (research) return `Я запущу research-подход: сформулирую 3-5 поисковых запросов, сравню источники, выделю риски и соберу краткий отчёт. Текущий фокус: “${userText}”.`
    if (content) return `Для контента я разложу задачу на: идея → структура → текст → визуал/image prompt → публикация. По вашему запросу подготовлю 2 варианта и CTA. Уточните площадку: Instagram, Telegram, сайт или email?`
    if (contact) return `Могу передать контакт оператору/CRM. Напишите телефон и удобное время связи.${ruLead}`
    return `Понял запрос: “${userText}”. Я отвечаю в рамках роли “${role}”. Следующий шаг: уточню контекст, проверю доступные знания/инструменты и дам конкретное решение. ${previous ? `Учитываю предыдущий контекст: ${previous}.` : 'Что для вас самый важный результат?'}`
  }
  if (hi) return `Assalomu alaykum! Men ${role} sifatida ishlayman. Qaysi masalani hal qilamiz?`
  if (priceish) return `Narx mahsulot/xizmat va hajmga bog‘liq. Aynan qaysi mahsulot, kurs yoki xizmat qiziqtiryapti?${uzLead}`
  if (booking) return `Yozilish yoki start bo‘yicha yordam beraman. Sana, shahar/vaqt mintaqasi va aloqa raqamini yozing.${uzLead}`
  if (research) return `Research rejimi: savollar tuzaman, manbalarni solishtiraman va qisqa hisobot tayyorlayman. Mavzu: “${userText}”.`
  if (content) return `Kontent uchun vazifa: idea → matn → visual prompt → publication. Platformani ayting: Instagram, Telegram, sayt yoki email?`
  if (contact) return `Operator/CRM ga uzatish uchun telefon va qulay vaqtni yozing.${uzLead}`
  return `Tushundim: “${userText}”. Rolim: ${role}. Kontekstni aniqlab, amaliy yechim taklif qilaman. Siz uchun eng muhim natija nima?`
}

/**
 * Test-chat hook. When an agent config is supplied AND Supabase is enabled, every
 * message is answered by the REAL model via the `test-agent` Edge Function (the
 * agent's prompt/model/language/temperature, nothing persisted). Otherwise it
 * falls back to the local demo simulation so the UI still works offline.
 */
export function useAgentChat(agent?: PlatformAgent) {
  const { lang } = useI18n()
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
              // persist the test dialogue only for a SAVED agent (real UUID), so it
              // shows up in Dialogues + the DB (scenario A "dialogue saved in DB").
              persist: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(agent.id),
              message: tt,
              history: history.map((m) => ({ author: m.author, content: m.text })),
            },
          })
          setTyping(false)
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const reply = (data as any)?.reply as string | undefined
          if (error || !reply) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            console.warn('test-agent live call failed:', error?.message || (data as any)?.error || 'no reply')
            setMessages((m) => [...m, { id: nid(), author: 'agent', text: demoNote(langRef.current) + buildMockReply(tt, langRef.current, agent, history), time: now() }])
            return
          }
          setMessages((m) => [...m, { id: nid(), author: 'agent', text: reply, time: now() }])
        } catch (e) {
          setTyping(false)
          console.warn('test-agent live call threw:', e)
          setMessages((m) => [...m, { id: nid(), author: 'agent', text: demoNote(langRef.current) + buildMockReply(tt, langRef.current, agent, history), time: now() }])
        }
        return
      }

      // demo simulation
      const id = setTimeout(() => {
        setTyping(false)
        setMessages((m) => [...m, { id: nid(), author: 'agent', text: buildMockReply(tt, langRef.current, agent, history), time: now() }])
      }, 950)
      timers.current.push(id)
    },
    [live, agent],
  )

  const reset = useCallback(() => {
    timers.current.forEach(clearTimeout)
    timers.current = []
    setMessages([])
    setTyping(false)
  }, [])

  return { messages, typing, send, reset }
}
