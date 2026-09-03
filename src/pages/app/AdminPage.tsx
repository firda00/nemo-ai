import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { Activity, AlertTriangle, ArrowUpRight, Ban, Bot, Check, Coins, Gift, Layers3, Loader2, Lock, MessageSquareWarning, Plus, RefreshCw, Rocket, Search, ShieldCheck, Sparkles, Unlock, UserCog, Users } from 'lucide-react'
import { useI18n } from '../../i18n'
import { useToast } from '../../components/ui/Toast'
import { Button } from '../../components/ui/Button'
import { useAgentStore } from '../../store/useAgentStore'
import { supabase, isSupabaseEnabled } from '../../lib/supabase'
import { cn } from '../../lib/cn'

interface Account {
  id: string
  user_id: string | null
  email: string
  plan: string
  token_balance: number
  is_admin: boolean
  blocked: boolean
  agents: number
  last_login: string | null
}
interface GiftRow {
  code: string
  tokens: number
  redeemed_by: string | null
}
interface FeedbackRow {
  id: string
  email: string | null
  rating: -1 | 1
  category: string
  topic: string | null
  status: 'new' | 'reviewing' | 'resolved'
  contact_requested: boolean
  comment: string | null
  path: string | null
  created_at: string
}
interface SkillReviewRow {
  id: string
  name: string
  source_filename: string | null
  status: 'shared_candidate' | 'shared' | 'rejected'
  compatibility_score: number | null
  analysis: { reason?: string; risks?: string[] }
  created_at: string
}
interface ModeratedAgent {
  id: string
  account_id: string
  email: string | null
  name: string
  status: string
  type: string
}
interface OnboardingRow {
  account_id: string
  email: string | null
  name: string | null
  operating_markets: string[]
  owner_role: string | null
  primary_goal: string | null
  task_types: string[]
  data_sources: string[]
  default_action_policy: 'read_only' | 'approval_required'
  updated_at: string
}

type AdminSection = 'overview' | 'feedback' | 'onboarding' | 'accounts' | 'skills' | 'broadcast' | 'gifts' | 'agents'
const ADMIN_SECTIONS: AdminSection[] = ['overview', 'feedback', 'onboarding', 'accounts', 'skills', 'broadcast', 'gifts', 'agents']

const inputCls = 'glass w-full rounded-lg px-2.5 py-1.5 text-sm text-text outline-none placeholder:text-muted/70 focus:border-violet/50'

function MetricTile({ label, value, detail, icon, loading }: { label: string; value: string; detail: string; icon: ReactNode; loading: boolean }) {
  return (
    <article className="group min-w-0 rounded-[22px] border border-slate-200/80 bg-white p-5 shadow-[0_16px_45px_-34px_rgba(15,23,42,0.45)] transition duration-200 hover:-translate-y-0.5 hover:border-slate-300 dark:border-white/10 dark:bg-white/[0.035]">
      <div className="flex items-start justify-between gap-3">
        <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-500 dark:text-fog">{label}</p>
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-slate-100 text-slate-700 transition group-hover:bg-slate-900 group-hover:text-white dark:bg-white/[0.06] dark:text-muted">{icon}</span>
      </div>
      {loading ? <div className="mt-5 h-8 w-24 animate-pulse rounded-lg bg-slate-100 dark:bg-white/[0.06]" /> : <p className="mt-4 font-mono text-[2rem] font-semibold leading-none tracking-[-0.06em] text-slate-950 dark:text-text">{value}</p>}
      <p className="mt-3 truncate text-xs text-slate-500 dark:text-muted">{detail}</p>
    </article>
  )
}

function AttentionRow({ label, value, tone = 'neutral', onClick }: { label: string; value: number; tone?: 'neutral' | 'warning' | 'danger'; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className="group flex w-full items-center gap-3 rounded-xl px-3 py-3 text-left transition hover:bg-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500 dark:hover:bg-white/[0.04]">
      <span className={cn('h-2 w-2 rounded-full', tone === 'danger' ? 'bg-rose-500' : tone === 'warning' ? 'bg-amber-500' : 'bg-slate-400')} />
      <span className="min-w-0 flex-1 text-sm font-medium text-slate-700 dark:text-muted">{label}</span>
      <span className="font-mono text-sm font-semibold tabular-nums text-slate-950 dark:text-text">{value.toLocaleString('ru-RU')}</span>
      <ArrowUpRight size={14} className="text-slate-400 transition group-hover:-translate-y-0.5 group-hover:translate-x-0.5" />
    </button>
  )
}

export default function AdminPage() {
  const { t } = useI18n()
  const toast = useToast()
  const isAdmin = useAgentStore((s) => s.isAdmin)
  const accountId = useAgentStore((s) => s.accountId)
  const refreshBalance = useAgentStore((s) => s.refreshBalance)

  const [accounts, setAccounts] = useState<Account[]>([])
  const [gifts, setGifts] = useState<GiftRow[]>([])
  const [feedback, setFeedback] = useState<FeedbackRow[]>([])
  const [skillReviews, setSkillReviews] = useState<SkillReviewRow[]>([])
  const [moderatedAgents, setModeratedAgents] = useState<ModeratedAgent[]>([])
  const [onboarding, setOnboarding] = useState<OnboardingRow[]>([])
  const [adminCapabilities, setAdminCapabilities] = useState({ set_admin: false, moderate_agents: false })
  const [amounts, setAmounts] = useState<Record<string, string>>({})
  const [loading, setLoading] = useState(true)
  const [giftTokens, setGiftTokens] = useState('10000')
  const [giftCount, setGiftCount] = useState('1')
  const [busy, setBusy] = useState(false)
  const [bcMsg, setBcMsg] = useState('')
  const [bcBusy, setBcBusy] = useState(false)
  const [bcResult, setBcResult] = useState<string | null>(null)
  const [activeAction, setActiveAction] = useState<string | null>(null)
  const [activeSection, setActiveSection] = useState<AdminSection>(() => {
    const hash = window.location.hash.slice(1) as AdminSection
    return ADMIN_SECTIONS.includes(hash) ? hash : 'overview'
  })
  const [feedbackFilter, setFeedbackFilter] = useState<'open' | 'all' | 'resolved'>('open')
  const [feedbackSearch, setFeedbackSearch] = useState('')
  const [accountSearch, setAccountSearch] = useState('')
  const [accountPlan, setAccountPlan] = useState('all')

  const selectSection = (section: AdminSection) => {
    setActiveSection(section)
    window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}#${section}`)
  }

  useEffect(() => {
    const syncHash = () => {
      const hash = window.location.hash.slice(1) as AdminSection
      if (ADMIN_SECTIONS.includes(hash)) setActiveSection(hash)
    }
    window.addEventListener('hashchange', syncHash)
    return () => window.removeEventListener('hashchange', syncHash)
  }, [])

  const call = useCallback(async (action: string, extra: Record<string, unknown> = {}) => {
    if (!isSupabaseEnabled || !supabase) return null
    const { data, error } = await supabase.functions.invoke('admin-api', { body: { action, ...extra } })
    if (error || !(data as { ok?: boolean } | null)?.ok) {
      const status = (error as { context?: { status?: number } } | null)?.context?.status
      const code = (data as { error?: string } | null)?.error
      if (status === 401 || status === 403 || code === 'fresh_password_and_mfa_required') {
        window.dispatchEvent(new CustomEvent('nemo:admin-reauth-required'))
      }
      return null
    }
    return data as Record<string, unknown>
  }, [])

  const loadAll = useCallback(async () => {
    setLoading(true)
    const skillRequest = isSupabaseEnabled && supabase
      ? supabase.functions.invoke('review-skill', { body: { action: 'list_admin' } })
      : Promise.resolve({ data: null })
    const [a, g, f, onboardingRows, skills] = await Promise.all([call('list_accounts'), call('list_gifts'), call('list_feedback'), call('list_onboarding'), skillRequest])
    if (a) {
      setAccounts((a.accounts as Account[]) ?? [])
      const capabilities = (a.capabilities as { set_admin?: boolean; moderate_agents?: boolean } | undefined) ?? {}
      setAdminCapabilities({ set_admin: capabilities.set_admin === true, moderate_agents: capabilities.moderate_agents === true })
      if (capabilities.moderate_agents === true) {
        const agentRows = await call('list_agents')
        if (agentRows) setModeratedAgents((agentRows.agents as ModeratedAgent[]) ?? [])
      }
    }
    if (g) setGifts((g.gifts as GiftRow[]) ?? [])
    if (f) setFeedback((f.feedback as FeedbackRow[]) ?? [])
    if (onboardingRows) setOnboarding((onboardingRows.onboarding as OnboardingRow[]) ?? [])
    const skillData = skills.data as { skills?: SkillReviewRow[] } | null
    if (skillData?.skills) setSkillReviews(skillData.skills)
    setLoading(false)
  }, [call])
  useEffect(() => {
    if (isAdmin) window.setTimeout(() => void loadAll(), 0)
    else window.setTimeout(() => setLoading(false), 0)
  }, [isAdmin, loadAll])

  const apply = async (id: string, action: 'grant' | 'set') => {
    const amount = Number(amounts[id])
    if (!Number.isFinite(amount)) return
    const res = await call(action, { account_id: id, amount })
    if (!res) {
      toast(t('common.error'))
      return
    }
    setAccounts((accs) => accs.map((a) => (a.id === id ? { ...a, token_balance: Number(res.balance) } : a)))
    setAmounts((m) => ({ ...m, [id]: '' }))
    if (id === accountId) refreshBalance()
    toast(t('platform.adminPanel.granted'))
  }

  // soft block / unblock (unblock also lifts any hard ban)
  const setBlocked = async (a: Account, blocked: boolean) => {
    const res = await call('block', { account_id: a.id, blocked })
    if (!res) { toast(t('common.error')); return }
    if (!blocked && a.user_id) await call('ban', { user_id: a.user_id, banned: false })
    setAccounts((accs) => accs.map((x) => (x.id === a.id ? { ...x, blocked } : x)))
    toast(blocked ? t('platform.adminPanel.blockedMsg') : t('platform.adminPanel.unblockedMsg'))
  }
  // set the account's plan tier (controls which LLM the orchestrator uses)
  const setPlan = async (a: Account, plan: string) => {
    const res = await call('set_plan', { account_id: a.id, plan })
    if (!res) { toast(t('common.error')); return }
    setAccounts((accs) => accs.map((x) => (x.id === a.id ? { ...x, plan } : x)))
    toast(`Plan → ${plan}`)
  }
  // hard ban (cannot log in)
  const banUser = async (a: Account) => {
    if (!a.user_id) return
    const res = await call('ban', { user_id: a.user_id, banned: true })
    if (!res) { toast(t('common.error')); return }
    setAccounts((accs) => accs.map((x) => (x.id === a.id ? { ...x, blocked: true } : x)))
    toast(t('platform.adminPanel.bannedMsg'))
  }

  const fmtLogin = (iso: string | null) => {
    if (!iso) return t('platform.adminPanel.never')
    const d = new Date(iso)
    return isNaN(d.getTime()) ? '—' : d.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
  }

  const createGift = async () => {
    setBusy(true)
    const res = await call('create_gift', { tokens: Number(giftTokens), count: Number(giftCount) })
    setBusy(false)
    if (!res) {
      toast(t('common.error'))
      return
    }
    toast(t('platform.adminPanel.giftCreated'))
    loadAll()
  }

  const sendBroadcast = async () => {
    if (!supabase || bcBusy || bcMsg.trim().length < 2) return
    setBcBusy(true); setBcResult(null)
    try {
      const { data } = await supabase.functions.invoke('send-broadcast', { body: { message: bcMsg.trim() } })
      const p = data as { ok?: boolean; recipients?: number; sent?: number; failed?: number; message?: string; error?: string } | null
      if (p?.ok) { setBcResult(t('adminPage.bcSent', { sent: p.sent ?? 0, recipients: p.recipients ?? 0, failed: p.failed ?? 0 })); setBcMsg('') }
      else setBcResult(p?.message ?? p?.error ?? t('adminPage.sendFailed'))
    } catch { setBcResult(t('adminPage.sendError')) } finally { setBcBusy(false) }
  }
  const setAdmin = async (a: Account, enabled: boolean) => {
    if (!a.user_id) return
    const res = await call('set_admin', { user_id: a.user_id, enabled })
    if (!res) { toast(t('common.error')); return }
    setAccounts((rows) => rows.map((row) => row.id === a.id ? { ...row, is_admin: enabled } : row))
    toast(enabled ? 'Администратор назначен' : 'Права администратора сняты')
  }
  const quarantineAgent = async (agent: ModeratedAgent, quarantined: boolean) => {
    const res = await call('quarantine_agent', { agent_id: agent.id, quarantined })
    if (!res) { toast(t('common.error')); return }
    setModeratedAgents((rows) => rows.map((row) => row.id === agent.id ? { ...row, status: quarantined ? 'paused' : 'active' } : row))
    toast(quarantined ? 'Агент остановлен' : 'Агент восстановлен')
  }

  const setFeedbackStatus = async (row: FeedbackRow, status: FeedbackRow['status']) => {
    if (activeAction) return
    const actionKey = `${row.id}:${status}`
    setActiveAction(actionKey)
    const res = await call('update_feedback_status', { feedback_id: row.id, status })
    setActiveAction(null)
    if (!res) { toast('Действие не выполнено. Если защищённая сессия истекла, войдите ещё раз.'); return }
    setFeedback((items) => items.map((item) => item.id === row.id ? { ...item, status } : item))
    toast(status === 'resolved' ? 'Обращение отмечено решённым' : 'Обращение взято в работу')
  }

  const reviewSkill = async (id: string, action: 'publish' | 'reject') => {
    if (!supabase) return
    const { data, error } = await supabase.functions.invoke('review-skill', { body: { action, id } })
    if (error || !(data as { ok?: boolean } | null)?.ok) { toast(t('common.error')); return }
    setSkillReviews((rows) => rows.map((row) => row.id === id ? { ...row, status: action === 'publish' ? 'shared' : 'rejected' } : row))
    toast(action === 'publish' ? 'Skill опубликован' : 'Skill отклонён')
  }

  if (!isAdmin) {
    return (
      <div className="container-page max-w-2xl py-16 text-center">
        <ShieldCheck size={32} className="mx-auto text-muted/50" />
        <p className="mt-3 text-sm text-muted">403 — admin only</p>
      </div>
    )
  }

  const openFeedback = feedback.filter((row) => row.status !== 'resolved').length
  const pendingSkills = skillReviews.filter((row) => row.status === 'shared_candidate').length
  const activeAccounts = accounts.filter((row) => !row.blocked).length
  const blockedAccounts = accounts.length - activeAccounts
  const activeAgents = moderatedAgents.filter((row) => row.status !== 'paused').length
  const pausedAgents = moderatedAgents.length - activeAgents
  const totalAgents = accounts.reduce((sum, row) => sum + row.agents, 0)
  const runningAgents = moderatedAgents.length > 0 ? activeAgents : totalAgents
  const tokenReserve = accounts.reduce((sum, row) => sum + row.token_balance, 0)
  const planCounts = accounts.reduce<Record<string, number>>((result, row) => {
    const plan = row.plan || 'free'
    result[plan] = (result[plan] ?? 0) + 1
    return result
  }, {})
  const plans = Object.entries(planCounts).sort((a, b) => b[1] - a[1])
  const number = (value: number) => new Intl.NumberFormat('ru-RU', { notation: value >= 100_000 ? 'compact' : 'standard', maximumFractionDigits: 1 }).format(value)
  const visibleFeedback = feedback.filter((row) => {
    const matchesStatus = feedbackFilter === 'all' || (feedbackFilter === 'open' ? row.status !== 'resolved' : row.status === 'resolved')
    const query = feedbackSearch.trim().toLowerCase()
    const matchesSearch = !query || [row.email, row.comment, row.path, row.topic, row.category].some((value) => value?.toLowerCase().includes(query))
    return matchesStatus && matchesSearch
  })
  const visibleAccounts = accounts.filter((row) => {
    const query = accountSearch.trim().toLowerCase()
    return (!query || row.email.toLowerCase().includes(query)) && (accountPlan === 'all' || (row.plan || 'free') === accountPlan)
  })
  const navItems: Array<{ id: AdminSection; label: string; count?: number }> = [
    { id: 'overview', label: 'Обзор' },
    { id: 'feedback', label: 'Обращения', count: openFeedback },
    { id: 'onboarding', label: 'Онбординг', count: onboarding.length },
    { id: 'accounts', label: 'Аккаунты', count: accounts.length },
    { id: 'skills', label: 'Навыки', count: pendingSkills },
    { id: 'broadcast', label: 'Рассылки' },
    { id: 'gifts', label: 'Промокоды' },
    ...(adminCapabilities.moderate_agents ? [{ id: 'agents' as const, label: 'Агенты', count: pausedAgents }] : []),
  ]

  return (
    <div className="container-page max-w-[1440px] pb-16 pt-7">
      <header className="relative overflow-hidden rounded-[30px] bg-[#111827] px-6 pb-7 pt-6 text-white shadow-[0_30px_90px_-48px_rgba(15,23,42,0.9)] md:px-8 md:pb-8">
        <div className="pointer-events-none absolute -right-16 -top-24 h-72 w-72 rounded-full bg-cyan-400/10 blur-3xl" />
        <div className="pointer-events-none absolute bottom-0 left-1/3 h-px w-1/2 bg-gradient-to-r from-transparent via-cyan-300/40 to-transparent" />
        <div className="relative flex flex-col justify-between gap-6 md:flex-row md:items-end">
          <div>
            <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.18em] text-cyan-300">
              <span className="h-1.5 w-1.5 rounded-full bg-cyan-300 shadow-[0_0_12px_rgba(103,232,249,0.9)]" />
              Операционный центр Nemo
            </div>
            <h1 className="mt-4 max-w-3xl text-balance text-3xl font-semibold tracking-[-0.045em] !text-white md:text-[2.6rem] md:leading-[1.05]">Центр управления платформой</h1>
            <p className="mt-3 max-w-2xl text-sm leading-6 text-slate-300">Пользователи, агенты, обращения и доступы — единая оперативная картина без переходов между модулями.</p>
          </div>
          <div className="flex items-center gap-3">
            <div className="hidden text-right sm:block">
              <p className="text-xs font-medium text-slate-200">Состояние системы</p>
              <p className="mt-1 flex items-center justify-end gap-1.5 text-[11px] text-emerald-300"><span className={cn('h-1.5 w-1.5 rounded-full', loading ? 'animate-pulse bg-amber-300' : 'bg-emerald-400')} /> {loading ? 'Обновляем данные' : 'Данные актуальны'}</p>
            </div>
            <button onClick={() => void loadAll()} disabled={loading} className="inline-flex h-10 items-center gap-2 rounded-xl border border-white/15 bg-white/[0.07] px-3.5 text-xs font-semibold text-white transition hover:bg-white/[0.12] active:scale-[0.98] disabled:opacity-50">
              <RefreshCw size={14} className={loading ? 'animate-spin' : ''} /> Обновить
            </button>
          </div>
        </div>
      </header>

      <nav aria-label="Разделы центра управления" className="mt-4 flex items-center gap-1 overflow-x-auto rounded-2xl border border-slate-200/80 bg-white p-1.5 shadow-[0_14px_45px_-32px_rgba(15,23,42,0.38)] dark:border-white/10 dark:bg-[#111827]">
        {navItems.map((item) => <button key={item.id} type="button" onClick={() => selectSection(item.id)} aria-current={activeSection === item.id ? 'page' : undefined} className={cn('flex items-center gap-2 whitespace-nowrap rounded-xl px-3 py-2 text-xs font-semibold transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500', activeSection === item.id ? '!bg-[#111827] !text-white shadow-sm' : 'text-slate-500 hover:bg-slate-100 hover:text-slate-950 dark:text-muted dark:hover:bg-white/[0.05] dark:hover:text-text')}>
          {item.label}{typeof item.count === 'number' && item.count > 0 && <span className={cn('rounded-full px-1.5 py-0.5 font-mono text-[9px]', activeSection === item.id ? '!bg-white/15 !text-white' : 'bg-slate-100 text-slate-500 dark:bg-white/[0.06]')}>{item.count}</span>}
        </button>)}
      </nav>

      {activeSection === 'overview' && <section id="overview" className="pt-6" aria-label="Обзор платформы">
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
          <MetricTile loading={loading} label="Аккаунты" value={number(accounts.length)} detail={`${number(activeAccounts)} доступны`} icon={<Users size={16} />} />
          <MetricTile loading={loading} label="Агенты" value={number(totalAgents)} detail={`${number(runningAgents)} работают`} icon={<Bot size={16} />} />
          <MetricTile loading={loading} label="Открытые обращения" value={number(openFeedback)} detail={openFeedback ? 'требуют реакции' : 'очередь обработана'} icon={<MessageSquareWarning size={16} />} />
          <MetricTile loading={loading} label="Токены на счетах" value={number(tokenReserve)} detail="совокупный баланс" icon={<Coins size={16} />} />
          <MetricTile loading={loading} label="На модерации" value={number(pendingSkills)} detail="пользовательских skills" icon={<Layers3 size={16} />} />
        </div>

        <div className="mt-4 grid gap-4 lg:grid-cols-[minmax(0,1.45fr)_minmax(310px,0.75fr)]">
          <article className="rounded-[26px] border border-slate-200/80 bg-white p-6 shadow-[0_18px_55px_-38px_rgba(15,23,42,0.45)] dark:border-white/10 dark:bg-white/[0.035]">
            <div className="flex items-start justify-between gap-4">
              <div><p className="text-base font-semibold tracking-tight text-slate-950 dark:text-text">Структура клиентской базы</p><p className="mt-1 text-xs text-slate-500 dark:text-muted">Распределение аккаунтов по действующим тарифам</p></div>
              <Activity size={18} className="text-slate-400" />
            </div>
            {loading ? <div className="mt-8 h-32 animate-pulse rounded-2xl bg-slate-100 dark:bg-white/[0.05]" /> : plans.length === 0 ? <p className="mt-8 rounded-2xl bg-slate-50 px-4 py-8 text-center text-sm text-slate-500 dark:bg-white/[0.03] dark:text-muted">Аккаунты пока не загружены</p> : (
              <div className="mt-7 space-y-4">
                {plans.slice(0, 6).map(([plan, count]) => {
                  const share = accounts.length ? Math.round((count / accounts.length) * 100) : 0
                  return <div key={plan} className="grid grid-cols-[88px_1fr_72px] items-center gap-3"><span className="truncate text-xs font-semibold capitalize text-slate-700 dark:text-muted">{plan}</span><div className="h-2 overflow-hidden rounded-full bg-slate-100 dark:bg-white/[0.06]"><div className="h-full rounded-full bg-slate-900 transition-[width] duration-500 dark:bg-cyan-300" style={{ width: `${Math.max(share, 3)}%` }} /></div><span className="text-right font-mono text-xs tabular-nums text-slate-500 dark:text-fog">{count} · {share}%</span></div>
                })}
              </div>
            )}
          </article>

          <aside className="rounded-[26px] bg-slate-100/80 p-3 dark:bg-white/[0.025]">
            <div className="flex items-center justify-between px-3 pb-2 pt-2"><div><p className="text-base font-semibold tracking-tight text-slate-950 dark:text-text">Требует внимания</p><p className="mt-1 text-xs text-slate-500 dark:text-muted">Очереди и ограничения</p></div><AlertTriangle size={17} className="text-amber-500" /></div>
            <div className="mt-2 divide-y divide-slate-200/70 dark:divide-white/[0.06]">
              <AttentionRow onClick={() => selectSection('feedback')} label="Открытые обращения" value={openFeedback} tone={openFeedback ? 'danger' : 'neutral'} />
              <AttentionRow onClick={() => selectSection('skills')} label="Skills на проверке" value={pendingSkills} tone={pendingSkills ? 'warning' : 'neutral'} />
              <AttentionRow onClick={() => selectSection('accounts')} label="Заблокированные аккаунты" value={blockedAccounts} tone={blockedAccounts ? 'warning' : 'neutral'} />
              {adminCapabilities.moderate_agents && <AttentionRow onClick={() => selectSection('agents')} label="Остановленные агенты" value={pausedAgents} tone={pausedAgents ? 'warning' : 'neutral'} />}
            </div>
          </aside>
        </div>
      </section>}

      {activeSection === 'onboarding' && <section id="onboarding" className="card mt-6 rounded-[26px] p-5 md:p-6">
        <div className="flex items-start justify-between gap-4">
          <div><h2 className="flex items-center gap-2 text-lg font-semibold tracking-tight text-text"><Rocket size={18} className="text-cyan" /> Ответы онбординга</h2><p className="mt-1 text-xs text-muted">Профиль бизнеса, цель, нужные задачи, источники данных и политика действий.</p></div>
          <span className="rounded-full bg-slate-100 px-2.5 py-1 font-mono text-xs text-muted dark:bg-white/[0.05]">{onboarding.length}</span>
        </div>
        {loading ? <p className="py-10 text-center text-sm text-muted">{t('common.loading')}</p> : onboarding.length === 0 ? <p className="mt-5 rounded-2xl border border-dashed border-slate-200 bg-slate-50 p-10 text-center text-sm text-muted dark:border-white/10 dark:bg-white/[0.025]">Завершённых анкет пока нет.</p> : <div className="mt-5 max-h-[650px] divide-y divide-slate-200 overflow-y-auto border-y border-slate-200 dark:divide-white/[0.07] dark:border-white/10">
          {onboarding.map((row) => <article key={row.account_id} className="grid gap-4 py-4 lg:grid-cols-[220px_minmax(0,1fr)_260px]">
            <div className="min-w-0"><p className="truncate text-sm font-semibold text-text">{row.name || 'Без названия'}</p><p className="mt-1 truncate text-xs text-muted">{row.email || row.account_id}</p><p className="mt-2 text-[11px] text-fog">Обновлено {new Date(row.updated_at).toLocaleString('ru-RU')}</p></div>
            <div className="min-w-0"><p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-fog">Главная цель</p><p className="mt-1 text-sm leading-6 text-text">{row.primary_goal || 'Не указана'}</p><div className="mt-3 flex flex-wrap gap-1.5">{row.task_types.map((task) => <span key={task} className="rounded-lg bg-violet/10 px-2 py-1 text-[10px] text-violet">{task}</span>)}</div></div>
            <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-xs"><div><dt className="text-fog">Рынок</dt><dd className="mt-0.5 font-medium text-text">{row.operating_markets.join(', ') || '—'}</dd></div><div><dt className="text-fog">Роль</dt><dd className="mt-0.5 font-medium text-text">{row.owner_role || '—'}</dd></div><div className="col-span-2"><dt className="text-fog">Источники</dt><dd className="mt-0.5 text-text">{row.data_sources.join(', ') || '—'}</dd></div><div className="col-span-2"><dt className="text-fog">Политика агента</dt><dd className="mt-0.5 font-medium text-text">{row.default_action_policy === 'read_only' ? 'Только анализ' : 'Действия после подтверждения'}</dd></div></dl>
          </article>)}
        </div>}
      </section>}

      {/* Feedback operations */}
      {activeSection === 'feedback' && <section id="feedback" className="card mt-6 rounded-[26px] p-5 md:p-6">
        <div className="flex flex-col justify-between gap-4 lg:flex-row lg:items-end">
          <div>
            <h2 className="flex items-center gap-2 text-lg font-semibold tracking-tight text-text"><MessageSquareWarning size={18} className="text-amber" /> Центр обращений</h2>
            <p className="mt-1 text-xs text-muted">Жалобы и отзывы собраны в одной рабочей очереди.</p>
          </div>
          <div className="flex flex-col gap-2 sm:flex-row">
            <label className="relative min-w-[240px]"><Search size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted" /><input value={feedbackSearch} onChange={(event) => setFeedbackSearch(event.target.value)} placeholder="Поиск по сообщению или email" className={cn(inputCls, 'h-10 pl-9')} /></label>
            <div className="flex rounded-xl bg-slate-100 p-1 dark:bg-white/[0.04]">
              {([['open', `Открытые ${openFeedback}`], ['all', 'Все'], ['resolved', 'Решённые']] as const).map(([filter, label]) => <button key={filter} type="button" onClick={() => setFeedbackFilter(filter)} className={cn('rounded-lg px-3 py-2 text-xs font-semibold transition', feedbackFilter === filter ? 'bg-white text-slate-950 shadow-sm dark:bg-white/10 dark:text-text' : 'text-muted hover:text-text')}>{label}</button>)}
            </div>
          </div>
        </div>
        {visibleFeedback.length === 0 ? <p className="mt-5 rounded-2xl border border-dashed border-slate-200 bg-slate-50 p-10 text-center text-sm text-muted dark:border-white/10 dark:bg-white/[0.025]">В этой очереди сообщений нет.</p> : (
          <div className="mt-5 max-h-[650px] divide-y divide-slate-200 overflow-y-auto border-y border-slate-200 pr-2 dark:divide-white/[0.07] dark:border-white/10">
            {visibleFeedback.map((row) => {
              const suspicious = /<script|javascript:|onerror\s*=/i.test(row.comment ?? '')
              return (
              <article key={row.id} className="grid gap-4 py-4 md:grid-cols-[minmax(0,1fr)_auto] md:items-start">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2 text-xs">
                  <span className={row.rating < 0 ? 'font-semibold text-danger' : 'font-semibold text-teal'}>{row.rating < 0 ? 'Жалоба' : 'Отзыв'}</span>
                  <span className="rounded-md bg-slate-100 px-1.5 py-0.5 text-muted dark:bg-white/[0.04]">{row.topic || row.category}</span>
                  <span className={cn('rounded-md px-1.5 py-0.5', row.status === 'resolved' ? 'bg-teal/10 text-teal' : row.status === 'reviewing' ? 'bg-amber/10 text-amber' : 'bg-violet/10 text-violet')}>{row.status === 'new' ? 'Новое' : row.status === 'reviewing' ? 'В работе' : 'Решено'}</span>
                  {suspicious && <span className="rounded-md bg-rose-50 px-1.5 py-0.5 font-medium text-rose-600 dark:bg-rose-500/10">подозрительный ввод</span>}
                  {row.contact_requested && <span className="text-accent-cyan">просит ответ</span>}
                  <span className="text-muted">{row.email || 'email unavailable'}</span>
                  </div>
                  <p className={cn('mt-2 whitespace-pre-wrap break-words text-sm leading-relaxed text-text', suspicious && 'font-mono text-xs')}>{row.comment || 'Комментарий не добавлен'}</p>
                  <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-fog"><span>{new Date(row.created_at).toLocaleString('ru-RU')}</span>{row.path && <span>Страница: {row.path}</span>}</div>
                </div>
                <div className="flex flex-wrap gap-2 md:justify-end">
                  {row.status === 'new' && <Button size="sm" variant="ghost" disabled={activeAction?.startsWith(row.id)} onClick={() => void setFeedbackStatus(row, 'reviewing')}>{activeAction === `${row.id}:reviewing` ? <Loader2 size={14} className="animate-spin" /> : null}Взять в работу</Button>}
                  {row.status !== 'resolved' && <Button size="sm" disabled={activeAction?.startsWith(row.id)} onClick={() => void setFeedbackStatus(row, 'resolved')}>{activeAction === `${row.id}:resolved` ? <Loader2 size={14} className="animate-spin" /> : null}Отметить решённым</Button>}
                  {row.status === 'resolved' && <Button size="sm" variant="ghost" disabled={activeAction?.startsWith(row.id)} onClick={() => void setFeedbackStatus(row, 'reviewing')}>{activeAction === `${row.id}:reviewing` ? <Loader2 size={14} className="animate-spin" /> : null}Открыть снова</Button>}
                </div>
              </article>
            )})}
          </div>
        )}
      </section>}

      {activeSection === 'skills' && <section id="skills" className="card mt-6 rounded-[26px] p-6">
        <div className="flex items-center justify-between gap-3">
          <div><h2 className="flex items-center gap-2 text-sm font-bold text-text"><Sparkles size={16} className="text-violet" /> Проверка пользовательских skills</h2><p className="mt-1 text-xs text-muted">AI может предложить публикацию, но окончательное решение принимает администратор.</p></div>
          <span className="rounded-full border border-white/10 px-2.5 py-1 text-xs text-muted">{skillReviews.filter((row) => row.status === 'shared_candidate').length}</span>
        </div>
        {skillReviews.length === 0 ? <p className="mt-4 rounded-2xl border border-white/10 bg-black/10 p-4 text-sm text-muted">Кандидатов на проверку нет.</p> : (
          <div className="mt-4 space-y-2">
            {skillReviews.map((row) => (
              <div key={row.id} className="rounded-2xl border border-white/10 bg-black/10 p-4">
                <div className="flex flex-wrap items-center gap-2"><p className="font-semibold text-text">{row.name}</p><span className="rounded-full border border-white/10 px-2 py-0.5 text-[10px] text-muted">{row.compatibility_score ?? 0}/100</span><span className="text-[10px] text-fog">{row.status}</span></div>
                <p className="mt-2 text-xs leading-relaxed text-muted">{row.analysis?.reason || 'Без пояснения'}</p>
                {row.analysis?.risks?.length ? <p className="mt-2 text-[11px] text-amber">Риски: {row.analysis.risks.join(', ')}</p> : null}
                {row.status === 'shared_candidate' && <div className="mt-3 flex gap-2"><Button size="sm" onClick={() => void reviewSkill(row.id, 'publish')}>Опубликовать</Button><Button size="sm" variant="ghost" onClick={() => void reviewSkill(row.id, 'reject')}>Оставить приватным</Button></div>}
              </div>
            ))}
          </div>
        )}
      </section>}

      {activeSection === 'broadcast' && <section id="broadcast" className="card mt-6 rounded-[26px] p-6">
        <h2 className="flex items-center gap-2 text-sm font-bold text-text"><Coins size={16} className="text-violet" /> {t('adminPage.smsTitle')}</h2>
        <p className="mt-1 text-xs text-muted">{t('adminPage.smsDesc')}</p>
        <textarea value={bcMsg} onChange={(e) => setBcMsg(e.target.value)} rows={3} placeholder={t('adminPage.smsPh')} className="glass mt-3 w-full resize-y rounded-xl px-3 py-2.5 text-sm text-text outline-none placeholder:text-fog focus:border-violet/50" />
        <div className="mt-3 flex items-center gap-3">
          <Button onClick={sendBroadcast} disabled={bcBusy || bcMsg.trim().length < 2}>{bcBusy ? <Loader2 size={15} className="animate-spin" /> : <Coins size={15} />} {t('adminPage.sendAll')}</Button>
          {bcResult && <span className="text-xs text-muted">{bcResult}</span>}
        </div>
      </section>}

      {/* gift cards */}
      {activeSection === 'gifts' && <section id="gifts" className="card mt-6 rounded-[26px] p-6">
        <p className="flex items-center gap-2 text-sm font-medium text-text">
          <Gift size={16} className="text-violet" /> {t('platform.adminPanel.giftTitle')}
        </p>
        <p className="mt-0.5 text-xs text-muted">{t('platform.adminPanel.giftDesc')}</p>
        <div className="mt-3 flex flex-wrap items-end gap-3">
          <label className="space-y-1">
            <span className="block text-[11px] text-muted">{t('platform.adminPanel.giftTokens')}</span>
            <input value={giftTokens} onChange={(e) => setGiftTokens(e.target.value)} className={cn(inputCls, 'w-32')} inputMode="numeric" />
          </label>
          <label className="space-y-1">
            <span className="block text-[11px] text-muted">{t('platform.adminPanel.giftCount')}</span>
            <input value={giftCount} onChange={(e) => setGiftCount(e.target.value)} className={cn(inputCls, 'w-24')} inputMode="numeric" />
          </label>
          <Button size="sm" onClick={createGift} disabled={busy || !(Number(giftTokens) > 0)}>
            {busy ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />} {t('platform.adminPanel.giftCreate')}
          </Button>
        </div>
        {gifts.length > 0 && (
          <ul className="mt-4 space-y-1.5">
            {gifts.slice(0, 12).map((g) => (
              <li key={g.code} className="flex items-center gap-3 rounded-lg border border-ice/[0.07] bg-ice/[0.02] px-3 py-2 text-sm">
                <code className="font-mono text-cyan">{g.code}</code>
                <span className="flex items-center gap-1 text-muted"><Coins size={12} /> {g.tokens.toLocaleString()}</span>
                <span className={cn('ml-auto rounded-full px-2 py-0.5 text-[10px]', g.redeemed_by ? 'bg-ice/10 text-muted' : 'bg-teal/15 text-teal')}>
                  {g.redeemed_by ? t('platform.adminPanel.giftRedeemed') : t('platform.adminPanel.giftActive')}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>}

      {/* accounts */}
      {activeSection === 'accounts' && <section id="accounts" className="card mt-6 rounded-[26px] p-5 md:p-6">
        <div className="mb-5 flex flex-col justify-between gap-4 lg:flex-row lg:items-end">
          <div><h2 className="flex items-center gap-2 text-lg font-semibold tracking-tight text-text"><Users size={18} className="text-violet" /> Управление аккаунтами</h2><p className="mt-1 text-xs text-muted">Баланс, тариф и доступ — в одной рабочей таблице.</p></div>
          <div className="flex flex-col gap-2 sm:flex-row">
            <label className="relative min-w-[240px]"><Search size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted" /><input value={accountSearch} onChange={(event) => setAccountSearch(event.target.value)} placeholder="Найти аккаунт по email" className={cn(inputCls, 'h-10 pl-9')} /></label>
            <select value={accountPlan} onChange={(event) => setAccountPlan(event.target.value)} className={cn(inputCls, 'h-10 min-w-[145px] cursor-pointer')} aria-label="Фильтр по тарифу"><option value="all">Все тарифы</option>{plans.map(([plan]) => <option key={plan} value={plan}>{plan}</option>)}</select>
          </div>
        </div>
        {loading ? (
          <p className="py-8 text-center text-sm text-muted">{t('common.loading')}</p>
        ) : visibleAccounts.length === 0 ? (
          <p className="rounded-2xl border border-dashed border-slate-200 bg-slate-50 p-10 text-center text-sm text-muted dark:border-white/10 dark:bg-white/[0.025]">Аккаунты по выбранному фильтру не найдены.</p>
        ) : (
          <div className="max-h-[650px] overflow-auto rounded-2xl border border-slate-200 dark:border-white/10">
            <table className="w-full min-w-[1080px] text-sm">
              <thead className="sticky top-0 z-10 bg-white dark:bg-[#111827]">
                <tr className="border-b border-slate-200 text-left text-xs text-muted dark:border-white/10">
                  <th className="py-2 pr-3 font-normal">{t('platform.adminPanel.colAccount')}</th>
                  <th className="py-2 pr-3 text-center font-normal">{t('platform.adminPanel.colAgents')}</th>
                  <th className="py-2 pr-3 font-normal">{t('platform.adminPanel.colLast')}</th>
                  <th className="py-2 pr-3 font-normal">{t('platform.adminPanel.colStatus')}</th>
                  <th className="py-2 pr-3 font-normal">{t('platform.adminPanel.colBalance')}</th>
                  <th className="py-2 font-normal">{t('platform.adminPanel.amountPh')}</th>
                </tr>
              </thead>
              <tbody>
                {visibleAccounts.map((a) => (
                  <tr key={a.id} className="border-b border-slate-100 transition hover:bg-slate-50/80 dark:border-white/[0.05] dark:hover:bg-white/[0.025]">
                    <td className="py-3 pl-3 pr-3">
                      <div className="flex items-center gap-2">
                        <span className="max-w-[180px] truncate text-text">{a.email}</span>
                        {a.is_admin && <span className="rounded-full bg-violet/15 px-1.5 py-0.5 text-[9px] text-violet">{t('platform.adminPanel.adminBadge')}</span>}
                      </div>
                    </td>
                    <td className="py-2.5 pr-3 text-center text-muted">{a.agents}</td>
                    <td className="py-2.5 pr-3 text-xs text-muted">{fmtLogin(a.last_login)}</td>
                    <td className="py-2.5 pr-3">
                      <span className={cn('rounded-full px-2 py-0.5 text-[10px]', a.blocked ? 'bg-danger/15 text-danger' : 'bg-teal/15 text-teal')}>
                        {a.blocked ? t('platform.adminPanel.statusBlocked') : t('platform.adminPanel.statusActive')}
                      </span>
                    </td>
                    <td className="py-2.5 pr-3 font-medium text-text">{a.token_balance.toLocaleString()}</td>
                    <td className="py-2.5 pr-3">
                      <div className="flex items-center gap-2">
                        <input
                          value={amounts[a.id] ?? ''}
                          onChange={(e) => setAmounts((m) => ({ ...m, [a.id]: e.target.value }))}
                          placeholder={t('platform.adminPanel.amountPh')}
                          className={cn(inputCls, 'w-24')}
                          inputMode="numeric"
                        />
                        <button onClick={() => apply(a.id, 'grant')} className="rounded-lg bg-brand px-2 py-1.5 text-xs font-medium text-white" title={t('platform.adminPanel.grant')}>
                          <Plus size={13} />
                        </button>
                        <button onClick={() => apply(a.id, 'set')} className="rounded-lg border border-ice/12 px-2 py-1.5 text-xs font-medium text-muted hover:text-text" title={t('platform.adminPanel.setBalance')}>
                          <Check size={13} />
                        </button>
                        <select value={a.plan ?? 'starter'} onChange={(e) => setPlan(a, e.target.value)} className={cn(inputCls, 'w-[112px] cursor-pointer')} title="Тариф аккаунта">
                          <option value="free">free</option>
                          <option value="starter">Starter</option>
                          <option value="pro">pro</option>
                          <option value="business">business</option>
                          <option value="agency">Agency</option>
                          <option value="enterprise">Enterprise</option>
                        </select>
                        {adminCapabilities.set_admin && a.user_id && (
                          <button onClick={() => void setAdmin(a, !a.is_admin)} className={cn('rounded-lg border px-2 py-1.5 text-xs', a.is_admin ? 'border-violet/30 text-violet' : 'border-ice/12 text-muted hover:text-text')} title={a.is_admin ? 'Снять права администратора' : 'Назначить администратором'}>
                            <UserCog size={13} />
                          </button>
                        )}
                        {!a.is_admin && (
                          <>
                            <button
                              onClick={() => setBlocked(a, !a.blocked)}
                              className={cn('rounded-lg border px-2 py-1.5 text-xs', a.blocked ? 'border-teal/30 text-teal hover:bg-teal/10' : 'border-ice/12 text-muted hover:text-text')}
                              title={a.blocked ? t('platform.adminPanel.unblock') : t('platform.adminPanel.block')}
                            >
                              {a.blocked ? <Unlock size={13} /> : <Lock size={13} />}
                            </button>
                            {!a.blocked && (
                              <button onClick={() => banUser(a)} className="rounded-lg border border-danger/30 px-2 py-1.5 text-xs text-danger hover:bg-danger/10" title={t('platform.adminPanel.ban')}>
                                <Ban size={13} />
                              </button>
                            )}
                          </>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>}

      {adminCapabilities.moderate_agents && activeSection === 'agents' && (
        <section id="agents" className="card mt-6 rounded-[26px] p-6">
          <h2 className="flex items-center gap-2 text-sm font-bold text-text"><Bot size={16} className="text-violet" /> Модерация агентов · {moderatedAgents.length}</h2>
          <p className="mt-1 text-xs text-muted">Остановите агента, который нарушает правила конфиденциальности или условия использования. Удаление не выполняется — решение можно отменить.</p>
          <div className="mt-4 grid gap-2 md:grid-cols-2">
            {moderatedAgents.map((agent) => {
              const paused = agent.status === 'paused'
              return (
                <div key={agent.id} className="flex items-center gap-3 rounded-2xl border border-white/10 bg-black/10 p-3">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-semibold text-text">{agent.name}</p>
                    <p className="truncate text-xs text-muted">{agent.email ?? agent.account_id} · {agent.type}</p>
                  </div>
                  <button onClick={() => void quarantineAgent(agent, !paused)} className={cn('rounded-xl border px-3 py-1.5 text-xs font-medium', paused ? 'border-teal/30 text-teal hover:bg-teal/10' : 'border-danger/30 text-danger hover:bg-danger/10')}>
                    {paused ? 'Восстановить' : 'Остановить'}
                  </button>
                </div>
              )
            })}
          </div>
        </section>
      )}
    </div>
  )
}
