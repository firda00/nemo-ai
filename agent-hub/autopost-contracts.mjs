import { readFileSync } from 'node:fs'

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8')
const migration = read('supabase/migrations/20260711150000_autopost_repair.sql')
const autopost = read('supabase/functions/autopost/index.ts')
const followup = read('supabase/functions/follow-up/index.ts')
const autopostUi = read('src/pages/app/AutopostPage.tsx')
const followupUi = read('src/pages/app/FollowUpsPage.tsx')
const deploy = read('deploy.ps1')

const checks = [
  ['scheduled_posts has platform', /add column if not exists platform/.test(migration)],
  ['scheduled_posts has media_url', /add column if not exists media_url/.test(migration)],
  ['social_accounts is reproducible', /create table if not exists public\.social_accounts/.test(migration)],
  ['social destinations may omit target_chat', /alter column target_chat drop not null/.test(migration)],
  ['autopost claims rows atomically', /claim_due_scheduled_posts/.test(autopost) && /for update skip locked/.test(migration)],
  ['follow-up claims rows atomically', /claim_due_follow_ups/.test(followup) && /for update skip locked/.test(migration)],
  ['Telegram scheduling requires a bot', /Сначала подключите и выберите Telegram-бота/.test(autopost)],
  ['UI supports send now', /postPayload\('send_now'\)/.test(autopostUi)],
  ['funnel links to a dialogue', /dialogue_id: dialogueId/.test(followupUi)],
  ['cron provisioning exists', /nemo-autopost-every-minute/.test(deploy) && /nemo-follow-up-every-five-minutes/.test(deploy)],
]

let failed = 0
for (const [name, ok] of checks) {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`)
  if (!ok) failed++
}
if (failed) process.exit(1)
console.log(`Autopost/funnel contracts: ${checks.length}/${checks.length}`)
