import { supabase, isSupabaseEnabled } from './supabase'
import type { Dialogue, DialogueMessage } from '../types/platform'

// Aggregates for Dashboard / Analytics computed from live Supabase data.
// In demo mode these are not used (pages fall back to mock data).

function fmt(iso?: string) {
  if (!iso) return ''
  const d = new Date(iso)
  return isNaN(d.getTime()) ? '' : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

/* eslint-disable @typescript-eslint/no-explicit-any */
function mapMsg(m: any): DialogueMessage {
  return { id: m.id, author: m.author, content: m.content ?? '', time: fmt(m.created_at) }
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
    updatedAt: fmt(row.updated_at),
    messages: raw.map(mapMsg),
  }
}
/* eslint-enable @typescript-eslint/no-explicit-any */

export interface LiveSummary {
  dialogues: Dialogue[]
  total: number
  resolved: number
  resolvedPct: number
  byChannel: { channel: string; value: number }[]
  daily: number[]
  leads: number
}

export async function fetchLiveSummary(): Promise<LiveSummary | null> {
  if (!isSupabaseEnabled || !supabase) return null
  const { data } = await supabase
    .from('dialogues')
    .select('*, messages(*)')
    .order('updated_at', { ascending: false })
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rows = (data ?? []) as any[]
  const dialogues = rows.map(mapDialogue)

  const total = dialogues.length
  const resolved = dialogues.filter((d) => d.status === 'resolved').length
  const resolvedPct = total ? Math.round((resolved / total) * 100) : 0

  const chMap: Record<string, number> = {}
  for (const d of dialogues) chMap[d.channel] = (chMap[d.channel] ?? 0) + 1
  const byChannel = Object.entries(chMap).map(([channel, value]) => ({ channel, value }))

  // last-30-days dialogue volume from created_at (page slices to the chosen range)
  const days = 30
  const buckets = new Array<number>(days).fill(0)
  const now = Date.now()
  for (const r of rows) {
    const ts = r.created_at ? new Date(r.created_at).getTime() : NaN
    if (isNaN(ts)) continue
    const ageDays = Math.floor((now - ts) / 86400000)
    if (ageDays >= 0 && ageDays < days) buckets[days - 1 - ageDays] += 1
  }

  const { count } = await supabase.from('leads').select('*', { count: 'exact', head: true })

  return { dialogues, total, resolved, resolvedPct, byChannel, daily: buckets, leads: count ?? 0 }
}
