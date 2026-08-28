import {
  Activity, AlertTriangle, CheckCircle2, Clipboard, CloudCog, Cpu, Download,
  Eye, EyeOff, FileKey2, Gauge, Globe, HardDrive, HeartPulse, KeyRound,
  LockKeyhole, Moon, RefreshCw, RotateCw, ShieldCheck, Sun, TerminalSquare,
  User as UserIcon, WalletCards, Webhook, Wrench,
} from 'lucide-react'
import { useCallback, useEffect, useState, type ComponentType, type ReactNode } from 'react'
import { Button } from '../../components/ui/Button'
import { MfaSetupPanel } from '../../components/platform/MfaSetupPanel'
import { ConnectAIModel } from '../../components/platform/ConnectAIModel'
import { useAuth } from '../../context/AuthContext'
import { useI18n } from '../../i18n'
import { cn } from '../../lib/cn'
import { DEFAULT_FORGE_SETTINGS, buildForgeDiagnosticBundle } from '../../lib/forge-settings'
import { applyTheme, themePreference, type ThemePreference } from '../../lib/theme'
import { isSupabaseEnabled, supabase } from '../../lib/supabase'
import {
  ConnectorHealthSchema, ForgeGovernanceConfigSchema, ForgeIntegrationSecretInputSchema,
  ForgeSecretRotationResultSchema, ForgeWorkerConfigSchema, type ConnectorHealth,
  type ForgeGovernanceConfig, type ForgeWorkerConfig,
} from '../../types/forge-settings'
import type { Lang } from '../../types'

type TabId = 'connectors' | 'compute' | 'governance' | 'support'
type IconType = ComponentType<{ size?: number; className?: string }>

// В массиве лежат ключи перевода, а не текст: массив создаётся один раз на модуле, а язык
// может смениться в любой момент — тогда готовая строка осталась бы от прежнего языка.
const TABS: Array<{ id: TabId; labelKey: string; compactKey: string; icon: IconType }> = [
  { id: 'connectors', labelKey: 'settingsPage.tabConnectors', compactKey: 'settingsPage.tabConnectorsShort', icon: Webhook },
  { id: 'compute', labelKey: 'settingsPage.tabCompute', compactKey: 'settingsPage.tabComputeShort', icon: Cpu },
  { id: 'governance', labelKey: 'settingsPage.tabGovernance', compactKey: 'settingsPage.tabGovernanceShort', icon: ShieldCheck },
  { id: 'support', labelKey: 'settingsPage.tabSupport', compactKey: 'settingsPage.tabSupportShort', icon: HeartPulse },
]

const inputCls = 'w-full rounded-xl border border-ice/10 bg-black/15 px-3 py-2.5 text-sm text-text outline-none transition focus:border-accent-cyan/50 focus:ring-2 focus:ring-accent-cyan/10'
const labelCls = 'mb-1.5 block text-[11px] font-semibold uppercase tracking-[0.08em] text-muted'

function initialHealth(): ConnectorHealth[] {
  const checkedAt = new Date().toISOString()
  return [
    { connectorId: 'forge-runtime', label: 'Forge Runtime', status: isSupabaseEnabled ? 'unknown' : 'unconfigured', latencyMs: null, activeInboxJobs: null, checkedAt, message: isSupabaseEnabled ? 'settingsPage.msgAwaitingCheck' : 'Demo mode' },
    { connectorId: 'amocrm', label: 'amoCRM', status: 'unknown', latencyMs: null, activeInboxJobs: null, checkedAt },
    { connectorId: 'telegram', label: 'Telegram', status: 'unknown', latencyMs: null, activeInboxJobs: null, checkedAt },
    { connectorId: 'uzum', label: 'Uzum Market', status: 'unknown', latencyMs: null, activeInboxJobs: null, checkedAt },
    { connectorId: 'ffmpeg-worker', label: 'FFmpeg Worker', status: 'unknown', latencyMs: null, activeInboxJobs: null, checkedAt, message: 'settingsPage.msgEdgeAgent' },
    { connectorId: 'whisper-worker', label: 'Whisper Worker', status: 'unknown', latencyMs: null, activeInboxJobs: null, checkedAt, message: 'settingsPage.msgEdgeAgent' },
  ].map((item) => ConnectorHealthSchema.parse(item))
}

export default function SettingsPage() {
  const { t } = useI18n()
  const [tab, setTab] = useState<TabId>('connectors')
  const [health, setHealth] = useState<ConnectorHealth[]>(initialHealth)
  const [checking, setChecking] = useState(false)
  const [operationsError, setOperationsError] = useState('')

  const refreshHealth = useCallback(async () => {
    setChecking(true)
    setOperationsError('')
    const checkedAt = new Date().toISOString()
    if (!supabase) {
      setHealth(initialHealth())
      setChecking(false)
      return
    }
    const started = performance.now()
    const [providerResult, backendResult, telegramResult] = await Promise.all([
      supabase.functions.invoke('connect-provider', { body: { action: 'status' } }),
      supabase.functions.invoke('backend-status', { body: {} }),
      supabase.from('channels').select('id').eq('type', 'telegram').limit(1),
    ])
    const latencyMs = Math.max(0, Math.round(performance.now() - started))
    const connected = new Set((providerResult.data as { connected?: string[] } | null)?.connected ?? [])
    const backendOk = !backendResult.error && (backendResult.data as { ok?: boolean } | null)?.ok === true
    const telegramOk = !telegramResult.error && (telegramResult.data?.length ?? 0) > 0
    setHealth(initialHealth().map((item): ConnectorHealth => {
      if (item.connectorId === 'forge-runtime') return { ...item, status: backendOk ? 'healthy' : 'degraded', latencyMs, checkedAt, message: backendOk ? 'settingsPage.msgJwtConfirmed' : 'settingsPage.msgBackendDown' }
      if (item.connectorId === 'amocrm') return { ...item, status: connected.has('amocrm') ? 'healthy' : 'unconfigured', latencyMs, checkedAt }
      if (item.connectorId === 'uzum') return { ...item, status: connected.has('uzum') ? 'healthy' : 'unconfigured', latencyMs, checkedAt }
      if (item.connectorId === 'telegram') return { ...item, status: telegramOk ? 'healthy' : 'unconfigured', latencyMs, checkedAt }
      return { ...item, checkedAt }
    }).map((item) => ConnectorHealthSchema.parse(item)))
    if (providerResult.error || backendResult.error) setOperationsError(t('settingsPage.diagPartial'))
    setChecking(false)
  }, [t])

  useEffect(() => {
    const timer = window.setTimeout(() => void refreshHealth(), 0)
    return () => window.clearTimeout(timer)
  }, [refreshHealth])

  return <div className="container-page max-w-7xl py-7">
    <header className="flex flex-wrap items-start justify-between gap-4">
      <div>
        <p className="mono-label">Nemo Control Plane</p>
        <h1 className="mt-2 text-3xl font-extrabold tracking-tight text-text">{t('settingsPage.title')}</h1>
        <p className="mt-2 max-w-2xl text-sm leading-6 text-muted">{t('settingsPage.subtitle')}</p>
      </div>
      <div className="flex items-center gap-2 rounded-xl border border-ice/10 bg-panel/60 px-3 py-2 text-xs text-muted"><span className={cn('h-2 w-2 rounded-full', isSupabaseEnabled ? 'bg-teal' : 'bg-amber')} />{isSupabaseEnabled ? 'Live tenant context' : 'Demo mode'}</div>
    </header>

    <nav className="mt-7 grid grid-cols-2 gap-2 rounded-2xl border border-ice/10 bg-panel/50 p-2 lg:grid-cols-4" aria-label={t('settingsPage.navAria')}>
      {TABS.map(({ id, labelKey, compactKey, icon: Icon }) => <button key={id} type="button" onClick={() => setTab(id)} aria-current={tab === id ? 'page' : undefined} className={cn('flex min-h-12 items-center justify-center gap-2 rounded-xl px-3 py-2 text-xs font-semibold transition', tab === id ? 'bg-gradient-to-r from-accent-cyan/15 to-accent-indigo/15 text-text ring-1 ring-accent-cyan/30' : 'text-muted hover:bg-white/5 hover:text-text')}><Icon size={16} /><span className="hidden sm:inline lg:hidden xl:inline">{t(labelKey)}</span><span className="sm:hidden lg:inline xl:hidden">{t(compactKey)}</span></button>)}
    </nav>

    {operationsError && <div className="mt-4 flex items-center gap-2 rounded-xl border border-amber/25 bg-amber/10 px-4 py-3 text-xs text-amber"><AlertTriangle size={15} />{operationsError}</div>}
    <div className="mt-5">
      {tab === 'connectors' && <ConnectorsTab health={health} onRefresh={refreshHealth} checking={checking} />}
      {tab === 'compute' && <ComputeTab health={health} />}
      {tab === 'governance' && <GovernanceTab />}
      {tab === 'support' && <SupportTab health={health} onRefresh={refreshHealth} checking={checking} />}
    </div>
  </div>
}

function ConnectorsTab({ health, onRefresh, checking }: { health: ConnectorHealth[]; onRefresh(): Promise<void>; checking: boolean }) {
  const { t } = useI18n()
  const [amoSubdomain, setAmoSubdomain] = useState('')
  const [secretDrafts, setSecretDrafts] = useState({ telegram: '', uzum: '' })
  const [visible, setVisible] = useState<Record<string, boolean>>({})
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)
  const [oneTimeUrl, setOneTimeUrl] = useState('')

  const rotateAmo = async () => {
    setNotice(''); setOneTimeUrl('')
    if (!supabase || !amoSubdomain.trim()) { setNotice(t('settingsPage.amoNeedBackend')); return }
    setBusy(true)
    const { data, error } = await supabase.functions.invoke('amocrm-webhook-secret', { body: { action: 'rotate', subdomain: amoSubdomain.trim().toLowerCase() } })
    const payload = data as { webhook_url?: string; previous_valid_until?: string | null; shown_once?: boolean; error?: string } | null
    if (error || !payload?.webhook_url || payload.shown_once !== true) setNotice(payload?.error || t('settingsPage.amoRotateFailed'))
    else {
      const validated = ForgeSecretRotationResultSchema.parse({ provider: 'amocrm', rotatedAt: new Date().toISOString(), previousValidUntil: payload.previous_valid_until ?? null, shownOnce: true, webhookUrl: payload.webhook_url })
      setOneTimeUrl(validated.webhookUrl ?? '')
      setNotice(t('settingsPage.amoRotated'))
      void onRefresh()
    }
    setBusy(false)
  }
  const validateDraft = (provider: 'telegram' | 'uzum') => {
    const result = ForgeIntegrationSecretInputSchema.safeParse({ provider, secret: secretDrafts[provider] })
    setNotice(result.success ? t('settingsPage.secretFormatOk', { kind: provider === 'telegram' ? 'Telegram Secret Token' : 'Uzum HMAC' }) : result.error.issues[0]?.message ?? t('settingsPage.secretInvalid'))
  }

  return <div className="grid gap-5 xl:grid-cols-[1.35fr_.65fr]">
    <div className="space-y-5">
      <Panel icon={KeyRound} title={t('settingsPage.webhooksTitle')} description={t('settingsPage.webhooksDesc')}>
        <div className="space-y-4">
          <IntegrationRow title="amoCRM" subtitle="Lifecycle endpoint · 24h grace" status={findStatus(health, 'amocrm')}>
            <div className="grid gap-2 sm:grid-cols-[1fr_auto]"><input value={amoSubdomain} onChange={(event) => setAmoSubdomain(event.target.value)} className={inputCls} placeholder="your-company" autoComplete="off" /><Button size="sm" variant="secondary" loading={busy} onClick={() => void rotateAmo()} leftIcon={<RotateCw size={14} />}>{t('settingsPage.rotate')}</Button></div>
          </IntegrationRow>
          {(['telegram', 'uzum'] as const).map((provider) => <IntegrationRow key={provider} title={provider === 'telegram' ? 'Telegram Forge' : 'Uzum Event Bridge'} subtitle={provider === 'telegram' ? 'X-Telegram-Bot-Api-Secret-Token' : 'HMAC-SHA256 + replay window'} status={findStatus(health, provider)}>
            <div className="grid gap-2 sm:grid-cols-[1fr_auto]"><div className="relative"><input type={visible[provider] ? 'text' : 'password'} value={secretDrafts[provider]} onChange={(event) => setSecretDrafts((current) => ({ ...current, [provider]: event.target.value }))} className={`${inputCls} pr-10`} placeholder="Write-only secret" autoComplete="new-password" spellCheck={false} /><button type="button" onClick={() => setVisible((current) => ({ ...current, [provider]: !current[provider] }))} aria-label={visible[provider] ? t('settingsPage.hideSecret') : t('settingsPage.showSecret')} className="absolute right-3 top-1/2 -translate-y-1/2 text-muted hover:text-text">{visible[provider] ? <EyeOff size={15} /> : <Eye size={15} />}</button></div><Button size="sm" variant="secondary" onClick={() => validateDraft(provider)}>{t('settingsPage.verify')}</Button></div>
          </IntegrationRow>)}
        </div>
        {(notice || oneTimeUrl) && <div className="mt-4 rounded-xl border border-accent-cyan/20 bg-accent-cyan/5 p-3 text-xs leading-5 text-muted"><p>{notice}</p>{oneTimeUrl && <div className="mt-2 flex items-center gap-2"><code className="min-w-0 flex-1 truncate rounded-lg bg-black/20 px-2 py-1.5 text-accent-cyan">{oneTimeUrl}</code><button type="button" aria-label={t('settingsPage.copyUrl')} onClick={() => void navigator.clipboard.writeText(oneTimeUrl)} className="rounded-lg border border-ice/10 p-2 text-muted hover:text-text"><Clipboard size={14} /></button></div>}</div>}
      </Panel>
      <ConnectAIModel />
    </div>
    <Panel icon={Activity} title={t('settingsPage.channelsTitle')} description={t('settingsPage.channelsDesc')}><HealthList health={health.filter((item) => ['forge-runtime', 'amocrm', 'telegram', 'uzum'].includes(item.connectorId))} /><Button variant="secondary" size="sm" fullWidth className="mt-4" loading={checking} onClick={() => void onRefresh()} leftIcon={<RefreshCw size={14} />}>{t('settingsPage.refreshStatuses')}</Button></Panel>
  </div>
}

function ComputeTab({ health }: { health: ConnectorHealth[] }) {
  const { t } = useI18n()
  const [config, setConfig] = useState<ForgeWorkerConfig>(DEFAULT_FORGE_SETTINGS.worker)
  const [message, setMessage] = useState('')
  const update = <K extends keyof ForgeWorkerConfig>(key: K, value: ForgeWorkerConfig[K]) => setConfig((current) => ({ ...current, [key]: value }))
  const validate = () => { const result = ForgeWorkerConfigSchema.safeParse(config); setMessage(result.success ? t('settingsPage.computeValid') : result.error.issues.map((issue) => issue.message).join(' · ')) }
  return <div className="grid gap-5 lg:grid-cols-[1fr_320px]">
    <Panel icon={TerminalSquare} title={t('settingsPage.computeTitle')} description={t('settingsPage.computeDesc')}>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="FFmpeg binary"><input value={config.ffmpegPath} onChange={(event) => update('ffmpegPath', event.target.value)} className={inputCls} spellCheck={false} /></Field>
        <Field label="Whisper CLI"><input value={config.whisperPath} onChange={(event) => update('whisperPath', event.target.value)} className={inputCls} spellCheck={false} /></Field>
        <Field label={t('settingsPage.fieldWorkers')}><input type="number" min={1} max={32} value={config.maxConcurrentWorkers} onChange={(event) => update('maxConcurrentWorkers', Number(event.target.value))} className={inputCls} /></Field>
        <Field label={t('settingsPage.fieldBudgetDefault')}><input type="number" min="0.01" step="0.01" value={config.defaultBudgetCapUsd} onChange={(event) => update('defaultBudgetCapUsd', Number(event.target.value))} className={inputCls} /></Field>
        <Field label={t('settingsPage.fieldTranscription')}><select value={config.transcriptionModel} onChange={(event) => update('transcriptionModel', event.target.value as ForgeWorkerConfig['transcriptionModel'])} className={inputCls}>{['tiny', 'base', 'small', 'medium'].map((value) => <option key={value}>{value}</option>)}</select></Field>
        <Field label={t('settingsPage.fieldCodec')}><select value={config.videoCodec} onChange={(event) => update('videoCodec', event.target.value as ForgeWorkerConfig['videoCodec'])} className={inputCls}><option value="h264">H.264</option><option value="h265">H.265</option><option value="vp9">VP9</option></select></Field>
      </div>
      <div className="mt-5 flex flex-wrap items-center gap-3"><Button onClick={validate} leftIcon={<Wrench size={15} />}>{t('settingsPage.checkConfig')}</Button><p className="max-w-xl text-xs leading-5 text-muted">{message || t('settingsPage.pathsNote')}</p></div>
    </Panel>
    <Panel icon={HardDrive} title={t('settingsPage.localTitle')} description={t('settingsPage.localDesc')}><HealthList health={health.filter((item) => item.connectorId.endsWith('-worker'))} /><div className="mt-4 rounded-xl border border-ice/10 bg-black/10 p-3 text-xs leading-5 text-muted">{t('settingsPage.profilesNote')}</div></Panel>
  </div>
}

function GovernanceTab() {
  const { t, lang, setLang } = useI18n()
  const { user, updateUser } = useAuth()
  const [theme, setTheme] = useState<ThemePreference>(themePreference)
  const [config, setConfig] = useState<ForgeGovernanceConfig>(DEFAULT_FORGE_SETTINGS.governance)
  const [message, setMessage] = useState('')
  const update = <K extends keyof ForgeGovernanceConfig>(key: K, value: ForgeGovernanceConfig[K]) => setConfig((current) => ({ ...current, [key]: value }))
  const validate = () => { const result = ForgeGovernanceConfigSchema.safeParse(config); setMessage(result.success ? t('settingsPage.policyValid') : result.error.issues.map((issue) => issue.message).join(' · ')) }
  const languages: Array<{ code: Lang; label: string }> = [{ code: 'uz', label: "O‘zbekcha" }, { code: 'ru', label: 'Русский' }, { code: 'en', label: 'English' }]
  return <div className="space-y-5">
    <div className="grid gap-5 lg:grid-cols-2">
      <Panel icon={WalletCards} title={t('settingsPage.budgetTitle')} description={t('settingsPage.budgetDesc')}>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={t('settingsPage.fieldBudgetCap')}><input type="number" min="0.01" step="0.01" value={config.defaultBudgetCapUsd} onChange={(event) => update('defaultBudgetCapUsd', Number(event.target.value))} className={inputCls} /></Field>
          <Field label={t('settingsPage.fieldHardCap')}><input type="number" min="0.01" step="0.01" value={config.hardProjectCapUsd} onChange={(event) => update('hardProjectCapUsd', Number(event.target.value))} className={inputCls} /></Field>
          <Field label={t('settingsPage.fieldRights')}><select value={config.contentRightsPolicy} onChange={(event) => update('contentRightsPolicy', event.target.value as ForgeGovernanceConfig['contentRightsPolicy'])} className={inputCls}><option value="fail_closed">Fail-closed RightsManifest</option><option value="strict_cc0">{t('settingsPage.rightsCc0')}</option></select></Field>
          <div className="rounded-xl border border-teal/20 bg-teal/5 p-3 text-xs leading-5 text-muted"><CheckCircle2 size={16} className="mb-2 text-teal" />{t('settingsPage.approvalAlways')}</div>
        </div>
        <div className="mt-4 flex flex-wrap items-center gap-3"><Button onClick={validate} leftIcon={<Gauge size={15} />}>{t('settingsPage.checkPolicy')}</Button><span className="text-xs text-muted">{message}</span></div>
      </Panel>
      <Panel icon={ShieldCheck} title={t('settingsPage.mfaTitle')} description={t('settingsPage.mfaDesc')}><MfaSetupPanel /></Panel>
    </div>
    <Panel icon={UserIcon} title={t('settingsPage.profileTitle')} description={t('settingsPage.profileDesc')}>
      <div className="grid gap-5 lg:grid-cols-3">
        <Field label={t('settingsPage.fieldName')}><input value={user?.name ?? ''} onChange={(event) => updateUser({ name: event.target.value })} className={inputCls} /></Field>
        <Field label={t('settingsPage.fieldLang')}><select value={lang} onChange={(event) => { const next = event.target.value as Lang; setLang(next); updateUser({ lang: next }) }} className={inputCls}>{languages.map((item) => <option key={item.code} value={item.code}>{item.label}</option>)}</select></Field>
        <Field label={t('settingsPage.fieldTheme')}><div className="grid grid-cols-3 gap-2">{([{ id: 'light', icon: Sun }, { id: 'dark', icon: Moon }, { id: 'system', icon: Globe }] as const).map(({ id, icon: Icon }) => <button key={id} type="button" onClick={() => { setTheme(id); applyTheme(id) }} className={cn('flex items-center justify-center rounded-xl border py-2.5 transition', theme === id ? 'border-violet/50 bg-violet/10 text-violet' : 'border-ice/10 text-muted hover:text-text')} aria-label={id}><Icon size={16} /></button>)}</div></Field>
      </div>
    </Panel>
  </div>
}

function SupportTab({ health, onRefresh, checking }: { health: ConnectorHealth[]; onRefresh(): Promise<void>; checking: boolean }) {
  const { t } = useI18n()
  const [exported, setExported] = useState('')
  const exportDiagnostics = () => {
    const bundle = buildForgeDiagnosticBundle({ appVersion: 'nemo-web-2026.08', connectors: health, settings: DEFAULT_FORGE_SETTINGS })
    const url = URL.createObjectURL(new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' }))
    const anchor = document.createElement('a'); anchor.href = url; anchor.download = `nemo-diagnostics-${new Date().toISOString().slice(0, 10)}.json`; anchor.click(); URL.revokeObjectURL(url)
    setExported(t('settingsPage.bundleReady'))
  }
  return <div className="grid gap-5 lg:grid-cols-[1fr_360px]">
    <Panel icon={HeartPulse} title={t('settingsPage.diagTitle')} description={t('settingsPage.diagDesc', { healthy: health.filter((item) => item.status === 'healthy').length, total: health.length })}><HealthList health={health} /><div className="mt-5 flex flex-wrap gap-2"><Button size="sm" variant="secondary" loading={checking} onClick={() => void onRefresh()} leftIcon={<RefreshCw size={14} />}>{t('settingsPage.runCheck')}</Button><Button size="sm" onClick={exportDiagnostics} leftIcon={<Download size={14} />}>{t('settingsPage.downloadBundle')}</Button></div>{exported && <p className="mt-3 text-xs text-teal">{exported}</p>}</Panel>
    <Panel icon={CloudCog} title="Nemo Support" description={t('settingsPage.supportDesc')}><div className="space-y-3"><SupportRule icon={LockKeyhole} title={t('settingsPage.ruleSecretsTitle')} text={t('settingsPage.ruleSecretsText')} /><SupportRule icon={FileKey2} title={t('settingsPage.ruleBillingTitle')} text={t('settingsPage.ruleBillingText')} /><SupportRule icon={Activity} title={t('settingsPage.ruleDiagTitle')} text={t('settingsPage.ruleDiagText')} /></div><Button onClick={exportDiagnostics} variant="secondary" fullWidth className="mt-5">{t('settingsPage.downloadForSupport')}</Button></Panel>
  </div>
}

function Panel({ icon: Icon, title, description, children }: { icon: IconType; title: string; description: string; children: ReactNode }) { return <section className="card rounded-2xl p-5 sm:p-6"><div className="flex items-start gap-3"><span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-accent-cyan/15 to-accent-indigo/15 text-accent-cyan"><Icon size={18} /></span><div><h2 className="font-semibold text-text">{title}</h2><p className="mt-1 text-xs leading-5 text-muted">{description}</p></div></div><div className="mt-5">{children}</div></section> }
function Field({ label, children }: { label: string; children: ReactNode }) { return <label className="block"><span className={labelCls}>{label}</span>{children}</label> }
function findStatus(health: ConnectorHealth[], connectorId: ConnectorHealth['connectorId']) { return health.find((item) => item.connectorId === connectorId)?.status ?? 'unknown' }
function IntegrationRow({ title, subtitle, status, children }: { title: string; subtitle: string; status: ConnectorHealth['status']; children: ReactNode }) { return <div className="rounded-2xl border border-ice/10 bg-white/[0.025] p-4"><div className="mb-3 flex items-center justify-between gap-3"><div><p className="text-sm font-semibold text-text">{title}</p><p className="mt-0.5 text-[11px] text-muted">{subtitle}</p></div><StatusBadge status={status} /></div>{children}</div> }
function StatusBadge({ status }: { status: ConnectorHealth['status'] }) { const style = status === 'healthy' ? 'bg-teal/10 text-teal border-teal/20' : status === 'degraded' || status === 'offline' ? 'bg-danger/10 text-danger border-danger/20' : 'bg-amber/10 text-amber border-amber/20'; return <span className={cn('rounded-full border px-2 py-1 text-[10px] font-semibold uppercase tracking-wide', style)}>{status}</span> }
function HealthList({ health }: { health: ConnectorHealth[] }) {
  const { t } = useI18n()
  // message приходит либо нашим ключом перевода, либо строкой от сервера — вторую переводить
  // нечем, поэтому показываем как есть.
  const say = (message: string) => (message.startsWith('settingsPage.') ? t(message) : message)
  return <div className="space-y-2">{health.map((item) => <div key={item.connectorId} className="flex items-center justify-between gap-3 rounded-xl border border-ice/10 bg-black/10 p-3"><div className="min-w-0"><p className="truncate text-xs font-semibold text-text">{item.label}</p><p className="mt-0.5 truncate text-[10px] text-muted">{item.message ? say(item.message) : item.latencyMs === null ? t('settingsPage.msgNoTelemetry') : `${item.latencyMs} ms`}</p></div><StatusBadge status={item.status} /></div>)}</div> }
function SupportRule({ icon: Icon, title, text }: { icon: IconType; title: string; text: string }) { return <div className="flex gap-3 rounded-xl border border-ice/10 bg-black/10 p-3"><span className="mt-0.5 text-violet"><Icon size={15} /></span><div><p className="text-xs font-semibold text-text">{title}</p><p className="mt-1 text-[11px] leading-5 text-muted">{text}</p></div></div> }
