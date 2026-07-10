import { createClient, type SupabaseClient } from '@supabase/supabase-js'

// Live backend is opt-in via env. When unset, the app stays in DEMO mode
// (mock auth + seeded data) so the prototype runs without a backend.
// Placeholder or malformed values (e.g. .env.example copied verbatim) also mean
// DEMO mode. Validation is purely local (no network), so a genuinely configured
// backend that is merely down stays in live mode and the outage surfaces as
// network errors instead of silently showing demo data.
const url = (import.meta.env.VITE_SUPABASE_URL as string | undefined)?.trim()
const anon = (import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined)?.trim()

// Deliberately targeted tokens (matched against the URL only — a key is
// validated structurally below, so a real key containing an unlucky substring
// is never misclassified). Covers the .env.example placeholders verbatim.
const PLACEHOLDER_RE = /YOUR_PROJECT_REF|YOUR_|your-project|change-?me|placeholder|^undefined$|^null$/i

// Exported for agent-hub/auth-rls-contracts.mjs, which extracts and EXECUTES
// these validators against known-placeholder and known-good values.
export function isValidSupabaseUrl(raw: string | undefined): boolean {
  const v = raw?.trim()
  if (!v || PLACEHOLDER_RE.test(v)) return false
  try {
    const u = new URL(v)
    return (u.protocol === 'https:' || u.protocol === 'http:') && u.hostname.length > 0
  } catch {
    return false
  }
}

export function isValidSupabaseAnonKey(raw: string | undefined): boolean {
  const v = raw?.trim()
  if (!v) return false
  if (v.startsWith('sb_secret_')) return false // secret keys must never reach the browser
  if (v.startsWith('sb_publishable_')) {
    // Real publishable keys carry a substantial base64url suffix; a stub like
    // "sb_publishable_x" is a placeholder, not a credential.
    return /^[A-Za-z0-9_-]{16,}$/.test(v.slice('sb_publishable_'.length))
  }
  // Legacy anon key: a JWT whose payload role is exactly 'anon'. This rejects
  // an accidentally pasted service_role JWT as well as non-JWT placeholders
  // like "your-anon-public-key". All three segments must be non-empty base64url.
  const parts = v.split('.')
  if (parts.length !== 3 || !v.startsWith('eyJ') || parts.some((p) => !/^[A-Za-z0-9_-]+$/.test(p))) return false
  try {
    const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/')
    const payload = JSON.parse(atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4)))
    return payload?.role === 'anon'
  } catch {
    return false
  }
}

export const isSupabaseEnabled = isValidSupabaseUrl(url) && isValidSupabaseAnonKey(anon)

// Values present but unusable → say so once (never printing the values
// themselves) instead of silently falling back to demo mode.
if (!isSupabaseEnabled && (url || anon)) {
  console.warn(
    '[nemo] VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY look like placeholder or malformed values — running in DEMO mode. Put real project values in .env.local to enable the live backend.'
  )
}

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
