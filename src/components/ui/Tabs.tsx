import type { LucideIcon } from 'lucide-react'
import { cn } from '../../lib/cn'

export interface TabDef {
  key: string
  label: string
  icon?: LucideIcon
}

export function Tabs({
  tabs,
  active,
  onChange,
  orientation = 'horizontal',
  className,
}: {
  tabs: TabDef[]
  active: string
  onChange: (key: string) => void
  orientation?: 'horizontal' | 'vertical'
  className?: string
}) {
  const vertical = orientation === 'vertical'
  return (
    <div
      className={cn(
        vertical ? 'flex flex-col gap-1' : 'flex gap-1 overflow-x-auto rounded-pill border border-white/10 bg-white/[0.03] p-1',
        className,
      )}
      role="tablist"
    >
      {tabs.map((tb) => {
        const isActive = active === tb.key
        return (
          <button
            key={tb.key}
            role="tab"
            aria-selected={isActive}
            onClick={() => onChange(tb.key)}
            className={cn(
              'flex items-center gap-2 whitespace-nowrap rounded-pill text-sm font-medium transition-colors',
              vertical ? 'px-3 py-2.5' : 'px-4 py-2',
              isActive ? 'bg-indigo text-white' : 'text-fog hover:text-ink',
            )}
          >
            {tb.icon && <tb.icon size={16} />}
            {tb.label}
          </button>
        )
      })}
    </div>
  )
}
