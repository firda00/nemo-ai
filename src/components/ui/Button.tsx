import type { ButtonHTMLAttributes, ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { cn } from '../../lib/cn'

type Variant = 'primary' | 'secondary' | 'ghost' | 'outline' | 'danger' | 'success' | 'subtle'
type Size = 'sm' | 'md' | 'lg' | 'icon'

const variants: Record<Variant, string> = {
  // Brand Identity 2026.1 flow gradient: cyan where the action starts, indigo where it lands.
  primary: 'bg-gradient-to-r from-accent-cyan to-accent-indigo text-white font-medium shadow-sm hover:opacity-90 active:opacity-100',
  secondary: 'bg-white/5 text-text border border-white/10 hover:bg-white/10 hover:border-white/20 active:bg-white/5',
  ghost: 'text-muted hover:text-text hover:bg-white/5 active:bg-white/5',
  outline: 'border border-white/15 bg-transparent text-text hover:bg-white/5 hover:border-white/30 active:bg-white/5',
  subtle: 'border border-white/10 bg-white/[0.03] text-text hover:bg-white/[0.06] hover:border-white/20 active:bg-white/5',
  danger: 'bg-danger/10 text-danger border border-danger/20 hover:bg-danger/20 hover:border-danger/30 active:bg-danger/15',
  success: 'bg-teal/10 text-teal border border-teal/20 hover:bg-teal/20 hover:border-teal/30 active:bg-teal/15',
}

const sizes: Record<Size, string> = {
  sm: 'px-3 py-1.5 text-[12px] gap-1.5',
  md: 'px-4 py-2 text-sm gap-2',
  lg: 'px-6 py-3 text-base gap-2.5',
  icon: 'p-2',
}

interface BaseProps {
  variant?: Variant
  size?: Size
  fullWidth?: boolean
  children: ReactNode
  className?: string
  leftIcon?: ReactNode
  rightIcon?: ReactNode
  loading?: boolean
  disabled?: boolean
}

type ButtonProps = BaseProps &
  ButtonHTMLAttributes<HTMLButtonElement> & { to?: undefined; href?: undefined }
type LinkProps = BaseProps & { to: string; href?: undefined }
type AnchorProps = BaseProps & { href: string; to?: undefined }

type AllButtonProps = ButtonProps | LinkProps | AnchorProps

export function Button(props: AllButtonProps) {
  const { 
    variant = 'primary', 
    size = 'md', 
    fullWidth, 
    className, 
    children, 
    leftIcon, 
    rightIcon, 
    loading,
    disabled = false,
    ...rest 
  } = props

  const classes = cn(
    'btn inline-flex items-center justify-center font-medium transition-all duration-200 ease-out',
    'rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet/50 focus-visible:ring-offset-2 focus-visible:ring-offset-bg',
    'disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:brightness-100',
    variants[variant], 
    sizes[size], 
    fullWidth && 'w-full', 
    className
  )

  const isLink = 'to' in props && props.to !== undefined
  const isAnchor = 'href' in props && props.href !== undefined

  const content = (
    <>
      {loading ? (
        <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24">
          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" fill="none" />
          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
        </svg>
      ) : (
        <>
          {leftIcon && <span className="flex-shrink-0">{leftIcon}</span>}
          {children}
          {rightIcon && <span className="flex-shrink-0">{rightIcon}</span>}
        </>
      )}
    </>
  )

  if (isLink) {
    return <Link to={(props as LinkProps).to} className={classes} aria-disabled={disabled}>{content}</Link>
  }
  if (isAnchor) {
    return <a href={(props as AnchorProps).href} className={classes} aria-disabled={disabled}>{content}</a>
  }
  return <button className={classes} disabled={disabled || loading} {...(rest as ButtonHTMLAttributes<HTMLButtonElement>)}>{content}</button>
}