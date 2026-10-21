// Reactive mock of src/context/AuthContext for the MOUNTED document-card smoke: the card's
// identity contract is `useAuth().user` (id+email feed the session scope), and the smoke must
// flip that identity WHILE the card stays mounted.
import { useSyncExternalStore } from 'react'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const g = globalThis as any
g.__docAuth = g.__docAuth ?? { user: { id: 'user-1', email: 'one@example.test' }, listeners: new Set() }
g.__docAuth.generation ??= 0

g.__setDocUser = (user: { id: string; email?: string } | null) => {
  if (g.__docAuth.user?.id !== user?.id) g.__docAuth.generation += 1
  g.__docAuth.user = user
  for (const listener of g.__docAuth.listeners) listener()
}

export function useAuth(): { user: { id: string; email?: string } | null; sessionGeneration: number; loading: boolean } {
  const user = useSyncExternalStore(
    (callback: () => void) => {
      g.__docAuth.listeners.add(callback)
      return () => g.__docAuth.listeners.delete(callback)
    },
    () => g.__docAuth.user,
  )
  return { user, sessionGeneration: g.__docAuth.generation, loading: false }
}
