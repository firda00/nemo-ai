import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8')

const migration = read('supabase/migrations/20260803170000_autonomous_run_checkpoints.sql')
const orchestrator = read('supabase/functions/orchestrate/index.ts')
const runner = read('src/components/platform/AutonomousRunner.tsx')

assert.match(migration, /unique \(account_id, run_ref\)/, 'repeated saves for one run must be idempotent')
assert.match(migration, /research_runs_account_run_ref_uidx/, 'a lost synth response must not create a second final run')
assert.match(migration, /where status = 'active'/, 'resume lookup needs an active-run partial index')
assert.match(migration, /enable row level security/, 'checkpoint state must be RLS protected')
assert.match(migration, /revoke all on table public\.autonomous_run_checkpoints from anon, authenticated/, 'browser roles must never write checkpoints directly')
assert.doesNotMatch(migration, /create policy/i, 'checkpoint state must remain service-role only')

for (const action of ['checkpoint_save', 'checkpoint_get', 'checkpoint_complete']) {
  assert.match(orchestrator, new RegExp(`action === '${action}'`), `${action} must be implemented`)
}
assert.ok(
  orchestrator.indexOf("if (action === 'checkpoint_save')") < orchestrator.indexOf('const orKey = await resolveOpenRouterKey'),
  'checkpoint recovery must work during provider outages',
)
assert.match(orchestrator, /serialized\.length > MAX_CHECKPOINT_CHARS/, 'checkpoint JSON must be bounded')
assert.match(orchestrator, /\.eq\('account_id', accountId\)/, 'checkpoint reads and writes must stay in the caller account')
assert.match(orchestrator, /\.eq\('user_id', user\.id\)/, 'checkpoint reads and writes must stay with the creating user')
assert.doesNotMatch(orchestrator, /refresh_token|access_token/, 'checkpoint storage must never persist session credentials')
assert.match(orchestrator, /\.eq\('run_ref', runRef\)[\s\S]{0,500}reused: true/, 'repeated synthesis must return the persisted report without another model call')
assert.match(orchestrator, /run_ref: runRef, report: r\.content/, 'the final run must retain its idempotency key')

assert.match(runner, /action: 'checkpoint_get'/, 'the runner must discover resumable work on mount')
assert.match(runner, /const specialistStart = restored/, 'specialists must resume at the persisted cursor')
assert.match(runner, /Number\(restored\?\.nextReview\)/, 'peer review must resume at the persisted cursor')
assert.ok((runner.match(/persistCheckpoint\('/g) ?? []).length >= 4, 'staff, specialist, review and synth boundaries must be checkpointed')
assert.match(runner, /if \(!await persistCheckpoint\('team'/, 'a failed team checkpoint must stop the run before more spend')
assert.match(runner, /if \(!await persistCheckpoint\('review'/, 'a failed review checkpoint must stop the run before more spend')
assert.match(runner, /action: 'checkpoint_complete'/, 'successful synthesis must close its checkpoint')
assert.match(runner, /autonomousRunner\.resumeCheckpoint/, 'the user must see that saved progress is available')
assert.match(runner, /if \(onGoalChange\) onGoalChange\(checkpoint\.state\.goal\)/, 'controlled runners must show which goal will be resumed')

console.log('Autonomous run checkpoint contracts passed.')
