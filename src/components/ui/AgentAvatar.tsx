import { Search, PenLine, BarChart3, CheckCircle, Plug, Check } from 'lucide-react'
import { cn } from '../../lib/cn'
import type { AgentColor, AgentGlyph, AgentRuntimeStatus } from '../../types'

// Round role-color avatars — tinted glass on dark (spec §3 Avatar).
const colorMap: Record<AgentColor, string> = {
  violet: 'bg-violet/20 text-violet',
  blue: 'bg-blue/20 text-blue',
  cyan: 'bg-cyan/20 text-cyan',
  teal: 'bg-teal/20 text-teal',
  amber: 'bg-amber/20 text-amber',
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
        active && 'ring-2 ring-indigo ring-offset-2 ring-offset-cream',
        className,
      )}
      aria-hidden
    >
      <Icon size={s.icon} strokeWidth={2} />
      {status === 'done' && (
        <span className="absolute -bottom-0.5 -right-0.5 flex h-3.5 w-3.5 items-center justify-center rounded-full bg-forest text-white ring-2 ring-cream">
          <Check size={9} strokeWidth={3} />
        </span>
      )}
    </span>
  )
}
