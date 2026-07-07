// B2B subscription plans + monthly limits. Priced from real unit economics: a full team
// run averages ~4.75k tokens; on the cheap model that's ~$0.0015/run, on the premium
// model ~$0.024/run. Fixed infra (VPS + Supabase) ~$55/mo. So limits mainly gate the
// premium model + abuse, not raw cost — margins stay high.
export interface PlanLimit {
  label: string
  price: number        // USD / month
  tokens: number       // monthly AI token quota (≈ tokens/4750 team runs)
  teams: number        // max saved teams
  premium: boolean     // access to the premium model (gpt-4o) for manager/steps
  media: boolean       // media generation allowed
  mediaMonthly: number // fair-use: max in-platform media generations / month (images etc.)
  browserMonthly: number // fair-use: max browser-agent tasks / month (included in subscription)
  videoMonthly: number // fair-use: max rendered videos / month (heavier than images — lower cap)
}

export const PLAN_LIMITS: Record<string, PlanLimit> = {
  free:       { label: 'Free',       price: 0,    tokens: 150_000,     teams: 1,    premium: false, media: false, mediaMonthly: 0,     browserMonthly: 0,     videoMonthly: 0 },
  starter:    { label: 'Starter',    price: 199,  tokens: 3_000_000,   teams: 5,    premium: false, media: true,  mediaMonthly: 150,   browserMonthly: 50,    videoMonthly: 20 },
  pro:        { label: 'Pro',        price: 299,  tokens: 10_000_000,  teams: 20,   premium: true,  media: true,  mediaMonthly: 600,   browserMonthly: 200,   videoMonthly: 80 },
  business:   { label: 'Business',   price: 999,  tokens: 35_000_000,  teams: 60,   premium: true,  media: true,  mediaMonthly: 2500,  browserMonthly: 800,   videoMonthly: 300 },
  agency:     { label: 'Agency',     price: 1990, tokens: 90_000_000,  teams: 200,  premium: true,  media: true,  mediaMonthly: 8000,  browserMonthly: 3000,  videoMonthly: 1000 },
  enterprise: { label: 'Enterprise', price: 2990, tokens: 250_000_000, teams: 9999, premium: true,  media: true,  mediaMonthly: 40000, browserMonthly: 15000, videoMonthly: 5000 },
  // existing beta accounts keep generous access
  beta:       { label: 'Beta',       price: 0,    tokens: 5_000_000,   teams: 10,   premium: false, media: true,  mediaMonthly: 300,   browserMonthly: 100,   videoMonthly: 40 },
}

export function planOf(p?: string | null): PlanLimit {
  return PLAN_LIMITS[String(p ?? 'free')] ?? PLAN_LIMITS.free
}

// month-to-date AI tokens for an account (resets on the 1st, UTC)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function monthlyTokens(admin: any, accountId: string): Promise<number> {
  const start = new Date()
  start.setUTCDate(1); start.setUTCHours(0, 0, 0, 0)
  const { data } = await admin.from('usage').select('tokens').eq('account_id', accountId).gte('created_at', start.toISOString()).limit(10000)
  return (data ?? []).reduce((s: number, u: any) => s + (Number(u.tokens) || 0), 0)
}

// month-to-date in-platform media generations for an account (resets on the 1st, UTC)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function monthlyMedia(admin: any, accountId: string): Promise<number> {
  const start = new Date()
  start.setUTCDate(1); start.setUTCHours(0, 0, 0, 0)
  const { count } = await admin.from('media_assets').select('id', { count: 'exact', head: true }).eq('account_id', accountId).gte('created_at', start.toISOString())
  return Number(count) || 0
}

// month-to-date browser-agent tasks for an account (counts tool_runs, resets on the 1st, UTC)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function monthlyBrowser(admin: any, accountId: string): Promise<number> {
  const start = new Date()
  start.setUTCDate(1); start.setUTCHours(0, 0, 0, 0)
  const { count } = await admin.from('tool_runs').select('id', { count: 'exact', head: true }).eq('account_id', accountId).eq('tool', 'browser_task').gte('created_at', start.toISOString())
  return Number(count) || 0
}

// month-to-date rendered videos for an account (counts tool_runs, resets on the 1st, UTC)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function monthlyVideo(admin: any, accountId: string): Promise<number> {
  const start = new Date()
  start.setUTCDate(1); start.setUTCHours(0, 0, 0, 0)
  const { count } = await admin.from('tool_runs').select('id', { count: 'exact', head: true }).eq('account_id', accountId).eq('tool', 'render_video').gte('created_at', start.toISOString())
  return Number(count) || 0
}
