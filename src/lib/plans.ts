// B2B subscription plans (mirror of supabase/functions/_shared/plans.ts — keep in sync).
export interface PlanLimit {
  label: string
  price: number
  tokens: number
  teams: number
  premium: boolean
  media: boolean
}

export const PLANS: Record<string, PlanLimit> = {
  free: { label: 'Free', price: 0, tokens: 150_000, teams: 1, premium: false, media: false },
  starter: { label: 'Starter', price: 199, tokens: 3_000_000, teams: 5, premium: false, media: true },
  pro: { label: 'Pro', price: 299, tokens: 10_000_000, teams: 20, premium: true, media: true },
  business: { label: 'Business', price: 999, tokens: 35_000_000, teams: 60, premium: true, media: true },
  agency: { label: 'Agency', price: 1990, tokens: 90_000_000, teams: 200, premium: true, media: true },
  enterprise: { label: 'Enterprise', price: 2990, tokens: 250_000_000, teams: 9999, premium: true, media: true },
  beta: { label: 'Beta', price: 0, tokens: 5_000_000, teams: 10, premium: false, media: true },
}
export const PLAN_ORDER = ['free', 'starter', 'pro', 'business', 'agency', 'enterprise'] as const

// a full team run averages ~4,750 tokens — express quotas as approx. runs for humans
export const runsFromTokens = (t: number): number => Math.round(t / 4750)
