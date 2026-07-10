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
  free: { label: 'Free', price: 0, tokens: 500_000, teams: 1, premium: false, media: false },
  starter: { label: 'Starter', price: 59, tokens: 6_000_000, teams: 3, premium: false, media: true },
  pro: { label: 'Pro', price: 249, tokens: 30_000_000, teams: 10, premium: true, media: true },
  business: { label: 'Business', price: 699, tokens: 90_000_000, teams: 30, premium: true, media: true },
  agency: { label: 'Agency', price: 1990, tokens: 90_000_000, teams: 200, premium: true, media: true },
  enterprise: { label: 'Enterprise', price: 1490, tokens: 300_000_000, teams: 9999, premium: true, media: true },
  beta: { label: 'Beta', price: 0, tokens: 5_000_000, teams: 10, premium: false, media: true },
}
export const PLAN_ORDER = ['free', 'starter', 'pro', 'business', 'enterprise'] as const

// a full team run averages ~4,750 tokens — express quotas as approx. runs for humans
export const runsFromTokens = (t: number): number => Math.round(t / 4750)
