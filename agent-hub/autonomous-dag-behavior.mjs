import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { blockedByFailedDependencies, dependenciesFor, readyNodeIndexes, validateDependencies } from '../supabase/functions/_shared/executionDag.ts'

assert.deepEqual(validateDependencies([], 0), [])
assert.deepEqual(validateDependencies([0, 1], 2), [0, 1])
for (const invalid of [undefined, '0', [-1], [1], [0, 0], [0.5]]) assert.equal(validateDependencies(invalid, 1), null)

const diamond = [
  { status: 'pending', depends_on: [] },
  { status: 'pending', depends_on: [0] },
  { status: 'pending', depends_on: [0] },
  { status: 'pending', depends_on: [1, 2] },
]
assert.deepEqual(readyNodeIndexes(diamond), [0])
diamond[0].status = 'done'
assert.deepEqual(readyNodeIndexes(diamond), [1, 2])
diamond[1].status = 'done'; diamond[2].status = 'done'
assert.deepEqual(readyNodeIndexes(diamond), [3])

const fourRoots = Array.from({ length: 4 }, () => ({ status: 'pending', depends_on: [] }))
assert.deepEqual(readyNodeIndexes(fourRoots, 3), [0, 1, 2])
assert.deepEqual(dependenciesFor({ status: 'pending' }, 2), [1], 'legacy nodes without metadata stay sequential')

const failed = [
  { status: 'failed', depends_on: [] },
  { status: 'pending', depends_on: [0] },
  { status: 'pending', depends_on: [1] },
  { status: 'done', depends_on: [] },
]
assert.deepEqual([...blockedByFailedDependencies(failed)], [[1, [0]], [2, [1]]])

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const worker = fs.readFileSync(path.join(root, 'supabase/functions/autonomous-worker/index.ts'), 'utf8')
const orchestrator = fs.readFileSync(path.join(root, 'supabase/functions/orchestrate/index.ts'), 'utf8')
assert.match(worker, /Promise\.allSettled\(ready\.map/, 'ready specialists must execute concurrently without fail-fast loss')
assert.match(worker, /MAX_PARALLEL_SPECIALISTS = 3/, 'specialist concurrency must remain bounded')
assert.match(worker, /dependencyIndexes\.map\(\(dependency\) => specs\[dependency\]\)/, 'handoff context must contain declared dependencies only')
assert.match(worker, /attempts >= MAX_SPECIALIST_ATTEMPTS \? 'failed' : 'pending'/, 'node retries must be bounded independently')
assert.match(worker, /state\.specs = specs[\s\S]*finish\(/, 'a wave must checkpoint merged partial successes once')
assert.match(orchestrator, /validateDependencies\(s\.depends_on, index\)/, 'generated dependency edges must be strictly validated')
assert.match(orchestrator, /depends_on: index > 0 \? \[index - 1\] : \[\]/, 'preset teams must retain sequential compatibility')

console.log('Autonomous DAG scheduling behavior passed.')
