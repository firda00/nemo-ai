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
  media: boolean       // media generation feature available at all (false = must upgrade)
  mediaIncluded: boolean // true = generation is INCLUDED on Nemo's keys (no API to connect).
                         // false = BYO tier: connect your own provider key.
  mediaTrialWeekly: number // reserved for explicitly trial-enabled plans
  video: boolean       // VIDEO generation offered on this tier (budgeted feature — Plus/Pro/Max only)
  hiResVideo: boolean  // 1080p and 4K rendering (Pro and above; lower tiers render 720p).
                       // Independent of `premium` — beta keeps hi-res without premium LLMs.
  mediaMonthly: number // fair-use: max INCLUDED media generations / month (images+video+voice)
  browserMonthly: number // fair-use: max browser-agent tasks / month (included in subscription)
  videoMonthly: number // fair-use: max rendered videos / month (heavier than images — lower cap)
  competitors: number  // max competitors analyzed in ONE competitor-factory run
}

export const PLAN_LIMITS: Record<string, PlanLimit> = {
  // Self-serve ladder approved for launch. Prices flow to Stripe via inline price_data — no Price IDs to sync.
  // Starter is BYO (mediaIncluded:false); Pro and above include generation on Nemo's key.
  free:       { label: 'Free',       price: 0,    tokens: 150_000,     teams: 1,    premium: false, media: false, mediaIncluded: false, mediaTrialWeekly: 0,  video: false, hiResVideo: false, mediaMonthly: 0,     browserMonthly: 0,     videoMonthly: 0,    competitors: 1 },
  starter:    { label: 'Starter',    price: 25,  tokens: 500_000,    teams: 1,   premium: false, media: true,  mediaIncluded: false, mediaTrialWeekly: 0, video: false, hiResVideo: false, mediaMonthly: 0,     browserMonthly: 20,   videoMonthly: 0,    competitors: 2 },
  pro:        { label: 'Pro',        price: 59,  tokens: 2_000_000,  teams: 2,   premium: true,  media: true,  mediaIncluded: true,  mediaTrialWeekly: 0, video: true,  hiResVideo: true,  mediaMonthly: 100,   browserMonthly: 75,   videoMonthly: 20,   competitors: 3 },
  business:   { label: 'Business',   price: 119, tokens: 6_000_000,  teams: 10,  premium: true,  media: true,  mediaIncluded: true,  mediaTrialWeekly: 0, video: true,  hiResVideo: true,  mediaMonthly: 400,   browserMonthly: 250,  videoMonthly: 80,   competitors: 5 },
  agency:     { label: 'Agency',     price: 350, tokens: 20_000_000, teams: 30,  premium: true,  media: true,  mediaIncluded: true,  mediaTrialWeekly: 0, video: true,  hiResVideo: true,  mediaMonthly: 1500,  browserMonthly: 1000, videoMonthly: 300,  competitors: 10 },
  enterprise: { label: 'Enterprise', price: 0,   tokens: 60_000_000, teams: 100, premium: true,  media: true,  mediaIncluded: true,  mediaTrialWeekly: 0, video: true,  hiResVideo: true,  mediaMonthly: 5000,  browserMonthly: 3000, videoMonthly: 1000, competitors: 20 },
  // existing beta accounts keep generous included access
  beta:       { label: 'Beta',       price: 0,    tokens: 5_000_000,   teams: 10,   premium: false, media: true,  mediaIncluded: true,  mediaTrialWeekly: 0,  video: true,  hiResVideo: true,  mediaMonthly: 300,   browserMonthly: 100,   videoMonthly: 40,   competitors: 5 },
}

export function planOf(p?: string | null): PlanLimit {
  return PLAN_LIMITS[String(p ?? 'free')] ?? PLAN_LIMITS.free
}

// month-to-date AI tokens for an account (resets on the 1st, UTC)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function monthlyTokens(admin: any, accountId: string): Promise<number> {
  const { data, error } = await admin.rpc('monthly_token_usage', { p_account_id: accountId })
  if (error) throw new Error(`monthly token usage unavailable: ${error.message}`)
  return Number(data) || 0
}

// month-to-date in-platform media generations for an account (resets on the 1st, UTC)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function monthlyMedia(admin: any, accountId: string): Promise<number> {
  const start = new Date()
  start.setUTCDate(1); start.setUTCHours(0, 0, 0, 0)
  const { count } = await admin.from('media_assets').select('id', { count: 'exact', head: true }).eq('account_id', accountId).gte('created_at', start.toISOString())
  return Number(count) || 0
}

// this-week in-platform media generations for an account (images+video+voice saved to
// media_assets). Resets Monday 00:00 UTC. Used for the BYO tiers' small weekly free trial.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function weeklyMedia(admin: any, accountId: string): Promise<number> {
  const start = new Date()
  const dow = (start.getUTCDay() + 6) % 7 // 0 = Monday
  start.setUTCDate(start.getUTCDate() - dow); start.setUTCHours(0, 0, 0, 0)
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
