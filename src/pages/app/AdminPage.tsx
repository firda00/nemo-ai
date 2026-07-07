import { useCallback, useEffect, useState } from 'react'
import { ShieldCheck, Plus, Check, Coins, Gift, Loader2, Lock, Unlock, Ban } from 'lucide-react'
import { useI18n } from '../../i18n'
import { useToast } from '../../components/ui/Toast'
import { Button } from '../../components/ui/Button'
import { useAgentStore } from '../../store/useAgentStore'
import { supabase, isSupabaseEnabled } from '../../lib/supabase'
import { cn } from '../../lib/cn'

interface Account {
  id: string
  user_id: string | null
  email: string
  plan: string
  token_balance: number
  is_admin: boolean
  blocked: boolean
  agents: number
  last_login: string | null
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
  const [bcMsg, setBcMsg] = useState('')
  const [bcBusy, setBcBusy] = useState(false)
  const [bcResult, setBcResult] = useState<string | null>(null)

  const call = useCallback(async (action: string, extra: Record<string, unknown> = {}) => {
    if (!isSupabaseEnabled || !supabase) return null
    const { data, error } = await supabase.functions.invoke('admin-api', { body: { action, ...extra } })
    if (error || !(data as { ok?: boolean } | null)?.ok) return null
    return data as Record<string, unknown>
  }, [])

  const loadAll = useCallback(async () => {
    setLoading(true)
    const [a, g] = await Promise.all([call('list_accounts'), call('list_gifts')])
    if (a) setAccounts((a.accounts as Account[]) ?? [])
    if (g) setGifts((g.gifts as GiftRow[]) ?? [])
    setLoading(false)
  }, [call])
  useEffect(() => {
    if (isAdmin) window.setTimeout(() => void loadAll(), 0)
    else window.setTimeout(() => setLoading(false), 0)
  }, [isAdmin, loadAll])

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

  // soft block / unblock (unblock also lifts any hard ban)
  const setBlocked = async (a: Account, blocked: boolean) => {
    const res = await call('block', { account_id: a.id, blocked })
    if (!res) { toast(t('common.error')); return }
    if (!blocked && a.user_id) await call('ban', { user_id: a.user_id, banned: false })
    setAccounts((accs) => accs.map((x) => (x.id === a.id ? { ...x, blocked } : x)))
    toast(blocked ? t('platform.adminPanel.blockedMsg') : t('platform.adminPanel.unblockedMsg'))
  }
  // set the account's plan tier (controls which LLM the orchestrator uses)
  const setPlan = async (a: Account, plan: string) => {
    const res = await call('set_plan', { account_id: a.id, plan })
    if (!res) { toast(t('common.error')); return }
    setAccounts((accs) => accs.map((x) => (x.id === a.id ? { ...x, plan } : x)))
    toast(`Plan → ${plan}`)
  }
  // hard ban (cannot log in)
  const banUser = async (a: Account) => {
    if (!a.user_id) return
    const res = await call('ban', { user_id: a.user_id, banned: true })
    if (!res) { toast(t('common.error')); return }
    setAccounts((accs) => accs.map((x) => (x.id === a.id ? { ...x, blocked: true } : x)))
    toast(t('platform.adminPanel.bannedMsg'))
  }

  const fmtLogin = (iso: string | null) => {
    if (!iso) return t('platform.adminPanel.never')
    const d = new Date(iso)
    return isNaN(d.getTime()) ? '—' : d.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
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

  const sendBroadcast = async () => {
    if (!supabase || bcBusy || bcMsg.trim().length < 2) return
    setBcBusy(true); setBcResult(null)
    try {
      const { data } = await supabase.functions.invoke('send-broadcast', { body: { message: bcMsg.trim() } })
      const p = data as { ok?: boolean; recipients?: number; sent?: number; failed?: number; message?: string; error?: string } | null
      if (p?.ok) { setBcResult(t('adminPage.bcSent', { sent: p.sent ?? 0, recipients: p.recipients ?? 0, failed: p.failed ?? 0 })); setBcMsg('') }
      else setBcResult(p?.message ?? p?.error ?? t('adminPage.sendFailed'))
    } catch { setBcResult(t('adminPage.sendError')) } finally { setBcBusy(false) }
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

      {/* SMS broadcast — Nemo news/ads to all saved phones */}
      <div className="card mt-6 rounded-3xl p-6">
        <h2 className="flex items-center gap-2 text-sm font-bold text-text"><Coins size={16} className="text-violet" /> {t('adminPage.smsTitle')}</h2>
        <p className="mt-1 text-xs text-muted">{t('adminPage.smsDesc')}</p>
        <textarea value={bcMsg} onChange={(e) => setBcMsg(e.target.value)} rows={3} placeholder={t('adminPage.smsPh')} className="glass mt-3 w-full resize-y rounded-xl px-3 py-2.5 text-sm text-text outline-none placeholder:text-fog focus:border-violet/50" />
        <div className="mt-3 flex items-center gap-3">
          <Button onClick={sendBroadcast} disabled={bcBusy || bcMsg.trim().length < 2}>{bcBusy ? <Loader2 size={15} className="animate-spin" /> : <Coins size={15} />} {t('adminPage.sendAll')}</Button>
          {bcResult && <span className="text-xs text-muted">{bcResult}</span>}
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
                  <th className="py-2 pr-3 text-center font-normal">{t('platform.adminPanel.colAgents')}</th>
                  <th className="py-2 pr-3 font-normal">{t('platform.adminPanel.colLast')}</th>
                  <th className="py-2 pr-3 font-normal">{t('platform.adminPanel.colStatus')}</th>
                  <th className="py-2 pr-3 font-normal">{t('platform.adminPanel.colBalance')}</th>
                  <th className="py-2 font-normal">{t('platform.adminPanel.amountPh')}</th>
                </tr>
              </thead>
              <tbody>
                {accounts.map((a) => (
                  <tr key={a.id} className="border-b border-ice/[0.05]">
                    <td className="py-2.5 pr-3">
                      <div className="flex items-center gap-2">
                        <span className="max-w-[180px] truncate text-text">{a.email}</span>
                        {a.is_admin && <span className="rounded-full bg-violet/15 px-1.5 py-0.5 text-[9px] text-violet">{t('platform.adminPanel.adminBadge')}</span>}
                      </div>
                    </td>
                    <td className="py-2.5 pr-3 text-center text-muted">{a.agents}</td>
                    <td className="py-2.5 pr-3 text-xs text-muted">{fmtLogin(a.last_login)}</td>
                    <td className="py-2.5 pr-3">
                      <span className={cn('rounded-full px-2 py-0.5 text-[10px]', a.blocked ? 'bg-danger/15 text-danger' : 'bg-teal/15 text-teal')}>
                        {a.blocked ? t('platform.adminPanel.statusBlocked') : t('platform.adminPanel.statusActive')}
                      </span>
                    </td>
                    <td className="py-2.5 pr-3 font-medium text-text">{a.token_balance.toLocaleString()}</td>
                    <td className="py-2.5">
                      <div className="flex items-center gap-2">
                        <input
                          value={amounts[a.id] ?? ''}
                          onChange={(e) => setAmounts((m) => ({ ...m, [a.id]: e.target.value }))}
                          placeholder={t('platform.adminPanel.amountPh')}
                          className={cn(inputCls, 'w-24')}
                          inputMode="numeric"
                        />
                        <button onClick={() => apply(a.id, 'grant')} className="rounded-lg bg-brand px-2 py-1.5 text-xs font-medium text-white" title={t('platform.adminPanel.grant')}>
                          <Plus size={13} />
                        </button>
                        <button onClick={() => apply(a.id, 'set')} className="rounded-lg border border-ice/12 px-2 py-1.5 text-xs font-medium text-muted hover:text-text" title={t('platform.adminPanel.setBalance')}>
                          <Check size={13} />
                        </button>
                        <select value={a.plan ?? 'free'} onChange={(e) => setPlan(a, e.target.value)} className={cn(inputCls, 'w-[92px] cursor-pointer')} title="Plan (free=cheap model, pro/business=gpt-4o)">
                          <option value="free">free</option>
                          <option value="pro">pro</option>
                          <option value="business">business</option>
                        </select>
                        {!a.is_admin && (
                          <>
                            <button
                              onClick={() => setBlocked(a, !a.blocked)}
                              className={cn('rounded-lg border px-2 py-1.5 text-xs', a.blocked ? 'border-teal/30 text-teal hover:bg-teal/10' : 'border-ice/12 text-muted hover:text-text')}
                              title={a.blocked ? t('platform.adminPanel.unblock') : t('platform.adminPanel.block')}
                            >
                              {a.blocked ? <Unlock size={13} /> : <Lock size={13} />}
                            </button>
                            {!a.blocked && (
                              <button onClick={() => banUser(a)} className="rounded-lg border border-danger/30 px-2 py-1.5 text-xs text-danger hover:bg-danger/10" title={t('platform.adminPanel.ban')}>
                                <Ban size={13} />
                              </button>
                            )}
                          </>
                        )}
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
