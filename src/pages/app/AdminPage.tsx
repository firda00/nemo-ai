import { useEffect, useState } from 'react'
import { ShieldCheck, Plus, Check, Coins, Gift, Loader2 } from 'lucide-react'
import { useI18n } from '../../i18n'
import { useToast } from '../../components/ui/Toast'
import { Button } from '../../components/ui/Button'
import { useAgentStore } from '../../store/useAgentStore'
import { supabase, isSupabaseEnabled } from '../../lib/supabase'
import { cn } from '../../lib/cn'

interface Account {
  id: string
  email: string
  plan: string
  token_balance: number
  is_admin: boolean
}
interface GiftRow {
  code: string
  tokens: number
  redeemed_by: string | null
}

const inputCls = 'glass w-full rounded-lg px-2.5 py-1.5 text-sm text-text outline-none placeholder:text-muted/70 focus:border-violet/50'

export default function AdminPage() {
  const { t } = useI18n()
  const toast = useToast()
  const isAdmin = useAgentStore((s) => s.isAdmin)
  const accountId = useAgentStore((s) => s.accountId)
  const refreshBalance = useAgentStore((s) => s.refreshBalance)

  const [accounts, setAccounts] = useState<Account[]>([])
  const [gifts, setGifts] = useState<GiftRow[]>([])
  const [amounts, setAmounts] = useState<Record<string, string>>({})
  const [loading, setLoading] = useState(true)
  const [giftTokens, setGiftTokens] = useState('10000')
  const [giftCount, setGiftCount] = useState('1')
  const [busy, setBusy] = useState(false)

  const call = async (action: string, extra: Record<string, unknown> = {}) => {
    if (!isSupabaseEnabled || !supabase) return null
    const { data, error } = await supabase.functions.invoke('admin-api', { body: { action, ...extra } })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    if (error || !(data as any)?.ok) return null
    return data as Record<string, unknown>
  }

  const loadAll = async () => {
    setLoading(true)
    const [a, g] = await Promise.all([call('list_accounts'), call('list_gifts')])
    if (a) setAccounts((a.accounts as Account[]) ?? [])
    if (g) setGifts((g.gifts as GiftRow[]) ?? [])
    setLoading(false)
  }
  useEffect(() => {
    if (isAdmin) loadAll()
    else setLoading(false)
  }, [isAdmin])

  const apply = async (id: string, action: 'grant' | 'set') => {
    const amount = Number(amounts[id])
    if (!Number.isFinite(amount)) return
    const res = await call(action, { account_id: id, amount })
    if (!res) {
      toast(t('common.error'))
      return
    }
    setAccounts((accs) => accs.map((a) => (a.id === id ? { ...a, token_balance: Number(res.balance) } : a)))
    setAmounts((m) => ({ ...m, [id]: '' }))
    if (id === accountId) refreshBalance()
    toast(t('platform.adminPanel.granted'))
  }

  const createGift = async () => {
    setBusy(true)
    const res = await call('create_gift', { tokens: Number(giftTokens), count: Number(giftCount) })
    setBusy(false)
    if (!res) {
      toast(t('common.error'))
      return
    }
    toast(t('platform.adminPanel.giftCreated'))
    loadAll()
  }

  if (!isAdmin) {
    return (
      <div className="container-page max-w-2xl py-16 text-center">
        <ShieldCheck size={32} className="mx-auto text-muted/50" />
        <p className="mt-3 text-sm text-muted">403 — admin only</p>
      </div>
    )
  }

  return (
    <div className="container-page max-w-5xl py-8">
      <div className="flex items-center gap-3">
        <span className="flex h-11 w-11 items-center justify-center rounded-2xl bg-brand text-white shadow-btn">
          <ShieldCheck size={22} />
        </span>
        <div>
          <h1 className="text-2xl font-normal tracking-tight text-text">{t('platform.nav.admin')}</h1>
          <p className="text-sm text-muted">{t('platform.adminPanel.subtitle')}</p>
        </div>
      </div>

      {/* gift cards */}
      <section className="card mt-6 rounded-2xl p-5">
        <p className="flex items-center gap-2 text-sm font-medium text-text">
          <Gift size={16} className="text-violet" /> {t('platform.adminPanel.giftTitle')}
        </p>
        <p className="mt-0.5 text-xs text-muted">{t('platform.adminPanel.giftDesc')}</p>
        <div className="mt-3 flex flex-wrap items-end gap-3">
          <label className="space-y-1">
            <span className="block text-[11px] text-muted">{t('platform.adminPanel.giftTokens')}</span>
            <input value={giftTokens} onChange={(e) => setGiftTokens(e.target.value)} className={cn(inputCls, 'w-32')} inputMode="numeric" />
          </label>
          <label className="space-y-1">
            <span className="block text-[11px] text-muted">{t('platform.adminPanel.giftCount')}</span>
            <input value={giftCount} onChange={(e) => setGiftCount(e.target.value)} className={cn(inputCls, 'w-24')} inputMode="numeric" />
          </label>
          <Button size="sm" onClick={createGift} disabled={busy || !(Number(giftTokens) > 0)}>
            {busy ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />} {t('platform.adminPanel.giftCreate')}
          </Button>
        </div>
        {gifts.length > 0 && (
          <ul className="mt-4 space-y-1.5">
            {gifts.slice(0, 12).map((g) => (
              <li key={g.code} className="flex items-center gap-3 rounded-lg border border-ice/[0.07] bg-ice/[0.02] px-3 py-2 text-sm">
                <code className="font-mono text-cyan">{g.code}</code>
                <span className="flex items-center gap-1 text-muted"><Coins size={12} /> {g.tokens.toLocaleString()}</span>
                <span className={cn('ml-auto rounded-full px-2 py-0.5 text-[10px]', g.redeemed_by ? 'bg-ice/10 text-muted' : 'bg-teal/15 text-teal')}>
                  {g.redeemed_by ? t('platform.adminPanel.giftRedeemed') : t('platform.adminPanel.giftActive')}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* accounts */}
      <section className="card mt-6 rounded-2xl p-5">
        <p className="mb-3 flex items-center gap-2 text-sm font-medium text-text">
          <Coins size={16} className="text-violet" /> {t('platform.adminPanel.accountsTitle')} · {accounts.length}
        </p>
        {loading ? (
          <p className="py-8 text-center text-sm text-muted">{t('common.loading')}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-ice/[0.07] text-left text-xs text-muted">
                  <th className="py-2 pr-3 font-normal">{t('platform.adminPanel.colAccount')}</th>
                  <th className="py-2 pr-3 font-normal">{t('platform.adminPanel.colBalance')}</th>
                  <th className="py-2 font-normal">{t('platform.adminPanel.amountPh')}</th>
                </tr>
              </thead>
              <tbody>
                {accounts.map((a) => (
                  <tr key={a.id} className="border-b border-ice/[0.05]">
                    <td className="py-2.5 pr-3">
                      <div className="flex items-center gap-2">
                        <span className="truncate text-text">{a.email}</span>
                        {a.is_admin && <span className="rounded-full bg-violet/15 px-1.5 py-0.5 text-[9px] text-violet">{t('platform.adminPanel.adminBadge')}</span>}
                      </div>
                    </td>
                    <td className="py-2.5 pr-3 font-medium text-text">{a.token_balance.toLocaleString()}</td>
                    <td className="py-2.5">
                      <div className="flex items-center gap-2">
                        <input
                          value={amounts[a.id] ?? ''}
                          onChange={(e) => setAmounts((m) => ({ ...m, [a.id]: e.target.value }))}
                          placeholder={t('platform.adminPanel.amountPh')}
                          className={cn(inputCls, 'w-28')}
                          inputMode="numeric"
                        />
                        <button onClick={() => apply(a.id, 'grant')} className="rounded-lg bg-brand px-2.5 py-1.5 text-xs font-medium text-white">
                          <Plus size={12} className="mr-0.5 inline" />{t('platform.adminPanel.grant')}
                        </button>
                        <button onClick={() => apply(a.id, 'set')} className="rounded-lg border border-ice/12 px-2.5 py-1.5 text-xs font-medium text-muted hover:text-text">
                          <Check size={12} className="mr-0.5 inline" />{t('platform.adminPanel.setBalance')}
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  )
}
