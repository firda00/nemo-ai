import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8')
const [layout, drawer, quickEditDrawer, store, view, pipeline, autonomous, agentsPage, teamDetailPage, sectionNav, leadsPage, app] = await Promise.all([
  read('src/components/layout/AppLayout.tsx'),
  read('src/components/office/AgentDrawer.tsx'),
  read('src/components/agents/AgentQuickEditDrawer.tsx'),
  read('src/store/useTeamOfficeStore.ts'),
  read('src/components/office/TeamOfficeView.tsx'),
  read('src/components/office/PipelineNode.tsx'),
  read('src/pages/app/AutonomousPage.tsx'),
  read('src/pages/app/AgentsPage.tsx'),
  read('src/pages/app/TeamDetailPage.tsx'),
  read('src/components/platform/KnowledgeIntegrationNav.tsx'),
  read('src/pages/app/LeadsPage.tsx'),
  read('src/App.tsx'),
])

const normalDestinations = ['/app', '/app/teams', '/app/forge', '/app/content', '/app/knowledge', '/app/analytics', '/app/settings']
for (const route of normalDestinations) assert.match(layout, new RegExp(`to: '${route.replaceAll('/', '\\/')}'`))
assert.equal((layout.match(/to: '\/app(?:'|\/teams'|\/forge'|\/content'|\/knowledge'|\/analytics'|\/settings')/g) ?? []).length, 7)
assert.doesNotMatch(layout, /to: '\/app\/dialogues'/)
assert.doesNotMatch(app, /import DialoguesPage/)
assert.match(app, /path="dialogues" element=\{<Navigate to="\/app" replace \/>\}/)

assert.match(view, /reactflow/)
assert.match(view, /md:hidden/)
assert.match(view, /onNodesChange=\{onNodesChange\}/)
assert.match(view, /nodeSignature/)
assert.match(view, /fitView/)
assert.match(view, /useNodesState/)
assert.match(view, /nodesDraggable/)
assert.match(view, /h-\[600px\]/)
assert.match(view, /PipelineNode/)
assert.match(store, /applyNodeChanges/)
assert.match(store, /status: 'idle'/)
assert.match(pipeline, /A2A Wire v1/)
assert.match(autonomous, /navigate\('\/app\/agents'\)/)
assert.match(agentsPage, /from\('departments'\)/)
assert.match(agentsPage, /from\('sub_agents'\)/)
assert.match(agentsPage, /!teamsView && <TeamOfficeView platformAgents=\{visibleAgents\}/)
assert.doesNotMatch(agentsPage, /Команда на холсте|selectedOfficeTeamId|activeOfficeTeam/)
assert.match(agentsPage, /placeholder=\{registryCopy\.search\}/)
assert.match(agentsPage, /teamRoster\[a\.id\]\?\.count/)
assert.match(teamDetailPage, /activeTab.*'overview'.*'graph'.*'runs'/)
assert.match(teamDetailPage, /initialMode="graph"/)
assert.match(teamDetailPage, /supplementalAgents=\{graphAgents\}/)
assert.match(teamDetailPage, /\.eq\('main_agent_id', id\)/)
assert.match(teamDetailPage, /\.eq\('department_id', deptId\)/)
assert.match(agentsPage, /<AgentQuickEditDrawer/)
assert.match(agentsPage, /status: agent\.status === 'active' \? 'draft' : agent\.status/)
assert.match(quickEditDrawer, /approval_required/)
assert.match(quickEditDrawer, /read_only/)
assert.match(quickEditDrawer, /\/app\/agents\/\$\{agent\.id\}/)
assert.doesNotMatch(quickEditDrawer, /chain.of.thought|raw.*log|service_role|secret/i)
assert.doesNotMatch(drawer, /agent\.prompt|prompt\.rules|chain.of.thought|raw.*log/i)

for (const route of ['/app/lead-forms', '/app/integrations', '/app/knowledge', '/app/tools']) {
  assert.match(sectionNav, new RegExp(`to: '${route.replaceAll('/', '\\/')}'`))
}
assert.doesNotMatch(sectionNav, /\/app\/dialogues/)
assert.match(leadsPage, /<KnowledgeIntegrationNav active="leads"/)

// Hidden destinations remain valid deep links after sidebar compaction.
for (const route of ['agents', 'autopost', 'approvals', 'integrations', 'billing']) {
  assert.match(app, new RegExp(`path="${route}"`))
}

console.log('team office UI contracts passed')
