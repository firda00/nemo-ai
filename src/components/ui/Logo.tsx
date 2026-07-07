import { cn } from '../../lib/cn'

interface LogoProps {
  className?: string
  size?: number
  showWordmark?: boolean
  tone?: 'light' | 'dark'
}

export function Logo({ className, size = 30, showWordmark = true }: LogoProps) {
  return (
    <span className={cn('inline-flex items-center gap-2.5 select-none', className)}>
      <svg width={size} height={size} viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden>
        <defs>
          <linearGradient id="nemoMark" x1="6" y1="5" x2="27" y2="27" gradientUnits="userSpaceOnUse">
            <stop stopColor="#38BDF8" />
            <stop offset="0.55" stopColor="#6D7CFF" />
            <stop offset="1" stopColor="#22C55E" />
          </linearGradient>
          <filter id="nemoShadow" x="0" y="0" width="32" height="32" colorInterpolationFilters="sRGB">
            <feDropShadow dx="0" dy="8" stdDeviation="6" floodColor="#020617" floodOpacity="0.38" />
          </filter>
        </defs>
        <g filter="url(#nemoShadow)">
          <circle cx="16" cy="16" r="14.5" fill="#070B1A" stroke="#22304A" />
          <path d="M9.2 9.5C11.1 7.9 13.5 7 16.1 7c2.3 0 4.5.7 6.2 2" stroke="#34445F" strokeWidth="1.2" strokeLinecap="round" />
          <path d="M22.8 22.5c-1.9 1.6-4.3 2.5-6.9 2.5-2.3 0-4.5-.7-6.2-2" stroke="#34445F" strokeWidth="1.2" strokeLinecap="round" />
          <path d="M10.2 11.2h11.4L10.2 21h11.6" stroke="url(#nemoMark)" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" />
          <circle cx="8.2" cy="8.3" r="2.4" fill="#38BDF8" stroke="#DFF7FF" strokeWidth="0.7" />
          <circle cx="23.9" cy="9.7" r="1.6" fill="#6D7CFF" stroke="#DDE5FF" strokeWidth="0.55" />
          <circle cx="23.5" cy="24.1" r="2.6" fill="#22C55E" stroke="#DDFBE8" strokeWidth="0.7" />
        </g>
      </svg>
      {showWordmark && (
        <span className="font-sans text-[19px] font-extrabold leading-none tracking-[-0.03em] text-text">
          Nemo <span className="bg-gradient-to-r from-cyan to-blue bg-clip-text text-transparent">AI</span>
        </span>
      )}
    </span>
  )
}
