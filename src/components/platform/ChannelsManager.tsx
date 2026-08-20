import { useState } from 'react'
import { useEffect } from 'react'
import { Plug, Unplug, Check, X, Copy, ShieldCheck } from 'lucide-react'
import { useI18n } from '../../i18n'
import { useToast } from '../ui/Toast'
import { Button } from '../ui/Button'
import { useAgentStore } from '../../store/useAgentStore'
import { channelMeta, channelLabel } from '../../lib/platformMeta'
import { supabase, isSupabaseEnabled } from '../../lib/supabase'
import { cn } from '../../lib/cn'
import { widgetSnippet, widgetHostConfigured } from '../../lib/widget'
import type { ChannelType } from '../../types/platform'

const inputCls =
  'glass w-full rounded-xl px-3 py-2.5 text-sm text-text outline-none transition-colors placeholder:text-muted/70 focus:border-violet/50 focus:shadow-glow'

interface FieldDef {
  key: string
  label: string
  placeholder: string
}

interface MetaResult {
  webhook?: string
  verify_token?: string
  channel_id?: string
}
interface ChannelRow { id: string; type: ChannelType; label?: string | null; status?: string | null }

/**
 * Real channel connect/disconnect for one agent. Telegram → connect-telegram
 * (verifies the bot + sets the webhook); WhatsApp/Instagram/widget → connect-channel.
 * Credentials are stored server-side; here we only persist + re-hydrate the store.
 */
export function ChannelsManager({ agentId }: { agentId: string }) {
  const { t } = useI18n()
  const toast = useToast()
  const agent = useAgentStore((s) => s.agents.find((a) => a.id === agentId))
  const hydrate = useAgentStore((s) => s.hydrate)
  const updateAgent = useAgentStore((s) => s.updateAgent)
  const connected = agent?.channels ?? []

  const [active, setActive] = useState<ChannelType | null>(null)
  const [form, setForm] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<MetaResult | null>(null)
  const [copied, setCopied] = useState('')
  const [channelRows, setChannelRows] = useState<ChannelRow[]>([])

  const loadChannels = async () => {
    if (!isSupabaseEnabled || !supabase) return
    const { data } = await supabase.from('channels').select('id,type,label,status').eq('agent_id', agentId).order('created_at', { ascending: false })
    setChannelRows((data as ChannelRow[] | null) ?? [])
  }
  // Initial read synchronizes the server-backed channel list for this agent.
  // eslint-disable-next-line react-hooks/set-state-in-effect, react-hooks/exhaustive-deps
  useEffect(() => { void loadChannels() }, [agentId])

  // The visitor pastes this on their site; it loads the widget and talks to widget-webhook
  // (keyed by the channel id, which we only have AFTER connecting).
  const snippetFor = widgetSnippet

  const fieldsFor = (c: ChannelType): FieldDef[] => {
    switch (c) {
      case 'telegram':
        return [{ key: 'bot_token', label: t('platform.integrations.fields.tgToken'), placeholder: '123456789:AAH...' }]
      case 'whatsapp':
        return [
          { key: 'phone_number_id', label: t('platform.integrations.fields.waPhone'), placeholder: '102938475610293' },
          { key: 'token', label: t('platform.integrations.fields.waToken'), placeholder: 'EAAG...' },
        ]
      case 'instagram':
        return [
          { key: 'page_token', label: t('platform.integrations.fields.igToken'), placeholder: 'EAAG...' },
          { key: 'ig_id', label: t('platform.integrations.fields.igId'), placeholder: '17841400000000000' },
        ]
      default:
        return []
    }
  }

  const open = (c: ChannelType) => {
    setActive(c)
    setForm({})
    setResult(null)
  }

  const ready = active ? fieldsFor(active).every((f) => (form[f.key] ?? '').trim().length > 0) : false

  const submit = async () => {
    if (!active) return
    setBusy(true)
    try {
      if (!isSupabaseEnabled || !supabase) {
        // demo: just mark connected locally
        if (!connected.includes(active)) updateAgent(agentId, { channels: [...connected, active] })
        setActive(null)
        toast(t('platform.integrations.connectedMsg'))
        return
      }

      let data: { ok?: boolean; webhook?: string; verify_token?: string; channel_id?: string } | null = null
      let error: { message?: string } | null = null
      if (active === 'telegram') {
        const r = await supabase.functions.invoke('connect-telegram', {
          body: { bot_token: form.bot_token, agent_id: agentId },
        })
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        data = r.data as any
        error = r.error
      } else {
        const credentials =
          active === 'whatsapp'
            ? { phone_number_id: form.phone_number_id, token: form.token }
            : active === 'instagram'
              ? { page_token: form.page_token, ig_id: form.ig_id }
              : {}
        const r = await supabase.functions.invoke('connect-channel', {
          body: { agent_id: agentId, type: active, credentials },
        })
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        data = r.data as any
        error = r.error
      }

      if (error || !data?.ok) {
        toast(t('platform.editor.chConnectErr'))
        return
      }
      await hydrate()
      await loadChannels()
      if (active === 'widget') {
        // widget: show the embed snippet built from the real channel id
        setResult({ channel_id: data.channel_id, webhook: data.webhook })
      } else if (data.webhook) {
        // Meta channels: show the webhook + verify token to paste into Meta
        setResult({ webhook: data.webhook, verify_token: data.verify_token })
      } else {
        setActive(null)
      }
      toast(t('platform.integrations.connectedMsg'))
    } finally {
      setBusy(false)
    }
  }

  const disconnect = async (c: ChannelType, channelId?: string) => {
    if (isSupabaseEnabled && supabase) {
      const query = supabase.from('channels').delete().eq('agent_id', agentId).eq('type', c)
      if (channelId) query.eq('id', channelId)
      await query
      await hydrate()
      await loadChannels()
    } else {
      updateAgent(agentId, { channels: connected.filter((x) => x !== c) })
    }
    toast(t('platform.integrations.disconnectedMsg'))
  }

  const copy = (text: string, key: string) => {
    navigator.clipboard?.writeText(text)
    setCopied(key)
    toast(t('platform.integrations.copied'))
  }

  return (
    <div className="space-y-5">
      <div>
        <h2 className="font-normal text-text">{t('platform.editor.channelsTitle')}</h2>
        <p className="mt-0.5 text-xs text-muted">{t('platform.editor.channelsDesc')}</p>
      </div>

      {channelRows.length > 0 && (
        <div className="rounded-2xl border border-cyan/20 bg-cyan/[0.04] p-4">
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="text-sm font-semibold text-text">Подключённые боты и каналы</p>
              <p className="mt-1 text-xs text-muted">Можно добавить несколько ботов одной платформы и удалить каждый отдельно.</p>
            </div>
            <span className="rounded-full border border-cyan/25 px-2 py-1 text-xs text-cyan">{channelRows.length}</span>
          </div>
          <div className="mt-3 grid gap-2 sm:grid-cols-2">
            {channelRows.map((row) => (
              <div key={row.id} className="flex items-center gap-3 rounded-xl border border-white/10 bg-black/10 px-3 py-2.5">
                <span className="min-w-0 flex-1 truncate text-sm text-text">{row.label || channelLabel(row.type, t)}</span>
                <span className="text-[11px] text-teal">{row.status || 'connected'}</span>
                <button onClick={() => void disconnect(row.type, row.id)} className="rounded-lg p-1.5 text-muted hover:bg-danger/10 hover:text-danger" aria-label="Удалить подключение"><Unplug size={14} /></button>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="grid gap-3 sm:grid-cols-2">
        {(Object.keys(channelMeta) as ChannelType[]).map((c) => {
          const meta = channelMeta[c]
          const on = connected.includes(c)
          return (
            <div key={c} className={cn('flex items-center gap-3 rounded-xl border p-3.5 transition', on ? 'border-teal/30 bg-teal/[0.04]' : 'border-ice/10')}>
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg" style={{ background: `${meta.color}22`, color: meta.color }}>
                <meta.Icon size={17} />
              </span>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-normal text-text">{channelLabel(c, t)}</p>
                {(on || meta.soon) && (
                  <p className={cn('truncate text-[11px]', on ? 'text-teal' : 'text-amber')}>
                    {on ? t('platform.channels.connected') : t('platform.integrations.soon')}
                  </p>
                )}
              </div>
              {meta.soon ? (
                <span className="shrink-0 rounded-lg border border-ice/12 px-2.5 py-1.5 text-xs font-medium text-muted">{t('platform.integrations.soon')}</span>
              ) : on ? (
                <button onClick={() => disconnect(c)} className="inline-flex shrink-0 items-center gap-1 rounded-lg border border-ice/12 px-2.5 py-1.5 text-xs font-medium text-muted hover:text-danger">
                  <Unplug size={13} />
                  <span className="hidden sm:inline">{t('platform.integrations.disconnect')}</span>
                </button>
              ) : (
                <button onClick={() => open(c)} className="inline-flex shrink-0 items-center gap-1 rounded-lg bg-brand px-2.5 py-1.5 text-xs font-medium text-white">
                  <Plug size={13} />
                  {t('platform.integrations.connect')}
                </button>
              )}
            </div>
          )
        })}
      </div>

      {/* connect modal */}
      {active && (
        <div className="fixed inset-0 z-[90] flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={() => setActive(null)} />
          <div className="modal-panel relative w-full max-w-md rounded-2xl p-6 animate-fadeInUp">
            <div className="flex items-start justify-between">
              <div className="flex items-center gap-3">
                <span className="flex h-10 w-10 items-center justify-center rounded-xl" style={{ background: `${channelMeta[active].color}22`, color: channelMeta[active].color }}>
                  {(() => {
                    const Icon = channelMeta[active].Icon
                    return <Icon size={18} />
                  })()}
                </span>
                <div>
                  <h3 className="font-normal text-text">{channelLabel(active, t)}</h3>
                  <p className="text-xs text-muted">{t('platform.editor.chConnectTitle')}</p>
                </div>
              </div>
              <button onClick={() => setActive(null)} className="rounded-lg p-1.5 text-muted hover:bg-ice/[0.06] hover:text-text" aria-label={t('common.close')}>
                <X size={18} />
              </button>
            </div>

            <div className="mt-5 space-y-4">
              {result ? (
                active === 'widget' ? (
                  <div className="space-y-3">
                    <p className="flex items-start gap-2 rounded-xl border border-teal/15 bg-teal/[0.05] p-3 text-xs leading-relaxed text-muted">
                      <Check size={15} className="mt-0.5 shrink-0 text-teal" /> {t('channelsManager.widgetConnected')}
                    </p>
                    <pre className="overflow-x-auto rounded-xl border border-ice/10 bg-black/30 p-3 text-[12px] leading-relaxed text-cyan">{snippetFor(result.channel_id ?? '') ?? t('channelsManager.widgetHostMissing')}</pre>
                    <div className="flex items-center justify-between">
                      <button disabled={!widgetHostConfigured}
                        onClick={() => copy(snippetFor(result.channel_id ?? '') ?? '', 'ws')} className="inline-flex items-center gap-1.5 rounded-lg border border-ice/12 px-2.5 py-1.5 text-xs font-medium text-text hover:bg-ice/[0.05]">
                        {copied === 'ws' ? <Check size={14} className="text-teal" /> : <Copy size={14} />} {copied === 'ws' ? t('platform.integrations.copied') : t('platform.integrations.copy')}
                      </button>
                      <Button size="sm" onClick={() => setActive(null)}>
                        <Check size={14} /> {t('common.close')}
                      </Button>
                    </div>
                  </div>
                ) : (
                  <div className="space-y-3">
                    <p className="flex items-start gap-2 rounded-xl border border-ice/10 bg-ice/[0.03] p-3 text-xs leading-relaxed text-muted">
                      <ShieldCheck size={15} className="mt-0.5 shrink-0 text-teal" /> {t('platform.editor.chMetaNote')}
                    </p>
                    <ReadonlyField label={t('platform.editor.chWebhookUrl')} value={result.webhook ?? ''} onCopy={() => copy(result.webhook ?? '', 'wh')} copied={copied === 'wh'} />
                    {result.verify_token && (
                      <ReadonlyField label={t('platform.editor.chVerifyToken')} value={result.verify_token} onCopy={() => copy(result.verify_token ?? '', 'vt')} copied={copied === 'vt'} />
                    )}
                    <div className="flex justify-end">
                      <Button size="sm" onClick={() => setActive(null)}>
                        <Check size={14} /> {t('common.close')}
                      </Button>
                    </div>
                  </div>
                )
              ) : active === 'widget' ? (
                <div className="space-y-3">
                  <p className="text-xs text-muted">{t('platform.editor.chWidgetNote')}</p>
                  <div className="flex justify-end">
                    <Button size="sm" onClick={submit} disabled={busy}>
                      <Plug size={14} /> {busy ? '…' : t('platform.integrations.connect')}
                    </Button>
                  </div>
                </div>
              ) : (
                <>
                  {fieldsFor(active).map((f) => (
                    <label key={f.key} className="block space-y-1.5">
                      <span className="block text-xs text-muted">{f.label}</span>
                      <input
                        value={form[f.key] ?? ''}
                        onChange={(e) => setForm((s) => ({ ...s, [f.key]: e.target.value }))}
                        placeholder={f.placeholder}
                        className={inputCls}
                        autoComplete="off"
                      />
                    </label>
                  ))}
                  <div className="flex justify-end gap-2">
                    <Button size="sm" variant="ghost" onClick={() => setActive(null)}>
                      {t('common.cancel')}
                    </Button>
                    <Button size="sm" onClick={submit} disabled={busy || !ready}>
                      <Plug size={14} /> {busy ? '…' : t('platform.integrations.connect')}
                    </Button>
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function ReadonlyField({ label, value, onCopy, copied }: { label: string; value: string; onCopy: () => void; copied: boolean }) {
  return (
    <div>
      <span className="mb-1 block text-xs text-muted">{label}</span>
      <div className="flex items-center gap-2">
        <input readOnly value={value} className={cn(inputCls, 'flex-1 text-[12px] text-cyan')} />
        <button onClick={onCopy} className="shrink-0 rounded-lg border border-ice/12 p-2.5 text-muted hover:text-text">
          {copied ? <Check size={15} className="text-teal" /> : <Copy size={15} />}
        </button>
      </div>
    </div>
  )
}
