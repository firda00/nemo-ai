import assert from 'node:assert/strict'
import fs from 'node:fs'
import { GoalSchema, evaluateGoalConditions } from '../supabase/functions/_shared/goal.ts'

const read = (path) => fs.readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')
const orchestrator = read('supabase/functions/orchestrate/index.ts')
const worker = read('supabase/functions/autonomous-worker/index.ts')
const runner = read('src/components/platform/AutonomousRunner.tsx')
const migration = read('supabase/migrations/20260831100000_goal_conditioned_loop.sql')
const deploy = read('scripts/deploy-google-oauth.mjs')

const contract = GoalSchema.parse({
  goal_statement: 'Подготовить проверенный план запуска',
  definition_of_done: ['План запуска сформирован', 'Есть конкретные следующие действия'],
})
assert.equal(contract.max_iterations, 3)
assert.equal(contract.current_iteration, 0)
assert.equal(GoalSchema.safeParse({ ...contract, definition_of_done: ['one'] }).success, false)
assert.equal(GoalSchema.safeParse({ ...contract, max_iterations: 11 }).success, false)

const achieved = evaluateGoalConditions(contract, 'План запуска сформирован. Следующие действия:\n1. Проверить данные.\n2. Запустить тест. '.repeat(5), [])
assert.equal(achieved.achieved, true)
const unmet = evaluateGoalConditions(contract, 'Коротко.', [])
assert.equal(unmet.achieved, false)

assert.match(orchestrator, /goal_statement/)
assert.match(orchestrator, /goal_description/)
assert.match(orchestrator, /definition_of_done/)
assert.match(orchestrator, /max_iterations/)
assert.match(orchestrator, /current_iteration: 1/)
assert.match(worker, /run\.transition === 'goal_check'/)
assert.match(worker, /run\.transition === 'observe_plan'/)
assert.match(worker, /OBSERVE & PLAN/)
assert.match(worker, /evaluateGoalConditions/)
assert.match(worker, /current_iteration \+ 1/)
assert.match(worker, /status: 'goal_achieved'/)
assert.match(worker, /status: 'max_iterations'/)
assert.match(worker, /PREVIOUS ITERATION/)
assert.match(migration, /'goal_check'/)
assert.match(runner, /goalRuntime\.contract\.current_iteration/)
assert.match(runner, /definition_of_done\.map/)
assert.match(runner, /cancelWorkerRun/)
assert.match(deploy, /SUPABASE_ACCESS_TOKEN/)
assert.doesNotMatch(deploy, /console\.(?:log|error)\([^\n]*SUPABASE_ACCESS_TOKEN[^\n]*process\.env/)

console.log('[OK] Goal-conditioned contract, deterministic evaluator, durable loop, UI and OAuth deploy gate')
