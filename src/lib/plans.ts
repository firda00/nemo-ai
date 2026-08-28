// B2B subscription plans (mirror of supabase/functions/_shared/plans.ts — keep in sync).
//
// Витринная единица — ДИАЛОГ. `tokens` остался внутренним предохранителем и в карточках
// тарифов больше не показывается: владелец бизнеса не может оценить «2 000 000 токенов».
// Обоснование цен и двух порогов удержания ($50 и $250) — в комментарии серверного файла и
// в docs/market/unit-economics-2026-08.md.
//
// Каноничная цена для Узбекистана — priceUzs (сум): счёт выставляется в сумах через
// Payme/Click, Stripe в РУз не работает. `price` в долларах остаётся для Stripe и для
// англоязычной витрины.
//
// src/data/billing.ts — другой файл про деньги: он моделирует КРЕДИТЫ (1 кредит = 1000
// токенов) и пакеты пополнения для create-checkout. Карточки тарифов читают только ЭТОТ файл.
export interface PlanLimit {
  label: string
  price: number
  priceUzs: number
  dialogues: number
  voiceMinutes: number
  tokens: number
  teams: number
  premium: boolean
  media: boolean
  mediaIncluded: boolean
  mediaTrialWeekly: number
  video: boolean
  hiResVideo: boolean
  mediaMonthly: number
  browserMonthly: number
  videoMonthly: number
  competitors: number
}

export const PLANS: Record<string, PlanLimit> = {
  free: { label: 'Free', price: 0, priceUzs: 0, dialogues: 50, voiceMinutes: 0, tokens: 2_250_000, teams: 1, premium: false, media: false, mediaIncluded: false, mediaTrialWeekly: 0, video: false, hiResVideo: false, mediaMonthly: 0, browserMonthly: 0, videoMonthly: 0, competitors: 1 },
  starter: { label: 'Старт', price: 59, priceUzs: 690_000, dialogues: 1_000, voiceMinutes: 0, tokens: 45_000_000, teams: 1, premium: false, media: true, mediaIncluded: false, mediaTrialWeekly: 0, video: false, hiResVideo: false, mediaMonthly: 0, browserMonthly: 20, videoMonthly: 0, competitors: 2 },
  pro: { label: 'Бизнес', price: 143, priceUzs: 1_690_000, dialogues: 5_000, voiceMinutes: 0, tokens: 225_000_000, teams: 3, premium: true, media: true, mediaIncluded: true, mediaTrialWeekly: 0, video: true, hiResVideo: true, mediaMonthly: 100, browserMonthly: 75, videoMonthly: 20, competitors: 3 },
  business: { label: 'Команда', price: 254, priceUzs: 2_990_000, dialogues: 15_000, voiceMinutes: 0, tokens: 675_000_000, teams: 10, premium: true, media: true, mediaIncluded: true, mediaTrialWeekly: 0, video: true, hiResVideo: true, mediaMonthly: 400, browserMonthly: 250, videoMonthly: 80, competitors: 5 },
  agency: { label: 'Агентство', price: 350, priceUzs: 4_120_000, dialogues: 50_000, voiceMinutes: 0, tokens: 2_250_000_000, teams: 30, premium: true, media: true, mediaIncluded: true, mediaTrialWeekly: 0, video: true, hiResVideo: true, mediaMonthly: 1_500, browserMonthly: 1_000, videoMonthly: 300, competitors: 10 },
  enterprise: { label: 'Enterprise', price: 0, priceUzs: 0, dialogues: 200_000, voiceMinutes: 0, tokens: 9_000_000_000, teams: 100, premium: true, media: true, mediaIncluded: true, mediaTrialWeekly: 0, video: true, hiResVideo: true, mediaMonthly: 5_000, browserMonthly: 3_000, videoMonthly: 1_000, competitors: 20 },
  beta: { label: 'Beta', price: 0, priceUzs: 0, dialogues: 2_000, voiceMinutes: 0, tokens: 90_000_000, teams: 10, premium: false, media: true, mediaIncluded: true, mediaTrialWeekly: 0, video: true, hiResVideo: true, mediaMonthly: 300, browserMonthly: 100, videoMonthly: 40, competitors: 5 },
}
export const PLAN_ORDER = ['starter', 'pro', 'business', 'agency', 'enterprise'] as const

/**
 * i18n-ключ названия тарифа. `label` в PLANS остаётся техническим значением по умолчанию —
 * его видно только там, где перевода нет. Витрина обязана звать тариф на языке посетителя:
 * узбекский выбран языком по умолчанию, и кириллическое «Агентство» на нём читается как чужое.
 */
export const planLabelKey = (id: string): string => `billingPage.plan_${id}`

/** Цена в сумах для витрины: «690 000 so'm». Пробел неразрывный, как в остальных числах UI. */
export const formatUzs = (v: number): string => v.toLocaleString('ru-RU').replace(/\s/g, ' ')

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
