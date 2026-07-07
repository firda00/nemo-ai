import { useCallback, useEffect, useMemo, useState, type KeyboardEvent } from 'react'
import { useSearchParams } from 'react-router-dom'
import { Search, ArrowLeft, Hand, Bot, Send, X, Info, MessagesSquare, Tag, GitBranch, CheckCircle2 } from 'lucide-react'
import { useI18n } from '../../i18n'
import { useAgentStore } from '../../store/useAgentStore'
import { mockDialogues } from '../../data/platform'
import { channelMeta, channelLabel, dialogueStatusStyle } from '../../lib/platformMeta'
import { supabase, isSupabaseEnabled } from '../../lib/supabase'
import { cn } from '../../lib/cn'
import type { ChannelType, Dialogue, DialogueMessage, DialogueStatus } from '../../types/platform'

const live = isSupabaseEnabled

const statusKey: Record<DialogueStatus, string> = {
  open: 'statusOpen',
  resolved: 'statusResolved',
  needs_operator: 'statusNeedsOp',
  error: 'statusError',
}

let mid = 0

export default function DialoguesPage() {
  const { t } = useI18n()
  const getAgent = useAgentStore((s) => s.getAgent)
  const [params] = useSearchParams()
  const [dialogues, setDialogues] = useState<Dialogue[]>(live ? [] : mockDialogues)
  const [agentNames, setAgentNames] = useState<Record<string, string>>({})
  const [loading, setLoading] = useState(live)
  const [selectedId, setSelectedId] = useState<string | null>(params.get('d') ?? (live ? null : mockDialogues[0]?.id ?? null))
  const [query, setQuery] = useState('')
  const [channelF, setChannelF] = useState<ChannelType | 'all'>('all')
  const [statusF, setStatusF] = useState<DialogueStatus | 'all'>('all')
  const [custOpen, setCustOpen] = useState(false)
  const [reply, setReply] = useState('')

  // live mode: load dialogues + messages from Supabase, refresh on realtime events
  const load = useCallback(async () => {
    if (!live || !supabase) return
    const { data } = await supabase
      .from('dialogues')
      .select('*, messages(*), agents(name)')
      .order('updated_at', { ascending: false })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rows = (data ?? []) as any[]
    setDialogues(rows.map(mapDialogue))
    const names: Record<string, string> = {}
    for (const r of rows) if (r.agents?.name) names[r.agent_id] = r.agents.name
    setAgentNames(names)
    setLoading(false)
  }, [])

  useEffect(() => {
    if (!live || !supabase) return
    window.setTimeout(() => void load(), 0)
    const ch = supabase
      .channel('dialogues-rt')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'messages' }, () => load())
      .on('postgres_changes', { event: '*', schema: 'public', table: 'dialogues' }, () => load())
      .subscribe()
    // safety-net poll in case realtime is unavailable
    const iv = setInterval(load, 7000)
    return () => {
      supabase?.removeChannel(ch)
      clearInterval(iv)
    }
  }, [load])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return dialogues.filter((d) => {
      const matchQ = !q || d.customerName.toLowerCase().includes(q) || d.customerContact.toLowerCase().includes(q) || d.messages.some((m) => m.content.toLowerCase().includes(q))
      return matchQ && (channelF === 'all' || d.channel === channelF) && (statusF === 'all' || d.status === statusF)
    })
  }, [dialogues, query, channelF, statusF])

  const selected = dialogues.find((d) => d.id === selectedId) ?? null
  const agentName = selected
    ? (live ? agentNames[selected.agentId] ?? '—' : getAgent(selected.agentId)?.name ?? '—')
    : '—'

  const setSelected = (patch: Partial<Dialogue>) =>
    setDialogues((ds) => ds.map((d) => (d.id === selectedId ? { ...d, ...patch } : d)))

  const toggleTakeover = async () => {
    if (!selected) return
    const next = !selected.operatorTakeover
    setSelected({ operatorTakeover: next, status: next ? 'needs_operator' : 'open' })
    if (live && supabase) {
      await supabase
        .from('dialogues')
        .update({ operator_takeover: next, status: next ? 'needs_operator' : 'open' })
        .eq('id', selected.id)
    }
  }

  const sendReply = async () => {
    const text = reply.trim()
    if (!text || !selected) return
    setReply('')
    setSelected({
      messages: [...selected.messages, { id: `op${++mid}`, author: 'operator', content: text, time: nowTime() }],
      updatedAt: nowTime(),
    })
    if (live && supabase) {
      await supabase.functions.invoke('operator-send', { body: { dialogue_id: selected.id, text } })
    }
  }

  return (
    <div className="flex h-[calc(100vh-4rem)]">
      {/* list */}
      <aside className={cn('w-full shrink-0 flex-col border-r border-ice/[0.07] bg-panel sm:w-[320px] sm:flex', selected ? 'hidden sm:flex' : 'flex')}>
        <div className="space-y-2.5 border-b border-ice/[0.07] p-3">
          <h1 className="px-1 text-sm font-normal text-text">{t('platform.nav.dialogues')}</h1>
          <div className="relative">
            <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
            <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t('platform.dialogues.search')} aria-label={t('common.search')} className="glass w-full rounded-lg py-2 pl-9 pr-3 text-sm text-text outline-none placeholder:text-muted/70 focus:border-violet/50" />
          </div>
          <div className="flex gap-2">
            <select value={channelF} onChange={(e) => setChannelF(e.target.value as ChannelType | 'all')} className="glass flex-1 rounded-lg px-2 py-1.5 text-xs text-text outline-none">
              <option value="all" className="bg-panel">{t('platform.dialogues.allChannels')}</option>
              {(Object.keys(channelMeta) as ChannelType[]).map((c) => (
                <option key={c} value={c} className="bg-panel">{channelLabel(c, t)}</option>
              ))}
            </select>
            <select value={statusF} onChange={(e) => setStatusF(e.target.value as DialogueStatus | 'all')} className="glass flex-1 rounded-lg px-2 py-1.5 text-xs text-text outline-none">
              <option value="all" className="bg-panel">{t('platform.dialogues.allStatuses')}</option>
              {(Object.keys(statusKey) as DialogueStatus[]).map((s) => (
                <option key={s} value={s} className="bg-panel">{t(`platform.dialogues.${statusKey[s]}`)}</option>
              ))}
            </select>
          </div>
        </div>
        <div className="flex-1 overflow-y-auto p-2">
          {loading ? (
            <p className="px-2 py-8 text-center text-xs text-muted">{t('common.loading')}</p>
          ) : filtered.length === 0 ? (
            <p className="px-2 py-8 text-center text-xs text-muted">{t('platform.dialogues.empty')}</p>
          ) : (
            <ul className="space-y-0.5">
              {filtered.map((d) => {
                const meta = channelMeta[d.channel]
                const active = d.id === selectedId
                return (
                  <li key={d.id}>
                    <button onClick={() => { setSelectedId(d.id); setCustOpen(false) }} className={cn('flex w-full items-start gap-2.5 rounded-xl px-2.5 py-2.5 text-left transition-colors', active ? 'bg-ice/[0.08]' : 'hover:bg-ice/[0.04]')}>
                      <span className="relative mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg" style={{ background: `${meta.color}22`, color: meta.color }}>
                        <meta.Icon size={16} />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="flex items-center justify-between gap-2">
                          <span className="truncate text-sm font-normal text-text">{d.customerName}</span>
                          <span className="shrink-0 text-[10px] text-muted">{d.updatedAt}</span>
                        </span>
                        <span className="mt-0.5 line-clamp-1 text-xs text-muted">{d.messages[d.messages.length - 1]?.content}</span>
                        <span className="mt-1 flex items-center gap-1.5">
                          <span className={cn('rounded-full px-1.5 py-0.5 text-[9px] font-normal', dialogueStatusStyle[d.status])}>{t(`platform.dialogues.${statusKey[d.status]}`)}</span>
                          {d.unread > 0 && <span className="flex h-4 min-w-4 items-center justify-center rounded-full border border-cobalt/50 px-1 font-mono text-[9px] text-cobalt">{d.unread}</span>}
                        </span>
                      </span>
                    </button>
                  </li>
                )
              })}
            </ul>
          )}
        </div>
      </aside>

      {/* conversation */}
      {selected ? (
        <div className="flex min-w-0 flex-1 flex-col">
          <header className="flex shrink-0 items-center justify-between gap-3 border-b border-ice/[0.07] bg-panel/60 px-4 py-3 backdrop-blur">
            <div className="flex items-center gap-2.5">
              <button onClick={() => setSelectedId(null)} className="rounded-lg p-1.5 text-muted hover:bg-ice/[0.05] sm:hidden">
                <ArrowLeft size={18} />
              </button>
              <div>
                <p className="text-sm font-normal text-text">{selected.customerName}</p>
                <p className="text-[11px] text-muted">{channelLabel(selected.channel, t)} · {agentName}</p>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <button onClick={toggleTakeover} className={cn('inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-normal transition-colors', selected.operatorTakeover ? 'bg-amber/15 text-amber' : 'glass text-text hover:bg-ice/[0.09]')}>
                <Hand size={14} /> {selected.operatorTakeover ? t('platform.dialogues.handBack') : t('platform.dialogues.takeover')}
              </button>
              <button onClick={() => setCustOpen(true)} className="rounded-lg border border-ice/10 p-2 text-muted hover:bg-ice/[0.05] xl:hidden" aria-label={t('platform.dialogues.customer')}>
                <Info size={16} />
              </button>
            </div>
          </header>

          <div className="flex-1 space-y-3 overflow-y-auto p-4">
            <div className="mx-auto mb-4 max-w-2xl rounded-2xl border border-violet/20 bg-violet/10 p-4">
              <div className="flex items-center justify-between gap-3">
                <p className="flex items-center gap-2 text-sm font-medium text-text"><GitBranch size={16} className="text-violet" /> Agent Trace</p>
                <span className="rounded-pill border border-teal/20 bg-teal/10 px-2.5 py-1 text-[10px] font-medium text-teal">Nemo Score 92</span>
              </div>
              <div className="mt-3 grid gap-2 sm:grid-cols-3">
                {[
                  ['Team Leader', 'Intent detected'],
                  ['Knowledge Agent', 'Found answer source'],
                  ['Sales Specialist', 'Prepared reply'],
                ].map(([agent, action]) => (
                  <div key={agent} className="rounded-xl border border-white/10 bg-bg/50 p-3">
                    <p className="flex items-center gap-1.5 text-xs font-medium text-text"><CheckCircle2 size={13} className="text-teal" /> {agent}</p>
                    <p className="mt-1 text-[11px] text-muted">{action}</p>
                  </div>
                ))}
              </div>
            </div>
            {selected.messages.map((m) => {
              const incoming = m.author === 'customer'
              return (
                <div key={m.id} className={cn('flex', incoming ? 'justify-start' : 'justify-end')}>
                  <div className="max-w-[75%]">
                    {!incoming && <p className={cn('mb-0.5 px-1 text-right text-[10px] font-normal', m.author === 'operator' ? 'text-amber' : 'text-violet')}>{m.author === 'operator' ? t('platform.dialogues.you') : agentName}</p>}
                    <div className={cn('whitespace-pre-wrap rounded-2xl px-3.5 py-2.5 text-sm leading-relaxed', incoming ? 'glass rounded-tl-md text-text' : m.author === 'operator' ? 'rounded-tr-md border border-orange/40 bg-orange/10 text-text' : 'rounded-tr-md border border-cobalt/40 bg-cobalt/10 text-text')}>
                      {m.content}
                    </div>
                    <p className={cn('mt-0.5 px-1 text-[10px] text-muted/70', incoming ? 'text-left' : 'text-right')}>{m.time}</p>
                  </div>
                </div>
              )
            })}
          </div>

          {/* operator composer */}
          <div className="shrink-0 border-t border-ice/[0.07] p-3">
            {selected.operatorTakeover ? (
              <div className="glass flex items-end gap-2 rounded-xl p-2">
                <textarea
                  value={reply}
                  onChange={(e) => setReply(e.target.value)}
                  onKeyDown={(e: KeyboardEvent<HTMLTextAreaElement>) => {
                    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendReply() }
                  }}
                  rows={1}
                  placeholder={t('platform.dialogues.replyPh')}
                  aria-label={t('platform.dialogues.replyPh')}
                  className="max-h-32 flex-1 resize-none bg-transparent px-2 py-1.5 text-sm text-text outline-none placeholder:text-muted/70"
                />
                <button onClick={sendReply} disabled={!reply.trim()} className="flex h-9 w-9 items-center justify-center rounded-lg border border-cobalt/50 text-cobalt transition-colors hover:bg-cobalt/10 disabled:opacity-40">
                  <Send size={16} />
                </button>
              </div>
            ) : (
              <div className="flex items-center justify-between gap-3 rounded-xl border border-ice/[0.07] bg-ice/[0.02] px-4 py-3">
                <span className="flex items-center gap-2 text-xs text-muted">
                  <Bot size={15} className="text-violet" /> {agentName}
                </span>
                <button onClick={toggleTakeover} className="text-xs font-normal text-violet hover:underline">
                  {t('platform.dialogues.takeover')}
                </button>
              </div>
            )}
          </div>
        </div>
      ) : (
        <div className="hidden flex-1 items-center justify-center sm:flex">
          <p className="flex flex-col items-center gap-3 text-sm text-muted">
            <MessagesSquare size={28} className="text-muted/50" />
            {t('platform.dialogues.selectHint')}
          </p>
        </div>
      )}

      {/* customer panel */}
      {selected && <CustomerPanel dialogue={selected} agentName={agentName} open={custOpen} onClose={() => setCustOpen(false)} />}
    </div>
  )
}

function CustomerPanel({ dialogue, agentName, open, onClose }: { dialogue: Dialogue; agentName: string; open: boolean; onClose: () => void }) {
  const { t } = useI18n()
  const meta = channelMeta[dialogue.channel]
  const Body = (
    <div className="space-y-5 p-5">
      <div className="flex flex-col items-center text-center">
        <span className="flex h-14 w-14 items-center justify-center rounded-full bg-indigo text-xl font-medium text-white">{dialogue.customerName.charAt(0)}</span>
        <p className="mt-3 font-normal text-text">{dialogue.customerName}</p>
        <span className={cn('mt-1 rounded-full px-2 py-0.5 text-[10px] font-normal', dialogueStatusStyle[dialogue.status])}>{t(`platform.dialogues.${statusKey[dialogue.status]}`)}</span>
      </div>
      <dl className="space-y-3 text-sm">
        <Row label={t('platform.dialogues.contact')} value={dialogue.customerContact} />
        <Row label={t('platform.dialogues.channel')} value={<span className="inline-flex items-center gap-1.5" style={{ color: meta.color }}><meta.Icon size={14} /> {channelLabel(dialogue.channel, t)}</span>} />
        <Row label={t('platform.dialogues.agent')} value={agentName} />
      </dl>
      <div>
        <p className="mb-1.5 text-xs font-normal text-muted">{t('platform.dialogues.tags')}</p>
        <div className="flex flex-wrap gap-1.5">
          {dialogue.tags.length ? dialogue.tags.map((tag) => (
            <span key={tag} className="inline-flex items-center gap-1 rounded-full bg-ice/[0.06] px-2 py-0.5 text-[11px] text-muted"><Tag size={11} /> {tag}</span>
          )) : <span className="text-[11px] text-muted">—</span>}
        </div>
      </div>
    </div>
  )

  return (
    <>
      <aside className="hidden w-[280px] shrink-0 border-l border-ice/[0.07] bg-panel xl:block">{Body}</aside>
      {open && (
        <div className="fixed inset-0 z-40 xl:hidden">
          <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
          <div className="absolute inset-y-0 right-0 w-[86%] max-w-xs bg-panel shadow-card animate-fadeIn">
            <div className="flex items-center justify-between border-b border-ice/[0.07] px-4 py-3">
              <h3 className="text-sm font-normal text-text">{t('platform.dialogues.customer')}</h3>
              <button onClick={onClose} className="rounded-lg p-1.5 text-muted hover:bg-ice/[0.06]"><X size={20} /></button>
            </div>
            {Body}
          </div>
        </div>
      )}
    </>
  )
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <dt className="text-muted">{label}</dt>
      <dd className="font-medium text-text">{value}</dd>
    </div>
  )
}

function nowTime() {
  return new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

function fmtTime(iso?: string) {
  if (!iso) return ''
  const d = new Date(iso)
  return isNaN(d.getTime()) ? '' : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

// --- map Supabase rows -> frontend Dialogue shape (live mode) ---
/* eslint-disable @typescript-eslint/no-explicit-any */
function mapMessage(m: any): DialogueMessage {
  return { id: m.id, author: m.author, content: m.content ?? '', time: fmtTime(m.created_at) }
}

function mapDialogue(row: any): Dialogue {
  const raw = (row.messages ?? []).slice().sort((a: any, b: any) => (a.created_at < b.created_at ? -1 : 1))
  return {
    id: row.id,
    agentId: row.agent_id,
    channel: row.channel,
    customerName: row.customer_name ?? '—',
    customerContact: row.customer_contact ?? '',
    status: row.status,
    tags: row.tags ?? [],
    operatorTakeover: !!row.operator_takeover,
    unread: 0,
    updatedAt: fmtTime(row.updated_at),
    messages: raw.map(mapMessage),
  }
}
/* eslint-enable @typescript-eslint/no-explicit-any */
