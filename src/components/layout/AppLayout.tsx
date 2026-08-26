import { useEffect, useState, type MouseEvent as ReactMouseEvent, type CSSProperties } from 'react'
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom'
import {
  LayoutDashboard,
  Users,
  Settings as SettingsIcon,
  ShieldCheck,
  Menu,
  X,
  LogOut,
  ChevronDown,
  PanelLeftClose,
  PanelLeftOpen,
  Brain,
  MessageSquare,
  LineChart,
  Megaphone,
  Sparkles,
} from 'lucide-react'
import { useI18n } from '../../i18n'
import { useAuth } from '../../context/AuthContext'
import { useAgentStore } from '../../store/useAgentStore'
import { Logo } from '../ui/Logo'
import { LanguageToggle } from '../ui/LanguageToggle'
import { Button } from '../ui/Button'
import { cn } from '../../lib/cn'
import { FeedbackWidget } from '../platform/FeedbackWidget'
import { featureEnabled, trackEvent } from '../../lib/telemetry'

export function AppLayout() {
  const { t } = useI18n()
  const { user, logout, isAuthed } = useAuth()
  const isAdmin = useAgentStore((s) => s.isAdmin)
  const navigate = useNavigate()
  const location = useLocation()
  const hydrate = useAgentStore((s) => s.hydrate)
  const [open, setOpen] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const [feedbackEnabled, setFeedbackEnabled] = useState(true)
  const [online, setOnline] = useState(() => typeof navigator === 'undefined' ? true : navigator.onLine)
  // desktop sidebar collapse (hide) — persisted so it stays the user's choice
  const [collapsed, setCollapsed] = useState(() => {
    try { return localStorage.getItem('nemo.sidebar') === 'collapsed' } catch { return false }
  })
  const toggleCollapse = () =>
    setCollapsed((v) => {
      const next = !v
      try { localStorage.setItem('nemo.sidebar', next ? 'collapsed' : 'open') } catch { /* ignore */ }
      return next
    })
  // desktop sidebar width — drag the right edge to resize; persisted, clamped 200–380px
  const [width, setWidth] = useState(() => {
    try { const v = Number(localStorage.getItem('nemo.sidebar.w')); return v >= 200 && v <= 380 ? v : 240 } catch { return 240 }
  })
  const startDrag = (e: ReactMouseEvent) => {
    e.preventDefault()
    let last = width
    const onMove = (ev: MouseEvent) => { last = Math.min(380, Math.max(200, ev.clientX)); setWidth(last) }
    const onUp = () => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
      document.body.style.userSelect = ''
      try { localStorage.setItem('nemo.sidebar.w', String(last)) } catch { /* ignore */ }
    }
    document.body.style.userSelect = 'none'
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }

  // load agents from the live backend (no-op in demo mode)
  useEffect(() => {
    hydrate()
  }, [hydrate])

  useEffect(() => {
    const onOnline = () => setOnline(true)
    const onOffline = () => setOnline(false)
    window.addEventListener('online', onOnline)
    window.addEventListener('offline', onOffline)
    return () => {
      window.removeEventListener('online', onOnline)
      window.removeEventListener('offline', onOffline)
    }
  }, [])

  useEffect(() => {
    if (isAuthed) void trackEvent('page_view')
  }, [location.pathname, isAuthed])

  useEffect(() => {
    if (!isAuthed) return
    void featureEnabled('feedback_agent', user?.id).then(setFeedbackEnabled)
  }, [isAuthed, user?.id])

  // The sidebar is a map, not a feature inventory. Deep links remain routable while the
  // seven daily destinations stay visible here.
  type NavItem = { to: string; label: string; icon: typeof LayoutDashboard; end?: boolean; badge?: string }
  const navGroups: { title: string; items: NavItem[] }[] = [
    { title: t('appLayout.groupMain'), items: [
      { to: '/app', label: t('appLayout.navOverview'), icon: LayoutDashboard, end: true },
      { to: '/app/dialogues', label: t('appLayout.navDialogues'), icon: MessageSquare },
      { to: '/app/teams', label: t('teamOffice.navTeams'), icon: Users },
      { to: '/app/content', label: t('teamOffice.navMarketing'), icon: Megaphone },
      { to: '/app/knowledge', label: t('teamOffice.navKnowledge'), icon: Brain },
      { to: '/app/analytics', label: t('appLayout.navAnalytics'), icon: LineChart },
      { to: '/app/settings', label: t('mvp.sidebar.settings'), icon: SettingsIcon },
    ] },
    ...(isAdmin ? [{ title: t('appLayout.groupAccount'), items: [{ to: '/app/admin', label: t('appLayout.navAdmin'), icon: ShieldCheck }] }] : []),
  ]
  const nav = navGroups.flatMap((g) => g.items)

  // Header title: fall back to the create pages' own headings when not in nav.
  const titleFallback: Record<string, string> = {
    '/app/create-agent': t('mvp.sidebar.createAgent'),
    '/app/create-team': t('mvp.sidebar.createTeam'),
    '/app/agents': t('mvp.sidebar.agents'),
    '/app/autonomous': t('appLayout.navAutonomous'),
    '/app/research': t('appLayout.navResearch'),
    '/app/automations': t('appLayout.navAutomations'),
    '/app/company-brain': t('appLayout.navCompanyBrain'),
    '/app/marketing': t('appLayout.navMarketing'),
    '/app/autopost': t('appLayout.navAutopost'),
    '/app/followups': t('appLayout.navFollowups'),
    '/app/lead-forms': t('teamOffice.marketingTabs.leads'),
    '/app/integrations': t('appLayout.navTools'),
    '/app/tools': t('appLayout.navToolsHub'),
    '/app/templates': t('mvp.sidebar.templates'),
    '/app/activity': t('appLayout.navActivity'),
    '/app/approvals': t('teamOffice.marketingTabs.approvals'),
    '/app/memory': t('appLayout.navMemory'),
    '/app/library': t('appLayout.navLibrary'),
    '/app/billing': t('appLayout.navBilling'),
  }
  const current = nav
    .filter((n) => (n.end ? location.pathname === n.to : location.pathname.startsWith(n.to)))
    .sort((a, b) => b.to.length - a.to.length)[0] ?? (titleFallback[location.pathname] ? { label: titleFallback[location.pathname] } : undefined)

  const handleLogout = () => {
    logout()
    navigate('/')
  }

  const SidebarBody = (
    <div className="flex h-full flex-col border-r border-ice/10 bg-bg">
      <div className="flex h-16 items-center justify-between px-5">
        <Link to="/" onClick={() => setOpen(false)}>
          <Logo />
        </Link>
        <button onClick={toggleCollapse} className="hidden rounded-full p-1.5 text-muted hover:bg-white/5 hover:text-text lg:inline-flex" aria-label={t('appLayout.hideSidebar')} title={t('appLayout.hideSidebar')}>
          <PanelLeftClose size={19} />
        </button>
        <button onClick={() => setOpen(false)} className="rounded-full p-1.5 text-muted hover:bg-white/5 lg:hidden">
          <X size={20} />
        </button>
      </div>
      <nav className="flex-1 space-y-4 overflow-y-auto px-3 py-4">
        {navGroups.map((group) => (
          <div key={group.title} className="space-y-1">
            <p className="px-3 pb-1 text-[10.5px] font-semibold uppercase tracking-[0.16em] text-fog">{group.title}</p>
            {group.items.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.end}
                onClick={() => setOpen(false)}
                className={({ isActive }) =>
                  cn(
                    // The active item is marked by a cyan rail and a raised surface rather than a
                    // filled block: at sidebar density a solid fill on every visit reads as noise.
                    'relative flex items-center gap-3 rounded-xl px-3 py-2 text-sm font-medium transition-colors',
                    'before:absolute before:left-0 before:top-1/2 before:h-5 before:w-0.5 before:-translate-y-1/2 before:rounded-full before:bg-accent-cyan before:opacity-0 before:transition-opacity',
                    isActive
                      ? 'bg-panel text-text before:opacity-100'
                      : 'text-muted hover:bg-panel/70 hover:text-text',
                  )
                }
              >
                {({ isActive }) => (
                  <>
                    <item.icon size={17} className={cn('transition-colors', isActive && 'text-accent-cyan')} />
                    <span className="flex-1">{item.label}</span>
                    {item.badge && <span className="rounded-full border border-amber/30 bg-amber/10 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-amber">{item.badge}</span>}
                  </>
                )}
              </NavLink>
            ))}
          </div>
        ))}
      </nav>
      <div className="border-t border-ice/10 p-3">
        <Button to="/app/create-team" fullWidth size="sm">
          <Sparkles size={15} className="shrink-0" />
          {t('mvp.sidebar.createTeam')}
        </Button>
      </div>
    </div>
  )

  return (
    <div className="flex min-h-screen bg-bg" style={{ '--sb': collapsed ? '64px' : `${width}px` } as CSSProperties}>
      <aside className="fixed inset-y-0 left-0 z-30 hidden border-r border-ice/10 bg-bg lg:block" style={{ width: collapsed ? 64 : width }}>
        {collapsed ? (
          <div className="flex h-full flex-col items-center py-3">
            <div className="flex h-14 w-full items-center justify-center gap-1 border-b border-ice/10 px-2">
              <Link to="/" className="rounded-xl p-1.5 transition hover:bg-white/5" aria-label="Nemo AI">
                <Logo showWordmark={false} size={30} />
              </Link>
              <button onClick={toggleCollapse} className="rounded-xl p-2 text-muted transition hover:bg-white/5 hover:text-text" aria-label={t('appLayout.showSidebar')} title={t('appLayout.showSidebar')}>
                <PanelLeftOpen size={17} />
              </button>
            </div>

            <nav className="flex w-full flex-1 flex-col items-center gap-1 overflow-y-auto px-2 py-4" aria-label={t('common.menu')}>
              {navGroups.flatMap((group) => group.items).map((item) => (
                <NavLink
                  key={item.to}
                  to={item.to}
                  end={item.end}
                  title={item.label}
                  aria-label={item.label}
                  className={({ isActive }) => cn(
                    'relative flex h-10 w-10 shrink-0 items-center justify-center rounded-xl text-muted transition-colors',
                    'before:absolute before:left-0 before:top-1/2 before:h-5 before:w-0.5 before:-translate-y-1/2 before:rounded-full before:bg-accent-cyan before:opacity-0',
                    isActive ? 'bg-panel text-accent-cyan before:opacity-100' : 'hover:bg-panel/70 hover:text-text',
                  )}
                >
                  <item.icon size={18} className="shrink-0" />
                </NavLink>
              ))}
            </nav>

            <div className="w-full border-t border-ice/10 px-2 pt-3">
              <Link
                to="/app/create-team"
                title={t('mvp.sidebar.createTeam')}
                aria-label={t('mvp.sidebar.createTeam')}
                className="mx-auto flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-r from-accent-cyan to-accent-indigo text-white shadow-sm transition hover:opacity-90 active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-cyan/60"
              >
                <Sparkles size={17} className="shrink-0" />
              </Link>
            </div>
          </div>
        ) : (
          <>
            {SidebarBody}
            <div
              onMouseDown={startDrag}
              className="group absolute inset-y-0 -right-1 z-40 hidden w-2 cursor-col-resize lg:block"
              title={t('appLayout.resizeSidebar')}
              role="separator"
              aria-orientation="vertical"
            >
              <div className="mx-auto h-full w-px bg-transparent transition-colors group-hover:bg-violet/50" />
            </div>
          </>
        )}
      </aside>

      {open && (
        <div className="fixed inset-0 z-40 lg:hidden">
          <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={() => setOpen(false)} />
          <div className="absolute inset-y-0 left-0 w-64 animate-fadeIn">{SidebarBody}</div>
        </div>
      )}

      <div className="flex min-w-0 flex-1 flex-col lg:pl-[var(--sb)]">
        {!online && (
          <div role="status" className="sticky top-0 z-50 border-b border-amber/30 bg-amber/15 px-4 py-2 text-center text-xs font-medium text-amber">
            {t('common.offline')}
          </div>
        )}
        <header className="sticky top-0 z-20 flex h-16 items-center justify-between gap-3 border-b border-ice/10 bg-bg/80 px-4 backdrop-blur sm:px-6">
          <div className="min-w-0 flex items-center gap-2 sm:gap-3">
            <button onClick={() => setOpen(true)} className="rounded-full p-2 text-muted hover:bg-white/5 lg:hidden" aria-label={t('common.menu')}>
              <Menu size={22} />
            </button>
            <h1 className="truncate text-base font-semibold tracking-tight text-text sm:text-xl">{current?.label ?? 'Nemo AI'}</h1>
          </div>

          <div className="flex items-center gap-2 sm:gap-3">
            <div className="hidden sm:block"><LanguageToggle /></div>
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
        {isAuthed && feedbackEnabled && <FeedbackWidget />}
      </div>
    </div>
  )
}
