// Run telemetry (C0) and watchdog liveness (D).
//
// Both exist because a number that is quietly wrong is worse than a number that is missing:
// billing advertised ~8x the work a plan could do, cost read as $0.02 on 700k tokens, 23% of
// tokens were attributed to models that do not exist, and a monitor that had been dead for
// twelve days rendered as a green "Operational" banner.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  formatCheckAge,
  OPS_STALE_AFTER_MINUTES,
  opsLiveness,
} from '../src/lib/opsHealth.ts'
import {
  PLANS,
  SHORT_TASK_TOKENS,
  TEAM_RUN_TOKENS,
  formatRunRange,
  shortTasksFromTokens,
  teamRunsFromTokens,
} from '../src/lib/plans.ts'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8')

// ─── Watchdog liveness ───────────────────────────────────────────────────────
const fresh = Date.parse('2026-07-25T12:00:00Z')
assert.equal(opsLiveness('2026-07-25T11:55:00Z', 'ok', fresh).status, 'ok', 'a fresh ok is an ok')
assert.equal(opsLiveness('2026-07-25T11:55:00Z', 'warn', fresh).status, 'warn')
assert.equal(
  opsLiveness('2026-07-13T13:20:03Z', 'ok', fresh).status,
  'stale',
  'the twelve-day-old ok row must never render as a healthy platform',
)
assert.equal(opsLiveness('2026-07-13T13:20:03Z', 'ok', fresh).reported, false)
assert.equal(opsLiveness(null, null, fresh).status, 'unknown', 'no rows at all is unknown, not ok')
assert.equal(opsLiveness('not-a-date', 'ok', fresh).status, 'unknown')
const justPastCutoff = new Date(fresh - (OPS_STALE_AFTER_MINUTES + 1) * 60_000).toISOString()
const justInside = new Date(fresh - (OPS_STALE_AFTER_MINUTES - 1) * 60_000).toISOString()
assert.equal(opsLiveness(justPastCutoff, 'ok', fresh).status, 'stale', 'one minute past three missed intervals is stale')
assert.equal(opsLiveness(justInside, 'ok', fresh).status, 'ok', 'a single missed tick is not an outage')
assert.equal(formatCheckAge(283 * 60), '11 сут назад')
assert.equal(formatCheckAge(null), '—')

const watchdog = read('supabase/functions/ops-watchdog/index.ts')
assert.match(watchdog, /missedRuns/, 'the watchdog must notice its own missing runs')
assert.match(
  watchdog,
  /status !== prevStatus \|\| missedRuns/,
  'a monitoring gap must alert even when the status did not change, or a dead cron resumes silently',
)
assert.match(watchdog, /\.eq\('tool', 'browser_task'\)/, 'stuck browser tasks must be swept')
assert.match(watchdog, /result: 'timeout', ok: false/, 'a swept job must be closed, not left running')
assert.match(watchdog, /\.eq\('result', 'running'\)/)
assert.match(watchdog, /details\.stuck_jobs\.ok/, 'a failed sweep must degrade the overall status')

const observability = read('src/pages/app/ObservabilityPage.tsx')
assert.match(observability, /opsLiveness\(health\?\.created_at, health\?\.status, checkedAt\)/)
assert.match(observability, /setCheckedAt\(Date\.now\(\)\)/, 'freshness is sampled when the row is read, not during render')
assert.doesNotMatch(
  observability,
  /health\.status === 'ok' \? t\('observabilityPage\.healthOk'\)/,
  'the banner must render derived liveness, never the raw stored status',
)

// ─── Run telemetry ───────────────────────────────────────────────────────────
const migration = read('supabase/migrations/20260725120000_run_telemetry.sql')
assert.match(migration, /alter table public\.usage add column if not exists stage/)
assert.match(migration, /alter table public\.usage add column if not exists run_ref/)
assert.match(migration, /alter table public\.research_runs add column if not exists cost/)
assert.match(migration, /model not like '%\/%'/, 'stage labels are exactly the values with no provider prefix')
assert.doesNotMatch(migration, /update public\.usage\s+set cost =/, 'historical cost must not be back-filled from a guess')

const orchestrate = read('supabase/functions/orchestrate/index.ts')
assert.match(orchestrate, /cost: estimateCostUsd\(model, tokens\)/, 'every orchestrated call must record its cost')
assert.match(orchestrate, /run_ref: runRef/, 'usage rows must be attributable to one run')
assert.match(orchestrate, /tokens: runTokens, cost: Number\(runCost\.toFixed\(6\)\)/, 'the run row must carry its own totals')
assert.match(orchestrate, /\.eq\('run_ref', runRef\)/, 'run totals are summed from what actually happened')
assert.match(orchestrate, /Math\.min\(2, Number\(s\.revisions\)/, 'persisted telemetry must retain both possible revision passes')

const runner = read('src/components/platform/AutonomousRunner.tsx')
assert.match(runner, /runRef\.current = resume\?\.run_ref \|\| crypto\.randomUUID\(\)/, 'each new run needs one id and resumed runs must retain it')
assert.match(runner, /run_ref: runRef\.current/, 'every call in the run must carry it')
const researchPage = read('src/pages/app/ResearchPage.tsx')
assert.match(researchPage, /s\.review\.score \?\? 0/, 'reopened team runs must expose their persisted peer-review score')
assert.match(researchPage, /s\.review\.needs_human_review/, 'reopened team runs must preserve the human-review warning')
assert.match(researchPage, /result\?\.status === 'needs_review'/, 'the persisted run status must drive the reopened warning')
assert.match(researchPage, /autonomousRunner\.escalatedBanner/, 'human review must be prominent above the reopened deliverable')

// No pipeline label may sit in the model column: that is what made 23% of tokens belong to
// models that do not exist, and made estimateCostUsd price a 4o run at the cheap tier.
const usageWriters = [
  'supabase/functions/_shared/agent.ts',
  'supabase/functions/_shared/groupchat.ts',
  'supabase/functions/_shared/tgProcess.ts',
  'supabase/functions/analyze-content/index.ts',
  'supabase/functions/compose-agent/index.ts',
  'supabase/functions/content-visual/index.ts',
  'supabase/functions/edit-file/index.ts',
  'supabase/functions/follow-up/index.ts',
  'supabase/functions/generate-image/index.ts',
  'supabase/functions/localize/index.ts',
  'supabase/functions/logistics-workflow/index.ts',
  'supabase/functions/ops-workflow/index.ts',
  'supabase/functions/orchestrate/index.ts',
  'supabase/functions/research-agent/index.ts',
  'supabase/functions/test-agent/index.ts',
  'supabase/functions/transcribe-file/index.ts',
  'supabase/functions/watch-sources/index.ts',
]
const LABEL_IN_MODEL = /from\('usage'\)\.insert\(\{[^}]*model: '(?!.*\/)[^']+'/
for (const file of usageWriters) {
  assert.doesNotMatch(read(file), LABEL_IN_MODEL, `${file} writes a pipeline label into usage.model`)
}
assert.doesNotMatch(
  read('supabase/functions/_shared/agent.ts'),
  /modelTag = '(tool|team)'/,
  'the tool/team stage must not overwrite the model id — it also mispriced the row',
)

// Insert sites that name a real model must price it; label-only sites must NOT invent a price.
for (const file of usageWriters) {
  const body = read(file)
  for (const [, insert] of body.matchAll(/from\('usage'\)\.insert\(\{([^}]*)\}/g)) {
    // `model` as shorthand is a real model id just as much as `model: X` is.
    const named = /model: (?!null)/.test(insert) || /(^|[{,])\s*model\s*(,|$)/.test(insert)
    if (named) assert.match(insert, /cost:/, `${file} records a model without its cost`)
    else assert.doesNotMatch(insert, /cost: estimateCostUsd/, `${file} prices a row whose model is unknown`)
  }
}

// ─── Billing honesty ─────────────────────────────────────────────────────────
// Измеренные константы остаются измеренными: они защищают от возврата к выдумке в 4 750 токенов
// на прогон, из-за которой каждый тариф обещал примерно в восемь раз больше работы, чем мог.
assert.ok(TEAM_RUN_TOKENS.median > 30_000, 'the measured median must not silently return to the 4,750 fiction')
assert.ok(TEAM_RUN_TOKENS.max / TEAM_RUN_TOKENS.min > 5, 'a 5.6x spread is why one constant cannot be honest')
assert.ok(SHORT_TASK_TOKENS.mean > 0)
assert.ok(teamRunsFromTokens(PLANS.starter.tokens).low > 0, 'the run estimate must stay computable')
assert.equal(formatRunRange(teamRunsFromTokens(PLANS.starter.tokens)), `${teamRunsFromTokens(PLANS.starter.tokens).low}–${teamRunsFromTokens(PLANS.starter.tokens).high}`)
assert.ok(shortTasksFromTokens(PLANS.starter.tokens) > teamRunsFromTokens(PLANS.starter.tokens).high * 5, 'short tasks are ~15x cheaper than team runs')

// Единица тарифа — диалог. Токен остался ВНУТРЕННИМ предохранителем, и у него ровно одна
// обязанность: сработать позже диалогового лимита. Если клиент купил 1 000 диалогов и упёрся
// в токены на восьмисотом — это нарушенное обещание, а не защита от злоупотребления.
const GUARD_TOKENS_PER_DIALOGUE = 45_000
const WORKING_ESTIMATE_PER_DIALOGUE = 15_000
assert.ok(
  GUARD_TOKENS_PER_DIALOGUE >= WORKING_ESTIMATE_PER_DIALOGUE * 3,
  'the guard must keep a threefold margin over the working estimate, or a heavy honest customer trips it',
)
for (const [key, plan] of Object.entries(PLANS)) {
  if (!plan.dialogues) continue
  assert.equal(
    plan.tokens,
    plan.dialogues * GUARD_TOKENS_PER_DIALOGUE,
    `${key}: токенный потолок разошёлся с диалогами — предохранитель сработает раньше проданного лимита`,
  )
}

// Витрина считает в диалогах и молчит про токены: владелец бизнеса не может планировать расход
// в токенах, и именно эта единица измерения останавливала людей сильнее самой цены.
for (const file of ['src/pages/app/BillingPage.tsx', 'src/pages/PricingPage.tsx']) {
  const body = read(file)
  assert.doesNotMatch(body, /runsFromTokens\(/, `${file} still quotes the single-constant estimate`)
  assert.doesNotMatch(body, /\.tokens\b/, `${file} still shows a token quota to the customer`)
  assert.match(body, /\.dialogues\b/, `${file} must price the plan in dialogues`)
}
const extra = read('src/i18n/extra.ts')
assert.doesNotMatch(extra, /4 750|4,750/, 'the per-run constant must be gone from every language')

console.log('Run telemetry and watchdog liveness contracts passed.')
