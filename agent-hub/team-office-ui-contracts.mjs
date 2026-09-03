import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8')
const [layout, drawer, quickEditDrawer, store, view, pipeline, autonomous, agentsPage, teamDetailPage, sectionNav, leadsPage, app, runner, storeArtifact] = await Promise.all([
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
  read('src/components/platform/AutonomousRunner.tsx'),
  read('src/components/platform/StoreSnapshotArtifact.tsx'),
])

const sidebarBlock = layout.slice(layout.indexOf('const navGroups'), layout.indexOf('const nav ='))
const teamNames = await read('src/lib/teamDisplayName.ts')
const normalDestinations = ['/app', '/app/teams', '/app/settings']
for (const route of normalDestinations) assert.match(sidebarBlock, new RegExp(`to: '${route.replaceAll('/', '\\/')}'`))
for (const route of ['/app/content', '/app/finance', '/app/research', '/app/knowledge', '/app/analytics']) assert.doesNotMatch(sidebarBlock, new RegExp(`to: '${route.replaceAll('/', '\\/')}'`))
assert.equal((sidebarBlock.match(/to: '\/app(?:'|\/teams'|\/settings')/g) ?? []).length, 3)
assert.doesNotMatch(sidebarBlock, /to: '\/app\/forge'/)
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
assert.match(teamDetailPage, /min-\[1180px\]:grid-cols-\[220px_minmax\(0,1fr\)_310px\]/)
assert.match(teamDetailPage, /setTelegramOpen\(true\)/)
assert.match(teamDetailPage, /telegramOpen && <div/)
assert.match(teamDetailPage, /role="dialog" aria-modal="true" aria-labelledby="telegram-settings-title"/)
assert.match(teamDetailPage, /setInspectorOpen\(\(value\) => !value\)/)
assert.match(teamDetailPage, /setSelectedSub\(sa\)/)
assert.match(teamDetailPage, /selectedSub && <div/)
assert.match(teamDetailPage, /teamDetailPage\.operationsTools/)
assert.equal((teamDetailPage.match(/<AutonomousRunner/g) ?? []).length, 1)
assert.match(teamDetailPage, /streamMode onTaskSubmitted=/, 'team tasks must enter the command stream immediately')
assert.match(teamDetailPage, /team-working-message/, 'the command stream must show a live working state')
assert.match(teamDetailPage, /team-thinking-dots/, 'the working state must visibly animate without exposing private reasoning')
assert.match(teamDetailPage, /streamEndRef\.current\?\.scrollIntoView/, 'new chat activity must remain visible')
assert.match(teamDetailPage, /teamDisplayName\(\{ name:/, 'team rooms must never expose a raw creation prompt as their title')
assert.match(teamNames, /Команда роста Uzum/, 'generated Uzum teams need a short Russian customer-facing name')
assert.match(teamNames, /generatedName/, 'custom names must be preserved while generated prompt names are normalized')
assert.match(teamDetailPage, /onFastTask=/, 'simple store questions must bypass the expensive autonomous goal loop')
assert.match(teamDetailPage, /StoreSnapshotArtifact/, 'store status must render as an in-chat artifact')
assert.match(teamDetailPage, /adaptiveTeam/, 'saved teams must be able to recruit task-specific temporary subagents')
assert.match(teamDetailPage, /max-h-80 overflow-y-auto/, 'the full client-facing report must be readable inside the command stream')
assert.match(teamDetailPage, /latestRun\.kind === 'store_snapshot'/, 'saved store snapshots must reopen as dashboard artifacts')
assert.match(teamDetailPage, /platformAgents=\{\[\]\}/, 'the graph must use the normalized live team nodes rather than stale platform state')
assert.match(runner, /await onFastTask\(task, \{ hasInputArtifacts: inputArtifacts\.length > 0 \}\)/, 'the runner must support deterministic fast artifacts without bypassing attached evidence')
assert.match(storeArtifact, /action: 'status'/)
assert.match(storeArtifact, /action: 'list_skus'/)
assert.match(storeArtifact, /sold_units_7d/)
assert.match(storeArtifact, /stock_total/)
assert.doesNotMatch(storeArtifact, /dangerouslySetInnerHTML|service_role|OPENROUTER_API_KEY/)
assert.doesNotMatch(teamDetailPage, /CoordinatorAgentPanel|PlannerCommandCenter/)
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
