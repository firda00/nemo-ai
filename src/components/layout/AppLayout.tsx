import { useEffect, useState } from 'react'
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom'
import {
  LayoutDashboard,
  Bot,
  Telescope,
  MessagesSquare,
  BookOpen,
  Plug,
  ClipboardList,
  LayoutTemplate,
  BarChart3,
  CreditCard,
  Settings as SettingsIcon,
  ShieldCheck,
  Coins,
  Menu,
  X,
  LogOut,
  ChevronDown,
} from 'lucide-react'
import { useI18n } from '../../i18n'
import { useAuth } from '../../context/AuthContext'
import { useAgentStore } from '../../store/useAgentStore'
import { Logo } from '../ui/Logo'
import { LanguageToggle } from '../ui/LanguageToggle'
import { Button } from '../ui/Button'
import { cn } from '../../lib/cn'

export function AppLayout() {
  const { t } = useI18n()
  const { user, logout } = useAuth()
  const navigate = useNavigate()
  const location = useLocation()
  const hydrate = useAgentStore((s) => s.hydrate)
  const tokenBalance = useAgentStore((s) => s.tokenBalance)
  const isAdmin = useAgentStore((s) => s.isAdmin)
  const [open, setOpen] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)

  // load agents from the live backend (no-op in demo mode)
  useEffect(() => {
    hydrate()
  }, [hydrate])

  const nav: { to: string; label: string; icon: typeof LayoutDashboard; end?: boolean; soon?: boolean }[] = [
    { to: '/app', label: t('platform.nav.dashboard'), icon: LayoutDashboard, end: true },
    { to: '/app/agents', label: t('platform.nav.agents'), icon: Bot },
    { to: '/app/research', label: t('platform.nav.research'), icon: Telescope },
    { to: '/app/dialogues', label: t('platform.nav.dialogues'), icon: MessagesSquare },
    { to: '/app/knowledge', label: t('platform.nav.knowledge'), icon: BookOpen },
    { to: '/app/integrations', label: t('platform.nav.integrations'), icon: Plug },
    { to: '/app/lead-forms', label: t('platform.nav.leadForms'), icon: ClipboardList },
    { to: '/app/templates', label: t('platform.nav.templates'), icon: LayoutTemplate },
    { to: '/app/analytics', label: t('platform.nav.analytics'), icon: BarChart3 },
    { to: '/app/billing', label: t('platform.nav.billing'), icon: CreditCard },
    { to: '/app/settings', label: t('platform.nav.settings'), icon: SettingsIcon },
    ...(isAdmin ? [{ to: '/app/admin', label: t('platform.nav.admin'), icon: ShieldCheck }] : []),
  ]

  const current = nav
    .filter((n) => (n.end ? location.pathname === n.to : location.pathname.startsWith(n.to)))
    .sort((a, b) => b.to.length - a.to.length)[0]

  const handleLogout = () => {
    logout()
    navigate('/')
  }

  const SidebarBody = (
    <div className="flex h-full flex-col border-r border-white/[0.07] bg-panel">
      <div className="flex h-16 items-center justify-between px-5">
        <Link to="/" onClick={() => setOpen(false)}>
          <Logo />
        </Link>
        <button onClick={() => setOpen(false)} className="rounded-full p-1.5 text-muted hover:bg-white/5 lg:hidden">
          <X size={20} />
        </button>
      </div>
      <nav className="flex-1 space-y-1 overflow-y-auto px-3 py-4">
        {nav.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.end}
            onClick={() => setOpen(false)}
            className={({ isActive }) =>
              cn(
                'flex items-center gap-3 rounded-xl px-3.5 py-2.5 text-sm font-medium transition-colors',
                isActive ? 'bg-brand text-white shadow-btn' : 'text-muted hover:bg-white/5 hover:text-text',
              )
            }
          >
            <item.icon size={18} />
            <span className="flex-1">{item.label}</span>
            {item.soon && <span className="rounded-pill bg-infoblue px-1.5 py-0.5 text-[9px] font-medium text-midnight">{t('common.soon')}</span>}
          </NavLink>
        ))}
      </nav>
      <div className="border-t border-white/[0.07] p-3">
        <Button to="/onboarding" fullWidth size="sm">
          {t('platform.agents.create')}
        </Button>
      </div>
    </div>
  )

  return (
    <div className="flex min-h-screen bg-bg">
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-60 lg:block">{SidebarBody}</aside>

      {open && (
        <div className="fixed inset-0 z-40 lg:hidden">
          <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={() => setOpen(false)} />
          <div className="absolute inset-y-0 left-0 w-64 animate-fadeIn">{SidebarBody}</div>
        </div>
      )}

      <div className="flex min-w-0 flex-1 flex-col lg:pl-60">
        <header className="sticky top-0 z-20 flex h-16 items-center justify-between gap-3 border-b border-white/[0.07] bg-bg/80 px-4 backdrop-blur sm:px-6">
          <div className="flex items-center gap-3">
            <button onClick={() => setOpen(true)} className="rounded-full p-2 text-muted hover:bg-white/5 lg:hidden" aria-label={t('common.menu')}>
              <Menu size={22} />
            </button>
            <h1 className="text-xl font-semibold tracking-tight text-text">{current?.label ?? 'Nemo AI'}</h1>
          </div>

          <div className="flex items-center gap-2 sm:gap-3">
            <Link to="/app/billing" className="hidden items-center gap-2 rounded-pill border border-white/10 bg-white/5 px-3.5 py-1.5 text-sm hover:bg-white/10 sm:flex">
              <Coins size={14} className="text-cyan" />
              <span className="font-medium text-text">{tokenBalance.toLocaleString()}</span>
              <span className="text-xs text-muted">{t('platform.topbar.tokens')}</span>
            </Link>
            <LanguageToggle />
            <div className="relative">
              <button onClick={() => setMenuOpen((v) => !v)} className="flex items-center gap-1.5 rounded-pill p-0.5 pr-1.5 hover:bg-white/5">
                <span className="flex h-8 w-8 items-center justify-center rounded-full bg-brand text-sm font-medium text-white">
                  {user?.name?.charAt(0).toUpperCase() ?? 'U'}
                </span>
                <ChevronDown size={15} className="text-muted" />
              </button>
              {menuOpen && (
                <>
                  <div className="fixed inset-0 z-10" onClick={() => setMenuOpen(false)} />
                  <div className="card absolute right-0 z-20 mt-2 w-56 p-1.5 animate-fadeIn">
                    <div className="px-3 py-2">
                      <p className="truncate text-sm font-medium text-text">{user?.name}</p>
                      <p className="truncate text-xs text-muted">{user?.email}</p>
                    </div>
                    <Link to="/app/settings" onClick={() => setMenuOpen(false)} className="block rounded-xl px-3 py-2 text-sm text-muted hover:bg-white/5 hover:text-text">
                      {t('platform.nav.settings')}
                    </Link>
                    <button onClick={handleLogout} className="flex w-full items-center gap-2 rounded-xl px-3 py-2 text-sm text-muted hover:bg-white/5 hover:text-text">
                      <LogOut size={15} /> {t('nav.logout')}
                    </button>
                  </div>
                </>
              )}
            </div>
          </div>
        </header>

        <main className="relative flex-1">
          <div className="pointer-events-none absolute inset-x-0 top-0 h-72 bg-brand-radial opacity-50" />
          <div className="relative">
            <Outlet />
          </div>
        </main>
      </div>
    </div>
  )
}
