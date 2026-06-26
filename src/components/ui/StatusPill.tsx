import { useI18n } from '../../i18n'
import { cn } from '../../lib/cn'
import type { AgentRuntimeStatus } from '../../types'

const styles: Record<AgentRuntimeStatus, { wrap: string; dot: string; pulse: boolean }> = {
  idle: { wrap: 'bg-infoblue text-midnight', dot: 'bg-midnight/50', pulse: false },
  waiting: { wrap: 'bg-infoblue text-midnight', dot: 'bg-midnight/50', pulse: false },
  working: { wrap: 'bg-indigo/10 text-indigo', dot: 'bg-indigo', pulse: true },
  done: { wrap: 'bg-forest/10 text-forest', dot: 'bg-forest', pulse: false },
  error: { wrap: 'bg-danger/10 text-danger', dot: 'bg-danger', pulse: false },
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
