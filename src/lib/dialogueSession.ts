// Bounded REST operations with one captured JWT. Tenant scope is derived from that
// user's profile, never from a selected dialogue or the mutable global client.
import type { EmployeeAuthClient } from './employeePersistence'

export type DialogueRow = Record<string, unknown>
export interface DialogueScope {
  accountId: string
  check: () => void
  request: (table: 'agents' | 'dialogues' | 'messages', query: Record<string, string>, patch?: DialogueRow) => Promise<DialogueRow[]>
}
export interface DialogueSessionOptions {
  userId: string
  alive: () => boolean
  signal: AbortSignal
  timeoutMs?: number
  connection?: { url: string; anonKey: string }
  fetch?: typeof globalThis.fetch
}

export async function withDialogueSession<T>(client: EmployeeAuthClient, options: DialogueSessionOptions, work: (scope: DialogueScope) => Promise<T>): Promise<T> {
  const controller = new AbortController()
  const abort = () => controller.abort()
  options.signal.addEventListener('abort', abort, { once: true })
  const check = () => { if (!options.userId || !options.alive() || options.signal.aborted || controller.signal.aborted) throw new Error('SESSION_SCOPE_LOST') }
  const subscription = client.auth.onAuthStateChange((event, session) => { if (event === 'SIGNED_OUT' || session?.user.id !== options.userId) abort() }).data.subscription
  const timer = setTimeout(abort, options.timeoutMs ?? 15_000)
  let rejectOnAbort: (() => void) | undefined
  const cancelled = new Promise<never>((_, reject) => { rejectOnAbort = () => reject(new Error('REQUEST_INTERRUPTED')); controller.signal.addEventListener('abort', rejectOnAbort, { once: true }) })
  try {
    const operation = (async () => {
      check()
      const { data, error } = await client.auth.getSession()
      check()
      const session = data?.session
      if (error || session?.user.id !== options.userId || !session.access_token) throw new Error('AUTH_REQUIRED')
      const token = session.access_token
      const connection = options.connection ?? { url: String(import.meta.env.VITE_SUPABASE_URL ?? ''), anonKey: String(import.meta.env.VITE_SUPABASE_ANON_KEY ?? '') }
      if (!connection.url || !connection.anonKey) throw new Error('BACKEND_UNAVAILABLE')
      const request = async (table: string, query: Record<string, string>, patch?: DialogueRow): Promise<DialogueRow[]> => {
        check()
        const url = new URL(`rest/v1/${table}`, connection.url.replace(/\/?$/, '/'))
        Object.entries(query).forEach(([key, value]) => url.searchParams.set(key, value))
        const response = await (options.fetch ?? globalThis.fetch)(url, { method: patch ? 'PATCH' : 'GET',
          headers: { apikey: connection.anonKey, Authorization: `Bearer ${token}`, ...(patch ? { 'Content-Type': 'application/json', Prefer: 'return=representation' } : {}) },
          ...(patch ? { body: JSON.stringify(patch) } : {}), signal: controller.signal })
        check()
        const text = await response.text()
        check()
        if (!response.ok || text.length > 3_000_000) throw new Error('REQUEST_FAILED')
        const rows: unknown = JSON.parse(text)
        if (!Array.isArray(rows) || rows.some(row => !row || typeof row !== 'object' || Array.isArray(row))) throw new Error('INVALID_RESULT')
        return rows as DialogueRow[]
      }
      const rows = await request('users', { select: 'account_id', id: `eq.${options.userId}`, limit: '1' })
      if (rows.length !== 1 || typeof rows[0].account_id !== 'string' || !rows[0].account_id) throw new Error('PROFILE_UNAVAILABLE')
      const result = await work({ accountId: rows[0].account_id, check, request })
      check()
      return result
    })()
    return await Promise.race([operation, cancelled])
  } finally {
    clearTimeout(timer)
    if (rejectOnAbort) controller.signal.removeEventListener('abort', rejectOnAbort)
    options.signal.removeEventListener('abort', abort)
    subscription.unsubscribe()
  }
}

export async function loadDialogueRows(scope: DialogueScope) {
  const agents = await scope.request('agents', { select: 'id,name', account_id: `eq.${scope.accountId}`, limit: '1000' })
  const ids = agents.map(row => String(row.id)).filter(id => /^[0-9a-f-]{36}$/i.test(id))
  if (!ids.length) return { agents, dialogues: [], messages: [] }
  const dialogues = await scope.request('dialogues', { select: '*', agent_id: `in.(${ids.join(',')})`, order: 'updated_at.desc', limit: '200' })
  const dialogueIds = dialogues.map(row => String(row.id)).filter(id => /^[0-9a-f-]{36}$/i.test(id))
  const messages = dialogueIds.length ? await scope.request('messages', { select: '*', dialogue_id: `in.(${dialogueIds.join(',')})`, order: 'created_at.desc', limit: '2000' }) : []
  return { agents, dialogues, messages: messages.reverse() }
}

export async function updateDialogueState(scope: DialogueScope, id: string, agentId: string, patch: { status: string; operator_takeover: boolean }) {
  const agents = await scope.request('agents', { select: 'id', id: `eq.${agentId}`, account_id: `eq.${scope.accountId}`, limit: '1' })
  if (agents.length !== 1 || agents[0].id !== agentId) throw new Error('DIALOGUE_UNAVAILABLE')
  const rows = await scope.request('dialogues', { select: 'id,status,operator_takeover', id: `eq.${id}`, agent_id: `eq.${agentId}` }, patch)
  if (rows.length !== 1 || rows[0].id !== id || rows[0].status !== patch.status || rows[0].operator_takeover !== patch.operator_takeover) throw new Error('UPDATE_UNCONFIRMED')
}
