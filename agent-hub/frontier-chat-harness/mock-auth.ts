import { useAuth as useDocumentAuth } from '../document-harness/mock-auth'

// The original reactive auth fixture is reused, plus synchronous SDK auth events.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const g = globalThis as any
type Session = { user: { id: string; email?: string } } | null
const authListeners = new Set<(event: string, session: Session) => void>()
export function subscribeAuth(callback: (event: string, session: Session) => void) {
  authListeners.add(callback)
  return { data: { subscription: { unsubscribe: () => authListeners.delete(callback) } } }
}
g.__setFrontierUser = (user: { id: string; email?: string } | null) => {
  for (const callback of authListeners) callback(user ? 'SIGNED_IN' : 'SIGNED_OUT', user ? { user } : null)
  g.__setDocUser(user)
}
export const useAuth = useDocumentAuth
