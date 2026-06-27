import { useMemo, useState, type ReactNode } from 'react'
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
} from 'lucide-react'
import { useI18n } from '../../i18n'
import { useToast } from '../../components/ui/Toast'
import { Button } from '../../components/ui/Button'
import { ConfirmDialog } from '../../components/ui/ConfirmDialog'
import { useIntegrationStore, type IntegrationStatus } from '../../store/useIntegrationStore'
import { supabase, isSupabaseEnabled } from '../../lib/supabase'
import { INTEGRATIONS, INT_CATEGORIES, INT_REGIONS, type IntCategory, type IntRegion } from '../../data/integrations'
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
  const [confirmId, setConfirmId] = useState<string | null>(null)

  // filters
  const [query, setQuery] = useState('')
  const [cat, setCat] = useState<IntCategory | 'all'>('all')
  const [region, setRegion] = useState<IntRegion | 'all'>('all')

  // connect details for the few LIVE integrations (method + fields)
  const CONNECTABLE: Record<string, IntegrationDef> = {
    telegram: { id: 'telegram', name: 'Telegram', icon: Send, color: '#3FA9F5', method: 'token', fields: [{ key: 'token', label: t('platform.integrations.fields.tgToken'), placeholder: '123456789:AAH...' }] },
    whatsapp: {
      id: 'whatsapp', name: 'WhatsApp', icon: MessageCircle, color: '#25D366', method: 'token',
      fields: [
        { key: 'phone', label: t('platform.integrations.fields.waPhone'), placeholder: '102938475610293' },
        { key: 'token', label: t('platform.integrations.fields.waToken'), placeholder: 'EAAG...' },
      ],
    },
    instagram: { id: 'instagram', name: 'Instagram', icon: Camera, color: '#E1306C', method: 'oauth' },
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

  const openConnect = (def: IntegrationDef) => {
    setActive(def)
    setForm({})
    setBusy(false)
    setCopied(false)
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
      // deno-lint-ignore no-explicit-any
      if (error || !(data as any)?.ok) {
        toast(error?.message ?? t('platform.integrations.statusError'))
        return
      }
      finishConnect(def.id)
      return
    }
    finishConnect(def.id)
  }

  const authorize = (id: string) => {
    setBusy(true)
    window.setTimeout(() => finishConnect(id), 900)
  }

  const copySnippet = () => {
    navigator.clipboard?.writeText(WIDGET_SNIPPET)
    setCopied(true)
    toast(t('platform.integrations.copied'))
  }

  const tokenReady = active?.fields ? active.fields.every((f) => (form[f.key] ?? '').trim().length > 0) : false

  const Chip = ({ on, onClick, children }: { on: boolean; onClick: () => void; children: ReactNode }) => (
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

  return (
    <div className="container-page max-w-6xl py-8">
      <h1 className="text-2xl font-semibold tracking-tight text-text">{t('platform.integrations.catalogTitle')}</h1>
      <p className="mt-1 text-sm text-muted">{t('platform.integrations.catalogDesc')}</p>

      {/* search */}
      <div className="glass mt-6 flex items-center gap-2 rounded-xl px-3 py-2.5 focus-within:border-violet/50 focus-within:shadow-glow">
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

      {/* category filter */}
      <div className="mt-4 flex flex-wrap gap-2">
        <Chip on={cat === 'all'} onClick={() => setCat('all')}>{t('platform.integrations.allCats')}</Chip>
        {INT_CATEGORIES.map((c) => (
          <Chip key={c} on={cat === c} onClick={() => setCat(c)}>{t(`platform.integrations.cat.${c}`)}</Chip>
        ))}
      </div>

      {/* region filter */}
      <div className="mt-2.5 flex flex-wrap gap-2">
        <Chip on={region === 'all'} onClick={() => setRegion('all')}>{t('platform.integrations.allRegions')}</Chip>
        {INT_REGIONS.map((r) => (
          <Chip key={r} on={region === r} onClick={() => setRegion(r)}>{t(`platform.integrations.region.${r}`)}</Chip>
        ))}
      </div>

      {/* grid */}
      {filtered.length === 0 ? (
        <p className="mt-12 text-center text-sm text-muted">{t('platform.integrations.noResults')}</p>
      ) : (
        <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {filtered.map((it) => {
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

                <h3 className="mt-4 font-medium text-text">{it.name}</h3>
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
              {active.method === 'token' &&
                active.fields?.map((f) => (
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

              {active.method === 'oauth' && (
                <p className="flex items-start gap-2 rounded-xl border border-white/10 bg-white/[0.03] p-3 text-xs leading-relaxed text-muted">
                  <ExternalLink size={15} className="mt-0.5 shrink-0" /> {t('platform.integrations.authorizeNote')}
                </p>
              )}

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
              <Button size="sm" variant="ghost" onClick={() => setActive(null)}>
                {t('common.cancel')}
              </Button>
              {active.method === 'oauth' ? (
                <Button size="sm" onClick={() => authorize(active.id)} disabled={busy}>
                  {busy ? <RefreshCw size={14} className="animate-spin" /> : <ExternalLink size={14} />} {t('platform.integrations.authorize')}
                </Button>
              ) : (
                <Button size="sm" onClick={() => submitConnect(active)} disabled={busy || (active.method === 'token' && !tokenReady)}>
                  <Plug size={14} /> {busy ? '…' : t('platform.integrations.connect')}
                </Button>
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
