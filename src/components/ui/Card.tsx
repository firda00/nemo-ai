import type { ReactNode } from 'react'
import { cn } from '../../lib/cn'

type CardVariant = 'default' | 'elevated' | 'outlined' | 'glass' | 'gradient'
type CardPadding = 'none' | 'sm' | 'md' | 'lg'

const variants: Record<CardVariant, string> = {
  default: 'bg-panel border border-border',
  elevated: 'bg-panel shadow-xl shadow-black/30 border border-border/50',
  outlined: 'bg-transparent border border-white/10',
  glass: 'bg-white/5 backdrop-blur-xl border border-white/10',
  gradient: 'bg-gradient-to-br from-violet/10 to-cyan/10 border border-violet/20',
}

const paddings: Record<CardPadding, string> = {
  none: '',
  sm: 'p-4',
  md: 'p-6',
  lg: 'p-8',
}

interface CardProps {
  children: ReactNode
  className?: string
  variant?: CardVariant
  padding?: CardPadding
  hover?: boolean
  onClick?: () => void
}

export function Card({ children, className, variant = 'default', padding = 'md', hover = false, onClick }: CardProps) {
  const classes = cn(
    // `lift` replaces `transition-all`: the old rule animated every changed property,
    // including layout ones, so a hovered card could nudge its neighbours.
    'lift rounded-2xl',
    variants[variant],
    paddings[padding],
    hover && 'cursor-pointer hover:border-accent-cyan/40 hover:shadow-[0_10px_30px_-12px_rgba(6,182,212,0.25)]',
    onClick && 'cursor-pointer active:scale-[0.98]',
    className
  )

  return (
    <div className={classes} onClick={onClick}>
      {children}
    </div>
  )
}

export function CardHeader({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn('mb-4', className)}>{children}</div>
}

export function CardTitle({ children, className }: { children: ReactNode; className?: string }) {
  return <h3 className={cn('text-lg font-semibold text-text tracking-tight', className)}>{children}</h3>
}

export function CardDescription({ children, className }: { children: ReactNode; className?: string }) {
  return <p className={cn('text-sm text-muted mt-1', className)}>{children}</p>
}

export function CardContent({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn('', className)}>{children}</div>
}

export function CardFooter({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn('mt-4 pt-4 border-t border-border flex items-center gap-2', className)}>{children}</div>
}