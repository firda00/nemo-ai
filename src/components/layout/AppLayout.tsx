import { useEffect, useState, type MouseEvent as ReactMouseEvent, type CSSProperties } from 'react'
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom'
import {
  LayoutDashboard,
  Bot,
  Users,
  Wand2,
  PenLine,
  Building2,
  Send,
  BarChart3,
  Archive,
  Blocks,
  CreditCard,
  ClipboardList,
  Repeat,
  Activity,
  Workflow,
  Wrench,
  Settings as SettingsIcon,
  Menu,
  X,
  LogOut,
  ChevronDown,
  PanelLeftClose,
  PanelLeftOpen,
  MessageSquare,
  UserRoundSearch,
  Mail,
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
  const { user, logout, live, isAuthed } = useAuth()
  const accountId = useAgentStore((s) => s.accountId)
  const isAdmin = useAgentStore((s) => s.isAdmin)
  const navigate = useNavigate()
  const location = useLocation()
  const hydrate = useAgentStore((s) => s.hydrate)
  const [open, setOpen] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const [emailEnabled, setEmailEnabled] = useState(true)
  const [feedbackEnabled, setFeedbackEnabled] = useState(true)
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
    if (isAuthed) void trackEvent('page_view')
  }, [location.pathname, isAuthed])

  useEffect(() => {
    if (!isAuthed) return
    void featureEnabled('email_assistant', user?.id).then(setEmailEnabled)
    void featureEnabled('feedback_agent', user?.id).then(setFeedbackEnabled)
  }, [isAuthed, user?.id])

  // Grouped nav — a few labeled sections instead of one long flat list, so the
  // sidebar is scannable (fixes the "too complex" feeling).
  type NavItem = { to: string; label: string; icon: typeof LayoutDashboard; end?: boolean; badge?: string }
  const navGroups: { title: string; items: NavItem[] }[] = [
    { title: t('appLayout.groupMain'), items: [
      { to: '/app', label: t('appLayout.navOverview'), icon: LayoutDashboard, end: true },
      { to: '/app/content', label: t('appLayout.navContent'), icon: PenLine },
      { to: '/app/autopost', label: t('appLayout.navAutopost'), icon: Send },
      { to: '/app/followups', label: t('appLayout.navFollowups'), icon: Repeat },
    ] },
    { title: t('appLayout.groupAiTeams'), items: [
      { to: '/app/company-brain', label: t('appLayout.navCompanyBrain'), icon: Building2 },
      { to: '/app/autonomous', label: t('appLayout.navAutonomous'), icon: Wand2 },
      { to: '/app/automations', label: t('appLayout.navAutomations'), icon: Workflow, badge: t('automations.devBadge') },
      { to: '/app/agents', label: t('mvp.sidebar.agents'), icon: Bot },
      { to: '/app/teams', label: t('mvp.sidebar.aiTeams'), icon: Users },
      { to: '/app/integrations', label: t('appLayout.navTools'), icon: Blocks },
      { to: '/app/tools', label: t('appLayout.navToolsHub'), icon: Wrench },
      { to: '/app/templates', label: t('mvp.sidebar.templates'), icon: ClipboardList },
    ] },
    { title: t('appLayout.groupResults'), items: [
      // Monitoring (system/site health) is an admin-only view.
      ...(isAdmin ? [{ to: '/app/monitor', label: t('appLayout.navMonitor'), icon: Activity }] : []),
      { to: '/app/dialogues', label: t('platform.nav.dialogues'), icon: MessageSquare },
      ...(emailEnabled ? [{ to: '/app/email-assistant', label: 'Email Assistant', icon: Mail }] : []),
      { to: '/app/lead-forms', label: t('platform.nav.leadForms'), icon: UserRoundSearch },
      { to: '/app/analytics', label: t('platform.nav.analytics'), icon: BarChart3 },
      { to: '/app/activity', label: t('appLayout.navActivity'), icon: BarChart3 },
      { to: '/app/library', label: t('appLayout.navLibrary'), icon: Archive },
      { to: '/app/results', label: t('mvp.sidebar.results'), icon: ClipboardList },
    ] },
    { title: t('appLayout.groupAccount'), items: [
      { to: '/app/billing', label: t('appLayout.navBilling'), icon: CreditCard },
      { to: '/app/settings', label: t('mvp.sidebar.settings'), icon: SettingsIcon },
    ] },
  ]
  const nav = navGroups.flatMap((g) => g.items)

  // Header title: fall back to the create pages' own headings when not in nav.
  const titleFallback: Record<string, string> = {
    '/app/create-agent': t('mvp.sidebar.createAgent'),
    '/app/create-team': t('mvp.sidebar.createTeam'),
  }
  const current = nav
    .filter((n) => (n.end ? location.pathname === n.to : location.pathname.startsWith(n.to)))
    .sort((a, b) => b.to.length - a.to.length)[0] ?? (titleFallback[location.pathname] ? { label: titleFallback[location.pathname] } : undefined)

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
                    'flex items-center gap-3 rounded-xl px-3 py-2 text-sm font-medium transition-colors',
                    isActive ? 'bg-brand text-white shadow-btn' : 'text-muted hover:bg-white/5 hover:text-text',
                  )
                }
              >
                <item.icon size={17} />
                <span className="flex-1">{item.label}</span>
                {item.badge && <span className="rounded-full border border-amber/30 bg-amber/10 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-amber">{item.badge}</span>}
              </NavLink>
            ))}
          </div>
        ))}
      </nav>
      <div className="border-t border-white/[0.07] p-3">
        <Button to="/app/create-team" fullWidth size="sm">
          {t('mvp.sidebar.createTeam')}
        </Button>
      </div>
    </div>
  )

  return (
    <div className="flex min-h-screen bg-bg" style={{ '--sb': collapsed ? '0px' : `${width}px` } as CSSProperties}>
      <aside className={cn('fixed inset-y-0 left-0 z-30', collapsed ? 'hidden' : 'hidden lg:block')} style={{ width }}>
        {SidebarBody}
        {/* drag handle to resize the sidebar */}
        <div
          onMouseDown={startDrag}
          className="group absolute inset-y-0 -right-1 z-40 hidden w-2 cursor-col-resize lg:block"
          title={t('appLayout.resizeSidebar')}
          role="separator"
          aria-orientation="vertical"
        >
          <div className="mx-auto h-full w-px bg-transparent transition-colors group-hover:bg-violet/50" />
        </div>
      </aside>

      {open && (
        <div className="fixed inset-0 z-40 lg:hidden">
          <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={() => setOpen(false)} />
          <div className="absolute inset-y-0 left-0 w-64 animate-fadeIn">{SidebarBody}</div>
        </div>
      )}

      <div className={cn('flex min-w-0 flex-1 flex-col', !collapsed && 'lg:pl-[var(--sb)]')}>
        <header className="sticky top-0 z-20 flex h-16 items-center justify-between gap-3 border-b border-white/[0.07] bg-bg/80 px-4 backdrop-blur sm:px-6">
          <div className="flex items-center gap-3">
            <button onClick={() => setOpen(true)} className="rounded-full p-2 text-muted hover:bg-white/5 lg:hidden" aria-label={t('common.menu')}>
              <Menu size={22} />
            </button>
            {collapsed && (
              <button onClick={toggleCollapse} className="hidden rounded-full p-2 text-muted hover:bg-white/5 hover:text-text lg:inline-flex" aria-label={t('appLayout.showSidebar')} title={t('appLayout.showSidebar')}>
                <PanelLeftOpen size={22} />
              </button>
            )}
            <h1 className="text-xl font-semibold tracking-tight text-text">{current?.label ?? 'Nemo AI'}</h1>
            <span className={cn('hidden rounded-pill border px-2.5 py-1 text-[11px] font-medium sm:inline-flex', live && isAuthed && accountId !== 'demo' ? 'border-teal/20 bg-teal/10 text-teal' : 'border-amber/25 bg-amber/10 text-amber')}>
              {live && isAuthed && accountId !== 'demo' ? 'Live workspace' : 'Demo mode · local simulation'}
            </span>
          </div>

          <div className="flex items-center gap-2 sm:gap-3">
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
        {isAuthed && feedbackEnabled && <FeedbackWidget />}
      </div>
    </div>
  )
}
