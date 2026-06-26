import { create } from 'zustand'
import { seedAgents } from '../data/platform'
import { supabase, isSupabaseEnabled } from '../lib/supabase'
import type { AgentColor } from '../types'
import type { PlatformAgent } from '../types/platform'

let counter = 100
export const newAgentId = () => `ag_${++counter}`

const palette: AgentColor[] = ['violet', 'blue', 'cyan', 'teal', 'amber']

export function blankAgent(): PlatformAgent {
  return {
    id: newAgentId(),
    name: '',
    type: 'chat',
    avatarColor: palette[counter % palette.length],
    role: '',
    prompt: { role: '', tasks: '', tone: '', rules: '' },
    model: 'google/gemma-4-31b-it:free',
    temperature: 0.6,
    timezone: 'Asia/Tashkent',
    schedule: '24/7',
    language: 'auto',
    status: 'draft',
    channels: [],
    knowledge: [],
    leadForm: {
      enabled: false,
      fields: [
        { id: 'f1', label: 'Ism', type: 'text', required: true },
        { id: 'f2', label: 'Telefon', type: 'phone', required: true },
      ],
      trigger: 'qiziqish bildirilganda',
      destination: 'table',
    },
    lastActivity: '—',
    dialoguesToday: 0,
  }
}

// ---- live (Supabase) mapping ----
const defaultLeadForm = blankAgent().leadForm

/* eslint-disable @typescript-eslint/no-explicit-any */
function mapAgent(row: any): PlatformAgent {
  const channels = Array.from(new Set((row.channels ?? []).map((c: any) => c.type))) as PlatformAgent['channels']
  const prompt = row.prompt ?? { role: '', tasks: '', tone: '', rules: '' }
  const lf = row.lead_form && Object.keys(row.lead_form).length ? row.lead_form : defaultLeadForm
  return {
    id: row.id,
    name: row.name ?? '',
    type: (row.type ?? 'chat') as PlatformAgent['type'],
    avatarColor: (row.avatar_color ?? 'violet') as AgentColor,
    role: prompt.role ?? '',
    prompt,
    model: row.model ?? 'google/gemma-4-31b-it:free',
    temperature: Number(row.temperature ?? 0.6),
    timezone: row.timezone ?? 'Asia/Tashkent',
    schedule: row.schedule ?? '24/7',
    language: row.default_lang ?? 'auto',
    status: row.status ?? 'active',
    channels,
    knowledge: [],
    leadForm: lf,
    lastActivity: '—',
    dialoguesToday: 0,
  }
}

function toRow(a: PlatformAgent): any {
  return {
    name: a.name,
    type: a.type,
    avatar_color: a.avatarColor,
    prompt: a.prompt,
    model: a.model,
    temperature: a.temperature,
    timezone: a.timezone,
    schedule: a.schedule,
    default_lang: a.language,
    status: a.status,
    lead_form: a.leadForm,
  }
}
/* eslint-enable @typescript-eslint/no-explicit-any */

interface AgentStore {
  agents: PlatformAgent[]
  hydrated: boolean
  accountId: string | null
  isAdmin: boolean
  tokenBalance: number
  hydrate: () => Promise<void>
  /** Re-fetch the account token balance (after a top-up / gift redeem). */
  refreshBalance: () => Promise<void>
  /** Resolve the caller's account_id (cached), fetching from `users` if needed. */
  ensureAccountId: () => Promise<string | null>
  addAgent: (a: PlatformAgent) => Promise<{ id?: string; error?: string }>
  updateAgent: (id: string, patch: Partial<PlatformAgent>) => void
  deleteAgent: (id: string) => void
  duplicateAgent: (id: string) => string
  toggleAgent: (id: string) => void
  getAgent: (id: string) => PlatformAgent | undefined
}

export const useAgentStore = create<AgentStore>((set, get) => ({
  agents: isSupabaseEnabled ? [] : seedAgents,
  hydrated: !isSupabaseEnabled,
  accountId: null,
  isAdmin: false,
  tokenBalance: 0,

  hydrate: async () => {
    if (!isSupabaseEnabled || !supabase) {
      set({ hydrated: true })
      return
    }
    const { data: prof } = await supabase.from('users').select('account_id, is_admin').single()
    const accountId = prof?.account_id ?? null
    const [{ data }, acc] = await Promise.all([
      supabase.from('agents').select('*, channels(type)').order('created_at', { ascending: false }),
      accountId ? supabase.from('accounts').select('token_balance').eq('id', accountId).single() : Promise.resolve({ data: null }),
    ])
    set({
      agents: (data ?? []).map(mapAgent),
      accountId,
      isAdmin: Boolean(prof?.is_admin),
      tokenBalance: Number((acc as { data: { token_balance?: number } | null })?.data?.token_balance ?? 0),
      hydrated: true,
    })
  },

  refreshBalance: async () => {
    if (!isSupabaseEnabled || !supabase) return
    const accountId = await get().ensureAccountId()
    if (!accountId) return
    const { data } = await supabase.from('accounts').select('token_balance').eq('id', accountId).single()
    set({ tokenBalance: Number(data?.token_balance ?? 0) })
  },

  ensureAccountId: async () => {
    const cached = get().accountId
    if (cached) return cached
    if (!isSupabaseEnabled || !supabase) return null
    const { data } = await supabase.from('users').select('account_id').single()
    const id = data?.account_id ?? null
    if (id) set({ accountId: id })
    return id
  },

  // Async + robust: the onboarding wizard calls this before the app shell has
  // hydrated, so we resolve account_id on demand, persist via insert+select to
  // get the real row (and its UUID), and surface any error instead of swallowing it.
  addAgent: async (a) => {
    if (!isSupabaseEnabled || !supabase) {
      set((s) => ({ agents: [a, ...s.agents] }))
      return { id: a.id }
    }
    // optimistic insert with the temp client id
    set((s) => ({ agents: [a, ...s.agents] }))
    const accountId = await get().ensureAccountId()
    const { data, error } = await supabase
      .from('agents')
      .insert({ ...toRow(a), ...(accountId ? { account_id: accountId } : {}) })
      .select('*, channels(type)')
      .single()
    if (error || !data) {
      // roll back the optimistic row so the UI doesn't lie about success
      set((s) => ({ agents: s.agents.filter((x) => x.id !== a.id) }))
      return { error: error?.message ?? 'insert failed' }
    }
    const real = mapAgent(data)
    set((s) => ({ agents: s.agents.map((x) => (x.id === a.id ? real : x)) }))
    return { id: real.id }
  },

  updateAgent: (id, patch) => {
    set((s) => ({ agents: s.agents.map((a) => (a.id === id ? { ...a, ...patch } : a)) }))
    if (isSupabaseEnabled && supabase) {
      const merged = get().agents.find((a) => a.id === id)
      if (merged) void supabase.from('agents').update(toRow(merged)).eq('id', id).then(() => {})
    }
  },

  deleteAgent: (id) => {
    set((s) => ({ agents: s.agents.filter((a) => a.id !== id) }))
    if (isSupabaseEnabled && supabase) void supabase.from('agents').delete().eq('id', id).then(() => {})
  },

  duplicateAgent: (id) => {
    const src = get().agents.find((a) => a.id === id)
    const copy: PlatformAgent = {
      ...(src ?? blankAgent()),
      id: newAgentId(),
      name: (src?.name ?? 'Agent') + ' (nusxa)',
      status: 'draft',
      dialoguesToday: 0,
      lastActivity: '—',
    }
    set((s) => ({ agents: [copy, ...s.agents] }))
    if (isSupabaseEnabled && supabase) {
      const accountId = get().accountId
      void supabase
        .from('agents')
        .insert({ ...toRow(copy), ...(accountId ? { account_id: accountId } : {}) })
        .then(() => get().hydrate())
    }
    return copy.id
  },

  toggleAgent: (id) => {
    set((s) => ({
      agents: s.agents.map((a) =>
        a.id === id ? { ...a, status: a.status === 'active' ? 'paused' : 'active' } : a,
      ),
    }))
    if (isSupabaseEnabled && supabase) {
      const a = get().agents.find((x) => x.id === id)
      if (a) void supabase.from('agents').update({ status: a.status }).eq('id', id).then(() => {})
    }
  },

  getAgent: (id) => get().agents.find((a) => a.id === id),
}))
