// Token packages (USD). Must stay in sync with supabase/functions/create-checkout PACKAGES.
export interface TokenPackage {
  id: string
  usd: number
  tokens: number
  popular?: boolean
}

export const TOKEN_PACKAGES: TokenPackage[] = [
  { id: 'starter', usd: 5, tokens: 250_000 },
  { id: 'pro', usd: 20, tokens: 1_200_000, popular: true },
  { id: 'business', usd: 50, tokens: 3_500_000 },
]

// ---- Pricing model (USD) — single source of truth ----
// Base custom-top-up rate: $1 = 50 000 tokens. Packages give MORE tokens per $
// (volume discount), so the base rate is the "no discount" price. This rate already
// embeds the markup over our OpenRouter cost ("доп плата за наш API-токен").
export const USD_TO_TOKENS = 50_000
// Rough average tokens consumed by one full dialogue (a few turns) — for the calculator.
export const TOKENS_PER_DIALOGUE = 3_000
// Fixed monthly price per agent — covers VPS hosting + our API access ("сервер ВПС").
// Token usage is billed separately from the balance. Chosen NOT to change later.
export const AGENT_PRICE_USD = 4
// Custom top-up bounds (USD).
export const CUSTOM_MIN_USD = 1
export const CUSTOM_MAX_USD = 500
export const tokensForUsd = (usd: number) => Math.round(Math.max(0, usd) * USD_TO_TOKENS)
