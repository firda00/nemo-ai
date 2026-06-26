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
