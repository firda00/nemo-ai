// Preview never authenticates a user or sends credentials to a real service.
async function previewAuth(method: string) {
  const target = globalThis as unknown as { __authCalls?: string[] }
  ;(target.__authCalls ??= []).push(method)
  return { error: 'Локальный предпросмотр / Mahalliy ko‘rish / Local preview: authentication is not connected.' }
}
export function useAuth() { return { isAuthed: false, live: false, loading: false, recoveryReady: false,
  login: () => previewAuth('password'), signup: () => previewAuth('signup'), loginWithGoogle: () => previewAuth('google'),
  resetPassword: () => previewAuth('reset'), updatePassword: () => previewAuth('update'),
} }
export const isSupabaseEnabled = false
export const supabase = null
export async function submitWaitlist(payload: unknown) {
  const target = globalThis as unknown as { __waitlistCalls?: unknown[]; __waitlistFail?: boolean }
  ;(target.__waitlistCalls ??= []).push(payload)
  return !target.__waitlistFail
}
