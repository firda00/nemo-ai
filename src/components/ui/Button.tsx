import type { ButtonHTMLAttributes, ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { cn } from '../../lib/cn'

type Variant = 'primary' | 'ghost' | 'subtle' | 'outline' | 'danger'
type Size = 'sm' | 'md' | 'lg'

// Buttons (radius 12). Primary = brand gradient with violet glow (spec §3).
const variants: Record<Variant, string> = {
  primary: 'bg-brand text-white shadow-btn hover:brightness-110',
  ghost: 'text-text hover:bg-white/5',
  outline: 'border border-white/15 bg-white/5 text-text hover:bg-white/10',
  subtle: 'border border-white/10 bg-white/[0.03] text-text hover:bg-white/[0.06]',
  danger: 'border border-danger/40 bg-danger/10 text-danger hover:bg-danger/20',
}

const sizes: Record<Size, string> = {
  sm: 'px-4 py-2 text-[13px]',
  md: 'px-5 py-2.5 text-sm',
  lg: 'px-6 py-3 text-[15px]',
}

interface BaseProps {
  variant?: Variant
  size?: Size
  fullWidth?: boolean
  children: ReactNode
  className?: string
}

type ButtonProps = BaseProps &
  ButtonHTMLAttributes<HTMLButtonElement> & { to?: undefined; href?: undefined }
type LinkProps = BaseProps & { to: string; href?: undefined }
type AnchorProps = BaseProps & { href: string; to?: undefined }

export function Button(props: ButtonProps | LinkProps | AnchorProps) {
  const { variant = 'primary', size = 'md', fullWidth, className, children, ...rest } = props
  const classes = cn('btn', variants[variant], sizes[size], fullWidth && 'w-full', className)

  if ('to' in props && props.to !== undefined) {
    return (
      <Link to={(props as LinkProps).to} className={classes}>
        {children}
      </Link>
    )
  }
  if ('href' in props && props.href !== undefined) {
    return (
      <a href={(props as AnchorProps).href} className={classes}>
        {children}
      </a>
    )
  }
  return (
    <button className={classes} {...(rest as ButtonHTMLAttributes<HTMLButtonElement>)}>
      {children}
    </button>
  )
}
