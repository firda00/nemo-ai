import { useEffect, useState } from 'react'
import { Coins, Zap, BadgeCheck, Gift, Loader2, Check } from 'lucide-react'
import { useI18n } from '../../i18n'
import { useToast } from '../../components/ui/Toast'
import { MODELS } from '../../data/platform'
import { TOKEN_PACKAGES } from '../../data/billing'
import { Button } from '../../components/ui/Button'
import { useAgentStore } from '../../store/useAgentStore'
import { supabase, isSupabaseEnabled } from '../../lib/supabase'
import { cn } from '../../lib/cn'

const live = isSupabaseEnabled

interface UsageRow {
  id: string
  created_at: string
  model: string
  tokens: number
}

export default function BillingPage() {
  const { t } = useI18n()
  const toast = useToast()
  const tokenBalance = useAgentStore((s) => s.tokenBalance)
  const refreshBalance = useAgentStore((s) => s.refreshBalance)
  const [dialogs, setDialogs] = useState(300)
  const [usage, setUsage] = useState<UsageRow[]>([])
  const [giftCode, setGiftCode] = useState('')
  const [redeeming, setRedeeming] = useState(false)
  const [buying, setBuying] = useState<string | null>(null)
  const cost = (dialogs * 1500).toLocaleString('ru-RU')

  useEffect(() => {
    if (live && supabase) {
      supabase
        .from('usage')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(20)
        .then(({ data }) => setUsage((data ?? []) as UsageRow[]))
    }
  }, [])

  // returning from a successful Stripe checkout
  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    if (params.get('paid') === '1') {
      refreshBalance()
      toast(t('platform.billing.paidOk'))
      window.history.replaceState({}, '', '/app/billing')
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const buy = async (id: string) => {
    if (!live || !supabase) {
      toast(t('platform.billing.buyErr'))
      return
    }
    setBuying(id)
    const { data, error } = await supabase.functions.invoke('create-checkout', { body: { package: id } })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const url = (data as any)?.url as string | undefined
    if (error || !url) {
      setBuying(null)
      toast(t('platform.billing.buyErr'))
      return
    }
    window.location.href = url
  }

  const balance = live ? tokenBalance : 87660
  const modelLabel = (id: string) => MODELS.find((m) => m.id === id)?.label ?? id

  const redeem = async () => {
    const code = giftCode.trim()
    if (!code || redeeming) return
    setRedeeming(true)
    if (live && supabase) {
      const { data, error } = await supabase.functions.invoke('redeem-gift', { body: { code } })
      setRedeeming(false)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const d = data as any
      if (error || !d?.ok) {
        toast(t('platform.billing.redeemErr'))
        return
      }
      setGiftCode('')
      refreshBalance()
      toast(`+${Number(d.added).toLocaleString()} ${t('platform.billing.redeemOk')}`)
    } else {
      setRedeeming(false)
      toast(t('platform.billing.redeemErr'))
    }
  }
  const fmtDate = (iso: string) => {
    const d = new Date(iso)
    return isNaN(d.getTime()) ? '—' : d.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
  }

  return (
    <div className="container-page max-w-4xl py-8">
      <h1 className="text-2xl font-normal tracking-tight text-text">{t('platform.nav.billing')}</h1>
      <p className="mt-1 text-sm text-muted">{t('platform.billing.subtitle')}</p>

      <div className="mt-6 grid gap-4 sm:grid-cols-2">
        <div className="card rounded-2xl p-5">
          <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-violet/15 text-violet"><BadgeCheck size={18} /></span>
          <p className="mt-4 text-xs text-muted">{t('platform.billing.planTitle')}</p>
          <p className="mt-0.5 text-lg font-normal text-text">{t('platform.billing.planBeta')}</p>
        </div>
        <div className="card rounded-2xl p-5">
          <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-cyan/15 text-cyan"><Coins size={18} /></span>
          <p className="mt-4 text-xs text-muted">{t('platform.billing.balance')}</p>
          <div className="mt-0.5">
            <p className="text-lg font-normal text-text">{balance.toLocaleString()} <span className="text-xs text-muted">{t('platform.billing.tokens')}</span></p>
          </div>
        </div>
      </div>

      {/* redeem gift card */}
      <div className="card mt-5 rounded-2xl p-5">
        <p className="flex items-center gap-2 text-sm font-medium text-text">
          <Gift size={16} className="text-violet" /> {t('platform.billing.redeemTitle')}
        </p>
        <div className="mt-3 flex gap-2">
          <input
            value={giftCode}
            onChange={(e) => setGiftCode(e.target.value.toUpperCase())}
            onKeyDown={(e) => e.key === 'Enter' && redeem()}
            placeholder={t('platform.billing.redeemPh')}
            className="glass w-full max-w-xs rounded-xl px-3 py-2.5 font-mono text-sm text-text outline-none placeholder:text-muted/60 focus:border-violet/50"
          />
          <Button size="sm" onClick={redeem} disabled={redeeming || !giftCode.trim()}>
            {redeeming ? <Loader2 size={14} className="animate-spin" /> : <Gift size={14} />} {t('platform.billing.redeemBtn')}
          </Button>
        </div>
      </div>

      {/* token packages */}
      <section className="mt-5">
        <h2 className="font-medium text-text">{t('platform.billing.buyTitle')}</h2>
        <p className="mt-0.5 text-sm text-muted">{t('platform.billing.buyDesc')}</p>
        <div className="mt-4 grid gap-4 sm:grid-cols-3">
          {TOKEN_PACKAGES.map((p) => (
            <div
              key={p.id}
              className={cn(
                'card relative flex flex-col rounded-2xl p-5',
                p.popular && 'border-violet/50 shadow-btn',
              )}
            >
              {p.popular && (
                <span className="absolute -top-2.5 left-5 rounded-pill bg-brand px-2.5 py-0.5 text-[10px] font-semibold text-white">
                  {t('platform.billing.popular')}
                </span>
              )}
              <p className="text-3xl font-bold text-text">
                ${p.usd}
              </p>
              <p className="mt-1 flex items-center gap-1.5 text-sm text-muted">
                <Coins size={14} className="text-cyan" /> {p.tokens.toLocaleString()} {t('platform.billing.tokens')}
              </p>
              <Button size="sm" className="mt-4" fullWidth onClick={() => buy(p.id)} disabled={buying === p.id}>
                {buying === p.id ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />} {t('platform.billing.buy')}
              </Button>
            </div>
          ))}
        </div>
      </section>

      {/* calculator */}
      <div className="card mt-5 rounded-2xl p-6">
        <h2 className="font-normal text-text">{t('platform.billing.calcTitle')}</h2>
        <p className="mt-1 text-sm text-muted">{t('platform.billing.calcDesc')}</p>
        <div className="mt-5 flex items-center justify-between text-sm">
          <span className="text-muted">{t('platform.billing.dialogsLabel')}</span>
          <span className="font-medium text-text">{dialogs.toLocaleString('ru-RU')}</span>
        </div>
        <input type="range" min={50} max={2000} step={50} value={dialogs} onChange={(e) => setDialogs(Number(e.target.value))} aria-label={t('platform.billing.dialogsLabel')} className="mt-3 w-full cursor-pointer accent-violet" />
        <div className="mt-1 flex justify-between text-[11px] text-muted"><span>50</span><span>2000</span></div>
        <div className="mt-5 flex items-center justify-between rounded-2xl border border-ice/[0.07] bg-ice/[0.02] p-4">
          <span className="text-xs text-muted">{t('platform.billing.estimate')}</span>
          <p className="text-2xl font-normal text-text">{cost} <span className="text-sm text-muted">{t('platform.billing.perMonth')}</span></p>
        </div>
      </div>

      {/* usage history */}
      <section className="card mt-5 rounded-2xl">
        <div className="flex items-center gap-2 border-b border-ice/[0.07] px-5 py-3.5">
          <Zap size={16} className="text-amber" />
          <h2 className="font-normal text-text">{t('platform.billing.usageTitle')}</h2>
        </div>
        {usage.length === 0 ? (
          <p className="px-5 py-10 text-center text-sm text-muted">{t('platform.billing.usageEmpty')}</p>
        ) : (
          <ul className="divide-y divide-ice/[0.05]">
            {usage.map((u) => (
              <li key={u.id} className="flex items-center justify-between gap-3 px-5 py-3 text-sm">
                <span className="text-muted">{fmtDate(u.created_at)}</span>
                <span className="text-text">{modelLabel(u.model)}</span>
                <span className="font-mono text-xs text-muted">{u.tokens?.toLocaleString('ru-RU')}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}
