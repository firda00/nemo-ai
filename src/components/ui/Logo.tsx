import { cn } from '../../lib/cn'

interface LogoProps {
  className?: string
  size?: number
  showWordmark?: boolean
  tone?: 'light' | 'dark'
  variant?: 'flow' | 'neon'
}

// Product-shell mark: the glass inset keeps the small N legible while the outer gradient
// carries the brand colour. The photographic neon logo stays reserved for large marketing
// placements; navigation needs a compact vector that remains crisp at 24–40 px.
export function Logo({ className, size = 30, showWordmark = true, variant = 'flow' }: LogoProps) {
  if (variant === 'neon') {
    return (
      <span className={cn('inline-flex items-center gap-3 select-none', className)}>
        <span
          className="relative shrink-0 overflow-hidden rounded-[28%] border border-[#48ecf4]/25 bg-[#090c19] shadow-[0_0_24px_rgba(72,236,244,0.14)]"
          style={{ width: size, height: size }}
        >
          <img
            src="/brand/nemo-logo-neon.jpeg"
            alt=""
            aria-hidden="true"
            className="absolute left-1/2 top-1/2 max-w-none"
            style={{ width: '160%', transform: 'translate(-50%, -43%)' }}
          />
        </span>
        {showWordmark && (
          <span className="font-brand text-[18px] font-light leading-none tracking-[0.18em] text-[#e8fbff]">
            NEMO
          </span>
        )}
      </span>
    )
  }

  return (
    <span className={cn('inline-flex select-none items-center gap-2.5', className)}>
      <span
        className="relative inline-flex shrink-0 items-center justify-center rounded-[30%] bg-flow-gradient p-px shadow-[0_8px_24px_-10px_rgba(79,70,229,0.7)] transition-transform duration-200 ease-out group-hover:-translate-y-px"
        style={{ width: size, height: size }}
      >
        <span className="absolute inset-[1px] rounded-[29%] bg-panel/90 shadow-[inset_0_1px_0_rgba(255,255,255,0.14)] backdrop-blur-md" />
        <svg className="relative h-[56%] w-[56%] text-accent-indigo" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden>
          <path d="M5.25 18.75V5.25L18.75 18.75V5.25" stroke="currentColor" strokeWidth="2.8" strokeLinecap="round" strokeLinejoin="round" />
          <circle cx="5.25" cy="5.25" r="1.35" className="fill-accent-cyan" />
          <circle cx="18.75" cy="18.75" r="1.35" className="fill-accent-indigo" />
        </svg>
      </span>
      {showWordmark && (
        <span className="inline-flex items-center gap-1.5">
          <span className="font-brand text-[19px] font-extrabold leading-none tracking-[-0.045em] text-text">Nemo</span>
          <span className="rounded-md border border-accent-indigo/20 bg-accent-indigo/[0.08] px-1.5 py-0.5 text-[9px] font-extrabold uppercase leading-none tracking-[0.12em] text-accent-indigo shadow-[inset_0_1px_0_rgba(255,255,255,0.08)]">
            AI
          </span>
        </span>
      )}
    </span>
  )
}
