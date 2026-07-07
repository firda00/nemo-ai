import { useState } from 'react'
import { Send, Loader2, CheckCircle2, X } from 'lucide-react'
import { supabase } from '../../lib/supabase'
import { useI18n } from '../../i18n'
import { Button } from '../ui/Button'
import { cn } from '../../lib/cn'

export interface BotTarget {
  agent_id?: string
  sub_agent_id?: string
  scope?: 'dm' | 'group'
  label?: string
}

/**
 * Paste a @BotFather token and bind it to a target: the whole team (agent_id),
 * a single sub-agent (sub_agent_id → its own bot in its persona), or a group
 * task-bot (scope:'group'). Compact mode renders a small pill that expands.
 */
export function TelegramBotConnect({
  target, connected, compact, hint, onConnected,
}: {
  target: BotTarget
  connected?: boolean
  compact?: boolean
  hint?: string
  onConnected?: (bot: string) => void
}) {
  const { t } = useI18n()
  const [open, setOpen] = useState(!compact)
  const [token, setToken] = useState('')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const [done, setDone] = useState(Boolean(connected))

  const connect = async () => {
    if (!supabase || token.trim().length < 20 || busy) return
    setBusy(true); setMsg(null)
    try {
      const { data, error } = await supabase.functions.invoke('connect-telegram', { body: { bot_token: token.trim(), ...target } })
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const p = data as any
      if (error || !p?.ok) { setMsg({ ok: false, text: (p?.error as string) || t('telegramBotConnect.errConnect') }); return }
      setDone(true); setMsg({ ok: true, text: t('telegramBotConnect.connectedMsg', { bot: p.bot }) }); setToken(''); onConnected?.(p.bot as string)
    } catch { setMsg({ ok: false, text: t('telegramBotConnect.errGeneric') }) } finally { setBusy(false) }
  }

  if (compact && !open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className={cn('shrink-0 inline-flex items-center gap-1 rounded-lg border px-2 py-1 text-[11px] transition', done ? 'border-teal/30 text-teal' : 'border-ice/12 text-muted hover:text-text')}
      >
        {done ? <><CheckCircle2 size={12} /> {t('telegramBotConnect.botLabel')}</> : <><Send size={12} /> {t('telegramBotConnect.botLabel')}</>}
      </button>
    )
  }

  return (
    <div className="w-full">
      {(hint || compact) && (
        <div className="flex items-start justify-between gap-2">
          {hint ? <p className="text-[12px] leading-relaxed text-muted">{hint}</p> : <span />}
          {compact && (
            <button onClick={() => { setOpen(false); setMsg(null); setToken('') }} className="shrink-0 rounded-lg p-1 text-muted hover:bg-white/5 hover:text-text" title={t('telegramBotConnect.collapse')} aria-label={t('telegramBotConnect.collapse')}>
              <X size={15} />
            </button>
          )}
        </div>
      )}
      <div className="mt-2 flex flex-col gap-2 sm:flex-row">
        <input
          value={token}
          onChange={(e) => setToken(e.target.value)}
          type="password"
          placeholder="123456789:AAH..."
          className="flex-1 rounded-xl border border-ice/10 bg-black/20 px-3 py-2 text-sm text-text outline-none placeholder:text-muted focus:border-violet/50"
        />
        <Button onClick={connect} disabled={busy || token.trim().length < 20}>
          {busy ? <><Loader2 size={15} className="animate-spin" /> …</> : <><Send size={15} /> {done ? t('telegramBotConnect.reconnect') : t('telegramBotConnect.connect')}</>}
        </Button>
      </div>
      {msg && <p className={cn('mt-2 rounded-lg px-3 py-2 text-xs', msg.ok ? 'bg-teal/10 text-teal' : 'bg-danger/10 text-danger')}>{msg.text}</p>}
    </div>
  )
}
