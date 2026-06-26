import { cn } from '../../lib/cn'

interface LogoProps {
  className?: string
  size?: number
  showWordmark?: boolean
  tone?: 'light' | 'dark'
}

/**
 * Nemo mark — a glowing concentric "moon/AI" orb in the brand gradient,
 * paired with an Inter wordmark, "AI" lit in violet (spec §3).
 */
export function Logo({ className, size = 30, showWordmark = true }: LogoProps) {
  return (
    <span className={cn('inline-flex items-center gap-2.5 select-none', className)}>
      <svg width={size} height={size} viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden>
        <defs>
          <linearGradient id="nemoMark" x1="2" y1="2" x2="30" y2="30" gradientUnits="userSpaceOnUse">
            <stop stopColor="#8B7CF8" />
            <stop offset="0.5" stopColor="#5B7CF6" />
            <stop offset="1" stopColor="#22D3EE" />
          </linearGradient>
        </defs>
        <circle cx="16" cy="16" r="15" fill="url(#nemoMark)" />
        <circle cx="16" cy="16" r="9" fill="#10162E" />
        <circle cx="16" cy="16" r="3.5" fill="url(#nemoMark)" />
      </svg>
      {showWordmark && (
        <span className="font-sans text-[19px] font-bold leading-none tracking-tight text-text">
          Nemo<span className="text-violet"> AI</span>
        </span>
      )}
    </span>
  )
}
