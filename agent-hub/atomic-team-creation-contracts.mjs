import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { MIN_STAFF_SPECIALISTS, MAX_STAFF_SPECIALISTS, staffCandidates } from '../supabase/functions/_shared/staffRoster.ts'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8')
const migration = read('supabase/migrations/20260803140000_atomic_agent_teams.sql')
const persistence = read('src/lib/dynamicTeams.ts')
const factory = read('src/pages/OnboardingPage.tsx')
const deploy = read('deploy.ps1')
const repair = read('supabase/migrations/20260804160000_team_draft_and_usage_aggregate.sql')
const orchestrator = read('supabase/functions/orchestrate/index.ts')

assert.match(migration, /security invoker/, 'team creation must retain caller RLS')
assert.match(migration, /v_account_id uuid := public\.current_account_id\(\)/, 'account id must come from auth context')
assert.doesNotMatch(migration, /p_account_id/, 'the browser must not choose a tenant')
assert.match(migration, /v_count < 2 or v_count > 6/, 'roster must be bounded')
assert.match(migration, /v_policy not in \('read_only', 'approval_required'\)/)
assert.match(migration, /coalesce\(v_specialist->>'status', 'active'\) not in \('active', 'paused'\)/)
assert.match(migration, /revoke all on function public\.create_agent_team[\s\S]*from public, anon/)
assert.match(migration, /grant execute on function public\.create_agent_team[\s\S]*to authenticated/)
assert.match(persistence, /rpc\('create_agent_team'/, 'all shared dynamic team callers must use the atomic RPC')
assert.match(factory, /action: 'staff'/, 'Factory must request a real specialist roster')
assert.match(factory, /saveDynamicTeam\(addAgent/, 'Factory must persist the roster through the shared atomic boundary')
assert.match(factory, /draft\.type === 'workflow' \? `\/app\/teams\//, 'created teams must open the team workspace')
assert.match(deploy, /20260803140000_atomic_agent_teams\.sql/)
assert.match(repair, /create or replace function public\.create_agent_team[\s\S]*?'draft'/i, 'the production repair must create a draft manager')
const browserLimit = Number(persistence.match(/opts\.specialists\.length > (\d+)/)?.[1])
const databaseLimit = Number(repair.match(/v_count < \d+ or v_count > (\d+)/)?.[1])
assert.equal(MAX_STAFF_SPECIALISTS, browserLimit, 'the architect must respect the browser persistence limit')
assert.equal(MAX_STAFF_SPECIALISTS, databaseLimit, 'the architect must respect the current atomic RPC limit')
assert.ok(MAX_STAFF_SPECIALISTS >= 5, 'valid five-specialist teams must be retained')
assert.equal(MIN_STAFF_SPECIALISTS, 3, 'the architect needs room for planner, executor, and reviewer')
assert.match(orchestrator, /dependency graph of \$\{MIN_STAFF_SPECIALISTS\}-\$\{MAX_STAFF_SPECIALISTS\} specialists/, 'the prompt must use the enforced staff bounds')
assert.match(orchestrator, /const candidates = staffCandidates\(parsed\?\.subagents\)\s+if \(!candidates\) continue\s+const mapped = candidates\.map/, 'invalid rosters must retry before mapping, without silently dropping members')
assert.match(orchestrator, /attempt < 3 && subagents\.length === 0/, 'invalid roster retries must remain bounded')
const roster = (count) => Array.from({ length: count }, (_, index) => ({ role: index === count - 1 ? 'Reviewer' : `Specialist ${index}`, depends_on: index ? [index - 1] : [] }))
for (const count of [3, 5, 6]) {
  const original = roster(count)
  assert.strictEqual(staffCandidates(original), original, 'valid teams must preserve every member, including the last reviewer and all dependency indexes')
}
for (const value of [null, {}, [], roster(2), roster(7), [...roster(5), null], [...roster(5), { role: ' ' }]]) {
  assert.equal(staffCandidates(value), null, 'invalid or oversized rosters must be rejected in full')
}
assert.match(deploy, /20260804160000_team_draft_and_usage_aggregate\.sql/)

console.log('Atomic team creation contracts passed.')
