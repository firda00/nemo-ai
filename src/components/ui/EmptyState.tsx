import type { LucideIcon } from 'lucide-react'
import type { ReactNode } from 'react'

export function EmptyState({
  icon: Icon,
  title,
  desc,
  action,
}: {
  icon: LucideIcon
  title: string
  desc?: string
  action?: ReactNode
}) {
  return (
    <div className="card flex flex-col items-center rounded-2xl px-6 py-14 text-center">
      <span className="flex h-12 w-12 items-center justify-center rounded-xl border border-ice/15 text-ice">
        <Icon size={22} strokeWidth={1.6} />
      </span>
      <p className="mt-4 text-sm text-text">{title}</p>
      {desc && <p className="mt-1 max-w-sm text-xs leading-relaxed text-muted">{desc}</p>}
      {action && <div className="mt-5">{action}</div>}
    </div>
  )
}
