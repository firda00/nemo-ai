import { useEffect, useState } from 'react'
import { Check, KeyRound, Sparkles, Trash2 } from 'lucide-react'
import { useI18n } from '../../i18n'
import { PROVIDERS, providerOf } from '../../data/platform'
import { supabase, isSupabaseEnabled } from '../../lib/supabase'
import { useToast } from '../ui/Toast'
import { cn } from '../../lib/cn'

const inputCls =
  'glass w-full rounded-xl px-3 py-2.5 text-sm text-text outline-none transition-colors placeholder:text-muted/70 focus:border-violet/50 focus:shadow-glow'

/**
 * Model selection grouped by company. The user picks a company, then a model,
 * and chooses the API-key source: Nemo's key (billed via balance) or their own
 * key (stored server-only in provider_keys — never read back to the client).
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

  // Everything runs through OpenRouter, so BYO key = ONE OpenRouter key per
  // account (applies to every model). We can detect that a key exists but never
  // read the secret back.
  const [hasOwnKey, setHasOwnKey] = useState(false)
  const [useOwn, setUseOwn] = useState(false)
  const [keyInput, setKeyInput] = useState('')
  const [savingKey, setSavingKey] = useState(false)

  useEffect(() => {
    if (!isSupabaseEnabled || !supabase) return
    let on = true
    supabase
      .from('provider_keys')
      .select('provider')
      .eq('provider', 'openrouter')
      .maybeSingle()
      .then(({ data }) => {
        if (on) setHasOwnKey(Boolean(data))
      })
    return () => {
      on = false
    }
  }, [])

  const showOwn = useOwn || hasOwnKey

  const saveKey = async () => {
    if (!isSupabaseEnabled || !supabase || !keyInput.trim()) return
    setSavingKey(true)
    const { error } = await supabase
      .from('provider_keys')
      .upsert({ provider: 'openrouter', api_key: keyInput.trim() }, { onConflict: 'account_id,provider' })
    setSavingKey(false)
    if (error) {
      toast(error.message)
      return
    }
    setHasOwnKey(true)
    setKeyInput('')
    toast(t('platform.editor.keySaved'))
  }

  const removeKey = async () => {
    if (!isSupabaseEnabled || !supabase) return
    await supabase.from('provider_keys').delete().eq('provider', 'openrouter')
    setHasOwnKey(false)
    setUseOwn(false)
    toast(t('platform.editor.keyRemoved'))
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
              <p className="text-sm font-normal text-text">{m.label}</p>
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
              <KeyRound size={14} className={hasOwnKey ? 'text-teal' : 'text-cyan'} /> {t('platform.editor.keyOwn')}
            </p>
            <p className="mt-1 text-[11px] leading-snug text-muted">{t('platform.editor.keyOwnHint')}</p>
          </button>
        </div>

        {showOwn && (
          <div>
            {hasOwnKey ? (
              <div className="flex items-center justify-between rounded-xl border border-teal/25 bg-teal/[0.06] px-3 py-2.5">
                <span className="flex items-center gap-2 text-sm text-teal">
                  <Check size={15} /> {t('platform.editor.keyConnected')}
                </span>
                <button onClick={removeKey} className="rounded-lg p-1.5 text-muted hover:bg-ice/[0.06] hover:text-danger">
                  <Trash2 size={15} />
                </button>
              </div>
            ) : (
              <div className="flex gap-2">
                <input
                  type="password"
                  value={keyInput}
                  onChange={(e) => setKeyInput(e.target.value)}
                  placeholder={t('platform.editor.keyPlaceholder')}
                  className={inputCls}
                  autoComplete="off"
                />
                <button
                  onClick={saveKey}
                  disabled={savingKey || !keyInput.trim()}
                  className="shrink-0 rounded-xl bg-brand px-3 py-2.5 text-sm font-medium text-white disabled:opacity-50"
                >
                  {savingKey ? '…' : t('platform.editor.keySave')}
                </button>
              </div>
            )}
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
