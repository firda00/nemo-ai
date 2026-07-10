import { useEffect, useState } from 'react'
import { Loader2, Users, Link2, Check, Trash2 } from 'lucide-react'
import { supabase, isSupabaseEnabled } from '../../lib/supabase'
import { useI18n } from '../../i18n'
import { cn } from '../../lib/cn'

type Status = { connected: boolean; sheet_id?: string; tab?: string; map?: Record<string, number>; count?: number; sample?: Member[] }
type Member = { name: string; username: string; chatId: string; dept: string }
type Preview = { sheet_id: string; headers: string[]; rows: string[][]; sample: Member[] }
type MapKeys = 'name' | 'chatId' | 'username' | 'dept'
const COLS: MapKeys[] = ['name', 'chatId', 'username', 'dept']

/**
 * Connect a company's OWN Google Sheet as the planerka team roster (name + Telegram chat_id +
 * username + department). The planerka reads it to DM each person their tasks directly.
 */
export function PlanerkaMembersCard() {
  const { t } = useI18n()
  const [status, setStatus] = useState<Status | null>(null)
  const [url, setUrl] = useState('')
  const [tab, setTab] = useState('')
  const [preview, setPreview] = useState<Preview | null>(null)
  const [map, setMap] = useState<Record<MapKeys, number>>({ name: -1, chatId: -1, username: -1, dept: -1 })
  const [busy, setBusy] = useState<'load' | 'preview' | 'save' | 'off' | null>('load')
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)

  const loadStatus = async () => {
    if (!isSupabaseEnabled || !supabase) { setBusy(null); return }
    try {
      const { data } = await supabase.functions.invoke('planerka-members', { body: { action: 'status' } })
      setStatus((data as Status) ?? null)
    } finally { setBusy(null) }
  }
  useEffect(() => {
    let alive = true
    ;(async () => {
      if (!isSupabaseEnabled || !supabase) { if (alive) setBusy(null); return }
      try {
        const { data } = await supabase.functions.invoke('planerka-members', { body: { action: 'status' } })
        if (alive) setStatus((data as Status) ?? null)
      } finally { if (alive) setBusy(null) }
    })()
    return () => { alive = false }
  }, [])

  // best-effort: guess a column index by header keyword for the auto-mapping default
  const guess = (headers: string[], keys: string[]) => {
    const lower = headers.map((h) => h.toLowerCase())
    for (let i = 0; i < lower.length; i++) if (keys.some((k) => lower[i].includes(k))) return i
    return -1
  }

  const doPreview = async () => {
    if (!supabase || busy) return
    setBusy('preview'); setMsg(null); setPreview(null)
    try {
      const { data } = await supabase.functions.invoke('planerka-members', { body: { action: 'preview', url, tab } })
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const p = data as any
      if (!p?.ok) { setMsg({ ok: false, text: p?.message || p?.error || t('planerkaMembers.previewFail') }); return }
      const headers: string[] = p.headers ?? []
      setPreview({ sheet_id: p.sheet_id, headers, rows: p.rows ?? [], sample: p.sample ?? [] })
      setMap({
        name: guess(headers, ['имя', 'фио', 'сотрудник', 'ism', 'xodim', 'name']),
        chatId: guess(headers, ['chat', 'id', 'айди']),
        username: guess(headers, ['user', 'ник', 'логин', 'telegram', 'телеграм']),
        dept: guess(headers, ['отдел', 'должн', 'depart', 'position', 'role', 'lavozim', 'bo']),
      })
    } catch { setMsg({ ok: false, text: t('planerkaMembers.errGeneric') }) } finally { setBusy(null) }
  }

  const save = async () => {
    if (!supabase || busy) return
    setBusy('save'); setMsg(null)
    try {
      const clean: Record<string, number> = {}
      for (const k of COLS) if (map[k] >= 0) clean[k] = map[k]
      const { data } = await supabase.functions.invoke('planerka-members', { body: { action: 'save', url, tab, map: clean } })
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const p = data as any
      if (!p?.ok) { setMsg({ ok: false, text: p?.message || p?.error || t('planerkaMembers.errGeneric') }); return }
      setMsg({ ok: true, text: t('planerkaMembers.savedN', { n: p.count ?? 0 }) })
      setPreview(null); setUrl(''); setTab('')
      await loadStatus()
    } catch { setMsg({ ok: false, text: t('planerkaMembers.errGeneric') }) } finally { setBusy(null) }
  }

  const disconnect = async () => {
    if (!supabase || busy) return
    setBusy('off'); setMsg(null)
    try {
      await supabase.functions.invoke('planerka-members', { body: { action: 'disconnect' } })
      setStatus({ connected: false }); setPreview(null)
    } finally { setBusy(null) }
  }

  const inputCls = 'w-full rounded-xl border border-ice/12 bg-black/20 px-3 py-2 text-sm text-text outline-none focus:border-violet/50'
  const openUrl = status?.sheet_id ? `https://docs.google.com/spreadsheets/d/${status.sheet_id}/edit` : null

  return (
    <section className="card rounded-3xl p-6">
      <div className="flex items-center gap-2">
        <Users size={18} className="text-teal" />
        <h2 className="text-lg font-bold text-text">{t('planerkaMembers.title')}</h2>
      </div>
      <p className="mt-2 text-sm leading-relaxed text-muted">{t('planerkaMembers.desc')}</p>

      {busy === 'load' ? (
        <p className="mt-4 inline-flex items-center gap-2 text-sm text-muted"><Loader2 size={15} className="animate-spin" /> …</p>
      ) : status?.connected ? (
        <div className="mt-4">
          <div className="flex flex-wrap items-center gap-2 rounded-xl border border-teal/20 bg-teal/[0.06] px-3 py-2.5">
            <Check size={15} className="text-teal" />
            <span className="text-sm text-text">{t('planerkaMembers.connectedN', { n: status.count ?? 0 })}</span>
            {openUrl && <a href={openUrl} target="_blank" rel="noreferrer" className="ml-auto inline-flex items-center gap-1.5 text-xs text-violet hover:underline"><Link2 size={13} /> {t('planerkaMembers.open')}</a>}
            <button onClick={disconnect} disabled={busy === 'off'} className="inline-flex items-center gap-1 text-xs text-muted hover:text-danger disabled:opacity-40"><Trash2 size={13} /> {t('planerkaMembers.disconnect')}</button>
          </div>
          {!!status.sample?.length && (
            <ul className="mt-2 space-y-1 text-xs text-muted">
              {status.sample.map((m, i) => (
                <li key={i}>• {m.name || m.username || '—'}{m.dept ? ` — ${m.dept}` : ''}{m.chatId ? ' ✓' : ` (${t('planerkaMembers.needStart')})`}</li>
              ))}
            </ul>
          )}
        </div>
      ) : (
        <div className="mt-4 space-y-2">
          <input value={url} onChange={(e) => setUrl(e.target.value)} className={inputCls} placeholder={t('planerkaMembers.urlPh')} />
          <input value={tab} onChange={(e) => setTab(e.target.value)} className={inputCls} placeholder={t('planerkaMembers.tabPh')} />
          <button onClick={doPreview} disabled={busy === 'preview' || url.trim().length < 10} className="inline-flex items-center gap-2 rounded-xl bg-brand px-4 py-2 text-sm font-medium text-white transition disabled:opacity-40">
            {busy === 'preview' ? <Loader2 size={15} className="animate-spin" /> : <Link2 size={15} />} {t('planerkaMembers.preview')}
          </button>
        </div>
      )}

      {/* column mapping after a successful preview */}
      {preview && (
        <div className="mt-4 rounded-2xl border border-ice/10 bg-black/20 p-4">
          <p className="mb-3 text-xs font-medium uppercase tracking-wide text-muted">{t('planerkaMembers.mapTitle')}</p>
          <div className="grid gap-3 sm:grid-cols-2">
            {COLS.map((key) => (
              <label key={key} className="text-sm">
                <span className="mb-1 block text-xs text-muted">{t(`planerkaMembers.col_${key}`)}</span>
                <select value={map[key]} onChange={(e) => setMap((m) => ({ ...m, [key]: Number(e.target.value) }))} className={inputCls}>
                  <option value={-1} className="bg-panel">{t('planerkaMembers.colNone')}</option>
                  {preview.headers.map((h, i) => <option key={i} value={i} className="bg-panel">{h || `#${i + 1}`}</option>)}
                </select>
              </label>
            ))}
          </div>
          {!!preview.sample.length && (
            <p className="mt-3 text-xs text-teal">{t('planerkaMembers.detectedN', { n: preview.sample.length })}</p>
          )}
          <button onClick={save} disabled={busy === 'save' || map.name < 0} className="mt-3 inline-flex items-center gap-2 rounded-xl bg-brand px-4 py-2 text-sm font-medium text-white transition disabled:opacity-40">
            {busy === 'save' ? <Loader2 size={15} className="animate-spin" /> : <Check size={15} />} {t('planerkaMembers.save')}
          </button>
        </div>
      )}

      {msg && <p className={cn('mt-3 rounded-lg px-3 py-2 text-xs', msg.ok ? 'bg-teal/10 text-teal' : 'bg-danger/10 text-danger')}>{msg.text}</p>}
    </section>
  )
}
