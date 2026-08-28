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

const TABS: Array<{ id: TabId; label: string; compact: string; icon: IconType }> = [
  { id: 'connectors', label: 'Интеграции и вебхуки', compact: 'Интеграции', icon: Webhook },
  { id: 'compute', label: 'Вычислительные воркеры', compact: 'Воркеры', icon: Cpu },
  { id: 'governance', label: 'Безопасность и лимиты', compact: 'Лимиты', icon: ShieldCheck },
  { id: 'support', label: 'Nemo Support и диагностика', compact: 'Диагностика', icon: HeartPulse },
]

const inputCls = 'w-full rounded-xl border border-ice/10 bg-black/15 px-3 py-2.5 text-sm text-text outline-none transition focus:border-accent-cyan/50 focus:ring-2 focus:ring-accent-cyan/10'
const labelCls = 'mb-1.5 block text-[11px] font-semibold uppercase tracking-[0.08em] text-muted'

function initialHealth(): ConnectorHealth[] {
  const checkedAt = new Date().toISOString()
  return [
    { connectorId: 'forge-runtime', label: 'Forge Runtime', status: isSupabaseEnabled ? 'unknown' : 'unconfigured', latencyMs: null, activeInboxJobs: null, checkedAt, message: isSupabaseEnabled ? 'Ожидает проверки' : 'Demo mode' },
    { connectorId: 'amocrm', label: 'amoCRM', status: 'unknown', latencyMs: null, activeInboxJobs: null, checkedAt },
    { connectorId: 'telegram', label: 'Telegram', status: 'unknown', latencyMs: null, activeInboxJobs: null, checkedAt },
    { connectorId: 'uzum', label: 'Uzum Market', status: 'unknown', latencyMs: null, activeInboxJobs: null, checkedAt },
    { connectorId: 'ffmpeg-worker', label: 'FFmpeg Worker', status: 'unknown', latencyMs: null, activeInboxJobs: null, checkedAt, message: 'Проверяется Edge Agent' },
    { connectorId: 'whisper-worker', label: 'Whisper Worker', status: 'unknown', latencyMs: null, activeInboxJobs: null, checkedAt, message: 'Проверяется Edge Agent' },
  ].map((item) => ConnectorHealthSchema.parse(item))
}

export default function SettingsPage() {
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
      if (item.connectorId === 'forge-runtime') return { ...item, status: backendOk ? 'healthy' : 'degraded', latencyMs, checkedAt, message: backendOk ? 'JWT и tenant context подтверждены' : 'Backend status недоступен' }
      if (item.connectorId === 'amocrm') return { ...item, status: connected.has('amocrm') ? 'healthy' : 'unconfigured', latencyMs, checkedAt }
      if (item.connectorId === 'uzum') return { ...item, status: connected.has('uzum') ? 'healthy' : 'unconfigured', latencyMs, checkedAt }
      if (item.connectorId === 'telegram') return { ...item, status: telegramOk ? 'healthy' : 'unconfigured', latencyMs, checkedAt }
      return { ...item, checkedAt }
    }).map((item) => ConnectorHealthSchema.parse(item)))
    if (providerResult.error || backendResult.error) setOperationsError('Часть диагностических проверок недоступна.')
    setChecking(false)
  }, [])

  useEffect(() => {
    const timer = window.setTimeout(() => void refreshHealth(), 0)
    return () => window.clearTimeout(timer)
  }, [refreshHealth])

  return <div className="container-page max-w-7xl py-7">
    <header className="flex flex-wrap items-start justify-between gap-4">
      <div>
        <p className="mono-label">Nemo Control Plane</p>
        <h1 className="mt-2 text-3xl font-extrabold tracking-tight text-text">Настройки и диагностика</h1>
        <p className="mt-2 max-w-2xl text-sm leading-6 text-muted">Секреты остаются write-only, конфигурация проверяется до применения, а диагностический пакет очищается от токенов и путей хоста.</p>
      </div>
      <div className="flex items-center gap-2 rounded-xl border border-ice/10 bg-panel/60 px-3 py-2 text-xs text-muted"><span className={cn('h-2 w-2 rounded-full', isSupabaseEnabled ? 'bg-teal' : 'bg-amber')} />{isSupabaseEnabled ? 'Live tenant context' : 'Demo mode'}</div>
    </header>

    <nav className="mt-7 grid grid-cols-2 gap-2 rounded-2xl border border-ice/10 bg-panel/50 p-2 lg:grid-cols-4" aria-label="Разделы настроек">
      {TABS.map(({ id, label, compact, icon: Icon }) => <button key={id} type="button" onClick={() => setTab(id)} aria-current={tab === id ? 'page' : undefined} className={cn('flex min-h-12 items-center justify-center gap-2 rounded-xl px-3 py-2 text-xs font-semibold transition', tab === id ? 'bg-gradient-to-r from-accent-cyan/15 to-accent-indigo/15 text-text ring-1 ring-accent-cyan/30' : 'text-muted hover:bg-white/5 hover:text-text')}><Icon size={16} /><span className="hidden sm:inline lg:hidden xl:inline">{label}</span><span className="sm:hidden lg:inline xl:hidden">{compact}</span></button>)}
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
  const [amoSubdomain, setAmoSubdomain] = useState('')
  const [secretDrafts, setSecretDrafts] = useState({ telegram: '', uzum: '' })
  const [visible, setVisible] = useState<Record<string, boolean>>({})
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)
  const [oneTimeUrl, setOneTimeUrl] = useState('')

  const rotateAmo = async () => {
    setNotice(''); setOneTimeUrl('')
    if (!supabase || !amoSubdomain.trim()) { setNotice('Подключите live backend и укажите поддомен amoCRM.'); return }
    setBusy(true)
    const { data, error } = await supabase.functions.invoke('amocrm-webhook-secret', { body: { action: 'rotate', subdomain: amoSubdomain.trim().toLowerCase() } })
    const payload = data as { webhook_url?: string; previous_valid_until?: string | null; shown_once?: boolean; error?: string } | null
    if (error || !payload?.webhook_url || payload.shown_once !== true) setNotice(payload?.error || 'Ротация не выполнена. Нужны права owner/admin и активная интеграция amoCRM.')
    else {
      const validated = ForgeSecretRotationResultSchema.parse({ provider: 'amocrm', rotatedAt: new Date().toISOString(), previousValidUntil: payload.previous_valid_until ?? null, shownOnce: true, webhookUrl: payload.webhook_url })
      setOneTimeUrl(validated.webhookUrl ?? '')
      setNotice('Новый URL показан один раз. Старый секрет действует ещё до 24 часов.')
      void onRefresh()
    }
    setBusy(false)
  }
  const validateDraft = (provider: 'telegram' | 'uzum') => {
    const result = ForgeIntegrationSecretInputSchema.safeParse({ provider, secret: secretDrafts[provider] })
    setNotice(result.success ? `Формат ${provider === 'telegram' ? 'Telegram Secret Token' : 'Uzum HMAC'} корректен. Сохранение выполняется только серверным Secret Manager.` : result.error.issues[0]?.message ?? 'Некорректный секрет.')
  }

  return <div className="grid gap-5 xl:grid-cols-[1.35fr_.65fr]">
    <div className="space-y-5">
      <Panel icon={KeyRound} title="Входящие вебхуки" description="Ротация происходит через tenant-scoped backend. Статусы никогда не возвращают plaintext.">
        <div className="space-y-4">
          <IntegrationRow title="amoCRM" subtitle="Lifecycle endpoint · 24h grace" status={findStatus(health, 'amocrm')}>
            <div className="grid gap-2 sm:grid-cols-[1fr_auto]"><input value={amoSubdomain} onChange={(event) => setAmoSubdomain(event.target.value)} className={inputCls} placeholder="your-company" autoComplete="off" /><Button size="sm" variant="secondary" loading={busy} onClick={() => void rotateAmo()} leftIcon={<RotateCw size={14} />}>Ротировать</Button></div>
          </IntegrationRow>
          {(['telegram', 'uzum'] as const).map((provider) => <IntegrationRow key={provider} title={provider === 'telegram' ? 'Telegram Forge' : 'Uzum Event Bridge'} subtitle={provider === 'telegram' ? 'X-Telegram-Bot-Api-Secret-Token' : 'HMAC-SHA256 + replay window'} status={findStatus(health, provider)}>
            <div className="grid gap-2 sm:grid-cols-[1fr_auto]"><div className="relative"><input type={visible[provider] ? 'text' : 'password'} value={secretDrafts[provider]} onChange={(event) => setSecretDrafts((current) => ({ ...current, [provider]: event.target.value }))} className={`${inputCls} pr-10`} placeholder="Write-only secret" autoComplete="new-password" spellCheck={false} /><button type="button" onClick={() => setVisible((current) => ({ ...current, [provider]: !current[provider] }))} aria-label={visible[provider] ? 'Скрыть секрет' : 'Показать секрет'} className="absolute right-3 top-1/2 -translate-y-1/2 text-muted hover:text-text">{visible[provider] ? <EyeOff size={15} /> : <Eye size={15} />}</button></div><Button size="sm" variant="secondary" onClick={() => validateDraft(provider)}>Проверить</Button></div>
          </IntegrationRow>)}
        </div>
        {(notice || oneTimeUrl) && <div className="mt-4 rounded-xl border border-accent-cyan/20 bg-accent-cyan/5 p-3 text-xs leading-5 text-muted"><p>{notice}</p>{oneTimeUrl && <div className="mt-2 flex items-center gap-2"><code className="min-w-0 flex-1 truncate rounded-lg bg-black/20 px-2 py-1.5 text-accent-cyan">{oneTimeUrl}</code><button type="button" aria-label="Скопировать URL" onClick={() => void navigator.clipboard.writeText(oneTimeUrl)} className="rounded-lg border border-ice/10 p-2 text-muted hover:text-text"><Clipboard size={14} /></button></div>}</div>}
      </Panel>
      <ConnectAIModel />
    </div>
    <Panel icon={Activity} title="Состояние каналов" description="Проверка с текущим JWT и tenant context."><HealthList health={health.filter((item) => ['forge-runtime', 'amocrm', 'telegram', 'uzum'].includes(item.connectorId))} /><Button variant="secondary" size="sm" fullWidth className="mt-4" loading={checking} onClick={() => void onRefresh()} leftIcon={<RefreshCw size={14} />}>Обновить статусы</Button></Panel>
  </div>
}

function ComputeTab({ health }: { health: ConnectorHealth[] }) {
  const [config, setConfig] = useState<ForgeWorkerConfig>(DEFAULT_FORGE_SETTINGS.worker)
  const [message, setMessage] = useState('')
  const update = <K extends keyof ForgeWorkerConfig>(key: K, value: ForgeWorkerConfig[K]) => setConfig((current) => ({ ...current, [key]: value }))
  const validate = () => { const result = ForgeWorkerConfigSchema.safeParse(config); setMessage(result.success ? 'Конфигурация валидна. Применение выполняется через scoped Edge Agent без service_role.' : result.error.issues.map((issue) => issue.message).join(' · ')) }
  return <div className="grid gap-5 lg:grid-cols-[1fr_320px]">
    <Panel icon={TerminalSquare} title="Compute Profiles и пути" description="Абсолютные пути проверяются без запуска shell-команд из браузера.">
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="FFmpeg binary"><input value={config.ffmpegPath} onChange={(event) => update('ffmpegPath', event.target.value)} className={inputCls} spellCheck={false} /></Field>
        <Field label="Whisper CLI"><input value={config.whisperPath} onChange={(event) => update('whisperPath', event.target.value)} className={inputCls} spellCheck={false} /></Field>
        <Field label="Параллельные воркеры (1–32)"><input type="number" min={1} max={32} value={config.maxConcurrentWorkers} onChange={(event) => update('maxConcurrentWorkers', Number(event.target.value))} className={inputCls} /></Field>
        <Field label="Budget cap по умолчанию, USD"><input type="number" min="0.01" step="0.01" value={config.defaultBudgetCapUsd} onChange={(event) => update('defaultBudgetCapUsd', Number(event.target.value))} className={inputCls} /></Field>
        <Field label="Модель транскрибации"><select value={config.transcriptionModel} onChange={(event) => update('transcriptionModel', event.target.value as ForgeWorkerConfig['transcriptionModel'])} className={inputCls}>{['tiny', 'base', 'small', 'medium'].map((value) => <option key={value}>{value}</option>)}</select></Field>
        <Field label="Видеокодек"><select value={config.videoCodec} onChange={(event) => update('videoCodec', event.target.value as ForgeWorkerConfig['videoCodec'])} className={inputCls}><option value="h264">H.264</option><option value="h265">H.265</option><option value="vp9">VP9</option></select></Field>
      </div>
      <div className="mt-5 flex flex-wrap items-center gap-3"><Button onClick={validate} leftIcon={<Wrench size={15} />}>Проверить конфигурацию</Button><p className="max-w-xl text-xs leading-5 text-muted">{message || 'Пути не включаются в диагностический пакет и не отправляются в поддержку.'}</p></div>
    </Panel>
    <Panel icon={HardDrive} title="Локальный контур" description="Статус бинарников подтверждает Edge Agent, не браузер."><HealthList health={health.filter((item) => item.connectorId.endsWith('-worker'))} /><div className="mt-4 rounded-xl border border-ice/10 bg-black/10 p-3 text-xs leading-5 text-muted">Profile B: 256 MB / 15s. Profile C: 1024 MB / 120s. Network deny-all, кроме scoped storage egress.</div></Panel>
  </div>
}

function GovernanceTab() {
  const { lang, setLang } = useI18n()
  const { user, updateUser } = useAuth()
  const [theme, setTheme] = useState<ThemePreference>(themePreference)
  const [config, setConfig] = useState<ForgeGovernanceConfig>(DEFAULT_FORGE_SETTINGS.governance)
  const [message, setMessage] = useState('')
  const update = <K extends keyof ForgeGovernanceConfig>(key: K, value: ForgeGovernanceConfig[K]) => setConfig((current) => ({ ...current, [key]: value }))
  const validate = () => { const result = ForgeGovernanceConfigSchema.safeParse(config); setMessage(result.success ? 'Политика валидна: бюджет закрывается fail-closed, публикация требует согласования.' : result.error.issues.map((issue) => issue.message).join(' · ')) }
  const languages: Array<{ code: Lang; label: string }> = [{ code: 'uz', label: "O‘zbekcha" }, { code: 'ru', label: 'Русский' }, { code: 'en', label: 'English' }]
  return <div className="space-y-5">
    <div className="grid gap-5 lg:grid-cols-2">
      <Panel icon={WalletCards} title="Бюджет и Content Rights" description="Лимиты валидируются до создания compute jobs.">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Budget Cap по умолчанию"><input type="number" min="0.01" step="0.01" value={config.defaultBudgetCapUsd} onChange={(event) => update('defaultBudgetCapUsd', Number(event.target.value))} className={inputCls} /></Field>
          <Field label="Жёсткий лимит проекта"><input type="number" min="0.01" step="0.01" value={config.hardProjectCapUsd} onChange={(event) => update('hardProjectCapUsd', Number(event.target.value))} className={inputCls} /></Field>
          <Field label="Политика прав"><select value={config.contentRightsPolicy} onChange={(event) => update('contentRightsPolicy', event.target.value as ForgeGovernanceConfig['contentRightsPolicy'])} className={inputCls}><option value="fail_closed">Fail-closed RightsManifest</option><option value="strict_cc0">Только CC0-1.0</option></select></Field>
          <div className="rounded-xl border border-teal/20 bg-teal/5 p-3 text-xs leading-5 text-muted"><CheckCircle2 size={16} className="mb-2 text-teal" />Human Approval перед публикацией включён постоянно и не может быть отключён в UI.</div>
        </div>
        <div className="mt-4 flex flex-wrap items-center gap-3"><Button onClick={validate} leftIcon={<Gauge size={15} />}>Проверить политику</Button><span className="text-xs text-muted">{message}</span></div>
      </Panel>
      <Panel icon={ShieldCheck} title="MFA и безопасность аккаунта" description="Дополнительная проверка для owner/admin действий."><MfaSetupPanel /></Panel>
    </div>
    <Panel icon={UserIcon} title="Профиль и интерфейс" description="Пользовательские настройки без секретных данных.">
      <div className="grid gap-5 lg:grid-cols-3">
        <Field label="Имя"><input value={user?.name ?? ''} onChange={(event) => updateUser({ name: event.target.value })} className={inputCls} /></Field>
        <Field label="Язык"><select value={lang} onChange={(event) => { const next = event.target.value as Lang; setLang(next); updateUser({ lang: next }) }} className={inputCls}>{languages.map((item) => <option key={item.code} value={item.code}>{item.label}</option>)}</select></Field>
        <Field label="Тема"><div className="grid grid-cols-3 gap-2">{([{ id: 'light', icon: Sun }, { id: 'dark', icon: Moon }, { id: 'system', icon: Globe }] as const).map(({ id, icon: Icon }) => <button key={id} type="button" onClick={() => { setTheme(id); applyTheme(id) }} className={cn('flex items-center justify-center rounded-xl border py-2.5 transition', theme === id ? 'border-violet/50 bg-violet/10 text-violet' : 'border-ice/10 text-muted hover:text-text')} aria-label={id}><Icon size={16} /></button>)}</div></Field>
      </div>
    </Panel>
  </div>
}

function SupportTab({ health, onRefresh, checking }: { health: ConnectorHealth[]; onRefresh(): Promise<void>; checking: boolean }) {
  const [exported, setExported] = useState('')
  const exportDiagnostics = () => {
    const bundle = buildForgeDiagnosticBundle({ appVersion: 'nemo-web-2026.08', connectors: health, settings: DEFAULT_FORGE_SETTINGS })
    const url = URL.createObjectURL(new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' }))
    const anchor = document.createElement('a'); anchor.href = url; anchor.download = `nemo-diagnostics-${new Date().toISOString().slice(0, 10)}.json`; anchor.click(); URL.revokeObjectURL(url)
    setExported('Пакет сформирован локально: секреты, токены и пути хоста удалены.')
  }
  return <div className="grid gap-5 lg:grid-cols-[1fr_360px]">
    <Panel icon={HeartPulse} title="Диагностика коннекторов" description={`${health.filter((item) => item.status === 'healthy').length}/${health.length} компонентов подтверждены как healthy.`}><HealthList health={health} /><div className="mt-5 flex flex-wrap gap-2"><Button size="sm" variant="secondary" loading={checking} onClick={() => void onRefresh()} leftIcon={<RefreshCw size={14} />}>Запустить проверку</Button><Button size="sm" onClick={exportDiagnostics} leftIcon={<Download size={14} />}>Скачать безопасный пакет</Button></div>{exported && <p className="mt-3 text-xs text-teal">{exported}</p>}</Panel>
    <Panel icon={CloudCog} title="Nemo Support" description="Поддержка видит только очищенный диагностический пакет."><div className="space-y-3"><SupportRule icon={LockKeyhole} title="Нет доступа к секретам" text="API keys, HMAC, JWT и cookies вырезаются до экспорта." /><SupportRule icon={FileKey2} title="Нет прямого биллинга" text="Support не может менять лимиты, тариф или совершать списания." /><SupportRule icon={Activity} title="Только диагностика" text="Версии, health-статусы, latency и безопасные коды ошибок." /></div><Button onClick={exportDiagnostics} variant="secondary" fullWidth className="mt-5">Скачать пакет для поддержки</Button></Panel>
  </div>
}

function Panel({ icon: Icon, title, description, children }: { icon: IconType; title: string; description: string; children: ReactNode }) { return <section className="card rounded-2xl p-5 sm:p-6"><div className="flex items-start gap-3"><span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-accent-cyan/15 to-accent-indigo/15 text-accent-cyan"><Icon size={18} /></span><div><h2 className="font-semibold text-text">{title}</h2><p className="mt-1 text-xs leading-5 text-muted">{description}</p></div></div><div className="mt-5">{children}</div></section> }
function Field({ label, children }: { label: string; children: ReactNode }) { return <label className="block"><span className={labelCls}>{label}</span>{children}</label> }
function findStatus(health: ConnectorHealth[], connectorId: ConnectorHealth['connectorId']) { return health.find((item) => item.connectorId === connectorId)?.status ?? 'unknown' }
function IntegrationRow({ title, subtitle, status, children }: { title: string; subtitle: string; status: ConnectorHealth['status']; children: ReactNode }) { return <div className="rounded-2xl border border-ice/10 bg-white/[0.025] p-4"><div className="mb-3 flex items-center justify-between gap-3"><div><p className="text-sm font-semibold text-text">{title}</p><p className="mt-0.5 text-[11px] text-muted">{subtitle}</p></div><StatusBadge status={status} /></div>{children}</div> }
function StatusBadge({ status }: { status: ConnectorHealth['status'] }) { const style = status === 'healthy' ? 'bg-teal/10 text-teal border-teal/20' : status === 'degraded' || status === 'offline' ? 'bg-danger/10 text-danger border-danger/20' : 'bg-amber/10 text-amber border-amber/20'; return <span className={cn('rounded-full border px-2 py-1 text-[10px] font-semibold uppercase tracking-wide', style)}>{status}</span> }
function HealthList({ health }: { health: ConnectorHealth[] }) { return <div className="space-y-2">{health.map((item) => <div key={item.connectorId} className="flex items-center justify-between gap-3 rounded-xl border border-ice/10 bg-black/10 p-3"><div className="min-w-0"><p className="truncate text-xs font-semibold text-text">{item.label}</p><p className="mt-0.5 truncate text-[10px] text-muted">{item.message ?? (item.latencyMs === null ? 'Нет подтверждённой телеметрии' : `${item.latencyMs} ms`)}</p></div><StatusBadge status={item.status} /></div>)}</div> }
function SupportRule({ icon: Icon, title, text }: { icon: IconType; title: string; text: string }) { return <div className="flex gap-3 rounded-xl border border-ice/10 bg-black/10 p-3"><span className="mt-0.5 text-violet"><Icon size={15} /></span><div><p className="text-xs font-semibold text-text">{title}</p><p className="mt-1 text-[11px] leading-5 text-muted">{text}</p></div></div> }
