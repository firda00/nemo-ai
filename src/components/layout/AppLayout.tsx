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
  Sparkles,
  Search,
  Command,
  ArrowUpRight,
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
import { isSupabaseEnabled, supabase } from '../../lib/supabase'
import { PLANS, planLabelKey } from '../../lib/plans'
import { extensionReachable, extensionState, linkExtension } from '../../lib/extensionLink'

export function AppLayout() {
  const { t } = useI18n()
  const { user, logout, isAuthed } = useAuth()
  const isAdmin = useAgentStore((s) => s.isAdmin)
  const navigate = useNavigate()
  const location = useLocation()
  const hydrate = useAgentStore((s) => s.hydrate)
  const activeAgentCount = useAgentStore((s) => s.agents.filter((agent) => agent.status === 'active').length)
  const [open, setOpen] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const [commandOpen, setCommandOpen] = useState(false)
  const [commandQuery, setCommandQuery] = useState('')
  const [feedbackEnabled, setFeedbackEnabled] = useState(true)
  const [online, setOnline] = useState(() => typeof navigator === 'undefined' ? true : navigator.onLine)
  const [workspacePlan, setWorkspacePlan] = useState('free')
  useEffect(() => {
    if (!isSupabaseEnabled || !supabase || !isAuthed) return
    let active = true
    void supabase.functions.invoke('plan-status', { body: {} }).then(({ data }) => {
      const plan = (data as { plan?: string } | null)?.plan
      if (active && plan && PLANS[plan]) setWorkspacePlan(plan)
    }).catch(() => undefined)
    return () => { active = false }
  }, [isAuthed])

  // Связь с локальным браузерным агентом устанавливается из любого рабочего экрана Nemo.
  // Отдельная страница настройки для этого не нужна: расширению передаётся только короткоживущий
  // access token, refresh token браузерное расширение никогда не получает.
  useEffect(() => {
    if (!isSupabaseEnabled || !supabase || !isAuthed) return
    let active = true
    ;(async () => {
      const state = await extensionState()
      if (!active || !extensionReachable(state) || state === 'linked') return
      const { data } = await supabase.auth.getSession()
      const session = data.session
      if (!active || !session?.access_token || !session.expires_at) return
      await linkExtension({ access_token: session.access_token, expires_at: session.expires_at })
    })().catch(() => undefined)
    return () => { active = false }
  }, [isAuthed, user?.id])
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
    if (!isAuthed && isSupabaseEnabled) return
    void hydrate({ forceProfile: isSupabaseEnabled })
  }, [hydrate, isAuthed, user?.id])

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
    const onCommandKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        setCommandOpen((value) => !value)
      }
      if (event.key === 'Escape') setCommandOpen(false)
    }
    window.addEventListener('keydown', onCommandKey)
    return () => window.removeEventListener('keydown', onCommandKey)
  }, [])

  useEffect(() => {
    if (isAuthed) void trackEvent('page_view')
  }, [location.pathname, isAuthed])

  useEffect(() => {
    if (!isAuthed) return
    void featureEnabled('feedback_agent', user?.id).then(setFeedbackEnabled)
  }, [isAuthed, user?.id])

  // The sidebar and Command Palette expose the same three supported entry points.
  // Specialist tools are mounted only as chat artifacts, not as hidden navigation.
  type NavItem = { to: string; label: string; icon: typeof LayoutDashboard; end?: boolean; badge?: string }
  const navGroups: { title: string; items: NavItem[] }[] = [
    { title: t('appLayout.groupMain'), items: [
      { to: '/app', label: t('appLayout.navChatTasks'), icon: LayoutDashboard, end: true },
      { to: '/app/teams', label: t('appLayout.navAiTeams'), icon: Users },
    ] },
    { title: t('appLayout.groupSystem'), items: [
      { to: '/app/settings', label: t('appLayout.navSettingsIntegrations'), icon: SettingsIcon },
    ] },
  ]
  const nav = navGroups.flatMap((g) => g.items)
  const commandItems = nav
  const commandResults = commandItems.filter((item) => item.label.toLocaleLowerCase().includes(commandQuery.trim().toLocaleLowerCase()))

  // Header title: fall back to the create pages' own headings when not in nav.
  const titleFallback: Record<string, string> = {
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
    '/app/approvals': t('teamOffice.marketingTabs.approvals'),
    '/app/memory': t('appLayout.navMemory'),
    '/app/library': t('appLayout.navLibrary'),
    '/app/billing': t('appLayout.navBilling'),
  }
  const current = commandItems
    .filter((n) => (n.end ? location.pathname === n.to : location.pathname.startsWith(n.to)))
    .sort((a, b) => b.to.length - a.to.length)[0] ?? (titleFallback[location.pathname] ? { label: titleFallback[location.pathname] } : undefined)

  const handleLogout = () => {
    logout()
    navigate('/')
  }

  const openCommandResult = (to: string) => {
    setCommandOpen(false)
    setCommandQuery('')
    navigate(to)
  }

  const SidebarBody = (
    <div className="flex h-full flex-col border-r border-ice/10 bg-bg">
      <div className="flex min-h-24 items-start justify-between gap-3 border-b border-ice/[0.07] px-5 py-4">
        <div className="min-w-0">
          <Link to="/" onClick={() => setOpen(false)} className="group inline-flex rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-cyan/50">
            <Logo size={36} />
          </Link>
          <div className="mt-2.5 inline-flex items-center gap-2 rounded-lg border border-ice/[0.07] bg-card/[0.025] px-2.5 py-1.5 text-[10px] font-medium text-muted">
            <span className="relative flex h-1.5 w-1.5">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-teal opacity-50" />
              <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-teal" />
            </span>
            {t('appLayout.activeAgents', { count: activeAgentCount })}
          </div>
        </div>
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
        <Button to="/app?create=team" fullWidth size="sm">
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
                to="/app?create=team"
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
        <header className="sticky top-0 z-20 grid h-[72px] grid-cols-[minmax(0,1fr)_auto] items-center gap-3 border-b border-ice/[0.08] bg-bg/80 px-4 shadow-[0_1px_0_rgba(255,255,255,0.025)] backdrop-blur-xl sm:px-6 xl:grid-cols-[minmax(0,1fr)_minmax(300px,520px)_minmax(0,1fr)]">
          <div className="min-w-0 flex items-center gap-2 sm:gap-3">
            <button onClick={() => setOpen(true)} className="rounded-full p-2 text-muted hover:bg-white/5 lg:hidden" aria-label={t('common.menu')}>
              <Menu size={22} />
            </button>
            <h1 className="truncate text-base font-semibold tracking-tight text-text sm:text-xl">{current?.label ?? 'Nemo AI'}</h1>
          </div>

          <button
            type="button"
            onClick={() => setCommandOpen(true)}
            className="group hidden h-10 w-full items-center gap-3 rounded-xl border border-ice/[0.09] bg-card/[0.035] px-3.5 text-left text-sm text-muted shadow-[inset_0_1px_0_rgba(255,255,255,0.04)] transition-[border-color,background-color,box-shadow] duration-200 hover:border-ice/[0.16] hover:bg-card/[0.06] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-cyan/35 xl:flex"
          >
            <Search size={16} className="text-fog transition-colors group-hover:text-accent-cyan" />
            <span className="min-w-0 flex-1 truncate">{t('appLayout.searchPlaceholder')}</span>
            <span className="inline-flex items-center gap-0.5 rounded-md border border-ice/[0.08] bg-panel/70 px-1.5 py-1 font-mono text-[10px] text-fog"><Command size={10} />K</span>
          </button>

          <div className="flex items-center justify-end gap-2 sm:gap-3">
            <button type="button" onClick={() => setCommandOpen(true)} className="inline-flex h-9 w-9 items-center justify-center rounded-xl border border-ice/[0.08] bg-card/[0.03] text-muted transition hover:bg-card/[0.07] hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-cyan/40 xl:hidden" aria-label={t('appLayout.searchLabel')}>
              <Search size={16} />
            </button>
            <div className="hidden md:block"><LanguageToggle /></div>
            <div className="relative">
              <button onClick={() => setMenuOpen((v) => !v)} className="group flex items-center gap-2 rounded-xl border border-transparent p-1 pr-1.5 transition hover:border-ice/[0.08] hover:bg-card/[0.04] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-cyan/40" aria-expanded={menuOpen} aria-label={t('appLayout.profileMenu')}>
                <span className="rounded-[11px] bg-flow-gradient p-px shadow-[0_6px_18px_-8px_rgba(79,70,229,0.75)]">
                  <span className="flex h-8 w-8 items-center justify-center rounded-[10px] bg-panel text-sm font-semibold text-text">
                    {user?.name?.charAt(0).toUpperCase() ?? 'U'}
                  </span>
                </span>
                <span className="hidden min-w-0 text-left 2xl:block">
                  <span className="block max-w-32 truncate text-xs font-semibold text-text">{user?.name ?? t('appLayout.workspaceName')}</span>
                  <span className="mt-0.5 flex items-center gap-1 text-[10px] text-fog">
                    {t('appLayout.workspaceName')}
                    <span className="text-ice/20">•</span>
                    <span className="text-accent-cyan">{t(planLabelKey(workspacePlan))}</span>
                  </span>
                </span>
                <ChevronDown size={14} className={cn('text-muted transition-transform duration-200', menuOpen && 'rotate-180')} />
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
                    {isAdmin && <Link to="/app/control-center" onClick={() => setMenuOpen(false)} className="flex items-center gap-2 rounded-xl px-3 py-2 text-sm text-muted hover:bg-white/5 hover:text-text"><ShieldCheck size={15} />{t('appLayout.navAdmin')}</Link>}
                    <button onClick={handleLogout} className="flex w-full items-center gap-2 rounded-xl px-3 py-2 text-sm text-muted hover:bg-white/5 hover:text-text">
                      <LogOut size={15} /> {t('nav.logout')}
                    </button>
                  </div>
                </>
              )}
            </div>
          </div>
        </header>

        {commandOpen && (
          <div className="fixed inset-0 z-50 flex items-start justify-center bg-bg/55 px-4 pt-[12vh] backdrop-blur-sm" onMouseDown={(event) => { if (event.currentTarget === event.target) setCommandOpen(false) }}>
            <section role="dialog" aria-modal="true" aria-label={t('appLayout.searchLabel')} className="w-full max-w-xl overflow-hidden rounded-2xl border border-ice/[0.12] bg-panel/95 shadow-[0_30px_80px_-28px_rgba(15,23,42,0.9)] backdrop-blur-xl animate-fadeIn">
              <div className="flex items-center gap-3 border-b border-ice/[0.08] px-4">
                <Search size={18} className="shrink-0 text-accent-cyan" />
                <input
                  autoFocus
                  value={commandQuery}
                  onChange={(event) => setCommandQuery(event.target.value)}
                  onKeyDown={(event) => { if (event.key === 'Enter' && commandResults[0]) openCommandResult(commandResults[0].to) }}
                  placeholder={t('appLayout.searchPlaceholder')}
                  className="h-14 min-w-0 flex-1 bg-transparent text-sm text-text outline-none placeholder:text-fog"
                />
                <kbd className="rounded-md border border-ice/[0.08] bg-bg/50 px-1.5 py-1 font-mono text-[10px] text-fog">ESC</kbd>
              </div>
              <div className="max-h-80 overflow-y-auto p-2">
                {commandResults.length ? commandResults.map((item) => (
                  <button key={item.to} type="button" onClick={() => openCommandResult(item.to)} className="group flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left text-sm text-muted transition hover:bg-card/[0.06] hover:text-text focus-visible:bg-card/[0.06] focus-visible:text-text focus-visible:outline-none">
                    <span className="flex h-8 w-8 items-center justify-center rounded-lg border border-ice/[0.07] bg-card/[0.03] text-fog transition group-hover:text-accent-cyan"><item.icon size={15} /></span>
                    <span className="flex-1 font-medium">{item.label}</span>
                    <ArrowUpRight size={14} className="opacity-0 transition-opacity group-hover:opacity-100" />
                  </button>
                )) : (
                  <p className="px-3 py-8 text-center text-sm text-muted">{t('appLayout.searchEmpty')}</p>
                )}
              </div>
            </section>
          </div>
        )}

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
