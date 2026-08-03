import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import type { Role, User } from '../types'
import { supabase, isSupabaseEnabled } from '../lib/supabase'

const STORAGE_KEY = 'nemo.user'

interface AuthResult {
  error?: string
}

interface AuthContextValue {
  user: User | null
  isAuthed: boolean
  loading: boolean
  /** True when running against the live Supabase backend (vs demo mode). */
  live: boolean
  login: (email: string, password?: string) => Promise<AuthResult>
  signup: (name: string, email: string, password?: string, ref?: string) => Promise<AuthResult>
  loginWithGoogle: () => Promise<AuthResult>
  logout: () => Promise<void>
  updateUser: (patch: Partial<User>) => void
}

const AuthContext = createContext<AuthContextValue | null>(null)

function nameFromEmail(email: string): string {
  const handle = email.split('@')[0] || 'Foydalanuvchi'
  return handle.charAt(0).toUpperCase() + handle.slice(1)
}

// ---- demo (mock) user model ----
function makeUser(email: string, name?: string): User {
  const role: Role = /admin/i.test(email) ? 'admin' : 'user'
  return {
    id: 'demo-' + email,
    email,
    name: name || nameFromEmail(email),
    lang: 'uz',
    role,
    createdAt: '2026-06-01',
    quotaUsed: 37,
    quotaLimit: 100,
  }
}

function loadUser(): User | null {
  if (typeof window === 'undefined') return null
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    return raw ? (JSON.parse(raw) as User) : null
  } catch {
    return null
  }
}

// ---- live (Supabase) user mapping ----
// deno not involved; this runs in the browser
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function userFromSession(sessionUser: any): User {
  const email = sessionUser?.email ?? ''
  const savedLang = sessionUser?.user_metadata?.lang
  return {
    id: sessionUser?.id ?? 'unknown',
    email,
    name: sessionUser?.user_metadata?.name ?? nameFromEmail(email),
    lang: savedLang === 'ru' || savedLang === 'en' || savedLang === 'uz' ? savedLang : 'uz',
    role: 'user',
    createdAt: (sessionUser?.created_at ?? '').slice(0, 10) || '2026-06-01',
    quotaUsed: 0,
    quotaLimit: 100,
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const live = isSupabaseEnabled
  const [user, setUser] = useState<User | null>(() => (live ? null : loadUser()))
  const [loading, setLoading] = useState<boolean>(live)
  const profileSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pendingMetadata = useRef<Record<string, string>>({})

  useEffect(() => () => {
    if (profileSaveTimer.current) clearTimeout(profileSaveTimer.current)
  }, [])

  // --- live session bootstrap + subscription ---
  useEffect(() => {
    const client = supabase
    if (!live || !client) return
    let active = true
    client.auth.getSession().then(({ data }) => {
      if (!active) return
      setUser(data.session ? userFromSession(data.session.user) : null)
      setLoading(false)
    })
    const { data: sub } = client.auth.onAuthStateChange((_event, session) => {
      setUser(session ? userFromSession(session.user) : null)
      setLoading(false)
    })
    return () => {
      active = false
      sub.subscription.unsubscribe()
    }
  }, [live])

  // --- demo persistence ---
  const persist = useCallback(
    (next: User | null) => {
      if (live) return
      setUser(next)
      if (typeof window === 'undefined') return
      if (next) window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
      else window.localStorage.removeItem(STORAGE_KEY)
    },
    [live],
  )

  const login = useCallback(
    async (email: string, password?: string): Promise<AuthResult> => {
      if (live && supabase) {
        const { data, error } = await supabase.auth.signInWithPassword({ email, password: password ?? '' })
        if (!error && data.session) setUser(userFromSession(data.session.user))
        return error ? { error: error.message } : {}
      }
      persist(makeUser(email))
      return {}
    },
    [live, persist],
  )

  const signup = useCallback(
    async (name: string, email: string, password?: string, ref?: string): Promise<AuthResult> => {
      if (live && supabase) {
        const { data, error } = await supabase.auth.signUp({
          email,
          password: password ?? '',
          options: { data: { name, ...(ref?.trim() ? { ref: ref.trim() } : {}) } },
        })
        if (!error && data.session) setUser(userFromSession(data.session.user))
        return error ? { error: error.message } : {}
      }
      persist(makeUser(email, name))
      return {}
    },
    [live, persist],
  )

  const loginWithGoogle = useCallback(async (): Promise<AuthResult> => {
    if (live && supabase) {
      const { error } = await supabase.auth.signInWithOAuth({
        provider: 'google',
        options: { redirectTo: window.location.origin + '/app' },
      })
      return error ? { error: error.message } : {}
    }
    persist(makeUser('demo.user@gmail.com', 'Demo User'))
    return {}
  }, [live, persist])

  const logout = useCallback(async () => {
    if (live && supabase) {
      // Explicitly revoke refresh tokens on every device. Supabase currently
      // defaults to global scope, but keeping it explicit prevents a future
      // SDK default change from silently weakening logout.
      await supabase.auth.signOut({ scope: 'global' })
      setUser(null)
      return
    }
    persist(null)
  }, [live, persist])

  const updateUser = useCallback((patch: Partial<User>) => {
    setUser((prev) => {
      if (!prev) return prev
      const next = { ...prev, ...patch }
      if (!isSupabaseEnabled && typeof window !== 'undefined') {
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
      }
      return next
    })
    const client = supabase
    if (!live || !client) return

    if (typeof patch.name === 'string') pendingMetadata.current.name = patch.name
    if (patch.lang === 'uz' || patch.lang === 'ru' || patch.lang === 'en') pendingMetadata.current.lang = patch.lang
    if (!Object.keys(pendingMetadata.current).length) return
    if (profileSaveTimer.current) clearTimeout(profileSaveTimer.current)
    profileSaveTimer.current = setTimeout(() => {
      const data = pendingMetadata.current
      pendingMetadata.current = {}
      profileSaveTimer.current = null
      void client.auth.updateUser({ data })
    }, 400)
  }, [live])

  const value = useMemo<AuthContextValue>(
    () => ({
      user,
      isAuthed: !!user,
      loading,
      live,
      login,
      signup,
      loginWithGoogle,
      logout,
      updateUser,
    }),
    [user, loading, live, login, signup, loginWithGoogle, logout, updateUser],
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

// eslint-disable-next-line react-refresh/only-export-components
export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used within AuthProvider')
  return ctx
}
