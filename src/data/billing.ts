// Token packages (USD). Must stay in sync with supabase/functions/create-checkout PACKAGES.
export interface TokenPackage {
  id: string
  usd: number
  tokens: number
  popular?: boolean
}

// ---- Pricing model v2 (USD) — single source of truth ----
// A "token" shown to the user = 1 Nemo CREDIT. 1 credit = 1000 LLM tokens of usage
// (the backend divides raw LLM usage by 1000 when charging the balance). $1 = 250 credits.
export const USD_TO_TOKENS = 250 // credits per $1  (1 credit = $0.004 = 0.4¢)
export const LLM_PER_CREDIT = 1_000 // 1 credit covers 1000 LLM tokens
export const STARTER_TOKENS = 1_000 // free credits granted to a new account
// ~3 credits per dialogue (~3000 LLM tokens) — for the calculator.
export const TOKENS_PER_DIALOGUE = 3
// Fixed monthly price per agent — VPS hosting + our API access. ~20x our cost (~$0.25);
// raise this constant for a bigger margin (e.g. $25 ≈ 100x). Token usage is billed separately.
export const AGENT_PRICE_USD = 5
// Custom top-up bounds (USD).
export const CUSTOM_MIN_USD = 1
export const CUSTOM_MAX_USD = 500
export const tokensForUsd = (usd: number) => Math.round(Math.max(0, usd) * USD_TO_TOKENS)

// Packages give more credits per $ (volume discount). Keep in sync with create-checkout.
export const TOKEN_PACKAGES: TokenPackage[] = [
  { id: 'starter', usd: 5, tokens: 1_250 },
  { id: 'pro', usd: 20, tokens: 5_500, popular: true }, // +10% bonus
  { id: 'business', usd: 50, tokens: 15_000 }, // +20% bonus
]
