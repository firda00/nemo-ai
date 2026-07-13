import { useEffect, useState } from 'react'
import { KeyRound, Loader2, CheckCircle2, ExternalLink, ShieldCheck, Sparkles, Unplug } from 'lucide-react'
import { supabase, isSupabaseEnabled } from '../../lib/supabase'
import { useI18n } from '../../i18n'
import { Button } from '../ui/Button'
import { cn } from '../../lib/cn'

/**
 * Self-service BYO model. A user connects their OWN OpenRouter account so the whole
 * platform runs on THEIR balance (OpenRouter routes to GPT-5 / Claude / Gemini / … —
 * the legal, stable equivalent of "use my paid AI"; no ChatGPT login/scraping).
 * The key is validated + stored server-only (write-only, never read back by the client).
 */
export function ConnectAIModel() {
  const { t } = useI18n()
  const [loading, setLoading] = useState(isSupabaseEnabled)
  const [connected, setConnected] = useState(false)
  const [label, setLabel] = useState<string | null>(null)
  const [key, setKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const keyValid = /^sk-or-v1-[A-Za-z0-9_-]{20,}$/.test(key.trim())

  useEffect(() => {
    if (!isSupabaseEnabled || !supabase) return
    ;(async () => {
      try {
        const { data } = await supabase!.functions.invoke('connect-model', { body: { action: 'status' } })
        const p = data as { connected?: boolean; label?: string } | null
        if (p?.connected) { setConnected(true); setLabel(p.label ?? null) }
      } catch { /* ignore */ }
      setLoading(false)
    })()
  }, [])

  const connect = async () => {
    if (!supabase || !keyValid || busy) return
    setBusy(true); setMsg(null)
    try {
      const { data } = await supabase.functions.invoke('connect-model', { body: { action: 'connect', api_key: key.trim() } })
      const p = data as { ok?: boolean; connected?: boolean; label?: string; error?: string } | null
      if (!p?.ok) { setMsg({ ok: false, text: p?.error ?? t('connectAIModel.errConnect') }); return }
      setConnected(true); setLabel(p.label ?? null); setKey('')
      setMsg({ ok: true, text: t('connectAIModel.connectedMsg') })
    } catch { setMsg({ ok: false, text: t('connectAIModel.errConnectGeneric') }) } finally { setBusy(false) }
  }

  const disconnect = async () => {
    if (!supabase || busy) return
    setBusy(true); setMsg(null)
    try {
      await supabase.functions.invoke('connect-model', { body: { action: 'disconnect' } })
      setConnected(false); setLabel(null)
      setMsg({ ok: true, text: t('connectAIModel.disconnectedMsg') })
    } catch { setMsg({ ok: false, text: t('connectAIModel.errGeneric') }) } finally { setBusy(false) }
  }

  return (
    <section className="card rounded-3xl p-6">
      <div className="flex items-center gap-2">
        <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-violet/15 text-violet"><Sparkles size={18} /></span>
        <div>
          <h2 className="text-lg font-bold text-text">{t('connectAIModel.title')}</h2>
          <p className="text-sm text-muted">{t('connectAIModel.subtitle')}</p>
        </div>
        {connected && <span className="ml-auto inline-flex items-center gap-1 rounded-full bg-teal/10 px-2.5 py-0.5 text-[11px] text-teal"><CheckCircle2 size={12} /> {t('connectAIModel.connectedBadge')}</span>}
      </div>

      <p className="mt-4 rounded-xl border border-ice/[0.07] bg-black/20 p-3 text-[12px] leading-relaxed text-muted">
        {t('connectAIModel.infoP1')}<span className="text-text">GPT-5, Claude, Gemini</span>{t('connectAIModel.infoP2')}
      </p>

      {loading ? (
        <div className="mt-4 flex items-center gap-2 text-sm text-muted"><Loader2 size={15} className="animate-spin" /> …</div>
      ) : connected ? (
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <span className="inline-flex items-center gap-2 rounded-xl border border-teal/20 bg-teal/[0.06] px-3 py-2 text-sm text-text"><KeyRound size={15} className="text-teal" /> {t('connectAIModel.keyConnected')}{label ? ` · ${label}` : ''}</span>
          <Button variant="ghost" onClick={disconnect} disabled={busy}>{busy ? <Loader2 size={15} className="animate-spin" /> : <Unplug size={15} />} {t('connectAIModel.disconnect')}</Button>
        </div>
      ) : (
        <>
          <ol className="mt-4 space-y-1.5 text-[13px] text-muted">
            <li>{t('connectAIModel.step1a')}<a href="https://openrouter.ai/keys" target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-violet hover:underline">openrouter.ai/keys <ExternalLink size={12} /></a>{t('connectAIModel.step1b')}</li>
            <li>{t('connectAIModel.step2a')}<span className="text-text">Create Key</span>{t('connectAIModel.step2b')}<span className="text-text">sk-or-...</span>{t('connectAIModel.step2c')}</li>
            <li>{t('connectAIModel.step3')}</li>
          </ol>
          <div className="mt-3 flex flex-col gap-2 sm:flex-row">
            <input
              value={key}
              onChange={(e) => setKey(e.target.value)}
              type="password"
              placeholder="sk-or-v1-..."
              className="flex-1 rounded-xl border border-ice/10 bg-black/20 px-3 py-2 text-sm text-text outline-none placeholder:text-muted focus:border-violet/50"
            />
            <Button onClick={connect} disabled={busy || !keyValid}>
              {busy ? <><Loader2 size={15} className="animate-spin" /> …</> : <><KeyRound size={15} /> {t('connectAIModel.connect')}</>}
            </Button>
          </div>
          {key.length > 0 && !keyValid && <p className="mt-2 text-xs text-danger">OpenRouter key must start with sk-or-v1- and contain the full key.</p>}
        </>
      )}

      {msg && <p className={cn('mt-3 rounded-lg px-3 py-2 text-xs', msg.ok ? 'bg-teal/10 text-teal' : 'bg-danger/10 text-danger')}>{msg.text}</p>}

      <p className="mt-4 flex items-center gap-1.5 text-[11px] text-fog"><ShieldCheck size={13} className="text-teal" /> {t('connectAIModel.securityNote')}</p>
    </section>
  )
}
