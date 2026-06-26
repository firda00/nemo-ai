import { Check } from 'lucide-react'
import { cn } from '../../lib/cn'

export function Stepper({ steps, current }: { steps: string[]; current: number }) {
  return (
    <ol className="flex items-center gap-2 sm:gap-3">
      {steps.map((label, i) => {
        const n = i + 1
        const done = n < current
        const active = n === current
        return (
          <li key={label} className="flex flex-1 items-center gap-2 sm:gap-3">
            <span
              className={cn(
                'flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-sm font-medium',
                done ? 'bg-forest text-white' : active ? 'bg-indigo text-white' : 'border border-ink/15 text-fog',
              )}
            >
              {done ? <Check size={15} strokeWidth={2.5} /> : n}
            </span>
            <span className={cn('hidden text-sm font-medium sm:block', active ? 'text-ink' : 'text-fog')}>{label}</span>
            {n < steps.length && <span className={cn('h-px flex-1', done ? 'bg-forest/40' : 'bg-ink/10')} />}
          </li>
        )
      })}
    </ol>
  )
}
