import { CheckCircle2, Circle, Clock3, ListTodo, ShieldAlert, UserRound } from 'lucide-react'
import { cn } from '../../lib/cn'

interface PlannerTask { id: string; title: string; owner?: string; deadline?: string; priority?: string; status?: string }

const LANES = [
  { id: 'todo', label: 'Следом', icon: ListTodo, tone: 'text-muted' },
  { id: 'in_progress', label: 'В работе', icon: Clock3, tone: 'text-cyan' },
  { id: 'blocked', label: 'Блокер', icon: ShieldAlert, tone: 'text-amber' },
  { id: 'done', label: 'Готово', icon: CheckCircle2, tone: 'text-teal' },
]

function laneFor(status?: string) {
  const value = (status ?? '').toLowerCase()
  if (value === 'done' || value === 'completed' || value === 'closed') return 'done'
  if (value.includes('block') || value === 'blocked') return 'blocked'
  if (value.includes('progress') || value === 'running') return 'in_progress'
  return 'todo'
}

export function PlannerCommandCenter({ tasks }: { tasks: PlannerTask[] }) {
  const visible = tasks.length ? tasks : [
    { id: 'demo-1', title: 'Назначить владельца первой задаче', owner: 'Координатор', priority: 'high', status: 'todo' },
    { id: 'demo-2', title: 'Проверить доказательство результата', owner: 'Контролёр', priority: 'medium', status: 'in_progress' },
  ]

  return (
    <section className="card rounded-3xl border border-violet/20 bg-violet/[0.035] p-5 sm:p-6">
      <div className="flex flex-wrap items-start gap-3">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-violet/15 text-violet"><ListTodo size={19} /></span>
        <div>
          <h2 className="text-lg font-bold text-text">Планёрка как рабочая доска</h2>
          <p className="mt-1 max-w-2xl text-sm leading-relaxed text-muted">Каждая задача проходит путь «следом → в работе → проверка → готово». Если нет владельца, срока или доказательства — она не считается закрытой.</p>
        </div>
      </div>

      <div className="mt-5 grid gap-3 md:grid-cols-4">
        {LANES.map((lane) => {
          const items = visible.filter((task) => laneFor(task.status) === lane.id)
          return (
            <div key={lane.id} className="min-h-32 rounded-2xl border border-ice/10 bg-black/10 p-3">
              <div className="flex items-center gap-1.5 border-b border-ice/10 pb-2">
                <lane.icon size={14} className={lane.tone} />
                <span className={cn('text-xs font-semibold', lane.tone)}>{lane.label}</span>
                <span className="ml-auto text-[10px] text-fog">{items.length}</span>
              </div>
              <div className="mt-2 space-y-2">
                {items.map((task) => (
                  <article key={task.id} className="rounded-xl border border-ice/[0.07] bg-white/[0.025] p-2.5">
                    <p className="text-[12px] leading-relaxed text-text">{task.title}</p>
                    <div className="mt-2 flex flex-wrap items-center gap-2 text-[10px] text-fog">
                      <span className="inline-flex items-center gap-1"><UserRound size={11} /> {task.owner || 'Владелец не назначен'}</span>
                      {task.deadline && <span>{task.deadline}</span>}
                      {task.priority && <span className={cn('rounded-full px-1.5 py-0.5', task.priority === 'high' ? 'bg-danger/15 text-danger' : 'bg-white/[0.06] text-muted')}>{task.priority}</span>}
                    </div>
                  </article>
                ))}
                {!items.length && <p className="flex items-center gap-1.5 py-3 text-[11px] text-fog"><Circle size={11} /> Пусто</p>}
              </div>
            </div>
          )
        })}
      </div>
    </section>
  )
}
