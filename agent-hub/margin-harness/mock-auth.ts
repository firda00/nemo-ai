// Reactive mock of src/context/AuthContext for the MOUNTED margin-card smoke: the card's
// whole identity contract is `useAuth().user`, and the smoke must flip that identity WHILE the
// card stays mounted — something the real provider only does on live session events.
import { useSyncExternalStore } from 'react'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const g = globalThis as any
g.__marginAuth = g.__marginAuth ?? { user: { id: 'user-1' }, listeners: new Set() }

g.__setMarginUser = (user: { id: string } | null) => {
  g.__marginAuth.user = user
  for (const listener of g.__marginAuth.listeners) listener()
}

export function useAuth(): { user: { id: string } | null } {
  const user = useSyncExternalStore(
    (callback: () => void) => {
      g.__marginAuth.listeners.add(callback)
      return () => g.__marginAuth.listeners.delete(callback)
    },
    () => g.__marginAuth.user,
  )
  return { user }
}
