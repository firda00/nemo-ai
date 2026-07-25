import { useCallback, useEffect, useState } from 'react'
import { ShieldCheck, Plus, Check, Coins, Gift, Loader2, Lock, Unlock, Ban, Bot, MessageSquareWarning, Sparkles, UserCog } from 'lucide-react'
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
interface FeedbackRow {
  id: string
  email: string | null
  rating: -1 | 1
  category: string
  comment: string | null
  path: string | null
  created_at: string
}
interface SkillReviewRow {
  id: string
  name: string
  source_filename: string | null
  status: 'shared_candidate' | 'shared' | 'rejected'
  compatibility_score: number | null
  analysis: { reason?: string; risks?: string[] }
  created_at: string
}
interface ModeratedAgent {
  id: string
  account_id: string
  email: string | null
  name: string
  status: string
  type: string
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
  const [feedback, setFeedback] = useState<FeedbackRow[]>([])
  const [skillReviews, setSkillReviews] = useState<SkillReviewRow[]>([])
  const [moderatedAgents, setModeratedAgents] = useState<ModeratedAgent[]>([])
  const [adminCapabilities, setAdminCapabilities] = useState({ set_admin: false, moderate_agents: false })
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
    const skillRequest = isSupabaseEnabled && supabase
      ? supabase.functions.invoke('review-skill', { body: { action: 'list_admin' } })
      : Promise.resolve({ data: null })
    const [a, g, f, skills] = await Promise.all([call('list_accounts'), call('list_gifts'), call('list_feedback'), skillRequest])
    if (a) {
      setAccounts((a.accounts as Account[]) ?? [])
      const capabilities = (a.capabilities as { set_admin?: boolean; moderate_agents?: boolean } | undefined) ?? {}
      setAdminCapabilities({ set_admin: capabilities.set_admin === true, moderate_agents: capabilities.moderate_agents === true })
      if (capabilities.moderate_agents === true) {
        const agentRows = await call('list_agents')
        if (agentRows) setModeratedAgents((agentRows.agents as ModeratedAgent[]) ?? [])
      }
    }
    if (g) setGifts((g.gifts as GiftRow[]) ?? [])
    if (f) setFeedback((f.feedback as FeedbackRow[]) ?? [])
    const skillData = skills.data as { skills?: SkillReviewRow[] } | null
    if (skillData?.skills) setSkillReviews(skillData.skills)
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
  const setAdmin = async (a: Account, enabled: boolean) => {
    if (!a.user_id) return
    const res = await call('set_admin', { user_id: a.user_id, enabled })
    if (!res) { toast(t('common.error')); return }
    setAccounts((rows) => rows.map((row) => row.id === a.id ? { ...row, is_admin: enabled } : row))
    toast(enabled ? 'Администратор назначен' : 'Права администратора сняты')
  }
  const quarantineAgent = async (agent: ModeratedAgent, quarantined: boolean) => {
    const res = await call('quarantine_agent', { agent_id: agent.id, quarantined })
    if (!res) { toast(t('common.error')); return }
    setModeratedAgents((rows) => rows.map((row) => row.id === agent.id ? { ...row, status: quarantined ? 'paused' : 'active' } : row))
    toast(quarantined ? 'Агент остановлен' : 'Агент восстановлен')
  }

  const reviewSkill = async (id: string, action: 'publish' | 'reject') => {
    if (!supabase) return
    const { data, error } = await supabase.functions.invoke('review-skill', { body: { action, id } })
    if (error || !(data as { ok?: boolean } | null)?.ok) { toast(t('common.error')); return }
    setSkillReviews((rows) => rows.map((row) => row.id === id ? { ...row, status: action === 'publish' ? 'shared' : 'rejected' } : row))
    toast(action === 'publish' ? 'Skill опубликован' : 'Skill отклонён')
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
      <section className="card mt-6 rounded-3xl p-6">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h2 className="flex items-center gap-2 text-sm font-bold text-text"><MessageSquareWarning size={16} className="text-amber" /> Жалобы и обратная связь</h2>
            <p className="mt-1 text-xs text-muted">Последние сообщения пользователей. Доступно только администраторам.</p>
          </div>
          <span className="rounded-full border border-white/10 px-2.5 py-1 text-xs text-muted">{feedback.length}</span>
        </div>
        {feedback.length === 0 ? <p className="mt-4 rounded-2xl border border-white/10 bg-black/10 p-4 text-sm text-muted">Новых сообщений нет.</p> : (
          <div className="mt-4 space-y-2">
            {feedback.slice(0, 20).map((row) => (
              <div key={row.id} className="rounded-2xl border border-white/10 bg-black/10 p-4">
                <div className="flex flex-wrap items-center gap-2 text-xs">
                  <span className={row.rating < 0 ? 'text-danger' : 'text-teal'}>{row.rating < 0 ? 'Жалоба' : 'Отзыв'}</span>
                  <span className="text-muted">{row.category}</span>
                  <span className="text-muted">{row.email || 'email unavailable'}</span>
                  <span className="ml-auto text-fog">{new Date(row.created_at).toLocaleString('ru-RU')}</span>
                </div>
                <p className="mt-2 whitespace-pre-wrap text-sm leading-relaxed text-text">{row.comment || 'Комментарий не добавлен'}</p>
                {row.path && <p className="mt-2 text-[11px] text-fog">Страница: {row.path}</p>}
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="card mt-6 rounded-3xl p-6">
        <div className="flex items-center justify-between gap-3">
          <div><h2 className="flex items-center gap-2 text-sm font-bold text-text"><Sparkles size={16} className="text-violet" /> Проверка пользовательских skills</h2><p className="mt-1 text-xs text-muted">AI может предложить публикацию, но окончательное решение принимает администратор.</p></div>
          <span className="rounded-full border border-white/10 px-2.5 py-1 text-xs text-muted">{skillReviews.filter((row) => row.status === 'shared_candidate').length}</span>
        </div>
        {skillReviews.length === 0 ? <p className="mt-4 rounded-2xl border border-white/10 bg-black/10 p-4 text-sm text-muted">Кандидатов на проверку нет.</p> : (
          <div className="mt-4 space-y-2">
            {skillReviews.map((row) => (
              <div key={row.id} className="rounded-2xl border border-white/10 bg-black/10 p-4">
                <div className="flex flex-wrap items-center gap-2"><p className="font-semibold text-text">{row.name}</p><span className="rounded-full border border-white/10 px-2 py-0.5 text-[10px] text-muted">{row.compatibility_score ?? 0}/100</span><span className="text-[10px] text-fog">{row.status}</span></div>
                <p className="mt-2 text-xs leading-relaxed text-muted">{row.analysis?.reason || 'Без пояснения'}</p>
                {row.analysis?.risks?.length ? <p className="mt-2 text-[11px] text-amber">Риски: {row.analysis.risks.join(', ')}</p> : null}
                {row.status === 'shared_candidate' && <div className="mt-3 flex gap-2"><Button size="sm" onClick={() => void reviewSkill(row.id, 'publish')}>Опубликовать</Button><Button size="sm" variant="ghost" onClick={() => void reviewSkill(row.id, 'reject')}>Оставить приватным</Button></div>}
              </div>
            ))}
          </div>
        )}
      </section>

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
                        <select value={a.plan ?? 'starter'} onChange={(e) => setPlan(a, e.target.value)} className={cn(inputCls, 'w-[112px] cursor-pointer')} title="Тариф аккаунта">
                          <option value="free">free</option>
                          <option value="starter">Starter</option>
                          <option value="pro">pro</option>
                          <option value="business">business</option>
                          <option value="agency">Agency</option>
                          <option value="enterprise">Enterprise</option>
                        </select>
                        {adminCapabilities.set_admin && a.user_id && (
                          <button onClick={() => void setAdmin(a, !a.is_admin)} className={cn('rounded-lg border px-2 py-1.5 text-xs', a.is_admin ? 'border-violet/30 text-violet' : 'border-ice/12 text-muted hover:text-text')} title={a.is_admin ? 'Снять права администратора' : 'Назначить администратором'}>
                            <UserCog size={13} />
                          </button>
                        )}
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

      {adminCapabilities.moderate_agents && (
        <section className="card mt-6 rounded-2xl p-5">
          <h2 className="flex items-center gap-2 text-sm font-bold text-text"><Bot size={16} className="text-violet" /> Модерация агентов · {moderatedAgents.length}</h2>
          <p className="mt-1 text-xs text-muted">Остановите агента, который нарушает правила конфиденциальности или условия использования. Удаление не выполняется — решение можно отменить.</p>
          <div className="mt-4 grid gap-2 md:grid-cols-2">
            {moderatedAgents.map((agent) => {
              const paused = agent.status === 'paused'
              return (
                <div key={agent.id} className="flex items-center gap-3 rounded-2xl border border-white/10 bg-black/10 p-3">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-semibold text-text">{agent.name}</p>
                    <p className="truncate text-xs text-muted">{agent.email ?? agent.account_id} · {agent.type}</p>
                  </div>
                  <button onClick={() => void quarantineAgent(agent, !paused)} className={cn('rounded-xl border px-3 py-1.5 text-xs font-medium', paused ? 'border-teal/30 text-teal hover:bg-teal/10' : 'border-danger/30 text-danger hover:bg-danger/10')}>
                    {paused ? 'Восстановить' : 'Остановить'}
                  </button>
                </div>
              )
            })}
          </div>
        </section>
      )}
    </div>
  )
}
