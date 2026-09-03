import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import type { LucideIcon } from 'lucide-react'
import {
  Send,
  MessageCircle,
  Camera,
  Globe,
  Building2,
  Calendar,
  Phone,
  ShoppingBag,
  CreditCard,
  LifeBuoy,
  Store,
  Share2,
  Wrench,
  Mail,
  Megaphone,
  BarChart3,
  Workflow,
  Search,
  Plug,
  Unplug,
  RefreshCw,
  Copy,
  Check,
  X,
  ShieldCheck,
  ExternalLink,
  Clock,
  Layers,
  Sparkles,
  ArrowRight,
  Zap,
} from 'lucide-react'
import { useI18n } from '../../i18n'
import { useToast } from '../../components/ui/Toast'
import { Button } from '../../components/ui/Button'
import { ConfirmDialog } from '../../components/ui/ConfirmDialog'
import { useIntegrationStore, type IntegrationStatus } from '../../store/useIntegrationStore'
import { supabase, isSupabaseEnabled } from '../../lib/supabase'
import { INTEGRATIONS, INT_CATEGORIES, INT_REGIONS, type IntCategory, type IntRegion } from '../../data/integrations'
import { GoogleSetup } from '../../components/platform/GoogleSetup'
import { cn } from '../../lib/cn'
import { KnowledgeIntegrationNav } from '../../components/platform/KnowledgeIntegrationNav'
import { widgetSnippet, widgetHostConfigured } from '../../lib/widget'

type ConnectMethod = 'token' | 'oauth' | 'widget'
interface FieldDef {
  key: string
  label: string
  placeholder: string
}
interface IntegrationDef {
  id: string
  name: string
  icon: LucideIcon
  color: string
  method: ConnectMethod
  fields?: FieldDef[]
}

const statusStyle: Record<IntegrationStatus, string> = {
  connected: 'bg-teal/10 text-teal',
  disconnected: 'bg-infoblue text-midnight',
  error: 'bg-danger/10 text-danger',
}

function Chip({ on, onClick, children }: { on: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={cn(
        'shrink-0 whitespace-nowrap rounded-pill border px-3 py-1.5 text-xs font-medium transition',
        on ? 'border-violet/60 bg-violet/10 text-text' : 'border-ice/10 text-muted hover:border-ice/25',
      )}
    >
      {children}
    </button>
  )
}

// category visual (used when an integration has no dedicated brand icon)
const CAT_META: Record<IntCategory, { Icon: LucideIcon; color: string }> = {
  messenger: { Icon: MessageCircle, color: '#3FA9F5' },
  crm: { Icon: Building2, color: '#2FB5F0' },
  telephony: { Icon: Phone, color: '#34D399' },
  marketplace: { Icon: ShoppingBag, color: '#F4A640' },
  payment: { Icon: CreditCard, color: '#8B7CF8' },
  calendar: { Icon: Calendar, color: '#EC6CB0' },
  helpdesk: { Icon: LifeBuoy, color: '#22D3EE' },
  ecommerce: { Icon: Store, color: '#13C5B4' },
  social: { Icon: Share2, color: '#5A8DEE' },
  email: { Icon: Mail, color: '#FB7185' },
  ads: { Icon: Megaphone, color: '#FACC15' },
  analytics: { Icon: BarChart3, color: '#818CF8' },
  automation: { Icon: Workflow, color: '#FB923C' },
  tools: { Icon: Wrench, color: '#9AA4B2' },
}

function CatIcon({ category }: { category: IntCategory }) {
  const Icon = CAT_META[category].Icon
  return <Icon size={13} />
}

// A few catalog items have a translatable descriptor in their name; resolve those
// via i18n at render (the raw data keeps the RU name for search/back-compat).
const NAME_I18N: Record<string, string> = {
  browser: 'dataUi.intBrowser',
  elevenlabs: 'dataUi.intElevenlabs',
  heygen: 'dataUi.intHeygen',
  higgsfield: 'dataUi.intHiggsfield',
  did: 'dataUi.intDid',
  synthesia: 'dataUi.intSynthesia',
}

const GOOGLE_IDS = ['google', 'gmail', 'gsheets', 'gdocs'] as const
const CHANNEL_IDS = ['telegram', 'instagram', 'whatsapp', 'widget'] as const
// Every catalog entry marked `live` must appear here (or in CONNECTABLE / GOOGLE_IDS),
// otherwise its card renders with no way to connect at all. These providers are configured
// with the account's own key on the AI tools page, which is where the link points.
const PROVIDER_UI_TO_KEY: Record<string, string> = {
  github: 'github',
  slack: 'slack',
  browser: 'hyperbrowser',
  hubspot: 'hubspot',
  amocrm: 'amocrm',
  bitrix24: 'bitrix24',
  uzum: 'uzum',
  stripe: 'stripe',
  notion: 'notion',
  airtable: 'airtable',
  elevenlabs: 'elevenlabs',
  heygen: 'heygen',
  replicate: 'replicate',
  wildberries: 'wildberries',
  ozon: 'ozon',
}

export default function IntegrationsPage({ embedded = false }: { embedded?: boolean }) {
  const { t } = useI18n()
  const toast = useToast()
  const status = useIntegrationStore((s) => s.status)
  const connect = useIntegrationStore((s) => s.connect)
  const disconnect = useIntegrationStore((s) => s.disconnect)
  const setError = useIntegrationStore((s) => s.setError)

  const [active, setActive] = useState<IntegrationDef | null>(null)
  const [form, setForm] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  const [copied, setCopied] = useState(false)
  const [copiedTok, setCopiedTok] = useState(false)
  const [confirmId, setConfirmId] = useState<string | null>(null)
  // for Meta channels (Instagram/WhatsApp): the account's agents + the webhook result to paste into Meta
  const [agents, setAgents] = useState<{ id: string; name: string }[]>([])
  const [connResult, setConnResult] = useState<{ channel_id?: string; webhook?: string; verify_token?: string } | null>(null)
  const [browserPairing, setBrowserPairing] = useState<{ secret: string; expiresAt: string } | null>(null)

  // filters
  const [query, setQuery] = useState('')
  const [cat, setCat] = useState<IntCategory | 'all'>('all')
  const [region, setRegion] = useState<IntRegion | 'all'>('all')
  const [onlyMine, setOnlyMine] = useState(false)
  const [limit, setLimit] = useState(48) // paginate the big catalog so it stays snappy

  // catalog stats for the header
  const stats = useMemo(() => ({
    total: INTEGRATIONS.length,
    live: INTEGRATIONS.filter((i) => i.status === 'live').length,
    cats: INT_CATEGORIES.length,
    regions: INT_REGIONS.length,
  }), [])
  const catCount = useMemo(() => {
    const m = new Map<string, number>()
    for (const i of INTEGRATIONS) m.set(i.category, (m.get(i.category) ?? 0) + 1)
    return m
  }, [])

  // connect details for the few LIVE integrations (method + fields)
  const CONNECTABLE: Record<string, IntegrationDef> = {
    telegram: { id: 'telegram', name: 'Telegram', icon: Send, color: '#3FA9F5', method: 'token', fields: [{ key: 'token', label: t('platform.integrations.fields.tgToken'), placeholder: '123456789:AAH...' }] },
    whatsapp: {
      id: 'whatsapp', name: 'WhatsApp', icon: MessageCircle, color: '#25D366', method: 'token',
      fields: [
        { key: 'phone_number_id', label: t('igConnect.waPhoneId'), placeholder: '102938475610293' },
        { key: 'token', label: t('igConnect.waToken'), placeholder: 'EAAG...' },
      ],
    },
    instagram: {
      id: 'instagram', name: 'Instagram', icon: Camera, color: '#E1306C', method: 'token',
      fields: [
        { key: 'page_token', label: t('igConnect.pageToken'), placeholder: 'EAAG... (Page access token)' },
        { key: 'ig_id', label: t('igConnect.igId'), placeholder: '17841400000000000' },
      ],
    },
    widget: { id: 'widget', name: t('platform.channels.widget'), icon: Globe, color: '#22D3EE', method: 'widget' },
    google: { id: 'google', name: 'Google', icon: Calendar, color: '#EA4335', method: 'oauth' },
    uzum: { id: 'uzum', name: 'Uzum Market', icon: ShoppingBag, color: '#7C3AED', method: 'token', fields: [{ key: 'token', label: 'API-ключ Uzum', placeholder: 'Вставьте ключ из кабинета Uzum Seller' }] },
  }

  // «Мои интеграции» — подключённые. Считается по тому же признаку, что и бейдж на карточке, иначе
  // счётчик у фильтра и вид каталога разъехались бы.
  const isConnected = (id: string) => (status[id] ?? 'disconnected') === 'connected'
  const mineCount = INTEGRATIONS.filter((it) => it.status !== 'soon' && isConnected(it.id)).length

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return INTEGRATIONS.filter(
      (it) =>
        (cat === 'all' || it.category === cat) &&
        (region === 'all' || it.regions.includes(region)) &&
        (!onlyMine || (it.status !== 'soon' && (status[it.id] ?? 'disconnected') === 'connected')) &&
        (!q || it.name.toLowerCase().includes(q)),
    )
  }, [query, cat, region, onlyMine, status])

  // reset pagination when the filter set changes (adjust state during render — no effect needed)
  const filterKey = `${query}|${cat}|${region}|${onlyMine}`
  const [prevKey, setPrevKey] = useState(filterKey)
  if (filterKey !== prevKey) { setPrevKey(filterKey); setLimit(48) }
  const visible = filtered.slice(0, limit)

  const openConnect = (def: IntegrationDef) => {
    setActive(def)
    setForm(agents[0] ? { agent_id: agents[0].id } : {})
    setBusy(false)
    setCopied(false)
    setCopiedTok(false)
    setConnResult(null)
  }

  const finishConnect = (id: string) => {
    connect(id)
    toast(t('platform.integrations.connectedMsg'))
    setActive(null)
    setBusy(false)
  }

  const submitConnect = async (def: IntegrationDef) => {
    if (isSupabaseEnabled && supabase && def.id === 'telegram') {
      setBusy(true)
      const { data, error } = await supabase.functions.invoke('connect-telegram', { body: { bot_token: form.token } })
      setBusy(false)
      if (error || !(data as { ok?: boolean } | null)?.ok) {
        toast(error?.message ?? t('platform.integrations.statusError'))
        return
      }
      finishConnect(def.id)
      return
    }
    // Instagram / WhatsApp / widget — real per-agent connection persisted by the backend.
    if (isSupabaseEnabled && supabase && (def.id === 'instagram' || def.id === 'whatsapp' || def.id === 'widget')) {
      if (!form.agent_id) { toast(t('igConnect.pickAgent')); return }
      setBusy(true)
      const credentials = def.id === 'instagram'
        ? { page_token: form.page_token, ig_id: form.ig_id }
        : def.id === 'whatsapp'
          ? { phone_number_id: form.phone_number_id, token: form.token }
          : {}
      const { data, error } = await supabase.functions.invoke('connect-channel', { body: { agent_id: form.agent_id, type: def.id, credentials } })
      setBusy(false)
      const p = data as { ok?: boolean; channel_id?: string; webhook?: string; verify_token?: string; error?: string } | null
      if (error || !p?.ok) { toast(p?.error ?? error?.message ?? t('platform.integrations.statusError')); return }
      setConnResult({ channel_id: p.channel_id, webhook: p.webhook, verify_token: p.verify_token })
      connect(def.id)
      toast(t('platform.integrations.connectedMsg'))
      return
    }
    if (isSupabaseEnabled && supabase && PROVIDER_UI_TO_KEY[def.id]) {
      setBusy(true)
      const { data, error } = await supabase.functions.invoke('connect-provider', {
        body: { action: 'connect', provider: PROVIDER_UI_TO_KEY[def.id], api_key: form.token },
      })
      setBusy(false)
      const p = data as { ok?: boolean; error?: string } | null
      if (error || !p?.ok) { toast(p?.error ?? error?.message ?? t('platform.integrations.statusError')); return }
      finishConnect(def.id)
      return
    }
    finishConnect(def.id)
  }

  // reflect the REAL Google connection + handle the OAuth return
  useEffect(() => {
    if (!isSupabaseEnabled || !supabase) return
    ;(async () => {
      // Clear all cached/demo state first. Only records returned by the backend become connected.
      for (const item of INTEGRATIONS) if (item.status !== 'soon') disconnect(item.id)
      try {
        const { data } = await supabase!.functions.invoke('google-oauth', { body: { action: 'status' } })
        if ((data as { connected?: boolean } | null)?.connected) for (const id of GOOGLE_IDS) connect(id)
      } catch { /* ignore */ }
      try {
        const { data } = await supabase!.functions.invoke('connect-provider', { body: { action: 'status' } })
        const providers = new Set(((data as { connected?: string[] } | null)?.connected ?? []).map(String))
        for (const [uiId, provider] of Object.entries(PROVIDER_UI_TO_KEY)) if (providers.has(provider)) connect(uiId)
      } catch { /* ignore */ }
      try {
        const { data: ags } = await supabase!.from('agents').select('id, name').order('created_at', { ascending: true })
        setAgents(((ags as { id: string; name: string }[]) ?? []).map((a) => ({ id: a.id, name: a.name || 'Agent' })))
      } catch { /* ignore */ }
      try {
        // reflect REAL connected channels (telegram/instagram/whatsapp/widget) from the backend
        const { data: chs } = await supabase!.from('channels').select('type, status')
        const rows = (chs as { type: string; status: string }[]) ?? []
        for (const ty of CHANNEL_IDS) {
          const matches = rows.filter((row) => row.type === ty)
          if (matches.some((row) => row.status === 'connected')) connect(ty)
          else if (matches.length) setError(ty)
        }
      } catch { /* ignore */ }
    })()
    const p = new URLSearchParams(window.location.search).get('google')
    if (p === 'connected') { for (const id of GOOGLE_IDS) connect(id); toast(t('integrationsPage.googleConnected')) }
    else if (p) toast(t('integrationsPage.googleFailed'))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const authorize = async (id: string) => {
    setBusy(true)
    if (id === 'google' && isSupabaseEnabled && supabase) {
      try {
        const { data, error } = await supabase.functions.invoke('google-oauth', { body: { action: 'authorize' } })
        const p = data as { ok?: boolean; url?: string; message?: string } | null
        if (!error && p?.url) { window.location.href = p.url; return }
        toast(p?.message ?? t('integrationsPage.googleNotConfigured'))
      } catch { toast(t('integrationsPage.googleOauthError')) }
      setBusy(false)
      return
    }
    setBusy(false)
    toast(t('platform.integrations.statusError'))
  }

  const copySnippet = () => {
    if (!connResult?.channel_id) return
    const snippet = widgetSnippet(connResult.channel_id)
    if (!snippet) { toast(t('platform.integrations.widgetHostMissing')); return }
    navigator.clipboard?.writeText(snippet)
    setCopied(true)
    toast(t('platform.integrations.copied'))
  }

  const needsAgent = active?.id === 'instagram' || active?.id === 'whatsapp' || active?.id === 'widget'
  const tokenReady = active?.fields
    ? active.fields.every((f) => (form[f.key] ?? '').trim().length > 0) && (!needsAgent || Boolean(form.agent_id))
    : false

  const disconnectReal = async (id: string) => {
    if (!supabase || !isSupabaseEnabled) return
    setBusy(true)
    try {
      if ((GOOGLE_IDS as readonly string[]).includes(id)) {
        const { data, error } = await supabase.functions.invoke('google-oauth', { body: { action: 'disconnect' } })
        if (error || !(data as { ok?: boolean } | null)?.ok) throw new Error(error?.message || 'google disconnect failed')
        for (const googleId of GOOGLE_IDS) disconnect(googleId)
      } else if (PROVIDER_UI_TO_KEY[id]) {
        const { data, error } = await supabase.functions.invoke('connect-provider', { body: { action: 'disconnect', provider: PROVIDER_UI_TO_KEY[id] } })
        if (error || !(data as { ok?: boolean } | null)?.ok) throw new Error(error?.message || 'provider disconnect failed')
        disconnect(id)
      } else if ((CHANNEL_IDS as readonly string[]).includes(id)) {
        const { error } = await supabase.from('channels').delete().eq('type', id)
        if (error) throw error
        disconnect(id)
      }
      toast(t('platform.integrations.disconnectedMsg'))
    } catch {
      toast(t('platform.integrations.statusError'))
    } finally {
      setBusy(false)
      setConfirmId(null)
    }
  }

  const createBrowserPairing = async () => {
    if (!supabase || !isSupabaseEnabled) return
    setBusy(true)
    try {
      const { data, error } = await supabase.functions.invoke('browser-bridge', { body: { action: 'create' } })
      if (error || !(data as { ok?: boolean; secret?: string; pairing?: { expires_at?: string } } | null)?.ok) throw error ?? new Error('pairing failed')
      const result = data as { secret: string; pairing: { expires_at: string } }
      setBrowserPairing({ secret: result.secret, expiresAt: result.pairing.expires_at })
    } catch { toast('Не удалось создать код связки Browser Agent.') }
    finally { setBusy(false) }
  }

  const clearBrowserObservations = async () => {
    if (!supabase || !isSupabaseEnabled) return
    setBusy(true)
    try {
      const { data, error } = await supabase.functions.invoke('browser-bridge', { body: { action: 'clear_observations' } })
      if (error || !(data as { ok?: boolean } | null)?.ok) throw error ?? new Error('clear failed')
      toast('Сохранённые Browser snapshots удалены.')
    } catch { toast('Не удалось удалить Browser snapshots.') }
    finally { setBusy(false) }
  }

  return (
    <div className={embedded ? 'w-full' : 'container-page max-w-6xl py-8'}>
      {!embedded && <KnowledgeIntegrationNav active="integrations" />}
      {/* hero */}
      <div className="relative overflow-hidden rounded-3xl border border-white/[0.07] bg-gradient-to-br from-violet/[0.12] via-panel to-panel p-6 sm:p-8">
        <div className="pointer-events-none absolute -right-20 -top-24 h-64 w-64 rounded-full bg-violet/20 blur-3xl" />
        <div className="relative">
          <span className="inline-flex items-center gap-1.5 rounded-pill border border-violet/25 bg-violet/10 px-3 py-1 text-[11px] font-medium text-violet">
            <Sparkles size={13} /> {t('platform.integrations.heroBadge', { total: String(stats.total) })}
          </span>
          <h1 className="mt-3 text-2xl font-semibold tracking-tight text-text sm:text-3xl">{t('platform.integrations.catalogTitle')}</h1>
          <p className="mt-1.5 max-w-2xl text-sm leading-relaxed text-muted">{t('platform.integrations.catalogDesc')}</p>

          <div className="mt-5 flex flex-wrap gap-2.5">
            {[
              { value: stats.total, label: t('platform.integrations.statTotal') },
              { value: stats.live, label: t('platform.integrations.statLive') },
              { value: stats.cats, label: t('platform.integrations.statCats') },
              { value: stats.regions, label: t('platform.integrations.statRegions') },
            ].map((s) => (
              <div key={s.label} className="flex items-baseline gap-1.5 rounded-2xl border border-white/[0.07] bg-white/[0.03] px-3.5 py-2">
                <span className="text-lg font-semibold tabular-nums text-text">{s.value}</span>
                <span className="text-xs text-muted">{s.label}</span>
              </div>
            ))}
          </div>

          <Link to="/app/settings?tab=integrations&directory=plugins" className="group mt-5 inline-flex items-center gap-3 rounded-2xl border border-white/[0.07] bg-black/20 px-4 py-3 transition-colors hover:border-violet/30">
            <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-violet/15 text-violet"><Zap size={17} /></span>
            <span className="min-w-0">
              <span className="block text-sm font-medium text-text">{t('platform.integrations.toolsLinkTitle')}</span>
              <span className="block text-xs text-muted">{t('platform.integrations.toolsLinkDesc')}</span>
            </span>
            <ArrowRight size={16} className="ml-1 shrink-0 text-muted transition-transform group-hover:translate-x-0.5" />
          </Link>
        </div>
      </div>

      <section className="card mt-6 rounded-3xl p-5">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <h2 className="text-base font-semibold text-text">Nemo Browser: связка с аккаунтом</h2>
            <p className="mt-1 max-w-2xl text-sm text-muted">Создайте временный код, вставьте его в расширение Nemo Browser и вручную сохраните snapshot. Агент получает только read-only данные Uzum, без паролей, cookies, форм, платежей или изменений.</p>
          </div>
          <div className="flex flex-wrap gap-2">
            <button onClick={clearBrowserObservations} disabled={busy || !isSupabaseEnabled} className="rounded-xl border border-white/10 px-4 py-2 text-sm font-semibold text-muted disabled:opacity-50">Удалить snapshots</button>
            <button onClick={createBrowserPairing} disabled={busy || !isSupabaseEnabled} className="rounded-xl border border-violet/35 bg-violet/10 px-4 py-2 text-sm font-semibold text-violet disabled:opacity-50">Создать код</button>
          </div>
        </div>
        {browserPairing && <div className="mt-4 rounded-2xl border border-ice/10 bg-black/20 p-4">
          <p className="text-xs text-muted">Код действует до {new Date(browserPairing.expiresAt).toLocaleString('ru-RU')}. Snapshot очищается от email, телефонов, токенов и URL-параметров, передаётся AI-провайдеру для анализа и автоматически удаляется через 24 часа.</p>
          <code className="mt-2 block break-all rounded-xl bg-black/30 p-3 text-xs text-teal">{browserPairing.secret}</code>
        </div>}
      </section>

      {/*
        ФИЛЬТРЫ: ОДНА ПОЛОСА ЧИПОВ, ОСТАЛЬНОЕ — КОМПАКТНЫМИ КОНТРОЛАМИ.

        Здесь было два ряда одинаковых чипов подряд: 14 категорий и 8 регионов, оба с переносом. Они
        читаются как один задвоенный список — разного в них только подписи, а на узком экране это
        четыре-пять строк кнопок над каталогом.

        Регионы не удалены, а свёрнуты в селект: это рабочий фильтр, и выкинуть его значило бы чинить
        вид ценой возможности. Чипы остались у одной сущности — категорий, — и уехали в
        горизонтальную прокрутку вместо переноса, чтобы полоса всегда была ровно одной строкой.
      */}
      <div className="sticky top-16 z-10 mt-6 space-y-2.5 rounded-2xl border border-white/[0.07] bg-panel/95 p-3 shadow-lg shadow-black/20 backdrop-blur">
        <div className="flex flex-col gap-2 sm:flex-row">
          <div className="glass flex min-w-0 flex-1 items-center gap-2 rounded-xl px-3 py-2 focus-within:border-violet/60 focus-within:shadow-glow">
            <Search size={15} className="shrink-0 text-muted" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t('platform.integrations.searchPh')}
              className="w-full bg-transparent text-sm text-text outline-none placeholder:text-fog"
            />
            {query && (
              <button onClick={() => setQuery('')} className="rounded-md p-1 text-muted hover:text-text" aria-label={t('common.close')}>
                <X size={15} />
              </button>
            )}
          </div>
          <select
            value={region}
            onChange={(e) => setRegion(e.target.value as IntRegion | 'all')}
            className="glass shrink-0 rounded-xl px-3 py-2 text-xs text-muted outline-none focus:border-violet/60 sm:w-44"
          >
            <option value="all">{t('platform.integrations.allRegions')}</option>
            {INT_REGIONS.map((r) => (
              <option key={r} value={r}>{t(`platform.integrations.region.${r}`)}</option>
            ))}
          </select>
        </div>

        <div className="no-scrollbar -mx-1 flex gap-2 overflow-x-auto px-1 pb-0.5">
          <Chip on={cat === 'all' && !onlyMine} onClick={() => { setCat('all'); setOnlyMine(false) }}>
            {t('platform.integrations.allCats')}
          </Chip>
          <Chip on={onlyMine} onClick={() => setOnlyMine((v) => !v)}>
            <span className="inline-flex items-center gap-1.5">
              {t('platform.integrations.mine')}
              <span className="text-[10px] text-fog">{mineCount}</span>
            </span>
          </Chip>
          {INT_CATEGORIES.map((c) => (
            <Chip key={c} on={cat === c} onClick={() => setCat(cat === c ? 'all' : c)}>
              <span className="inline-flex items-center gap-1.5">
                <CatIcon category={c} />
                {t(`platform.integrations.cat.${c}`)}
                <span className="text-[10px] text-fog">{catCount.get(c) ?? 0}</span>
              </span>
            </Chip>
          ))}
        </div>
      </div>

      {/* result count */}
      <p className="mt-4 text-xs text-muted">
        {t('platform.integrations.showing', { n: String(Math.min(limit, filtered.length)), total: String(filtered.length) })}
      </p>

      {/* grid */}
      {filtered.length === 0 ? (
        <p className="mt-12 text-center text-sm text-muted">{t('platform.integrations.noResults')}</p>
      ) : (
        <div className="mt-3 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {visible.map((it) => {
            const directDef = CONNECTABLE[it.id]
            const connectDef = directDef ?? ((GOOGLE_IDS as readonly string[]).includes(it.id) ? CONNECTABLE.google : undefined)
            const Icon = directDef?.icon ?? CAT_META[it.category].Icon
            const color = directDef?.color ?? CAT_META[it.category].color
            const st = status[it.id] ?? 'disconnected'
            const isOn = it.status !== 'soon' && st === 'connected'
            const isErr = it.status !== 'soon' && st === 'error'
            return (
              <div key={it.id} className="card flex flex-col p-5">
                <div className="flex items-start justify-between gap-3">
                  <span className="flex h-11 w-11 items-center justify-center rounded-xl" style={{ background: `${color}22`, color }}>
                    <Icon size={20} />
                  </span>
                  {it.status === 'soon' ? (
                    <span className="inline-flex items-center gap-1.5 rounded-pill bg-amber/10 px-2.5 py-0.5 text-[11px] font-medium text-amber">
                      <Clock size={12} /> {t('platform.integrations.soon')}
                    </span>
                  ) : (
                    <span className="flex flex-wrap items-center justify-end gap-1.5">
                      {it.status === 'beta' && (
                        <span className="inline-flex items-center gap-1.5 rounded-pill bg-violet/10 px-2.5 py-0.5 text-[11px] font-medium text-violet">
                          {t('platform.integrations.statusBeta')}
                        </span>
                      )}
                      <span className={cn('inline-flex items-center gap-1.5 rounded-pill px-2.5 py-0.5 text-[11px] font-medium', statusStyle[st])}>
                        <span className={cn('h-1.5 w-1.5 rounded-full', isOn ? 'bg-teal' : isErr ? 'bg-danger' : 'bg-midnight/60')} />
                        {isOn ? (PROVIDER_UI_TO_KEY[it.id] ? t('integrationsToolsPage.badgeConnected') : t('platform.integrations.statusConnected')) : isErr ? t('platform.integrations.statusError') : t('platform.integrations.statusDisconnected')}
                      </span>
                    </span>
                  )}
                </div>

                <h3 className="mt-4 font-medium text-text">{NAME_I18N[it.id] ? t(NAME_I18N[it.id]) : it.name}</h3>
                <div className="mt-2 flex flex-1 flex-wrap items-start gap-1.5">
                  <span className="rounded-md bg-ice/[0.06] px-1.5 py-0.5 text-[10px] text-muted">{t(`platform.integrations.cat.${it.category}`)}</span>
                  {it.regions.map((r) => (
                    <span key={r} className="rounded-md bg-ice/[0.04] px-1.5 py-0.5 text-[10px] text-fog">{t(`platform.integrations.region.${r}`)}</span>
                  ))}
                </div>

                {isOn && (it.id === 'telegram' || it.id === 'whatsapp') && (
                  <p className="mt-3 flex items-center gap-1.5 text-[11px] text-teal">
                    <ShieldCheck size={13} /> {t('platform.integrations.webhookOk')}
                  </p>
                )}

                <div className="mt-4 flex items-center gap-2">
                  {it.status === 'soon' ? (
                    <Button size="sm" variant="subtle" onClick={() => toast(t('platform.integrations.requestSoon'))}>
                      <Clock size={14} /> {t('platform.integrations.soon')}
                    </Button>
                  ) : isOn ? (
                    <>
                      {(PROVIDER_UI_TO_KEY[it.id] || (GOOGLE_IDS as readonly string[]).includes(it.id)) && (
                        <Link to="/app/settings?tab=integrations&directory=connectors" className="inline-flex items-center gap-1.5 rounded-lg border border-white/10 px-2.5 py-1.5 text-xs font-medium text-text hover:bg-white/5">
                          <Wrench size={14} /> {t('platform.integrations.test')}
                        </Link>
                      )}
                      {/* A rotated API key had no way in: a connected card offered only Test and
                          Disconnect, so replacing a key meant disconnecting first and hoping the
                          new one saved. connect-provider upserts on (account, provider), so the
                          same form simply overwrites the stored secret. */}
                      {connectDef && (
                        <Button size="sm" variant="ghost" onClick={() => openConnect(connectDef)}>
                          <Plug size={14} /> {t('platform.integrations.replaceKey')}
                        </Button>
                      )}
                      <Button size="sm" variant="ghost" onClick={() => setConfirmId(it.id)}>
                        <Unplug size={14} /> {t('platform.integrations.disconnect')}
                      </Button>
                    </>
                  ) : (
                    connectDef ? (
                      <Button size="sm" onClick={() => openConnect(connectDef)}>
                        <Plug size={14} /> {isErr ? t('platform.integrations.reconnect') : t('platform.integrations.connect')}
                      </Button>
                    ) : PROVIDER_UI_TO_KEY[it.id] ? (
                      <Link to="/app/settings?tab=integrations&directory=connectors" className="inline-flex items-center gap-1.5 rounded-lg bg-brand px-3 py-2 text-xs font-medium text-white hover:brightness-110">
                        <Plug size={14} /> {t('platform.integrations.connect')}
                      </Link>
                    ) : null
                  )}
                </div>
              </div>
            )
          })}
        </div>
      )}

      {filtered.length > limit && (
        <div className="mt-8 flex justify-center">
          <Button variant="subtle" onClick={() => setLimit((l) => l + 48)}>
            <Layers size={15} /> {t('platform.integrations.showMore')} · {filtered.length - limit}
          </Button>
        </div>
      )}

      {/* connect modal */}
      {active && (
        <div className="fixed inset-0 z-[90] flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={() => setActive(null)} />
          <div className="modal-panel relative w-full max-w-md rounded-2xl p-6 animate-fadeInUp">
            <div className="flex items-start justify-between">
              <div className="flex items-center gap-3">
                <span className="flex h-10 w-10 items-center justify-center rounded-xl" style={{ background: `${active.color}22`, color: active.color }}>
                  <active.icon size={18} />
                </span>
                <div>
                  <h3 className="font-medium text-text">{active.name}</h3>
                  <p className="text-xs text-muted">{t('platform.integrations.connect')}</p>
                </div>
              </div>
              <button onClick={() => setActive(null)} className="rounded-lg p-1.5 text-muted hover:bg-white/5 hover:text-text" aria-label={t('common.close')}>
                <X size={18} />
              </button>
            </div>

            <div className="mt-5 space-y-4">
              {!connResult && needsAgent && (
                <label className="block space-y-1.5">
                  <span className="block text-xs text-muted">{t('igConnect.agentLabel')}</span>
                  <select
                    value={form.agent_id ?? ''}
                    onChange={(e) => setForm((s) => ({ ...s, agent_id: e.target.value }))}
                    className="glass w-full rounded-xl px-3 py-2.5 text-sm text-text outline-none focus:border-cobalt/50 focus:shadow-glow"
                  >
                    {agents.length === 0 && <option value="">{t('igConnect.noAgents')}</option>}
                    {agents.map((a) => <option key={a.id} value={a.id} className="bg-panel">{a.name}</option>)}
                  </select>
                </label>
              )}

              {active.method === 'token' && !connResult && (
                <>
                  {active.fields?.map((f) => (
                    <label key={f.key} className="block space-y-1.5">
                      <span className="block text-xs text-muted">{f.label}</span>
                      <input
                        value={form[f.key] ?? ''}
                        onChange={(e) => setForm((s) => ({ ...s, [f.key]: e.target.value }))}
                        placeholder={f.placeholder}
                        className="glass w-full rounded-xl px-3 py-2.5 text-sm text-text outline-none placeholder:text-fog focus:border-cobalt/50 focus:shadow-glow"
                      />
                    </label>
                  ))}
                </>
              )}

              {/* Meta webhook result — paste into the Meta App to finish */}
              {connResult && active.id !== 'widget' && (
                <div className="space-y-3">
                  <p className="flex items-center gap-1.5 text-sm font-medium text-teal"><Check size={15} /> {t('igConnect.webhookTitle')}</p>
                  <div className="space-y-1.5">
                    <span className="block text-[11px] text-muted">{t('igConnect.webhookUrl')}</span>
                    <div className="flex items-center gap-2">
                      <code className="flex-1 overflow-x-auto rounded-lg border border-white/10 bg-black/30 px-2.5 py-2 text-[11px] text-cyan">{connResult.webhook}</code>
                      <button onClick={() => { navigator.clipboard?.writeText(connResult.webhook ?? ''); setCopied(true) }} className="rounded-lg border border-white/12 p-2 text-muted hover:text-text">{copied ? <Check size={14} className="text-teal" /> : <Copy size={14} />}</button>
                    </div>
                  </div>
                  <div className="space-y-1.5">
                    <span className="block text-[11px] text-muted">{t('igConnect.verifyToken')}</span>
                    <div className="flex items-center gap-2">
                      <code className="flex-1 overflow-x-auto rounded-lg border border-white/10 bg-black/30 px-2.5 py-2 text-[11px] text-cyan">{connResult.verify_token}</code>
                      <button onClick={() => { navigator.clipboard?.writeText(connResult.verify_token ?? ''); setCopiedTok(true) }} className="rounded-lg border border-white/12 p-2 text-muted hover:text-text">{copiedTok ? <Check size={14} className="text-teal" /> : <Copy size={14} />}</button>
                    </div>
                  </div>
                  <p className="text-[11px] leading-relaxed text-muted">{t('igConnect.webhookHint')}</p>
                </div>
              )}

              {active.method === 'oauth' && (active.id === 'google' ? (
                <GoogleSetup onConnected={() => connect('google')} />
              ) : (
                <p className="flex items-start gap-2 rounded-xl border border-white/10 bg-white/[0.03] p-3 text-xs leading-relaxed text-muted">
                  <ExternalLink size={15} className="mt-0.5 shrink-0" /> {t('platform.integrations.authorizeNote')}
                </p>
              ))}

              {active.method === 'widget' && (
                <div className="space-y-2">
                  <p className="text-xs text-muted">{t('platform.integrations.widgetNote')}</p>
                  {connResult?.channel_id && (
                    <>
                      <pre className="overflow-x-auto rounded-xl border border-white/10 bg-black/30 p-3 text-[12px] leading-relaxed text-cyan">{widgetSnippet(connResult.channel_id) ?? t('platform.integrations.widgetHostMissing')}</pre>
                      <button disabled={!widgetHostConfigured} onClick={copySnippet} className="inline-flex items-center gap-1.5 rounded-lg border border-white/12 px-2.5 py-1.5 text-xs font-medium text-text hover:bg-white/5">
                        {copied ? <Check size={14} className="text-teal" /> : <Copy size={14} />} {copied ? t('platform.integrations.copied') : t('platform.integrations.copy')}
                      </button>
                    </>
                  )}
                </div>
              )}
            </div>

            <div className="mt-6 flex justify-end gap-2">
              {connResult ? (
                <Button size="sm" onClick={() => setActive(null)}>
                  <Check size={14} /> {t('igConnect.done')}
                </Button>
              ) : (
                <>
                  <Button size="sm" variant="ghost" onClick={() => setActive(null)}>
                    {active.id === 'google' ? t('common.close') : t('common.cancel')}
                  </Button>
                  {active.id === 'google' ? null : active.method === 'oauth' ? (
                    <Button size="sm" onClick={() => authorize(active.id)} disabled={busy}>
                      {busy ? <RefreshCw size={14} className="animate-spin" /> : <ExternalLink size={14} />} {t('platform.integrations.authorize')}
                    </Button>
                  ) : (
                    <Button size="sm" onClick={() => submitConnect(active)} disabled={busy || (needsAgent && !form.agent_id) || (active.method === 'token' && !tokenReady)}>
                      <Plug size={14} /> {busy ? '…' : t('platform.integrations.connect')}
                    </Button>
                  )}
                </>
              )}
            </div>
          </div>
        </div>
      )}

      <ConfirmDialog
        open={confirmId !== null}
        title={t('platform.integrations.disconnectTitle')}
        message={t('platform.integrations.disconnectMsg')}
        confirmLabel={t('platform.integrations.disconnect')}
        cancelLabel={t('common.cancel')}
        danger
        onConfirm={() => { if (confirmId) void disconnectReal(confirmId) }}
        onCancel={() => setConfirmId(null)}
      />
    </div>
  )
}
