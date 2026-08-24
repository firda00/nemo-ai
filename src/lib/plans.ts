// B2B subscription plans (mirror of supabase/functions/_shared/plans.ts — keep in sync).
// Units here are RAW LLM tokens. src/data/billing.ts is the other pricing file: it models
// CREDITS (1 credit = 1000 LLM tokens) and top-up packages for create-checkout — same
// numbers, different unit. UI plan cards (Pricing/Billing) read from THIS file only.
export interface PlanLimit {
  label: string
  price: number
  tokens: number
  teams: number
  premium: boolean
  media: boolean
  mediaIncluded: boolean
  mediaTrialWeekly: number
  video: boolean
  mediaMonthly: number
  browserMonthly: number
  videoMonthly: number
  competitors: number
}

export const PLANS: Record<string, PlanLimit> = {
  free: { label: 'Free', price: 0, tokens: 150_000, teams: 1, premium: false, media: false, mediaIncluded: false, mediaTrialWeekly: 0, video: false, mediaMonthly: 0, browserMonthly: 0, videoMonthly: 0, competitors: 1 },
  starter: { label: 'Starter', price: 25, tokens: 500_000, teams: 1, premium: false, media: true, mediaIncluded: false, mediaTrialWeekly: 0, video: false, mediaMonthly: 0, browserMonthly: 20, videoMonthly: 0, competitors: 2 },
  pro: { label: 'Pro', price: 59, tokens: 2_000_000, teams: 2, premium: true, media: true, mediaIncluded: true, mediaTrialWeekly: 0, video: true, mediaMonthly: 100, browserMonthly: 75, videoMonthly: 20, competitors: 3 },
  business: { label: 'Business', price: 119, tokens: 6_000_000, teams: 10, premium: true, media: true, mediaIncluded: true, mediaTrialWeekly: 0, video: true, mediaMonthly: 400, browserMonthly: 250, videoMonthly: 80, competitors: 5 },
  agency: { label: 'Agency', price: 350, tokens: 20_000_000, teams: 30, premium: true, media: true, mediaIncluded: true, mediaTrialWeekly: 0, video: true, mediaMonthly: 1_500, browserMonthly: 1_000, videoMonthly: 300, competitors: 10 },
  enterprise: { label: 'Enterprise', price: 0, tokens: 60_000_000, teams: 100, premium: true, media: true, mediaIncluded: true, mediaTrialWeekly: 0, video: true, mediaMonthly: 5_000, browserMonthly: 3_000, videoMonthly: 1_000, competitors: 20 },
  beta: { label: 'Beta', price: 0, tokens: 5_000_000, teams: 10, premium: false, media: true, mediaIncluded: true, mediaTrialWeekly: 0, video: true, mediaMonthly: 300, browserMonthly: 100, videoMonthly: 40, competitors: 5 },
}
export const PLAN_ORDER = ['starter', 'pro', 'business', 'agency', 'enterprise'] as const

// Measured over real production runs (2026-07), not assumed. The previous constant of 4,750
// tokens per run was ~8x optimistic, so every plan advertised roughly eight times the work it
// could actually do. There is no single honest constant here: team runs spread 5.6x between
// their smallest and largest, and a short single-agent task is ~15x cheaper than a team run —
// so the UI quotes a measured RANGE and names it as measured.
//
// Provisional: n=13 team runs is a sample, not a distribution. Now that each run records its
// own tokens and cost (migration 20260725120000), replace these with values computed from
// research_runs once a few weeks of clean data exist.
export const TEAM_RUN_TOKENS = { min: 17_489, median: 38_469, max: 97_254, samples: 13 } as const
export const SHORT_TASK_TOKENS = { mean: 2_522, samples: 58 } as const

export interface RunEstimate { low: number; typical: number; high: number }

/** Team runs a quota buys: `low` assumes the heaviest observed run, `high` the lightest. */
export const teamRunsFromTokens = (t: number): RunEstimate => ({
  low: Math.floor(t / TEAM_RUN_TOKENS.max),
  typical: Math.round(t / TEAM_RUN_TOKENS.median),
  high: Math.floor(t / TEAM_RUN_TOKENS.min),
})

/** Short single-agent tasks (a question, one tool call) the same quota buys. */
export const shortTasksFromTokens = (t: number): number => Math.round(t / SHORT_TASK_TOKENS.mean)

export const formatRunRange = (e: RunEstimate): string => `${e.low}–${e.high}`
