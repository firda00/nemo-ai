// Token packages (USD). Must stay in sync with supabase/functions/create-checkout PACKAGES.
export interface TokenPackage {
  id: string
  usd: number
  tokens: number
  popular?: boolean
}

export interface SaasPlan {
  id: 'starter' | 'growth' | 'business'
  usd: number
  teams: number
  includedCredits: number
  popular?: boolean
  features: string[]
}

export interface UsageScenario {
  id: 'small' | 'growth' | 'scale'
  dialogues: number
  teams: number
  humanHoursSaved: number
}

export interface RuntimeTier {
  id: 'shared' | 'dedicated' | 'opensource'
  vpsCostUsd: number
  customerPriceUsd: number
  agents: string
}

export interface UnitEconomicsInput {
  platformUsd: number
  runtimeBaseUsd: number
  apiBaseUsd: number
  supportUsd: number
  customers: number
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

// Infrastructure economics. Customers pay separately for the runtime where their
// agents run. We keep at least 50% gross margin on VPS/runtime and API usage.
export const INFRA_MARKUP = 1.5
export const API_MARKUP = 1.5
export const runtimePrice = (vpsCostUsd: number) => Math.ceil(vpsCostUsd * INFRA_MARKUP)
export const apiCustomerPrice = (baseUsd: number) => Number((baseUsd * API_MARKUP).toFixed(2))
export const grossMarginPct = (revenue: number, cost: number) => (revenue <= 0 ? 0 : Math.round(((revenue - cost) / revenue) * 100))
export const calcUnitEconomics = ({ platformUsd, runtimeBaseUsd, apiBaseUsd, supportUsd, customers }: UnitEconomicsInput) => {
  const runtimeRevenue = runtimePrice(runtimeBaseUsd)
  const apiRevenue = apiCustomerPrice(apiBaseUsd)
  const revenuePerCustomer = platformUsd + runtimeRevenue + apiRevenue
  const costPerCustomer = runtimeBaseUsd + apiBaseUsd + supportUsd
  const profitPerCustomer = revenuePerCustomer - costPerCustomer
  return {
    customers,
    revenuePerCustomer,
    costPerCustomer,
    profitPerCustomer,
    grossMargin: grossMarginPct(revenuePerCustomer, costPerCustomer),
    mrr: revenuePerCustomer * customers,
    grossProfit: profitPerCustomer * customers,
    arr: revenuePerCustomer * customers * 12,
  }
}

// Packages give more credits per $ (volume discount). Keep in sync with create-checkout.
export const TOKEN_PACKAGES: TokenPackage[] = [
  { id: 'starter', usd: 5, tokens: 1_250 },
  { id: 'pro', usd: 20, tokens: 5_500, popular: true }, // +10% bonus
  { id: 'business', usd: 50, tokens: 15_000 }, // +20% bonus
]

export const SAAS_PLANS: SaasPlan[] = [
  {
    id: 'starter',
    usd: 49,
    teams: 1,
    includedCredits: 2_500,
    features: ['team_builder', 'company_brain', 'agent_trace'],
  },
  {
    id: 'growth',
    usd: 199,
    teams: 3,
    includedCredits: 15_000,
    popular: true,
    features: ['team_builder', 'company_brain', 'agent_trace', 'quality_checks', 'crm_handoff'],
  },
  {
    id: 'business',
    usd: 499,
    teams: 10,
    includedCredits: 50_000,
    features: ['team_builder', 'company_brain', 'agent_trace', 'quality_checks', 'crm_handoff', 'priority_support'],
  },
]

export const PLAN_FEATURES = ['team_builder', 'company_brain', 'agent_trace', 'quality_checks', 'crm_handoff', 'priority_support'] as const

export const USAGE_SCENARIOS: UsageScenario[] = [
  { id: 'small', dialogues: 1_000, teams: 1, humanHoursSaved: 45 },
  { id: 'growth', dialogues: 10_000, teams: 3, humanHoursSaved: 360 },
  { id: 'scale', dialogues: 100_000, teams: 10, humanHoursSaved: 2_800 },
]

export const RUNTIME_TIERS: RuntimeTier[] = [
  { id: 'shared', vpsCostUsd: 12, customerPriceUsd: runtimePrice(12), agents: '1-2 AI teams' },
  { id: 'dedicated', vpsCostUsd: 40, customerPriceUsd: runtimePrice(40), agents: '3-10 AI teams' },
  { id: 'opensource', vpsCostUsd: 80, customerPriceUsd: runtimePrice(80), agents: 'Open-source agents / custom workloads' },
]
