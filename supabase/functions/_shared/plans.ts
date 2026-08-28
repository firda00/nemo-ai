// B2B subscription plans + monthly limits.
//
// ── Что клиент видит в счёте ──────────────────────────────────────────────────────────────
// Единица тарификации — ДИАЛОГ, а не токен. Владелец бизнеса не может оценить, много ли
// «2 000 000 токенов»; «5 000 диалогов в месяц» он оценивает мгновенно и сравнивает с числом
// обращений, которые к нему реально приходят. `tokens` остаётся, но переходит в роль
// внутреннего предохранителя от злоупотребления, а не витринного лимита.
//
// ── Откуда взяты цены ─────────────────────────────────────────────────────────────────────
// docs/market/unit-economics-2026-08.md и docs/market/cjm-ltv-2026-08.md. Две границы,
// определяющие всю лестницу:
//   • $50/мес — обрыв удержания. У AI-продуктов дешевле $50 годовой GRR 23% против 45%
//     выше (ChartMogul «The AI churn wave», данные по сент. 2025). Поэтому самый дешёвый
//     платный тариф стоит $59, а не $25: разница в цене окупается удвоением срока жизни.
//   • $250/мес — вторая ступень: GRR 70% против 45%. Поэтому `business` поставлен выше $250,
//     а не под ним. При этом он остаётся дешевле менеджера по продажам в Ташкенте
//     ($297–340/мес, tipa.uz май 2026 / ish.uz 2026) — аргумент замещения сохраняется.
//
// ── Голос ─────────────────────────────────────────────────────────────────────────────────
// `voiceMinutes: 0` на всех тарифах намеренно. При $0,07–0,15/мин каскадом и $0,345/мин
// speech-to-speech полторы тысячи минут стоят $105–518 — больше любого тарифа. Голос
// продаётся отдельным метром с оплатой с первой минуты, а не включается в подписку.
// Счётчик — monthlyVoiceMinutes() ниже; принудительное применение лимита ещё не подключено
// к телефонии (отдельная задача, требует ревью Codex как всё, что касается биллинга).
//
// ── Ключи планов ──────────────────────────────────────────────────────────────────────────
// Ключи НЕ переименованы намеренно. Они захардкожены в stripe-webhook:117 (который при
// неизвестном ключе молча не активирует оплаченный план и всё равно отвечает 200),
// admin-api:159, PLAN_PRICE_UZS, CompetitorTeamPanel и AdminPage. Переименование ключа —
// тихая производственная авария; переоценка существующего ключа безопасна.
export interface PlanLimit {
  label: string
  price: number        // USD / month — витрина и Stripe. Для РУз каноничен priceUzs.
  priceUzs: number     // сум / месяц — то, что реально списывается через Payme/Click.
                       // 0 = тариф не продаётся самообслуживанием (free / enterprise / beta).
  dialogues: number    // ГЛАВНЫЙ витринный лимит: диалогов в месяц
  voiceMinutes: number // включённых голосовых минут. 0 = оплата поминутно с первой минуты.
  tokens: number       // ПОТОЛОК ЗЛОУПОТРЕБЛЕНИЯ, а не второй продуктовый лимит.
                       // Задан как dialogues × 45 000 — троекратный запас к оценке в ~13 750
                       // токенов на диалог (5 реплик × 2 500 вход + 250 выход).
                       //
                       // Запас именно троекратный, а не «впритык», потому что упор в потолок
                       // токенов раньше, чем исчерпаны оплаченные диалоги, — это нарушенное
                       // обещание, а не защита. Проданы диалоги; токены обязаны ловить только
                       // злоупотребление на порядок. Реальная защита от стоимости — budget_cap
                       // на отдельный прогон, он тоньше и строже.
                       //
                       // 13 750 — оценка, а не замер: TEAM_RUN_TOKENS (n=13) меряет прогон
                       // команды, а не диалог. Заменить на измеренное, как только наберётся
                       // статистика по research_runs (миграция 20260725120000).
  teams: number        // max saved teams — ВНИМАНИЕ: сервером не применяется, только витрина
  premium: boolean     // access to the premium model for manager/steps
  media: boolean       // media generation feature available at all (false = must upgrade)
  mediaIncluded: boolean // true = generation is INCLUDED on Nemo's keys (no API to connect).
                         // false = BYO tier: connect your own provider key.
  mediaTrialWeekly: number // reserved for explicitly trial-enabled plans
  video: boolean       // VIDEO generation offered on this tier
  hiResVideo: boolean  // 1080p and 4K rendering; lower tiers render 720p.
                       // Independent of `premium` — beta keeps hi-res without premium LLMs.
  mediaMonthly: number // fair-use: max INCLUDED media generations / month (images+video+voice)
  browserMonthly: number // fair-use: max browser-agent tasks / month (included in subscription)
  videoMonthly: number // fair-use: max rendered videos / month (heavier than images — lower cap)
  competitors: number  // max competitors analyzed in ONE competitor-factory run
}

// Каждая запись держится В ОДНУ СТРОКУ: agent-hub/release-entitlement-contracts.mjs разбирает
// их однострочным regex `^\s*${id}:\s*\{.*$`. Перенос на несколько строк ломает контракт даже
// без смысловых изменений.
export const PLAN_LIMITS: Record<string, PlanLimit> = {
  // Старт (ключ starter) стоит выше $50 намеренно — см. комментарий об обрыве удержания.
  // Команда (ключ business) стоит выше $250 намеренно — вторая ступень удержания.
  free:       { label: 'Free',       price: 0,   priceUzs: 0,         dialogues: 50,      voiceMinutes: 0, tokens: 2_250_000,     teams: 1,   premium: false, media: false, mediaIncluded: false, mediaTrialWeekly: 0, video: false, hiResVideo: false, mediaMonthly: 0,    browserMonthly: 0,    videoMonthly: 0,    competitors: 1 },
  starter:    { label: 'Старт',      price: 59,  priceUzs: 690_000,   dialogues: 1_000,   voiceMinutes: 0, tokens: 45_000_000,    teams: 1,   premium: false, media: true,  mediaIncluded: false, mediaTrialWeekly: 0, video: false, hiResVideo: false, mediaMonthly: 0,    browserMonthly: 20,   videoMonthly: 0,    competitors: 2 },
  pro:        { label: 'Бизнес',     price: 143, priceUzs: 1_690_000, dialogues: 5_000,   voiceMinutes: 0, tokens: 225_000_000,   teams: 3,   premium: true,  media: true,  mediaIncluded: true,  mediaTrialWeekly: 0, video: true,  hiResVideo: true,  mediaMonthly: 100,  browserMonthly: 75,   videoMonthly: 20,   competitors: 3 },
  business:   { label: 'Команда',    price: 254, priceUzs: 2_990_000, dialogues: 15_000,  voiceMinutes: 0, tokens: 675_000_000,   teams: 10,  premium: true,  media: true,  mediaIncluded: true,  mediaTrialWeekly: 0, video: true,  hiResVideo: true,  mediaMonthly: 400,  browserMonthly: 250,  videoMonthly: 80,   competitors: 5 },
  agency:     { label: 'Агентство',  price: 350, priceUzs: 4_120_000, dialogues: 50_000,  voiceMinutes: 0, tokens: 2_250_000_000, teams: 30,  premium: true,  media: true,  mediaIncluded: true,  mediaTrialWeekly: 0, video: true,  hiResVideo: true,  mediaMonthly: 1500, browserMonthly: 1000, videoMonthly: 300,  competitors: 10 },
  enterprise: { label: 'Enterprise', price: 0,   priceUzs: 0,         dialogues: 200_000, voiceMinutes: 0, tokens: 9_000_000_000, teams: 100, premium: true, media: true,  mediaIncluded: true,  mediaTrialWeekly: 0, video: true,  hiResVideo: true,  mediaMonthly: 5000, browserMonthly: 3000, videoMonthly: 1000, competitors: 20 },
  // existing beta accounts keep generous included access
  beta:       { label: 'Beta',       price: 0,   priceUzs: 0,         dialogues: 2_000,   voiceMinutes: 0, tokens: 90_000_000,    teams: 10,  premium: false, media: true,  mediaIncluded: true,  mediaTrialWeekly: 0, video: true,  hiResVideo: true,  mediaMonthly: 300,  browserMonthly: 100,  videoMonthly: 40,   competitors: 5 },
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

// month-to-date dialogues for an account (resets on the 1st, UTC).
//
// `public.dialogues` не имеет собственного account_id — арендатор достижим только через
// agent_id → agents.account_id, поэтому здесь inner join, а не .eq('account_id', …), как у
// media_assets и tool_runs. Копировать сюда их однострочную форму нельзя: она молча вернёт 0.
//
// Один запрос, без выборки строк (head: true). Когда наберётся нагрузка, это стоит заменить
// на SQL-агрегат по образцу monthly_token_usage — тогда лимит перестанет зависеть от того,
// как PostgREST разворачивает embedded-фильтр.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function monthlyDialogues(admin: any, accountId: string): Promise<number> {
  const start = new Date()
  start.setUTCDate(1); start.setUTCHours(0, 0, 0, 0)
  const { count, error } = await admin
    .from('dialogues')
    .select('id, agents!inner(account_id)', { count: 'exact', head: true })
    .eq('agents.account_id', accountId)
    .gte('created_at', start.toISOString())
  if (error) throw new Error(`monthly dialogue usage unavailable: ${error.message}`)
  return Number(count) || 0
}

// month-to-date voice minutes for an account (resets on the 1st, UTC).
//
// Источник — public.telephony_calls.duration_seconds. ВНИМАНИЕ: там колонка называется
// tenant_id, а не account_id. Индекс (tenant_id, created_at desc) уже существует.
//
// Голос не входит ни в один тариф (voiceMinutes: 0 везде) — счётчик нужен для поминутного
// выставления счёта, а не для отказа в обслуживании. Применение лимита к телефонии пока НЕ
// подключено: это отдельная задача, и как всё, что касается биллинга, она требует ревью Codex
// до реализации (CLAUDE.md).
//
// Суммирование постранично, а не одним select. PostgREST обрезает неограниченный ответ по
// настройке «Max rows» (по умолчанию 1000) и делает это МОЛЧА, без ошибки: аккаунт с 1500
// звонками получил бы счёт за 1000. Для счётчика, по которому выставляются деньги, тихое
// занижение хуже отказа.
//
// Правильное решение — SQL-агрегат по образцу monthly_token_usage. Он требует миграции, а
// миграции и биллинг по CLAUDE.md идут через ревью Codex, поэтому здесь честная пагинация,
// а RPC остаётся следующим шагом.
const VOICE_PAGE = 1000

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function monthlyVoiceMinutes(admin: any, accountId: string): Promise<number> {
  const start = new Date()
  start.setUTCDate(1); start.setUTCHours(0, 0, 0, 0)
  let seconds = 0
  for (let offset = 0; ; offset += VOICE_PAGE) {
    const { data, error } = await admin
      .from('telephony_calls')
      .select('duration_seconds')
      .eq('tenant_id', accountId)
      .gte('created_at', start.toISOString())
      .order('created_at', { ascending: true })
      .range(offset, offset + VOICE_PAGE - 1)
    if (error) throw new Error(`monthly voice usage unavailable: ${error.message}`)
    const page = (data ?? []) as { duration_seconds?: number }[]
    for (const row of page) seconds += Number(row.duration_seconds) || 0
    // Короткая страница означает конец выборки. Ровно полная — читаем следующую.
    if (page.length < VOICE_PAGE) break
  }
  return Math.ceil(seconds / 60)
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
