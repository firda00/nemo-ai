// Resolve which OpenRouter key to use for an account's LLM calls.
// If the account saved its OWN OpenRouter key (provider_keys.provider = 'openrouter')
// we bill their key; otherwise we fall back to Nemo's shared key (billed via tokens).
// Must be called with a SERVICE-ROLE client — provider_keys.api_key is not readable
// by anon/authenticated (only Edge Functions can read the secret).

/* eslint-disable @typescript-eslint/no-explicit-any */
import { openSecret } from './secretBox.ts'
export async function resolveOpenRouterKey(admin: any, accountId: string | null | undefined, fallback: string): Promise<string> {
  if (!accountId) return fallback
  try {
    const { data } = await admin
      .from('provider_keys')
      .select('api_key')
      .eq('account_id', accountId)
      .eq('provider', 'openrouter')
      .maybeSingle()
    const k = data?.api_key
    return typeof k === 'string' && k.trim() ? (await openSecret(k)).trim() : fallback
  } catch {
    return fallback
  }
}
/* eslint-enable @typescript-eslint/no-explicit-any */
