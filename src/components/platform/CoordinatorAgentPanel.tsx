import { useMemo, useState } from 'react'
import { Bot, ChevronDown, CircleHelp, Loader2, MessageSquare, Sparkles, Wand2 } from 'lucide-react'
import { supabase, isSupabaseEnabled } from '../../lib/supabase'
import { useI18n } from '../../i18n'
import { cn } from '../../lib/cn'

type Mode = 'content' | 'planner' | 'general'
type CopyLang = 'ru' | 'uz' | 'en'

interface Step {
  title: string
  agent: string
  reason: string
}

const STEPS: Record<Mode, Step[]> = {
  content: [
    { title: 'Brief', agent: 'Координатор', reason: 'Сначала фиксирует цель, аудиторию, формат и ограничение по времени.' },
    { title: 'Research', agent: 'Исследователь', reason: 'Проверяет входные материалы и находит сильный угол, а не придумывает тему вслепую.' },
    { title: 'Draft', agent: 'Автор', reason: 'Создаёт пост или сценарий по согласованному углу и CTA.' },
    { title: 'Review', agent: 'Редактор', reason: 'Проверяет факты, ясность, тон и готовность к публикации.' },
    { title: 'Delivery', agent: 'Публикатор', reason: 'Готовит визуал, канал и публикацию; отправка всегда остаётся отдельным шагом.' },
  ],
  planner: [
    { title: 'Capture', agent: 'Координатор', reason: 'Собирает решения встречи и превращает их в конкретные задачи.' },
    { title: 'Assign', agent: 'Диспетчер', reason: 'Назначает владельца, срок и приоритет; неизвестный владелец считается блокером.' },
    { title: 'Execute', agent: 'Исполнитель', reason: 'Выполняет одну задачу и оставляет короткое доказательство результата.' },
    { title: 'Review', agent: 'Контролёр', reason: 'Проверяет результат и возвращает задачу на доработку, если критерий не выполнен.' },
    { title: 'Report', agent: 'Координатор', reason: 'Показывает руководителю прогресс, риски и следующий управленческий шаг.' },
  ],
  general: [
    { title: 'Capture', agent: 'Координатор', reason: 'Фиксирует цель, входные данные, ограничения и критерии готового результата.' },
    { title: 'Route', agent: 'Диспетчер', reason: 'Передаёт работу подходящему специалисту; нехватка данных или компетенции считается блокером.' },
    { title: 'Execute', agent: 'Исполнитель', reason: 'Выполняет ограниченный участок работы и не заявляет о результате без подтверждения инструментами или данными.' },
    { title: 'Review', agent: 'Контролёр', reason: 'Сверяет результат с критериями, доказательствами и правилами безопасности, при необходимости возвращает на доработку.' },
    { title: 'Deliver', agent: 'Координатор', reason: 'Передаёт проверенный результат, открытые блокеры и следующий шаг; внешнее действие требует отдельного подтверждения.' },
  ],
}

const GENERAL_STEPS: Record<CopyLang, Step[]> = {
  ru: STEPS.general,
  uz: [
    { title: 'Qabul qilish', agent: 'Koordinator', reason: 'Maqsad, kirish ma’lumotlari, cheklovlar va tayyor natija mezonini aniqlaydi.' },
    { title: 'Yo‘naltirish', agent: 'Dispetcher', reason: 'Ishni mos mutaxassisga beradi; yetishmayotgan ma’lumot yoki vakolat blok hisoblanadi.' },
    { title: 'Bajarish', agent: 'Ijrochi', reason: 'Chegaralangan ish qismini bajaradi va tasdiqsiz natijani bajarilgan deb ko‘rsatmaydi.' },
    { title: 'Tekshirish', agent: 'Nazoratchi', reason: 'Natijani mezonlar, dalillar va xavfsizlik qoidalari bo‘yicha tekshiradi.' },
    { title: 'Topshirish', agent: 'Koordinator', reason: 'Tekshirilgan natija, ochiq bloklar va keyingi qadamni beradi; tashqi harakat alohida tasdiqni talab qiladi.' },
  ],
  en: [
    { title: 'Capture', agent: 'Coordinator', reason: 'Records the goal, inputs, constraints, and acceptance criteria.' },
    { title: 'Route', agent: 'Dispatcher', reason: 'Routes work to the right specialist; missing data or permission is a blocker.' },
    { title: 'Execute', agent: 'Specialist', reason: 'Completes a bounded part of the task and never claims an unverified action succeeded.' },
    { title: 'Review', agent: 'Reviewer', reason: 'Checks the result against criteria, evidence, and safety rules.' },
    { title: 'Deliver', agent: 'Coordinator', reason: 'Returns the reviewed result, open blockers, and next step; external action needs separate approval.' },
  ],
}

const FALLBACK: Record<CopyLang, Record<Mode, string>> = {
  ru: {
    content: 'Сначала нужно зафиксировать цель, аудиторию и формат. После этого команда сможет исследовать тему и подготовить черновик. Публикация не начнётся без отдельного подтверждения.',
    planner: 'Сначала отделите решения от задач. Для каждой задачи нужны владелец, срок и критерий результата; без них задача остаётся заблокированной.',
    general: 'Сначала координатор уточняет цель, входные данные и критерии результата. Затем работа передаётся подходящему специалисту, проверяется и только после этого возвращается вместе с блокерами и следующим шагом. Неподтверждённые действия не считаются выполненными.',
  },
  uz: {
    content: 'Avval maqsad, auditoriya va formatni aniqlash kerak. Shundan keyin jamoa mavzuni o‘rganib, qoralama tayyorlaydi. Alohida tasdiqsiz nashr boshlanmaydi.',
    planner: 'Avval qarorlarni vazifalardan ajrating. Har bir vazifaga mas’ul, muddat va natija mezoni kerak; ular bo‘lmasa, vazifa bloklangan holda qoladi.',
    general: 'Avval koordinator maqsad, kirish ma’lumotlari va natija mezonlarini aniqlaydi. Keyin ish mos mutaxassisga yo‘naltiriladi, tekshiriladi va bloklar hamda keyingi qadam bilan qaytariladi. Tasdiqlanmagan harakat bajarilgan deb hisoblanmaydi.',
  },
  en: {
    content: 'Start by defining the goal, audience, and format. The team can then research the topic and prepare a draft. Publishing will not begin without separate approval.',
    planner: 'Separate decisions from tasks first. Every task needs an owner, deadline, and result criterion; without them, it remains blocked.',
    general: 'The coordinator first clarifies the goal, inputs, and acceptance criteria. Work is then routed to the right specialist, reviewed, and returned with blockers and the next step. Unverified actions are not treated as completed.',
  },
}

export function CoordinatorAgentPanel({ mode, context = '', liveStatus }: { mode: Mode; context?: string; liveStatus?: string }) {
  const { lang } = useI18n()
  const copyLang: CopyLang = lang === 'ru' ? 'ru' : lang === 'uz' ? 'uz' : 'en'
  const fallback = FALLBACK[copyLang][mode]
  const [question, setQuestion] = useState('')
  const [answer, setAnswer] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [expanded, setExpanded] = useState(false)
  const steps = mode === 'general' ? GENERAL_STEPS[copyLang] : STEPS[mode]

  const copy = useMemo(() => lang === 'ru' ? {
    title: 'Координатор Nemo',
    subtitle: 'Объясняет, что делают агенты, зачем они это делают и что будет дальше.',
    live: 'Сейчас',
    ask: 'Спросить координатора',
    placeholder: mode === 'content' ? 'Например: почему текст ещё не готов?' : mode === 'planner' ? 'Например: почему задача не закрывается?' : 'Например: что сейчас делает команда и что блокирует результат?',
    mode: isSupabaseEnabled ? 'AI-режим' : 'Демо-режим',
    next: 'Логика потока',
  } : lang === 'uz' ? {
    title: 'Nemo koordinatori',
    subtitle: 'Agentlar nima qilayotgani, nima uchun va keyingi qadamni tushuntiradi.',
    live: 'Hozir',
    ask: 'Koordinatordan so‘rash',
    placeholder: mode === 'content' ? 'Masalan: nega matn hali tayyor emas?' : mode === 'planner' ? 'Masalan: nega vazifa yopilmayapti?' : 'Masalan: jamoa hozir nima qilmoqda va natijaga nima to‘sqinlik qilmoqda?',
    mode: isSupabaseEnabled ? 'AI rejim' : 'Demo rejim',
    next: 'Jarayon mantig‘i',
  } : {
    title: 'Nemo Coordinator',
    subtitle: 'Explains what agents are doing, why it matters, and what happens next.',
    live: 'Now',
    ask: 'Ask coordinator',
    placeholder: mode === 'content' ? 'For example: why is the draft not ready yet?' : mode === 'planner' ? 'For example: why is the task not closing?' : 'For example: what is the team doing now, and what is blocking delivery?',
    mode: isSupabaseEnabled ? 'AI mode' : 'Demo mode',
    next: 'Workflow logic',
  }, [lang, mode])

  const ask = async () => {
    const prompt = question.trim()
    if (!prompt || busy) return
    setBusy(true)
    try {
      if (!supabase) {
        setAnswer(fallback)
        return
      }
      const { data, error } = await supabase.functions.invoke('orchestrate', {
        body: {
          action: 'step',
          role: 'manager',
          goal: `Explain the ${mode} workflow to the owner. ${context}`.trim(),
          task: prompt,
          lang,
          system: 'You are Nemo Coordinator. Explain the current agent workflow in plain language. Be concrete: state, responsible agent, reason, blocker, next action. Never claim an action happened unless the context proves it. Keep it under 180 words.',
          context: `${context}\nWorkflow stages:\n${steps.map((s) => `${s.title}: ${s.agent} — ${s.reason}`).join('\n')}`,
        },
      })
      const text = (data as { output?: string } | null)?.output?.trim()
      setAnswer(error || !text ? fallback : text)
    } catch {
      setAnswer(fallback)
    } finally {
      setBusy(false)
      setQuestion('')
    }
  }

  return (
    <section className="card rounded-2xl border border-cyan/20 bg-cyan/[0.045] p-4">
      <div className="flex flex-wrap items-center gap-3">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-cyan/15 text-cyan"><Bot size={18} /></span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-base font-bold text-text">{copy.title}</h2>
            <span className="rounded-pill border border-teal/20 bg-teal/10 px-2 py-0.5 text-[10px] font-medium text-teal">{copy.mode}</span>
          </div>
        </div>
      </div>

      <div className="mt-3 flex items-start gap-2 rounded-xl border border-ice/10 bg-black/15 px-3 py-2.5">
        <Sparkles size={14} className="mt-0.5 shrink-0 text-cyan" />
        <p className="line-clamp-2 text-[13px] leading-relaxed text-text">{liveStatus || answer || fallback}</p>
      </div>

      <div className="mt-2">
        <button type="button" onClick={() => setExpanded((value) => !value)} aria-expanded={expanded} className="flex w-full items-center justify-between rounded-xl px-2 py-2 text-left text-xs font-medium text-muted transition hover:bg-white/[0.03] hover:text-text">
          <span className="flex items-center gap-1.5"><Wand2 size={13} /> {copy.next} · {steps.length}</span>
          <ChevronDown size={15} className={cn('transition-transform', expanded && 'rotate-180')} />
        </button>
        {expanded && (
          <div className="mt-1 grid gap-2 sm:grid-cols-5">
            {steps.map((step, i) => (
              <div key={step.title} className="rounded-xl border border-ice/10 bg-black/10 px-2.5 py-2">
                <p className="text-[11px] font-semibold text-text"><span className="mr-1 text-cyan">{i + 1}.</span>{step.title}</p>
                <p className="mt-0.5 text-[10px] font-medium text-violet">{step.agent}</p>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="mt-2 flex items-end gap-2">
        <div className="glass flex min-h-10 flex-1 items-center rounded-xl px-3">
          <MessageSquare size={15} className="mr-2 shrink-0 text-muted" />
          <input value={question} onChange={(e) => setQuestion(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void ask() }} placeholder={copy.placeholder} className="w-full bg-transparent text-sm text-text outline-none placeholder:text-fog" />
        </div>
        <button onClick={() => void ask()} disabled={busy || !question.trim()} aria-label={copy.ask} className={cn('inline-flex h-10 items-center gap-2 rounded-xl bg-brand px-3 text-sm font-medium text-white transition disabled:opacity-40', busy && 'cursor-wait')}>
          {busy ? <Loader2 size={15} className="animate-spin" /> : <CircleHelp size={15} />} <span className="hidden sm:inline">{copy.ask}</span>
        </button>
      </div>
    </section>
  )
}
