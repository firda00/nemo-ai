import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import type { LucideIcon } from 'lucide-react'
import {
  Send,
  MessageCircle,
  Camera,
  Globe,
  Building2,
  Briefcase,
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

const WIDGET_SNIPPET = '<script src="https://cdn.nemo.ai/widget.js" data-agent="ag_demo" async></script>'

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
        'rounded-pill border px-3 py-1.5 text-xs font-medium transition',
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

export default function IntegrationsPage() {
  const { t } = useI18n()
  const toast = useToast()
  const status = useIntegrationStore((s) => s.status)
  const connect = useIntegrationStore((s) => s.connect)
  const disconnect = useIntegrationStore((s) => s.disconnect)

  const [active, setActive] = useState<IntegrationDef | null>(null)
  const [form, setForm] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  const [copied, setCopied] = useState(false)
  const [copiedTok, setCopiedTok] = useState(false)
  const [confirmId, setConfirmId] = useState<string | null>(null)
  // for Meta channels (Instagram/WhatsApp): the account's agents + the webhook result to paste into Meta
  const [agents, setAgents] = useState<{ id: string; name: string }[]>([])
  const [connResult, setConnResult] = useState<{ webhook?: string; verify_token?: string } | null>(null)

  // filters
  const [query, setQuery] = useState('')
  const [cat, setCat] = useState<IntCategory | 'all'>('all')
  const [region, setRegion] = useState<IntRegion | 'all'>('all')
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
    amocrm: { id: 'amocrm', name: 'amoCRM', icon: Building2, color: '#3CB6E3', method: 'oauth' },
    bitrix24: { id: 'bitrix24', name: 'Bitrix24', icon: Briefcase, color: '#2FB5F0', method: 'oauth' },
    google: { id: 'google', name: 'Google', icon: Calendar, color: '#EA4335', method: 'oauth' },
  }

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return INTEGRATIONS.filter(
      (it) =>
        (cat === 'all' || it.category === cat) &&
        (region === 'all' || it.regions.includes(region)) &&
        (!q || it.name.toLowerCase().includes(q)),
    )
  }, [query, cat, region])

  // reset pagination when the filter set changes (adjust state during render — no effect needed)
  const filterKey = `${query}|${cat}|${region}`
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
    // Instagram / WhatsApp — real per-agent connect (connect-channel), returns webhook + verify token
    if (isSupabaseEnabled && supabase && (def.id === 'instagram' || def.id === 'whatsapp')) {
      if (!form.agent_id) { toast(t('igConnect.pickAgent')); return }
      setBusy(true)
      const credentials = def.id === 'instagram'
        ? { page_token: form.page_token, ig_id: form.ig_id }
        : { phone_number_id: form.phone_number_id, token: form.token }
      const { data, error } = await supabase.functions.invoke('connect-channel', { body: { agent_id: form.agent_id, type: def.id, credentials } })
      setBusy(false)
      const p = data as { ok?: boolean; webhook?: string; verify_token?: string; error?: string } | null
      if (error || !p?.ok) { toast(p?.error ?? error?.message ?? t('platform.integrations.statusError')); return }
      setConnResult({ webhook: p.webhook, verify_token: p.verify_token })
      connect(def.id)
      toast(t('platform.integrations.connectedMsg'))
      return
    }
    finishConnect(def.id)
  }

  // reflect the REAL Google connection + handle the OAuth return
  useEffect(() => {
    if (!isSupabaseEnabled || !supabase) return
    ;(async () => {
      try {
        const { data } = await supabase!.functions.invoke('google-oauth', { body: { action: 'status' } })
        if ((data as { connected?: boolean } | null)?.connected) connect('google')
      } catch { /* ignore */ }
      try {
        const { data: ags } = await supabase!.from('agents').select('id, name').order('created_at', { ascending: true })
        setAgents(((ags as { id: string; name: string }[]) ?? []).map((a) => ({ id: a.id, name: a.name || 'Agent' })))
      } catch { /* ignore */ }
      try {
        // reflect REAL connected channels (telegram/instagram/whatsapp/widget) from the backend
        const { data: chs } = await supabase!.from('channels').select('type')
        const types = new Set(((chs as { type: string }[]) ?? []).map((c) => c.type))
        for (const ty of ['telegram', 'instagram', 'whatsapp', 'widget']) if (types.has(ty)) connect(ty)
      } catch { /* ignore */ }
    })()
    const p = new URLSearchParams(window.location.search).get('google')
    if (p === 'connected') { connect('google'); toast(t('integrationsPage.googleConnected')) }
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
    window.setTimeout(() => finishConnect(id), 900)
  }

  const copySnippet = () => {
    navigator.clipboard?.writeText(WIDGET_SNIPPET)
    setCopied(true)
    toast(t('platform.integrations.copied'))
  }

  const needsAgent = active?.id === 'instagram' || active?.id === 'whatsapp'
  const tokenReady = active?.fields
    ? active.fields.every((f) => (form[f.key] ?? '').trim().length > 0) && (!needsAgent || Boolean(form.agent_id))
    : false

  return (
    <div className="container-page max-w-6xl py-8">
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

          <Link to="/app/tools" className="group mt-5 inline-flex items-center gap-3 rounded-2xl border border-white/[0.07] bg-black/20 px-4 py-3 transition-colors hover:border-violet/30">
            <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-violet/15 text-violet"><Zap size={17} /></span>
            <span className="min-w-0">
              <span className="block text-sm font-medium text-text">{t('platform.integrations.toolsLinkTitle')}</span>
              <span className="block text-xs text-muted">{t('platform.integrations.toolsLinkDesc')}</span>
            </span>
            <ArrowRight size={16} className="ml-1 shrink-0 text-muted transition-transform group-hover:translate-x-0.5" />
          </Link>
        </div>
      </div>

      {/* sticky filter bar */}
      <div className="sticky top-16 z-10 mt-6 space-y-3 rounded-2xl border border-white/[0.07] bg-panel/95 p-3 shadow-lg shadow-black/20 backdrop-blur">
        <div className="glass flex items-center gap-2 rounded-xl px-3 py-2.5 focus-within:border-violet/50 focus-within:shadow-glow">
          <Search size={16} className="shrink-0 text-muted" />
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

        <div className="flex flex-wrap gap-2">
          <Chip on={cat === 'all'} onClick={() => setCat('all')}>{t('platform.integrations.allCats')}</Chip>
          {INT_CATEGORIES.map((c) => (
            <Chip key={c} on={cat === c} onClick={() => setCat(c)}>
              <span className="inline-flex items-center gap-1.5">
                <CatIcon category={c} />
                {t(`platform.integrations.cat.${c}`)}
                <span className="text-[10px] text-fog">{catCount.get(c) ?? 0}</span>
              </span>
            </Chip>
          ))}
        </div>

        <div className="flex flex-wrap gap-2">
          <Chip on={region === 'all'} onClick={() => setRegion('all')}>{t('platform.integrations.allRegions')}</Chip>
          {INT_REGIONS.map((r) => (
            <Chip key={r} on={region === r} onClick={() => setRegion(r)}>{t(`platform.integrations.region.${r}`)}</Chip>
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
            const def = CONNECTABLE[it.id]
            const Icon = def?.icon ?? CAT_META[it.category].Icon
            const color = def?.color ?? CAT_META[it.category].color
            const st = status[it.id] ?? 'disconnected'
            const isOn = it.status === 'live' && st === 'connected'
            const isErr = it.status === 'live' && st === 'error'
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
                    <span className={cn('inline-flex items-center gap-1.5 rounded-pill px-2.5 py-0.5 text-[11px] font-medium', statusStyle[st])}>
                      <span className={cn('h-1.5 w-1.5 rounded-full', isOn ? 'bg-teal' : isErr ? 'bg-danger' : 'bg-midnight/60')} />
                      {isOn ? t('platform.integrations.statusConnected') : isErr ? t('platform.integrations.statusError') : t('platform.integrations.statusDisconnected')}
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
                      <Button size="sm" variant="subtle" onClick={() => toast(t('platform.integrations.testOk'))}>
                        <RefreshCw size={14} /> {t('platform.integrations.test')}
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => setConfirmId(it.id)}>
                        <Unplug size={14} /> {t('platform.integrations.disconnect')}
                      </Button>
                    </>
                  ) : (
                    def && (
                      <Button size="sm" onClick={() => openConnect(def)}>
                        <Plug size={14} /> {isErr ? t('platform.integrations.reconnect') : t('platform.integrations.connect')}
                      </Button>
                    )
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
          <div className="card relative w-full max-w-md rounded-2xl p-6 animate-fadeInUp">
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
              {active.method === 'token' && !connResult && (
                <>
                  {needsAgent && (
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
              {connResult && (
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
                  <pre className="overflow-x-auto rounded-xl border border-white/10 bg-black/30 p-3 text-[12px] leading-relaxed text-cyan">{WIDGET_SNIPPET}</pre>
                  <button onClick={copySnippet} className="inline-flex items-center gap-1.5 rounded-lg border border-white/12 px-2.5 py-1.5 text-xs font-medium text-text hover:bg-white/5">
                    {copied ? <Check size={14} className="text-teal" /> : <Copy size={14} />} {copied ? t('platform.integrations.copied') : t('platform.integrations.copy')}
                  </button>
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
                    <Button size="sm" onClick={() => submitConnect(active)} disabled={busy || (active.method === 'token' && !tokenReady)}>
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
        onConfirm={() => {
          if (confirmId) {
            disconnect(confirmId)
            toast(t('platform.integrations.disconnectedMsg'))
          }
          setConfirmId(null)
        }}
        onCancel={() => setConfirmId(null)}
      />
    </div>
  )
}
