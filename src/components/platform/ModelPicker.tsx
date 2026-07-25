import { useEffect, useState } from 'react'
import { Check, KeyRound, Loader2, Sparkles, Unplug } from 'lucide-react'
import { useI18n } from '../../i18n'
import { PROVIDERS, providerOf } from '../../data/platform'
import { useToast } from '../ui/Toast'
import { cn } from '../../lib/cn'
import { isSupabaseEnabled, supabase } from '../../lib/supabase'

const inputCls =
  'glass w-full rounded-xl px-3 py-2.5 text-sm text-text outline-none transition-colors placeholder:text-muted/70 focus:border-violet/50 focus:shadow-glow'

/**
 * Model selection grouped by company. The user picks a company, then a model,
 * and chooses the API-key source. OpenRouter keys are validated and encrypted by
 * the authenticated connect-model Edge Function and are never read back.
 */
export function ModelPicker({
  model,
  temperature,
  onModel,
  onTemperature,
}: {
  model: string
  temperature: number
  onModel: (id: string) => void
  onTemperature: (t: number) => void
}) {
  const { t } = useI18n()
  const toast = useToast()
  const selectedProvider = providerOf(model) ?? PROVIDERS[0]
  const [activeId, setActiveId] = useState(selectedProvider.id)
  const active = PROVIDERS.find((p) => p.id === activeId) ?? PROVIDERS[0]

  const [useOwn, setUseOwn] = useState(false)
  const [keyInput, setKeyInput] = useState('')
  const [savingKey, setSavingKey] = useState(false)
  const [ownKeyConnected, setOwnKeyConnected] = useState(false)
  const [checkingKey, setCheckingKey] = useState(isSupabaseEnabled)

  const showOwn = useOwn

  useEffect(() => {
    if (!supabase || !isSupabaseEnabled) return
    let activeRequest = true
    void supabase.functions.invoke('connect-model', { body: { action: 'status' } }).then(({ data }) => {
      if (!activeRequest) return
      const result = data as { connected?: boolean } | null
      setOwnKeyConnected(Boolean(result?.connected))
      setCheckingKey(false)
    }).catch(() => { if (activeRequest) setCheckingKey(false) })
    return () => { activeRequest = false }
  }, [])

  const saveKey = async () => {
    if (!supabase || !/^sk-or-v1-[A-Za-z0-9_-]{20,}$/.test(keyInput.trim()) || savingKey) return
    setSavingKey(true)
    try {
      const { data, error } = await supabase.functions.invoke('connect-model', { body: { action: 'connect', api_key: keyInput.trim() } })
      const result = data as { ok?: boolean; error?: string } | null
      if (error || !result?.ok) { toast(result?.error ?? t('connectAIModel.errConnect')); return }
      setOwnKeyConnected(true)
      setKeyInput('')
      toast(t('connectAIModel.connectedMsg'))
    } catch {
      toast(t('connectAIModel.errConnectGeneric'))
    } finally {
      setSavingKey(false)
    }
  }

  const disconnectKey = async () => {
    if (!supabase || savingKey) return
    setSavingKey(true)
    try {
      const { error } = await supabase.functions.invoke('connect-model', { body: { action: 'disconnect' } })
      if (error) { toast(t('connectAIModel.errGeneric')); return }
      setOwnKeyConnected(false)
      toast(t('connectAIModel.disconnectedMsg'))
    } catch {
      toast(t('connectAIModel.errGeneric'))
    } finally {
      setSavingKey(false)
    }
  }

  return (
    <div className="space-y-5">
      <h2 className="font-normal text-text">{t('platform.editor.modelTitle')}</h2>

      {/* company selector */}
      <div>
        <p className="mb-2 text-xs font-normal text-muted">{t('platform.editor.modelCompany')}</p>
        <div className="flex flex-wrap gap-2">
          {PROVIDERS.map((p) => (
            <button
              key={p.id}
              onClick={() => setActiveId(p.id)}
              className={cn(
                'rounded-xl border px-3 py-1.5 text-xs font-medium transition',
                activeId === p.id ? 'border-violet/60 bg-violet/10 text-text' : 'border-ice/10 text-muted hover:border-ice/25',
              )}
            >
              {p.name}
            </button>
          ))}
        </div>
      </div>

      {/* models of the active company */}
      <div className="grid gap-2.5 sm:grid-cols-2">
        {active.models.map((m) => (
          <button
            key={m.id}
            onClick={() => onModel(m.id)}
            className={cn(
              'flex items-center justify-between rounded-xl border p-3.5 text-left transition',
              model === m.id ? 'border-violet/60 bg-violet/10' : 'border-ice/10 hover:border-ice/25',
            )}
          >
            <div>
              <p className="flex items-center gap-1.5 text-sm font-normal text-text">
                {m.label}
                {m.premium && <span className="rounded-full bg-violet/15 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-violet">Pro 💎</span>}
              </p>
              <p className="text-[11px] text-muted">{m.id}</p>
            </div>
            {model === m.id && <Check size={16} className="text-violet" />}
          </button>
        ))}
      </div>

      {/* API key source for the active company */}
      <div className="space-y-3 rounded-2xl border border-ice/10 bg-ice/[0.02] p-4">
        <p className="text-xs font-normal text-muted">
          {t('platform.editor.keySource')} · OpenRouter
        </p>
        <div className="grid gap-2.5 sm:grid-cols-2">
          <button
            onClick={() => setUseOwn(false)}
            className={cn(
              'rounded-xl border p-3 text-left transition',
              !showOwn ? 'border-violet/60 bg-violet/10' : 'border-ice/10 hover:border-ice/25',
            )}
          >
            <p className="flex items-center gap-1.5 text-sm font-normal text-text">
              <Sparkles size={14} className="text-violet" /> {t('platform.editor.keyNemo')}
            </p>
            <p className="mt-1 text-[11px] leading-snug text-muted">{t('platform.editor.keyNemoHint')}</p>
          </button>
          <button
            onClick={() => setUseOwn(true)}
            className={cn(
              'rounded-xl border p-3 text-left transition',
              showOwn ? 'border-violet/60 bg-violet/10' : 'border-ice/10 hover:border-ice/25',
            )}
          >
            <p className="flex items-center gap-1.5 text-sm font-normal text-text">
              <KeyRound size={14} className="text-cyan" /> {t('platform.editor.keyOwn')}
            </p>
            <p className="mt-1 text-[11px] leading-snug text-muted">{t('connectAIModel.securityNote')}</p>
          </button>
        </div>

        {showOwn && (
          <div>
            {checkingKey ? (
              <div className="flex items-center gap-2 rounded-xl border border-ice/10 bg-black/15 p-3 text-xs text-muted"><Loader2 size={14} className="animate-spin" /> {t('common.loading')}</div>
            ) : ownKeyConnected ? (
              <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-teal/20 bg-teal/[0.06] p-3">
                <span className="flex items-center gap-2 text-xs text-teal"><Check size={14} /> {t('connectAIModel.keyConnected')}</span>
                <button type="button" onClick={() => void disconnectKey()} disabled={savingKey} className="inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs text-muted transition hover:bg-white/5 hover:text-text disabled:opacity-50">
                  {savingKey ? <Loader2 size={13} className="animate-spin" /> : <Unplug size={13} />} {t('connectAIModel.disconnect')}
                </button>
              </div>
            ) : isSupabaseEnabled ? <div className="flex gap-2">
              <input
                type="password"
                value={keyInput}
                onChange={(e) => setKeyInput(e.target.value)}
                placeholder={t('platform.editor.keyPlaceholder')}
                className={inputCls}
                autoComplete="off"
              />
              <button
                onClick={() => void saveKey()}
                disabled={savingKey || !/^sk-or-v1-[A-Za-z0-9_-]{20,}$/.test(keyInput.trim())}
                className="shrink-0 rounded-xl bg-brand px-3 py-2.5 text-sm font-medium text-white disabled:opacity-50"
              >
                {savingKey ? <Loader2 size={15} className="animate-spin" /> : t('platform.editor.keySave')}
              </button>
            </div> : <p className="rounded-xl border border-amber/25 bg-amber/10 p-3 text-xs text-muted">{t('connectAIModel.errConnectGeneric')}</p>}
          </div>
        )}
      </div>

      {/* temperature */}
      <label className="block space-y-1.5">
        <span className="block text-xs font-normal text-muted">
          {t('platform.editor.temperature')} · {temperature.toFixed(1)}
        </span>
        <input
          type="range"
          min={0}
          max={1}
          step={0.1}
          value={temperature}
          onChange={(e) => onTemperature(Number(e.target.value))}
          className="w-full cursor-pointer accent-violet"
        />
        <p className="mt-1 text-[11px] text-muted">{t('platform.editor.tempHint')}</p>
      </label>
    </div>
  )
}
