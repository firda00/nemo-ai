import { create } from 'zustand'
import { seedAgents } from '../data/platform'
import { supabase, isSupabaseEnabled } from '../lib/supabase'
import type { AgentColor } from '../types'
import type { PlatformAgent } from '../types/platform'
import { trackEvent } from '../lib/telemetry'

let counter = 100
export const newAgentId = () => `ag_${++counter}`

const palette: AgentColor[] = ['violet', 'blue', 'cyan', 'teal', 'amber']
const localAgents = () => seedAgents.map((agent) => ({ ...agent }))

export function blankAgent(): PlatformAgent {
  return {
    id: newAgentId(),
    name: '',
    type: 'chat',
    avatarColor: palette[counter % palette.length],
    role: '',
    prompt: { role: '', tasks: '', tone: '', rules: '' },
    model: 'openai/gpt-4o-mini',
    temperature: 0.6,
    timezone: 'Asia/Tashkent',
    schedule: '24/7',
    workStart: '09:00',
    workEnd: '18:00',
    language: 'auto',
    country: '',
    purpose: '',
    niche: '',
    riskTier: 'standard',
    templateKey: '',
    voiceEnabled: false,
    voiceMode: 'both',
    voiceId: 'alloy',
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
    workStart: row.work_start ?? '09:00',
    workEnd: row.work_end ?? '18:00',
    language: row.default_lang ?? 'auto',
    country: row.country ?? '',
    purpose: row.purpose ?? '',
    niche: row.niche ?? '',
    riskTier: row.risk_tier === 'regulated' ? 'regulated' : 'standard',
    templateKey: row.template_key ?? '',
    voiceEnabled: Boolean(row.voice_enabled),
    voiceMode: (row.voice_mode ?? 'both') as PlatformAgent['voiceMode'],
    voiceId: row.voice_id ?? 'alloy',
    personaMode: (row.persona_mode ?? 'business') as PlatformAgent['personaMode'],
    ownerName: row.owner_name ?? '',
    skills: Array.isArray(row.skills) ? row.skills : [],
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
    work_start: a.workStart ?? null,
    work_end: a.workEnd ?? null,
    default_lang: a.language,
    country: a.country?.trim() ? a.country.trim() : null,
    purpose: a.purpose?.trim() ? a.purpose.trim() : null,
    niche: a.niche?.trim() ? a.niche.trim() : null,
    risk_tier: a.riskTier ?? 'standard',
    template_key: a.templateKey?.trim() ? a.templateKey.trim() : null,
    voice_enabled: Boolean(a.voiceEnabled),
    voice_mode: a.voiceMode ?? 'both',
    voice_id: a.voiceId ?? null,
    persona_mode: a.personaMode ?? 'business',
    owner_name: a.personaMode === 'personal' && a.ownerName?.trim() ? a.ownerName.trim() : null,
    skills: Array.isArray(a.skills) ? a.skills : [],
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
  profileResolved: boolean
  hydrate: () => Promise<void>
  /** Re-fetch the account token balance (after a top-up / gift redeem). */
  refreshBalance: () => Promise<void>
  /** Resolve the caller's account_id (cached), fetching from `users` if needed. */
  ensureAccountId: () => Promise<string | null>
  addAgent: (a: PlatformAgent) => Promise<{ id?: string; error?: string }>
  updateAgent: (id: string, patch: Partial<PlatformAgent>) => Promise<{ error?: string }>
  deleteAgent: (id: string) => Promise<{ error?: string }>
  duplicateAgent: (id: string) => string
  toggleAgent: (id: string) => Promise<{ error?: string }>

  getAgent: (id: string) => PlatformAgent | undefined
}

export const useAgentStore = create<AgentStore>((set, get) => ({
  agents: isSupabaseEnabled ? [] : localAgents(),
  hydrated: !isSupabaseEnabled,
  accountId: null,
  isAdmin: false,
  tokenBalance: 0,
  profileResolved: !isSupabaseEnabled,

  hydrate: async () => {
    if (!isSupabaseEnabled || !supabase) {
      set({ agents: localAgents(), hydrated: true, profileResolved: true })
      return
    }
    const { profileResolved, accountId: cachedAccountId, isAdmin: cachedIsAdmin } = get()
    let accountId = cachedAccountId
    let isAdmin = cachedIsAdmin

    if (!profileResolved) {
      const { data: sessionData } = await supabase.auth.getSession()
      if (!sessionData.session) {
        set({ agents: localAgents(), accountId: 'demo', isAdmin: false, tokenBalance: 0, profileResolved: true, hydrated: true })
        return
      }

      const { data: prof, error: profileError } = await supabase.from('users').select('account_id, is_admin').eq('id', sessionData.session.user.id).maybeSingle()
      if (profileError || !prof?.account_id) {
        set({ agents: localAgents(), accountId: 'demo', isAdmin: false, tokenBalance: 0, profileResolved: true, hydrated: true })
        return
      }
      accountId = prof?.account_id ?? 'demo'
      isAdmin = Boolean(prof?.is_admin)
      set({ accountId, isAdmin, profileResolved: true })
    }

    if (accountId === 'demo') {
      set({ agents: localAgents(), accountId, isAdmin: false, tokenBalance: 0, hydrated: true })
      return
    }

    const [{ data }, acc] = await Promise.all([
      accountId ? supabase.from('agents').select('*, channels(type)').eq('account_id', accountId).order('created_at', { ascending: false }) : Promise.resolve({ data: [] }),
      accountId ? supabase.from('accounts').select('token_balance').eq('id', accountId).single() : Promise.resolve({ data: null }),
    ])
    set({
      agents: (data ?? []).map(mapAgent),
      accountId,
      isAdmin,
      tokenBalance: Number((acc as { data: { token_balance?: number } | null })?.data?.token_balance ?? 0),
      hydrated: true,
    })
  },

  refreshBalance: async () => {
    if (!isSupabaseEnabled || !supabase) return
    const accountId = await get().ensureAccountId()
    if (!accountId || accountId === 'demo') return
    const { data } = await supabase.from('accounts').select('token_balance').eq('id', accountId).single()
    set({ tokenBalance: Number(data?.token_balance ?? 0) })
  },

  ensureAccountId: async () => {
    const cached = get().accountId
    if (cached) return cached
    if (get().profileResolved) return cached || null
    if (!isSupabaseEnabled || !supabase) return null
    const { data: sessionData } = await supabase.auth.getSession()
    if (!sessionData.session) {
      set({ accountId: 'demo', isAdmin: false, profileResolved: true })
      return 'demo'
    }
    const { data, error } = await supabase.from('users').select('account_id, is_admin').eq('id', sessionData.session.user.id).maybeSingle()
    if (error) {
      set({ accountId: 'demo', isAdmin: false, profileResolved: true })
      return 'demo'
    }
    const id = data?.account_id ?? 'demo'
    set({ accountId: id, isAdmin: Boolean(data?.is_admin), profileResolved: true })
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
    if (accountId === 'demo') return { id: a.id }
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
    void trackEvent('agent_created', { type: real.type, status: real.status })
    return { id: real.id }
  },

  updateAgent: async (id, patch) => {
    set((s) => ({ agents: s.agents.map((a) => (a.id === id ? { ...a, ...patch } : a)) }))
    if (isSupabaseEnabled && supabase && get().accountId && get().accountId !== 'demo') {
      const merged = get().agents.find((a) => a.id === id)
      if (merged) {
        const { error } = await supabase.from('agents').update(toRow(merged)).eq('id', id).eq('account_id', get().accountId as string)
        if (error) return { error: error.message }
      }
    }
    return {}
  },

  deleteAgent: async (id) => {
    const prev = get().agents
    set((s) => ({ agents: s.agents.filter((a) => a.id !== id) }))
    if (isSupabaseEnabled && supabase && get().accountId && get().accountId !== 'demo') {
      const { error } = await supabase.from('agents').delete().eq('id', id).eq('account_id', get().accountId as string)
      if (error) {
        set({ agents: prev }) // restore so the UI doesn't lie about a delete that failed
        return { error: error.message }
      }
    }
    return {}
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
    if (isSupabaseEnabled && supabase && get().accountId && get().accountId !== 'demo') {
      const accountId = get().accountId
      void supabase
        .from('agents')
        .insert({ ...toRow(copy), ...(accountId ? { account_id: accountId } : {}) })
        .then(() => get().hydrate())
    }
    return copy.id
  },

  toggleAgent: async (id) => {
    set((s) => ({
      agents: s.agents.map((a) =>
        a.id === id ? { ...a, status: a.status === 'active' ? 'paused' : 'active' } : a,
      ),
    }))
    if (isSupabaseEnabled && supabase && get().accountId && get().accountId !== 'demo') {
      const a = get().agents.find((x) => x.id === id)
      if (a) {
        const { error } = await supabase.from('agents').update({ status: a.status }).eq('id', id).eq('account_id', get().accountId as string)
        if (error) return { error: error.message }
      }
    }
    return {}
  },

  getAgent: (id) => get().agents.find((a) => a.id === id),
}))
