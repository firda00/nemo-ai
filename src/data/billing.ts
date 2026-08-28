// Token packages (USD). Must stay in sync with supabase/functions/create-checkout PACKAGES.
// Units here are CREDITS (1 credit = 1000 LLM tokens). Subscription entitlements shown in the
// UI live in src/lib/plans.ts (raw LLM tokens) — same plan numbers, different unit. Do not add
// plan cards reading from this file.
export interface TokenPackage {
  id: string
  usd: number
  tokens: number
  popular?: boolean
}

export interface SaasPlan {
  id: 'starter' | 'pro' | 'business' | 'agency' | 'enterprise'
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
  { id: 'dabbler', usd: 10, tokens: 2_500 },
  { id: 'starter', usd: 25, tokens: 7_000 }, // +12% bonus
  { id: 'popular', usd: 50, tokens: 15_000, popular: true }, // +20% bonus
  { id: 'pro', usd: 100, tokens: 32_000 }, // +28% bonus
  { id: 'business', usd: 250, tokens: 87_500 }, // +40% bonus
]

// ВНИМАНИЕ: `usd` и `teams` здесь — ЗЕРКАЛО src/lib/plans.ts, а не независимый прайс.
// Каноничны PLANS (и их серверный оригинал supabase/functions/_shared/plans.ts); цену и
// названия тарифов витрина берёт ТОЛЬКО оттуда. При переоценке правится и этот массив.
//
// Доллар остаётся ориентиром: реально списывается сумма (PLANS[id].priceUzs) через
// Payme/Click. `label` здесь намеренно НЕТ — название тарифа живёт в PLANS[id].label в
// одном экземпляре, и заводить его копию тут значит гарантировать расхождение.
//
// `includedCredits` НЕ синхронизирован с PLANS[id].tokens и здесь не трогался: это другая
// модель (1 кредит = 1000 токенов) от пакетов пополнения, и переводить её на новые квоты —
// отдельное решение по биллингу, а не часть переоценки подписки.
export const SAAS_PLANS: SaasPlan[] = [
  {
    id: 'starter',
    usd: 59,
    teams: 1,
    includedCredits: 500,
    features: ['team_builder', 'company_brain', 'agent_trace'],
  },
  {
    id: 'pro',
    usd: 143,
    teams: 3,
    includedCredits: 2_000,
    popular: true,
    features: ['team_builder', 'company_brain', 'agent_trace', 'quality_checks', 'crm_handoff'],
  },
  {
    id: 'business',
    usd: 254,
    teams: 10,
    includedCredits: 6_000,
    features: ['team_builder', 'company_brain', 'agent_trace', 'quality_checks', 'crm_handoff', 'priority_support'],
  },
  {
    id: 'agency',
    usd: 350,
    teams: 30,
    includedCredits: 20_000,
    features: ['team_builder', 'company_brain', 'agent_trace', 'quality_checks', 'crm_handoff', 'priority_support'],
  },
  {
    id: 'enterprise',
    usd: 0,
    teams: 100,
    includedCredits: 60_000,
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
