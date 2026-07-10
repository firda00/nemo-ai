import { Search, PenLine, BarChart3, CheckCircle, Plug, Check } from 'lucide-react'
import { cn } from '../../lib/cn'
import type { AgentColor, AgentGlyph, AgentRuntimeStatus } from '../../types'

// Round role-color avatars — subtle dark glass on dark (spec §3 Avatar). Low-opacity
// fill + an inset colored ring so it reads as a tinted disc, never a bright/white block.
const colorMap: Record<AgentColor, string> = {
  violet: 'bg-violet/10 text-violet ring-1 ring-inset ring-violet/25',
  blue: 'bg-blue/10 text-blue ring-1 ring-inset ring-blue/25',
  cyan: 'bg-cyan/10 text-cyan ring-1 ring-inset ring-cyan/25',
  teal: 'bg-teal/10 text-teal ring-1 ring-inset ring-teal/25',
  amber: 'bg-amber/10 text-amber ring-1 ring-inset ring-amber/25',
}

const glyphMap: Record<AgentGlyph, typeof Search> = {
  search: Search,
  pen: PenLine,
  chart: BarChart3,
  check: CheckCircle,
  plug: Plug,
}

const sizeMap = {
  sm: { box: 'h-9 w-9', icon: 16 },
  md: { box: 'h-10 w-10', icon: 18 },
  lg: { box: 'h-12 w-12', icon: 20 },
}

export function AgentAvatar({
  color = 'violet',
  glyph,
  status,
  size = 'md',
  className,
}: {
  color?: AgentColor
  glyph: AgentGlyph
  status?: AgentRuntimeStatus
  size?: keyof typeof sizeMap
  className?: string
}) {
  const active = status === 'working'
  const Icon = glyphMap[glyph]
  const s = sizeMap[size]
  return (
    <span
      className={cn(
        'relative inline-flex shrink-0 items-center justify-center rounded-full',
        colorMap[color],
        s.box,
        active && 'ring-2 ring-violet ring-offset-2 ring-offset-bg',
        className,
      )}
      aria-hidden
    >
      <Icon size={s.icon} strokeWidth={2} />
      {status === 'done' && (
        <span className="absolute -bottom-0.5 -right-0.5 flex h-3.5 w-3.5 items-center justify-center rounded-full bg-teal text-midnight ring-2 ring-panel">
          <Check size={9} strokeWidth={3} />
        </span>
      )}
    </span>
  )
}
