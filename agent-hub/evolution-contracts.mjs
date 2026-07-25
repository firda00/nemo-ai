import { readFileSync } from 'node:fs'

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')
const fn = read('supabase/functions/evolve-agent/index.ts')
const ui = read('src/components/platform/AgentGrowth.tsx')
const migration = read('supabase/migrations/20260713120000_governed_agent_evolution.sql')
const deploy = read('deploy.ps1')
const spec = read('NEMO_AI_SPEC.md')

const checks = [
  ['auto mode is opt-in', /\.eq\('auto_evolve', true\)/.test(fn) && /default false/.test(read('supabase/migrations/20260707250000_agent_growth.sql'))],
  ['auto evolution has a seven-day cooldown', /AUTO_COOLDOWN_DAYS = 7/.test(fn) && /auto_applied/.test(fn)],
  ['auto evolution requires real conversation evidence', /MIN_AUTO_MESSAGES = 6/.test(fn) && /not_enough_evidence/.test(fn)],
  ['independent review gates automatic apply', /AUTO_REVIEW_SCORE = 88/.test(fn) && /Boolean\(review\.safe\)/.test(fn)],
  ['locked safety rules survive every apply and rollback', /LOCKED NEMO SAFETY/.test(fn) && (fn.match(/lockSafety\(/g) ?? []).length >= 4],
  ['cron endpoint is protected by a secret', /cronAuthorized/.test(fn) && /x-cron-secret/.test(fn) && /CRON_SECRET/.test(fn)],
  ['tenant scoping protects manual operations', /\.eq\('account_id', accountId\)/.test(fn) && /agent not found/.test(fn)],
  ['owners can disable autonomous evolution', /action === 'settings'/.test(fn) && /auto_evolve: enabled/.test(fn)],
  ['applied updates can be rolled back', /action === 'rollback'/.test(fn) && /prompt_before/.test(fn) && /rolled_back_at/.test(fn)],
  ['UI exposes status, review score, history and rollback', /autoTitle/.test(ui) && /review_score/.test(ui) && /rollback\(h\.id\)/.test(ui)],
  ['audit schema stores review and rollback evidence', /review_score/.test(migration) && /review_summary/.test(migration) && /rolled_back_at/.test(migration)],
  ['daily schedule and no-JWT deployment are explicit', /nemo-agent-evolution-daily/.test(deploy) && /'evolve-agent'/.test(deploy) && /--no-verify-jwt/.test(deploy)],
  ['current evolution cannot modify code or permissions', /cannot change tools,[\s\S]*code, deployment, permissions/.test(fn)],
  ['future code evolution is isolated, reviewed, tested and reversible', /isolated branch\/patch/.test(spec) && /independent reviewer/.test(spec) && /QA\/security agent/.test(spec) && /canary rollout/.test(spec) && /automatic rollback/.test(spec)],
]

let failed = 0
for (const [name, ok] of checks) {
  if (ok) console.log(`[OK] ${name}`)
  else { console.error(`[FAIL] ${name}`); failed++ }
}
if (failed) process.exit(1)
console.log(`Governed evolution contracts passed: ${checks.length}/${checks.length}.`)
