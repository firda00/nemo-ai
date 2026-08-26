import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8')
const [layout, drawer, store, view, app] = await Promise.all([
  read('src/components/layout/AppLayout.tsx'),
  read('src/components/office/AgentDrawer.tsx'),
  read('src/store/useTeamOfficeStore.ts'),
  read('src/components/office/TeamOfficeView.tsx'),
  read('src/App.tsx'),
])

const normalDestinations = ['/app', '/app/dialogues', '/app/teams', '/app/content', '/app/knowledge', '/app/analytics', '/app/settings']
for (const route of normalDestinations) assert.match(layout, new RegExp(`to: '${route.replaceAll('/', '\\/')}'`))
assert.equal((layout.match(/to: '\/app(?:'|\/dialogues'|\/teams'|\/content'|\/knowledge'|\/analytics'|\/settings')/g) ?? []).length, 7)

assert.match(view, /reactflow/)
assert.match(view, /md:hidden/)
assert.match(view, /nodesDraggable=\{false\}/)
assert.match(store, /status: 'idle'/)
assert.doesNotMatch(drawer, /agent\.prompt|prompt\.rules|chain.of.thought|raw.*log/i)

// Hidden destinations remain valid deep links after sidebar compaction.
for (const route of ['agents', 'autopost', 'approvals', 'integrations', 'billing']) {
  assert.match(app, new RegExp(`path="${route}"`))
}

console.log('team office UI contracts passed')
