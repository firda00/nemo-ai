import { createClient, type SupabaseClient } from '@supabase/supabase-js'

// Live backend is opt-in via env. When unset, the app stays in DEMO mode
// (mock auth + seeded data) so the prototype runs without a backend.
const url = import.meta.env.VITE_SUPABASE_URL as string | undefined
const anon = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined

export const isSupabaseEnabled = Boolean(url && anon)

export const supabase: SupabaseClient | null = isSupabaseEnabled
  ? createClient(url as string, anon as string, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
    })
  : null

// Bearer token of the current session (for authenticated Edge Function calls).
export async function getAccessToken(): Promise<string | null> {
  if (!supabase) return null
  const { data } = await supabase.auth.getSession()
  return data.session?.access_token ?? null
}
