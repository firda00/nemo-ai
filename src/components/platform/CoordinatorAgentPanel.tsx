import { useMemo, useState } from 'react'
import { Bot, CircleHelp, Loader2, MessageSquare, Sparkles, Wand2 } from 'lucide-react'
import { supabase, isSupabaseEnabled } from '../../lib/supabase'
import { useI18n } from '../../i18n'
import { cn } from '../../lib/cn'

type Mode = 'content' | 'planner'

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
}

const FALLBACK: Record<Mode, string> = {
  content: 'Сейчас я бы начал с брифа. Без цели, аудитории и формата остальные агенты будут делать красивый, но случайный контент. Следующий шаг — заполнить цель и запустить Research; публикация не начнётся без отдельного подтверждения.',
  planner: 'Сейчас важно отделить решения от задач. Координатор создаёт задачу, Диспетчер назначает владельца и срок, а Контролёр закрывает её только после доказательства результата. Если нет владельца или срока, задача остаётся заблокированной.',
}

export function CoordinatorAgentPanel({ mode, context = '', liveStatus }: { mode: Mode; context?: string; liveStatus?: string }) {
  const { lang } = useI18n()
  const [question, setQuestion] = useState('')
  const [answer, setAnswer] = useState(FALLBACK[mode])
  const [busy, setBusy] = useState(false)
  const steps = STEPS[mode]

  const copy = useMemo(() => lang === 'ru' ? {
    title: 'Координатор Nemo',
    subtitle: 'Объясняет, что делают агенты, зачем они это делают и что будет дальше.',
    live: 'Сейчас',
    ask: 'Спросить координатора',
    placeholder: mode === 'content' ? 'Например: почему текст ещё не готов?' : 'Например: почему задача не закрывается?',
    mode: isSupabaseEnabled ? 'AI-режим' : 'Демо-режим',
    next: 'Логика потока',
  } : lang === 'uz' ? {
    title: 'Nemo koordinatori',
    subtitle: 'Agentlar nima qilayotgani, nima uchun va keyingi qadamni tushuntiradi.',
    live: 'Hozir',
    ask: 'Koordinatorga so‘rash',
    placeholder: 'Masalan: nega matn hali tayyor emas?',
    mode: isSupabaseEnabled ? 'AI rejim' : 'Demo rejim',
    next: 'Jarayon mantig‘i',
  } : {
    title: 'Nemo Coordinator',
    subtitle: 'Explains what agents are doing, why it matters, and what happens next.',
    live: 'Now',
    ask: 'Ask coordinator',
    placeholder: 'For example: why is this still waiting?',
    mode: isSupabaseEnabled ? 'AI mode' : 'Demo mode',
    next: 'Workflow logic',
  }, [lang, mode])

  const ask = async () => {
    const prompt = question.trim()
    if (!prompt || busy) return
    setBusy(true)
    try {
      if (!supabase) {
        setAnswer(FALLBACK[mode])
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
      setAnswer(error || !text ? FALLBACK[mode] : text)
    } catch {
      setAnswer(FALLBACK[mode])
    } finally {
      setBusy(false)
      setQuestion('')
    }
  }

  return (
    <section className="card rounded-3xl border border-cyan/20 bg-cyan/[0.045] p-5 sm:p-6">
      <div className="flex flex-wrap items-start gap-3">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-cyan/15 text-cyan"><Bot size={20} /></span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-lg font-bold text-text">{copy.title}</h2>
            <span className="rounded-pill border border-teal/20 bg-teal/10 px-2 py-0.5 text-[10px] font-medium text-teal">{copy.mode}</span>
          </div>
          <p className="mt-1 text-sm leading-relaxed text-muted">{copy.subtitle}</p>
        </div>
      </div>

      <div className="mt-4 rounded-2xl border border-ice/10 bg-black/15 p-3.5">
        <p className="mb-1 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-cyan"><Sparkles size={13} /> {copy.live}</p>
        <p className="text-[13px] leading-relaxed text-text">{liveStatus || answer}</p>
      </div>

      <div className="mt-4">
        <p className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted"><Wand2 size={13} /> {copy.next}</p>
        <div className="grid gap-2 sm:grid-cols-5">
          {steps.map((step, i) => (
            <div key={step.title} className="rounded-xl border border-ice/10 bg-black/10 p-2.5">
              <p className="text-[11px] font-semibold text-text"><span className="mr-1 text-cyan">{i + 1}.</span>{step.title}</p>
              <p className="mt-1 text-[10px] font-medium text-violet">{step.agent}</p>
              <p className="mt-1 text-[10.5px] leading-relaxed text-fog">{step.reason}</p>
            </div>
          ))}
        </div>
      </div>

      <div className="mt-4 flex items-end gap-2">
        <div className="glass flex min-h-11 flex-1 items-center rounded-xl px-3">
          <MessageSquare size={15} className="mr-2 shrink-0 text-muted" />
          <input value={question} onChange={(e) => setQuestion(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void ask() }} placeholder={copy.placeholder} className="w-full bg-transparent text-sm text-text outline-none placeholder:text-fog" />
        </div>
        <button onClick={() => void ask()} disabled={busy || !question.trim()} className={cn('inline-flex h-11 items-center gap-2 rounded-xl bg-brand px-3.5 text-sm font-medium text-white transition disabled:opacity-40', busy && 'cursor-wait')}>
          {busy ? <Loader2 size={15} className="animate-spin" /> : <CircleHelp size={15} />} {copy.ask}
        </button>
      </div>
    </section>
  )
}
