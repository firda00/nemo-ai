import { cn } from '../../lib/cn'

interface LogoProps {
  className?: string
  size?: number
  showWordmark?: boolean
  tone?: 'light' | 'dark'
}

// Brand Identity 2026.1. Two stems hold position, the 45° diagonal carries work between
// them in the direction it flows — cyan where a task starts, indigo where it lands. The
// round stroke caps read as the nodes, so the mark survives at 16px with nothing added.
// Flat by contract: the previous mark's drop shadow is gone and does not come back.
export function Logo({ className, size = 30, showWordmark = true }: LogoProps) {
  return (
    <span className={cn('inline-flex items-center gap-2.5 select-none', className)}>
      <svg width={size} height={size} viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden>
        <defs>
          <linearGradient id="nemoFlow" x1="13" y1="13" x2="35" y2="35" gradientUnits="userSpaceOnUse">
            <stop stopColor="#06B6D4" />
            <stop offset="1" stopColor="#6366F1" />
          </linearGradient>
        </defs>
        <path d="M13 35V13M35 35V13" stroke="#6366F1" strokeWidth="5" strokeLinecap="round" />
        <path d="M13 13L35 35" stroke="url(#nemoFlow)" strokeWidth="5" strokeLinecap="round" />
      </svg>
      {showWordmark && (
        <span className="font-sans text-[19px] font-bold leading-none tracking-[-0.032em] text-text">
          Nemo <span className="bg-gradient-to-br from-accent-cyan to-accent-indigo bg-clip-text text-transparent">AI</span>
        </span>
      )}
    </span>
  )
}
