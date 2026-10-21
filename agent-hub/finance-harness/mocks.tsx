import { useSyncExternalStore } from 'react'
const g = globalThis as any
const listeners = new Set<() => void>(), authListeners = new Set<(event: string, session: any) => void>()
let snapshot = { user: { id: 'u1' } as { id: string } | null, sessionGeneration: 0 }
g.__setFinanceUser = (id: string | null) => {
  snapshot = { user: id ? { id } : null, sessionGeneration: snapshot.sessionGeneration + 1 }
  for (const fn of authListeners) fn(id ? 'SIGNED_IN' : 'SIGNED_OUT', id ? { user: { id } } : null)
  for (const fn of listeners) fn()
}
export const useAuth = () => useSyncExternalStore(callback => { listeners.add(callback); return () => listeners.delete(callback) }, () => snapshot)
export const isSupabaseEnabled = true
export const supabase = { auth: {
  getSession: async () => ({ data: { session: snapshot.user ? { user: snapshot.user, access_token: 'synthetic-' + snapshot.user.id } : null } }),
  onAuthStateChange: (callback: (event: string, session: any) => void) => { authListeners.add(callback); return { data: { subscription: { unsubscribe: () => authListeners.delete(callback) } } } },
} }
export const useAgentStore = (select: any) => select({ ensureAccountId: async () => snapshot.user?.id === 'u2' ? '22222222-2222-4222-8222-222222222222' : '11111111-1111-4111-8111-111111111111' })
export function ProductMarginPanel() { return null }
