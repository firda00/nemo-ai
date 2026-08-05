import { useI18n } from '../../i18n'
import { cn } from '../../lib/cn'
import type { AgentRuntimeStatus } from '../../types'

// Brand Identity 2026.1: translucent pills with a hairline of their own hue, not solid
// blocks. Semantic colour stays separate from the brand accent — done is teal and error is
// red because those mean something; only "working" borrows the brand cyan, since an agent
// mid-flight is exactly the live state the accent is for.
const styles: Record<AgentRuntimeStatus, { wrap: string; dot: string; pulse: boolean }> = {
  idle: { wrap: 'bg-muted/10 text-muted border border-muted/20', dot: 'bg-muted/60', pulse: false },
  waiting: { wrap: 'bg-muted/10 text-muted border border-muted/20', dot: 'bg-muted/60', pulse: false },
  working: { wrap: 'bg-accent-cyan/10 text-accent-cyan border border-accent-cyan/20', dot: 'bg-accent-cyan', pulse: true },
  done: { wrap: 'bg-teal/10 text-teal border border-teal/20', dot: 'bg-teal', pulse: false },
  error: { wrap: 'bg-danger/10 text-danger border border-danger/20', dot: 'bg-danger', pulse: false },
}

export function StatusPill({
  status,
  className,
}: {
  status: AgentRuntimeStatus
  className?: string
}) {
  const { t } = useI18n()
  const s = styles[status]
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-pill px-2.5 py-0.5 text-[11px] font-medium',
        s.wrap,
        className,
      )}
    >
      <span className={cn('h-1.5 w-1.5 rounded-full', s.dot, s.pulse && 'animate-pulse')} />
      {t(`status.${status}`)}
    </span>
  )
}
