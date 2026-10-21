import { create } from 'zustand'
import { seedAgents } from '../data/platform'
import { supabase, isSupabaseEnabled } from '../lib/supabase'
import type { AgentColor } from '../types'
import type { PlatformAgent } from '../types/platform'
import { trackEvent } from '../lib/telemetry'
import { EmployeePersistenceError, persistEmployeeDraft, resolveEmployeeAccount } from '../lib/employeePersistence'

let counter = 100
let agentSessionVersion = 0
interface RowMutation { revision: number; pending: number; confirmed: PlatformAgent | null }
const rowMutations = new Map<string, RowMutation>()
const writeQueues = new Map<string, Promise<void>>()
const beginRowMutation = (id: string, current: PlatformAgent) => {
  const mutation = rowMutations.get(id) ?? { revision: 0, pending: 0, confirmed: current }
  mutation.revision += 1
  mutation.pending += 1
  rowMutations.set(id, mutation)
  return mutation
}
const finishRowMutation = (id: string, mutation: RowMutation) => {
  mutation.pending -= 1
  if (!mutation.pending && rowMutations.get(id) === mutation) rowMutations.delete(id)
}
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
    sttModel: 'auto',
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
    actionPolicy: row.action_policy === 'read_only' ? 'read_only' : 'approval_required',
    templateKey: row.template_key ?? '',
    voiceEnabled: Boolean(row.voice_enabled),
    voiceMode: (row.voice_mode ?? 'both') as PlatformAgent['voiceMode'],
    voiceId: row.voice_id ?? 'alloy',
    sttModel: (row.stt_model ?? 'auto') as PlatformAgent['sttModel'],
    personaMode: (row.persona_mode ?? 'business') as PlatformAgent['personaMode'],
    ownerName: row.owner_name ?? '',
    skills: Array.isArray(row.skills) ? row.skills : [],
    configRevision: Number(row.config_revision ?? 1),
    publishedRevision: row.published_revision == null ? null : Number(row.published_revision),
    publishedAt: row.published_at ?? null,
    latestEvalRunId: row.latest_eval_run_id ?? null,
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
    action_policy: a.actionPolicy ?? 'approval_required',
    template_key: a.templateKey?.trim() ? a.templateKey.trim() : null,
    voice_enabled: Boolean(a.voiceEnabled),
    voice_mode: a.voiceMode ?? 'both',
    voice_id: a.voiceId ?? null,
    stt_model: a.sttModel ?? 'auto',
    persona_mode: a.personaMode ?? 'business',
    owner_name: a.personaMode === 'personal' && a.ownerName?.trim() ? a.ownerName.trim() : null,
    skills: Array.isArray(a.skills) ? a.skills : [],
    // Publication is a server-owned transition. All authoring writes remain drafts.
    status: a.status === 'active' ? 'draft' : a.status,
    lead_form: a.leadForm,
  }
}
/* eslint-enable @typescript-eslint/no-explicit-any */

// A mutation never borrows a replacement session while getSession/fetch/body waits.
// The profile and write share one JWT, deadline and explicit tenant boundary.
async function writeAgentRow(id: string, accountId: string, method: 'PATCH' | 'DELETE', payload: unknown,
  alive: () => boolean): Promise<Record<string, unknown>> {
  if (!supabase) throw new EmployeePersistenceError('BACKEND_UNAVAILABLE')
  // Serialize writes to the same tenant row. A later optimistic edit must also
  // be the last persisted edit, not merely the last response accepted by the UI.
  const queueKey = `${accountId}:${id}`
  const predecessor = writeQueues.get(queueKey) ?? Promise.resolve()
  let release!: () => void
  const finished = new Promise<void>((resolve) => { release = resolve })
  const tail = Promise.all([predecessor, finished]).then(() => {})
  writeQueues.set(queueKey, tail)
  void tail.then(() => { if (writeQueues.get(queueKey) === tail) writeQueues.delete(queueKey) })
  const controller = new AbortController()
  let stopCode: 'SESSION_CHANGED' | 'SAVE_TIMEOUT' = 'SESSION_CHANGED'
  let userId: string | undefined
  let observedId: string | null | undefined
  const stop = (code: typeof stopCode) => { stopCode = code; controller.abort() }
  const subscription = supabase.auth.onAuthStateChange((event, session) => {
    observedId = session?.user.id ?? null
    if (event === 'SIGNED_OUT' || (userId === undefined && event === 'SIGNED_IN') || (userId !== undefined && userId !== observedId)) stop('SESSION_CHANGED')
  }).data.subscription
  const check = () => {
    if (!alive()) stop('SESSION_CHANGED')
    if (controller.signal.aborted) throw new EmployeePersistenceError(stopCode)
  }
  let onAbort: (() => void) | undefined
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(new EmployeePersistenceError(stopCode))
    controller.signal.addEventListener('abort', onAbort, { once: true })
  })
  const timer = setTimeout(() => stop('SAVE_TIMEOUT'), 15_000)
  try {
    const operation = (async () => {
      check()
      const { data, error } = await supabase.auth.getSession()
      check()
      const session = data?.session
      if (error || !session?.access_token || !session.user.id) throw new EmployeePersistenceError('AUTH_REQUIRED')
      userId = session.user.id
      if (observedId !== undefined && observedId !== userId) throw new EmployeePersistenceError('SESSION_CHANGED')
      // The token is already pinned, and queue time is part of the same deadline.
      await predecessor
      check()
      const base = String(import.meta.env.VITE_SUPABASE_URL ?? '')
      const anonKey = String(import.meta.env.VITE_SUPABASE_ANON_KEY ?? '')
      if (!base || !anonKey) throw new EmployeePersistenceError('BACKEND_UNAVAILABLE')
      const headers = { apikey: anonKey, Authorization: `Bearer ${session.access_token}`, 'Content-Type': 'application/json', Prefer: 'return=representation' }
      const request = async (table: string, query: Record<string, string>, write = false) => {
        check()
        const url = new URL(`rest/v1/${table}`, base.replace(/\/?$/, '/'))
        for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value)
        const response = await fetch(url, { method: write ? method : 'GET', headers, signal: controller.signal,
          ...(write && method === 'PATCH' ? { body: JSON.stringify(payload) } : {}) })
        check()
        const text = await response.text()
        check()
        if (text.length > 2_000_000 || !response.ok) throw new EmployeePersistenceError('SAVE_FAILED')
        try { return JSON.parse(text) as unknown } catch { throw new EmployeePersistenceError('SAVE_FAILED') }
      }
      const profile = await request('users', { select: 'account_id', id: `eq.${userId}`, limit: '1' })
      if (!Array.isArray(profile) || profile.length !== 1 || profile[0]?.account_id !== accountId) throw new EmployeePersistenceError('SESSION_CHANGED')
      const rows = await request('agents', { select: '*,channels(type)', id: `eq.${id}`, account_id: `eq.${accountId}` }, true)
      if (!Array.isArray(rows) || rows.length !== 1 || rows[0]?.id !== id || rows[0]?.account_id !== accountId) throw new EmployeePersistenceError('SAVE_FAILED')
      check()
      return rows[0] as Record<string, unknown>
    })()
    return await Promise.race([operation, aborted])
  } finally {
    clearTimeout(timer)
    if (onAbort) controller.signal.removeEventListener('abort', onAbort)
    subscription.unsubscribe()
    release()
  }
}

const mutationError = (error: unknown) => error instanceof EmployeePersistenceError ? error.code : 'SAVE_FAILED'

interface AgentStore {
  agents: PlatformAgent[]
  hydrated: boolean
  accountId: string | null
  isAdmin: boolean
  tokenBalance: number
  profileResolved: boolean
  hydrate: (options?: { forceProfile?: boolean }) => Promise<void>
  /** Re-fetch the account token balance (after a top-up / gift redeem). */
  refreshBalance: () => Promise<void>
  /** Resolve the caller's account_id (cached), fetching from `users` if needed. */
  ensureAccountId: () => Promise<string | null>
  addAgent: (a: PlatformAgent) => Promise<{ id?: string; error?: string }>
  updateAgent: (id: string, patch: Partial<PlatformAgent>) => Promise<{ error?: string }>
  deleteAgent: (id: string) => Promise<{ error?: string }>
  duplicateAgent: (id: string) => Promise<{ id?: string; error?: string }>
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

  hydrate: async (options) => {
    if (!isSupabaseEnabled || !supabase) {
      set({ agents: localAgents(), hydrated: true, profileResolved: true })
      return
    }
    const operationVersion = agentSessionVersion
    const alive = () => operationVersion === agentSessionVersion
    const { profileResolved, accountId: cachedAccountId, isAdmin: cachedIsAdmin } = get()
    let accountId = cachedAccountId
    let isAdmin = cachedIsAdmin

    if (options?.forceProfile || !profileResolved) {
      const { data: sessionData } = await supabase.auth.getSession()
      if (!alive()) return
      if (!sessionData.session) {
        set({ agents: [], accountId: null, isAdmin: false, tokenBalance: 0, profileResolved: false, hydrated: true })
        return
      }

      const { data: prof, error: profileError } = await supabase.from('users').select('account_id, is_admin').eq('id', sessionData.session.user.id).maybeSingle()
      if (!alive()) return
      if (profileError) {
        // A transient profile read must not switch an authenticated tenant into demo mode.
        set({ profileResolved: false, hydrated: true })
        return
      }
      if (!prof?.account_id) {
        set({ agents: [], accountId: null, isAdmin: false, tokenBalance: 0, profileResolved: false, hydrated: true })
        return
      }
      accountId = prof.account_id
      isAdmin = Boolean(prof?.is_admin)
      // Publish the verified profile with the registry below, not ahead of it.
    }

    if (accountId === 'demo') {
      set({ agents: [], accountId: null, isAdmin: false, tokenBalance: 0, profileResolved: false, hydrated: true })
      return
    }

    const [agentResult, accountResult] = await Promise.all([
      accountId ? supabase.from('agents').select('*, channels(type)').eq('account_id', accountId).order('created_at', { ascending: false }) : Promise.resolve({ data: [] }),
      accountId ? supabase.from('accounts').select('token_balance').eq('id', accountId).single() : Promise.resolve({ data: null }),
    ])
    if (!alive()) return
    if ('error' in agentResult && agentResult.error) {
      // Preserve the last known registry rather than showing a false empty state.
      set({ ...(get().accountId === accountId ? {} : { agents: [] }), accountId, isAdmin, hydrated: true })
      return
    }
    set({
      agents: (agentResult.data ?? []).map(mapAgent),
      accountId,
      isAdmin,
      profileResolved: Boolean(accountId),
      tokenBalance: Number((accountResult as { data: { token_balance?: number } | null })?.data?.token_balance ?? 0),
      hydrated: true,
    })
  },

  refreshBalance: async () => {
    if (!isSupabaseEnabled || !supabase) return
    const accountId = await get().ensureAccountId()
    if (!accountId || accountId === 'demo') return
    const operationVersion = agentSessionVersion
    const { data } = await supabase.from('accounts').select('token_balance').eq('id', accountId).single()
    if (operationVersion !== agentSessionVersion || get().accountId !== accountId) return
    set({ tokenBalance: Number(data?.token_balance ?? 0) })
  },

  ensureAccountId: async () => {
    if (!isSupabaseEnabled || !supabase) return null
    const operationVersion = agentSessionVersion
    const alive = () => operationVersion === agentSessionVersion
    try {
      const result = await resolveEmployeeAccount(supabase, { alive })
      if (!alive()) return null
      set((s) => ({ ...(s.accountId === result.accountId ? {} : { agents: [], tokenBalance: 0 }), accountId: result.accountId, isAdmin: result.isAdmin, profileResolved: true }))
      return result.accountId
    } catch {
      if (alive()) set({ accountId: null, isAdmin: false, profileResolved: false, agents: [], tokenBalance: 0 })
      return null
    }
  },

  // Async + robust: the onboarding wizard calls this before the app shell has
  // hydrated, so we resolve account_id on demand, persist via insert+select to
  // get the real row (and its UUID), and surface any error instead of swallowing it.
  addAgent: async (a) => {
    if (!isSupabaseEnabled || !supabase) {
      set((s) => ({ agents: [a, ...s.agents] }))
      return { id: a.id }
    }
    const operationVersion = agentSessionVersion
    const alive = () => operationVersion === agentSessionVersion
    try {
      // No optimistic success: only a confirmed row can enter the live registry.
      const result = await persistEmployeeDraft(supabase, a.id, toRow(a), { alive })
      if (!alive()) return { error: 'SESSION_CHANGED' }
      const real = mapAgent(result.row)
      set((s) => ({ agents: [real, ...(s.accountId === result.accountId ? s.agents.filter((x) => x.id !== real.id) : [])], accountId: result.accountId, isAdmin: result.isAdmin, profileResolved: true }))
      void trackEvent('agent_created', { type: real.type, status: real.status })
      return { id: real.id }
    } catch (error) {
      return { error: error instanceof EmployeePersistenceError ? error.code : 'SAVE_FAILED' }
    }
  },

  updateAgent: async (id, patch) => {
    const previous = get().agents.find((a) => a.id === id)
    if (!previous) return { error: 'agent not found' }
    const accountId = get().accountId
    if (isSupabaseEnabled && (!accountId || accountId === 'demo')) return { error: 'PROFILE_UNAVAILABLE' }
    const version = agentSessionVersion
    const mutation = beginRowMutation(id, previous)
    const revision = mutation.revision
    const alive = () => version === agentSessionVersion && get().accountId === accountId
    const latest = () => alive() && mutation.revision === revision
    const merged = { ...previous, ...patch, id }
    const payload = JSON.parse(JSON.stringify(toRow(merged)))
    set((s) => ({ agents: s.agents.map((a) => a.id === id ? merged : a) }))
    if (!isSupabaseEnabled) { finishRowMutation(id, mutation); return {} }
    try {
      const row = await writeAgentRow(id, accountId!, 'PATCH', payload, alive)
      if (!alive()) return { error: 'SESSION_CHANGED' }
      mutation.confirmed = mapAgent(row)
      if (latest()) set((s) => ({ agents: s.agents.map((a) => a.id === id ? mutation.confirmed! : a) }))
    } catch (error) {
      if (latest() && mutation.confirmed) set((s) => ({ agents: s.agents.map((a) => a === merged ? mutation.confirmed! : a) }))
      return { error: mutationError(error) }
    } finally {
      finishRowMutation(id, mutation)
    }
    return {}
  },

  deleteAgent: async (id) => {
    const previous = get().agents.find((a) => a.id === id)
    if (!previous) return { error: 'agent not found' }
    const accountId = get().accountId
    if (isSupabaseEnabled && (!accountId || accountId === 'demo')) return { error: 'PROFILE_UNAVAILABLE' }
    const version = agentSessionVersion
    const mutation = beginRowMutation(id, previous)
    const revision = mutation.revision
    const alive = () => version === agentSessionVersion && get().accountId === accountId
    set((s) => ({ agents: s.agents.filter((a) => a.id !== id) }))
    if (!isSupabaseEnabled) { finishRowMutation(id, mutation); return {} }
    try {
      await writeAgentRow(id, accountId!, 'DELETE', undefined, alive)
      if (!alive()) return { error: 'SESSION_CHANGED' }
      mutation.confirmed = null
    } catch (error) {
      if (alive() && mutation.revision === revision && mutation.confirmed) set((s) => ({ agents: s.agents.some((a) => a.id === id) ? s.agents : [mutation.confirmed!, ...s.agents] }))
      return { error: mutationError(error) }
    } finally {
      finishRowMutation(id, mutation)
    }
    return {}
  },

  duplicateAgent: async (id) => {
    const src = get().agents.find((a) => a.id === id)
    if (!src) return { error: 'agent not found' }
    const copy: PlatformAgent = {
      ...structuredClone(src),
      id: crypto.randomUUID(),
      name: src.name + ' (nusxa)',
      status: 'draft',
      channels: [], knowledge: [], configRevision: 1,
      publishedRevision: null, publishedAt: null, latestEvalRunId: null,
      dialoguesToday: 0,
      lastActivity: '—',
    }
    return get().addAgent(copy)
  },

  toggleAgent: async (id) => {
    const current = get().agents.find((a) => a.id === id)
    if (!current) return { error: 'agent not found' }
    if (current.status !== 'active') return { error: 'Run a passing evaluation before publishing this agent.' }
    const accountId = get().accountId
    if (isSupabaseEnabled && (!accountId || accountId === 'demo')) return { error: 'PROFILE_UNAVAILABLE' }
    const version = agentSessionVersion
    const mutation = beginRowMutation(id, current)
    const revision = mutation.revision
    const alive = () => version === agentSessionVersion && get().accountId === accountId
    const latest = () => alive() && mutation.revision === revision
    const paused: PlatformAgent = { ...current, status: 'paused' }
    set((s) => ({ agents: s.agents.map((a) => a.id === id ? paused : a) }))
    if (!isSupabaseEnabled) { finishRowMutation(id, mutation); return {} }
    try {
      const row = await writeAgentRow(id, accountId!, 'PATCH', { status: 'paused' }, alive)
      if (!alive()) return { error: 'SESSION_CHANGED' }
      mutation.confirmed = mapAgent(row)
      if (latest()) set((s) => ({ agents: s.agents.map((a) => a.id === id ? mutation.confirmed! : a) }))
    } catch (error) {
      if (latest() && mutation.confirmed) set((s) => ({ agents: s.agents.map((a) => a === paused ? mutation.confirmed! : a) }))
      return { error: mutationError(error) }
    } finally {
      finishRowMutation(id, mutation)
    }
    return {}
  },

  getAgent: (id) => get().agents.find((a) => a.id === id),
}))

// Clear cached tenant state synchronously on identity loss/replacement; in-flight
// profile, hydration and insert results also check this generation before publish.
if (isSupabaseEnabled && supabase) {
  let userId: string | null | undefined
  supabase.auth.onAuthStateChange((event, session) => {
    const nextUserId = session?.user.id ?? null
    if (event === 'SIGNED_OUT' || (userId !== undefined && userId !== nextUserId)) {
      agentSessionVersion += 1
      rowMutations.clear()
      useAgentStore.setState({ agents: [], accountId: null, isAdmin: false, tokenBalance: 0, profileResolved: false, hydrated: false })
    }
    userId = nextUserId
  })
  useAgentStore.subscribe((state, previous) => {
    if (previous.accountId && state.accountId !== previous.accountId) {
      agentSessionVersion += 1
      rowMutations.clear()
    }
  })
}
