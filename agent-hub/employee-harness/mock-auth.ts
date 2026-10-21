import { useSyncExternalStore } from 'react'
let snapshot = { user: { id: 'employee-user-a' } as { id: string } | null, sessionGeneration: 1 }
const listeners = new Set<() => void>()
type Session = { user: { id: string }; access_token: string } | null
const authListeners = new Set<(event: string, session: Session) => void>()
export const auth = {
  getSession: async () => ({ data: { session: snapshot.user ? { user: snapshot.user, access_token: `jwt-${snapshot.user.id}` } : null } }),
  onAuthStateChange: (callback: (event: string, session: Session) => void) => { authListeners.add(callback); return { data: { subscription: { unsubscribe: () => authListeners.delete(callback) } } } },
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const g = globalThis as any
g.__setEmployeeUser = (user: { id: string } | null) => {
  authListeners.forEach(listener => listener(user ? 'SIGNED_IN' : 'SIGNED_OUT', user ? { user, access_token: `jwt-${user.id}` } : null))
  snapshot = { user, sessionGeneration: snapshot.sessionGeneration + 1 }
  listeners.forEach(listener => listener())
}
export const useAuth = () => useSyncExternalStore(listener => { listeners.add(listener); return () => listeners.delete(listener) }, () => snapshot)
