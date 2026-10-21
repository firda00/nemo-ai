import {
  Brain, Building2, Eye, EyeOff, Globe, KeyRound, Moon, RefreshCw,
  ShieldCheck, Sun, User as UserIcon, WalletCards, Webhook, GitBranch, Save,
  BookOpen, Library, Link2, Plug, Sparkles,
} from 'lucide-react'
import { useCallback, useEffect, useState, type ComponentType, type ReactNode } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { Button } from '../../components/ui/Button'
import { MfaSetupPanel } from '../../components/platform/MfaSetupPanel'
import { BriefingPanel } from '../../components/settings/BriefingPanel'
import { ReminderPanel } from '../../components/settings/ReminderPanel'
import { ConnectAIModel } from '../../components/platform/ConnectAIModel'
import BillingPage from './BillingPage'
import KnowledgePage from './KnowledgePage'
import { CapabilityDirectory, type DirectoryTab } from '../../components/platform/CapabilityDirectory'
import { useAuth } from '../../context/AuthContext'
import { useI18n } from '../../i18n'
import { cn } from '../../lib/cn'
import { applyTheme, themePreference, type ThemePreference } from '../../lib/theme'
import { isSupabaseEnabled, supabase } from '../../lib/supabase'
import type { Lang } from '../../types'

type TabId = 'profile' | 'integrations' | 'billing'
type IconType = ComponentType<{ size?: number; className?: string }>

// В массиве лежат ключи перевода, а не текст: массив создаётся один раз на модуле, а язык
// может смениться в любой момент — тогда готовая строка осталась бы от прежнего языка.
const TABS: Array<{ id: TabId; labelKey: string; compactKey: string; icon: IconType }> = [
  { id: 'profile', labelKey: 'settingsPage.tabPersonalization', compactKey: 'settingsPage.tabPersonalizationShort', icon: Brain },
  { id: 'integrations', labelKey: 'settingsPage.tabConnectors', compactKey: 'settingsPage.tabConnectorsShort', icon: Webhook },
  { id: 'billing', labelKey: 'settingsPage.tabBilling', compactKey: 'settingsPage.tabBillingShort', icon: WalletCards },
]

const inputCls = 'w-full rounded-xl border border-ice/10 bg-black/15 px-3 py-2.5 text-sm text-text outline-none transition focus:border-accent-cyan/50 focus:ring-2 focus:ring-accent-cyan/10'
const labelCls = 'mb-1.5 block text-[11px] font-semibold uppercase tracking-[0.08em] text-muted'

export default function SettingsPage() {
  const { t } = useI18n()
  const [searchParams, setSearchParams] = useSearchParams()
  const queryTab = searchParams.get('tab')
  const tab: TabId = queryTab === 'integrations' || queryTab === 'billing' ? queryTab : 'profile'

  const selectTab = (next: TabId) => {
    const params = new URLSearchParams(searchParams)
    params.set('tab', next)
    if (next !== 'integrations') params.delete('section')
    setSearchParams(params, { replace: true })
  }

  return <div className="container-page max-w-7xl py-7">
    <header>
      <h1 className="text-3xl font-extrabold tracking-tight text-text">{t('settingsPage.title')}</h1>
      <p className="mt-2 max-w-2xl text-sm leading-6 text-muted">{t('settingsPage.subtitle')}</p>
    </header>

    <nav className="mt-7 grid grid-cols-3 gap-2 rounded-2xl border border-ice/10 bg-panel/50 p-2" aria-label={t('settingsPage.navAria')}>
      {TABS.map(({ id, labelKey, compactKey, icon: Icon }) => <button key={id} type="button" onClick={() => selectTab(id)} aria-current={tab === id ? 'page' : undefined} className={cn('flex min-h-12 items-center justify-center gap-2 rounded-xl px-2 py-2 text-xs font-semibold transition duration-200 active:scale-[0.98] sm:px-3', tab === id ? 'bg-accent-cyan/10 text-text ring-1 ring-accent-cyan/30' : 'text-muted hover:bg-white/5 hover:text-text')}><Icon size={16} /><span className="hidden sm:inline">{t(labelKey)}</span><span className="sm:hidden">{t(compactKey)}</span></button>)}
    </nav>

    <div className="mt-5">
      {tab === 'profile' && <PersonalizationTab />}
      {tab === 'integrations' && <ConnectorsTab />}
      {tab === 'billing' && <BillingPage embedded />}
    </div>
  </div>
}

interface PersonalizationDraft {
  companyContext: string
  codingRules: string
  communicationTone: string
  forbiddenApproaches: string
  workspaceName: string
  industry: string
  timezone: string
}

const EMPTY_PERSONALIZATION: PersonalizationDraft = {
  companyContext: '', codingRules: '', communicationTone: '', forbiddenApproaches: '',
  workspaceName: '', industry: '', timezone: 'Asia/Tashkent',
}

function normalizePersonalization(value: unknown): PersonalizationDraft {
  const source = value && typeof value === 'object' ? value as Record<string, unknown> : {}
  const text = (key: keyof PersonalizationDraft, max: number) => typeof source[key] === 'string' ? String(source[key]).trim().slice(0, max) : EMPTY_PERSONALIZATION[key]
  return {
    companyContext: text('companyContext', 4_000),
    codingRules: text('codingRules', 4_000),
    communicationTone: text('communicationTone', 1_000),
    forbiddenApproaches: text('forbiddenApproaches', 3_000),
    workspaceName: text('workspaceName', 120),
    industry: text('industry', 160),
    timezone: text('timezone', 80) || 'Asia/Tashkent',
  }
}

function PersonalizationTab() {
  const { t } = useI18n()
  const { user, live } = useAuth()
  const storageKey = `nemo.personalization:${user?.id ?? 'anonymous'}`
  const [draft, setDraft] = useState<PersonalizationDraft>(EMPTY_PERSONALIZATION)
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState('')

  useEffect(() => {
    let active = true
    const load = async () => {
      if (live && supabase) {
        const { data } = await supabase.auth.getUser()
        if (active) setDraft(normalizePersonalization(data.user?.user_metadata?.nemo_personalization))
        return
      }
      try {
        const saved = window.localStorage.getItem(storageKey)
        if (active && saved) setDraft(normalizePersonalization(JSON.parse(saved)))
      } catch { /* optional local profile */ }
    }
    void load()
    return () => { active = false }
  }, [live, storageKey])

  const update = <K extends keyof PersonalizationDraft>(key: K, value: PersonalizationDraft[K]) => setDraft((current) => ({ ...current, [key]: value }))
  const save = async () => {
    setSaving(true); setMessage('')
    const clean = normalizePersonalization(draft)
    try {
      if (live && supabase) {
        const { error } = await supabase.auth.updateUser({ data: { nemo_personalization: clean } })
        if (error) throw error
      } else {
        window.localStorage.setItem(storageKey, JSON.stringify(clean))
      }
      setDraft(clean)
      setMessage(t('settingsPage.personalizationSaved'))
    } catch {
      setMessage(t('settingsPage.personalizationFailed'))
    } finally {
      setSaving(false)
    }
  }

  return <div className="space-y-5">
    <div className="grid gap-5 xl:grid-cols-[1.2fr_.8fr]">
      <Panel icon={Brain} title={t('settingsPage.personalizationTitle')} description={t('settingsPage.personalizationDesc')}>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={t('settingsPage.companyContext')}><textarea value={draft.companyContext} onChange={(event) => update('companyContext', event.target.value)} rows={5} maxLength={4_000} placeholder={t('settingsPage.companyContextPlaceholder')} className={`${inputCls} resize-y leading-6`} /></Field>
          <Field label={t('settingsPage.codingRules')}><textarea value={draft.codingRules} onChange={(event) => update('codingRules', event.target.value)} rows={5} maxLength={4_000} placeholder={t('settingsPage.codingRulesPlaceholder')} className={`${inputCls} resize-y leading-6`} /></Field>
          <Field label={t('settingsPage.communicationTone')}><textarea value={draft.communicationTone} onChange={(event) => update('communicationTone', event.target.value)} rows={4} maxLength={1_000} placeholder={t('settingsPage.communicationTonePlaceholder')} className={`${inputCls} resize-y leading-6`} /></Field>
          <Field label={t('settingsPage.forbiddenApproaches')}><textarea value={draft.forbiddenApproaches} onChange={(event) => update('forbiddenApproaches', event.target.value)} rows={4} maxLength={3_000} placeholder={t('settingsPage.forbiddenApproachesPlaceholder')} className={`${inputCls} resize-y leading-6`} /></Field>
        </div>
        <div className="mt-5 flex flex-wrap items-center gap-3"><Button onClick={() => void save()} loading={saving} leftIcon={<Save size={15} />}>{t('settingsPage.saveInstructions')}</Button><p role="status" className="text-xs text-muted">{message || t('settingsPage.personalizationScope')}</p></div>
      </Panel>

      <Panel icon={Building2} title={t('settingsPage.workspaceTitle')} description={t('settingsPage.workspaceDesc')}>
        <div className="space-y-4">
          <Field label={t('settingsPage.workspaceName')}><input value={draft.workspaceName} onChange={(event) => update('workspaceName', event.target.value)} maxLength={120} className={inputCls} placeholder="Nemo AI" /></Field>
          <Field label={t('settingsPage.industry')}><input value={draft.industry} onChange={(event) => update('industry', event.target.value)} maxLength={160} className={inputCls} placeholder={t('settingsPage.industryPlaceholder')} /></Field>
          <Field label={t('settingsPage.timezone')}><select value={draft.timezone} onChange={(event) => update('timezone', event.target.value)} className={inputCls}><option value="Asia/Tashkent">Asia/Tashkent</option><option value="Asia/Almaty">Asia/Almaty</option><option value="Europe/Moscow">Europe/Moscow</option><option value="UTC">UTC</option></select></Field>
          {/* Единственный вход на /app/memory: сайдбар упрощён до трёх пунктов, и без этой
              ссылки выпущенный экран памяти снова станет сиротой (org-memory contract). */}
          <Link to="/app/memory" className="group flex items-center gap-3 rounded-xl border border-ice/10 bg-black/15 px-3 py-2.5 text-sm font-semibold text-text transition duration-200 hover:border-accent-cyan/40 hover:bg-white/5">
            <Library size={16} className="text-accent-cyan" />
            {t('appLayout.navMemory')}
            <span aria-hidden className="ml-auto text-fog transition group-hover:translate-x-0.5 group-hover:text-muted">→</span>
          </Link>
        </div>
      </Panel>
    </div>

    <div className="grid gap-5 xl:grid-cols-2">
      <ConnectAIModel />
      <GitHubKeyCard />
    </div>
    <BriefingPanel />
    <ReminderPanel />
    <ProfilePreferences />
  </div>
}

function ProfilePreferences() {
  const { t, lang, setLang } = useI18n()
  const { user, updateUser } = useAuth()
  const [theme, setTheme] = useState<ThemePreference>(themePreference)
  const languages: Array<{ code: Lang; label: string }> = [{ code: 'uz', label: "O‘zbekcha" }, { code: 'ru', label: 'Русский' }, { code: 'en', label: 'English' }]

  return <div className="grid gap-5 lg:grid-cols-2">
    <Panel icon={UserIcon} title={t('settingsPage.profileTitle')} description={t('settingsPage.profileDesc')}>
      <div className="space-y-4">
        <Field label={t('settingsPage.fieldName')}><input value={user?.name ?? ''} onChange={(event) => updateUser({ name: event.target.value })} className={inputCls} /></Field>
        <Field label={t('settingsPage.fieldLang')}><select value={lang} onChange={(event) => { const next = event.target.value as Lang; setLang(next); updateUser({ lang: next }) }} className={inputCls}>{languages.map((item) => <option key={item.code} value={item.code}>{item.label}</option>)}</select></Field>
        <Field label={t('settingsPage.fieldTheme')}><div className="grid grid-cols-3 gap-2">{([{ id: 'light', icon: Sun }, { id: 'dark', icon: Moon }, { id: 'system', icon: Globe }] as const).map(({ id, icon: Icon }) => <button key={id} type="button" onClick={() => { setTheme(id); applyTheme(id) }} className={cn('flex items-center justify-center rounded-xl border py-2.5 transition duration-200 active:scale-[0.98]', theme === id ? 'border-accent-cyan/45 bg-accent-cyan/10 text-accent-cyan' : 'border-ice/10 text-muted hover:bg-white/5 hover:text-text')} aria-label={id}><Icon size={16} /></button>)}</div></Field>
      </div>
    </Panel>
    <Panel icon={ShieldCheck} title={t('settingsPage.mfaTitle')} description={t('settingsPage.mfaDesc')}><MfaSetupPanel /></Panel>
  </div>
}

function GitHubKeyCard() {
  const { t } = useI18n()
  const [key, setKey] = useState('')
  const [connected, setConnected] = useState(false)
  const [loading, setLoading] = useState(isSupabaseEnabled)
  const [busy, setBusy] = useState(false)
  const [visible, setVisible] = useState(false)
  const [message, setMessage] = useState('')
  const valid = /^(?:ghp_|github_pat_)[A-Za-z0-9_]{16,}$/.test(key.trim())

  const refresh = useCallback(async () => {
    if (!supabase) { setLoading(false); return }
    try {
      const { data } = await supabase.functions.invoke('connect-provider', { body: { action: 'status' } })
      const payload = data as { connected?: string[] } | null
      setConnected(payload?.connected?.includes('github') === true)
    } catch { /* status remains disconnected */ }
    setLoading(false)
  }, [])

  useEffect(() => {
    const timer = window.setTimeout(() => void refresh(), 0)
    return () => window.clearTimeout(timer)
  }, [refresh])

  const connect = async () => {
    if (!supabase || !valid) { setMessage(t('settingsPage.githubNeedBackend')); return }
    setBusy(true); setMessage('')
    try {
      const { data, error } = await supabase.functions.invoke('connect-provider', { body: { action: 'connect', provider: 'github', api_key: key.trim() } })
      const payload = data as { ok?: boolean; error?: string } | null
      if (error || !payload?.ok) throw new Error(payload?.error || 'connect failed')
      setConnected(true); setKey(''); setMessage(t('settingsPage.githubConnected'))
    } catch { setMessage(t('settingsPage.githubFailed')) } finally { setBusy(false) }
  }

  const disconnect = async () => {
    if (!supabase) return
    setBusy(true); setMessage('')
    try {
      await supabase.functions.invoke('connect-provider', { body: { action: 'disconnect', provider: 'github' } })
      setConnected(false); setMessage(t('settingsPage.githubDisconnected'))
    } catch { setMessage(t('settingsPage.githubFailed')) } finally { setBusy(false) }
  }

  return <section className="card rounded-3xl p-6">
    <div className="flex items-start gap-3"><span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-white/[0.06] text-text"><GitBranch size={18} /></span><div className="min-w-0 flex-1"><div className="flex flex-wrap items-center justify-between gap-2"><h2 className="text-lg font-bold text-text">{t('settingsPage.githubTitle')}</h2>{connected && <span className="rounded-lg bg-teal/10 px-2 py-1 text-[10px] font-semibold text-teal">{t('settingsPage.connected')}</span>}</div><p className="mt-1 text-sm leading-5 text-muted">{t('settingsPage.githubDesc')}</p></div></div>
    {loading ? <div className="mt-5 flex items-center gap-2 text-xs text-muted"><RefreshCw size={14} className="animate-spin" />{t('common.loading')}</div> : connected ? <Button className="mt-5" variant="secondary" onClick={() => void disconnect()} loading={busy}>{t('settingsPage.disconnectGithub')}</Button> : <div className="mt-5"><div className="relative"><input type={visible ? 'text' : 'password'} value={key} onChange={(event) => setKey(event.target.value)} placeholder="github_pat_…" autoComplete="new-password" spellCheck={false} className={`${inputCls} pr-10`} /><button type="button" onClick={() => setVisible((current) => !current)} aria-label={visible ? t('settingsPage.hideSecret') : t('settingsPage.showSecret')} className="absolute right-3 top-1/2 -translate-y-1/2 text-muted hover:text-text">{visible ? <EyeOff size={15} /> : <Eye size={15} />}</button></div><Button className="mt-3" onClick={() => void connect()} disabled={!valid || busy} loading={busy} leftIcon={<KeyRound size={14} />}>{t('settingsPage.connectGithub')}</Button></div>}
    {message && <p role="status" className="mt-3 text-xs leading-5 text-muted">{message}</p>}
    <p className="mt-4 flex items-start gap-2 text-[11px] leading-5 text-fog"><ShieldCheck size={13} className="mt-0.5 shrink-0 text-teal" />{t('settingsPage.githubSecurity')}</p>
  </section>
}

function ConnectorsTab() {
  const { t } = useI18n()
  const [searchParams] = useSearchParams()
  const querySection = searchParams.get('section')
  const directoryQuery = searchParams.get('directory')
  const requestedDirectory: DirectoryTab = directoryQuery === 'skills' || directoryQuery === 'plugins' ? directoryQuery : 'connectors'
  const legacyDirectory = querySection === 'skills' || querySection === 'services'
  const [directoryOpen, setDirectoryOpen] = useState(Boolean(directoryQuery || legacyDirectory))
  const [directoryTab, setDirectoryTab] = useState<DirectoryTab>(legacyDirectory && !searchParams.get('integration') ? 'skills' : requestedDirectory)

  const openDirectory = (next: DirectoryTab) => { setDirectoryTab(next); setDirectoryOpen(true) }
  return <div className="space-y-5">
    <section className="relative overflow-hidden rounded-[1.75rem] border border-cyan/15 bg-panel px-5 pb-6 pt-6 shadow-[0_18px_55px_rgba(14,31,58,.08)] sm:px-7 sm:pb-7">
      <div className="pointer-events-none absolute -right-20 -top-28 h-72 w-72 rounded-full bg-cyan/[0.08] blur-3xl" />
      <div className="relative flex flex-col gap-6 lg:flex-row lg:items-end lg:justify-between">
        <div className="max-w-2xl">
          <div className="flex items-center gap-3"><span className="grid h-11 w-11 place-items-center rounded-2xl bg-cyan/10 text-cyan ring-1 ring-inset ring-cyan/20"><Library size={20} /></span><div><p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-cyan">{t('settingsPage.directoryEyebrow')}</p><h2 className="mt-0.5 text-2xl font-bold tracking-tight text-text">{t('settingsPage.directoryTitle')}</h2></div></div>
          <p className="mt-4 max-w-xl text-sm leading-6 text-muted">{t('settingsPage.directoryDesc')}</p>
        </div>
        <Button onClick={() => openDirectory('connectors')} className="shrink-0" leftIcon={<Library size={16} />}>{t('settingsPage.directoryOpen')}</Button>
      </div>
      <div className="relative mt-6 grid gap-2 sm:grid-cols-3">
        {([
          { id: 'connectors' as const, label: t('settingsPage.directoryConnections'), icon: Link2, tone: 'text-cyan bg-cyan/10' },
          { id: 'skills' as const, label: t('settingsPage.directorySkills'), icon: Sparkles, tone: 'text-violet bg-violet/10' },
          { id: 'plugins' as const, label: t('settingsPage.directoryPlugins'), icon: Plug, tone: 'text-amber bg-amber/10' },
        ]).map(({ id, label, icon: Icon, tone }) => <button key={id} type="button" onClick={() => openDirectory(id)} className="group flex items-center gap-3 rounded-2xl bg-black/[0.08] px-4 py-3 text-left ring-1 ring-inset ring-ice/10 transition duration-200 hover:-translate-y-0.5 hover:bg-white/[0.055] hover:ring-ice/20 active:translate-y-0"><span className={cn('grid h-9 w-9 place-items-center rounded-xl', tone)}><Icon size={16} /></span><span className="text-sm font-semibold text-text">{label}</span><span className="ml-auto text-fog transition group-hover:translate-x-0.5 group-hover:text-muted">→</span></button>)}
      </div>
    </section>

    <section id="knowledge-base" className="scroll-mt-24 rounded-[1.75rem] border border-ice/10 bg-panel p-5 sm:p-7">
      <div className="mb-6 flex items-start gap-3"><span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-white/[0.055] text-text"><BookOpen size={18} /></span><div><h2 className="text-lg font-semibold text-text">{t('settingsPage.knowledgeTitle')}</h2><p className="mt-1 max-w-2xl text-xs leading-5 text-muted">{t('settingsPage.knowledgeDesc')}</p></div></div>
      <KnowledgePage embedded />
    </section>
    <CapabilityDirectory key={directoryTab} open={directoryOpen} onClose={() => setDirectoryOpen(false)} initialTab={directoryTab} />
  </div>
}

function Panel({ icon: Icon, title, description, children }: { icon: IconType; title: string; description: string; children: ReactNode }) { return <section className="card rounded-2xl p-5 sm:p-6"><div className="flex items-start gap-3"><span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-accent-cyan/15 to-accent-indigo/15 text-accent-cyan"><Icon size={18} /></span><div><h2 className="font-semibold text-text">{title}</h2><p className="mt-1 text-xs leading-5 text-muted">{description}</p></div></div><div className="mt-5">{children}</div></section> }
function Field({ label, children }: { label: string; children: ReactNode }) { return <label className="block"><span className={labelCls}>{label}</span>{children}</label> }
