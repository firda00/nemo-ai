import assert from 'node:assert/strict'
import fs from 'node:fs'

const read = (path) => fs.readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')
const layout = read('src/components/layout/AppLayout.tsx')
const desk = read('src/components/platform/SmartTaskDesk.tsx')
const intent = read('src/lib/smartArtifactIntent.ts')
const dashboard = read('src/pages/app/DashboardPage.tsx')
const app = read('src/App.tsx')
const translations = read('src/i18n/extra.ts')

const sidebar = layout.slice(layout.indexOf('const navGroups'), layout.indexOf('const nav ='))
const commandItems = layout.slice(layout.indexOf('const commandItems'), layout.indexOf('const commandResults'))

for (const route of ['/app', '/app/teams', '/app/settings']) {
  assert.match(sidebar, new RegExp(`to: '${route.replaceAll('/', '\\/')}'`), `${route} must remain a daily sidebar destination`)
}
assert.doesNotMatch(layout, /to: '\/app\/forge'/, 'Vibe Studio must not appear in sidebar or Command Palette')
for (const route of ['/app/content', '/app/finance', '/app/research', '/app/knowledge', '/app/analytics']) {
  const routePattern = new RegExp(`to: '${route.replaceAll('/', '\\/')}'`)
  assert.doesNotMatch(sidebar, routePattern, `${route} must not inflate the sidebar`)
  assert.doesNotMatch(layout, routePattern, `${route} must not appear in the Command Palette`)
}
assert.match(commandItems, /const commandItems = nav/, 'Command Palette must expose only active navigation')

for (const route of ['content', 'finance', 'research', 'commerce']) {
  assert.match(app, new RegExp(`path="${route}" element=\\{<Navigate to="\\/app" replace \\/>\\}`), `${route} must redirect to the chat with replace`)
}
assert.match(app, /path="forge" element=\{<Navigate to="\/app\/teams" replace \/>\}/, 'legacy Forge route must redirect to AI teams')
assert.match(app, /path="create-team" element=\{<Navigate to="\/app\?create=team" replace \/>\}/, 'legacy team form must start chat discovery')
assert.match(app, /path="create-agent" element=\{<Navigate to="\/app\?create=agent" replace \/>\}/, 'legacy agent form must start chat discovery')
assert.match(desk, /useSearchParams/, 'the chat must accept creation commands from product CTAs')
assert.match(desk, /step: 'goal' \| 'channels' \| 'format'/, 'team creation must use a three-step discovery flow')
assert.match(desk, /discoveryCopy\.goal/, 'discovery must ask for the outcome')
assert.match(desk, /discoveryCopy\.channels/, 'discovery must ask for channels and sources')
assert.match(desk, /discoveryCopy\.format/, 'discovery must ask for solo or team format')

assert.match(dashboard, /<SmartTaskDesk \/>/, 'the main workspace must mount Chat & Tasks')
assert.match(desk, /classifyTaskArtifact/, 'the chat entry point must route plain-language intents')
assert.match(intent, /finance[\s\S]*research[\s\S]*marketing/, 'intent routing must cover finance, research, and marketing')
assert.match(desk, /MarketingCampaignStudio/, 'marketing must render as a chat artifact')
assert.match(desk, /FinanceCashFlowDashboard/, 'finance must render as a chat artifact')
assert.match(desk, /ResearchNotebookHub/, 'research must render as a chat artifact')
assert.match(intent, /'browser'/, 'Uzum browser work must be recognized as an on-demand chat artifact')
assert.match(desk, /runExtensionBrowserTask/, 'the browser artifact must invoke the linked local extension')
assert.match(desk, /needsConfirmation/, 'irreversible moderation submission must retain a human gate')
assert.match(intent, /explicitlyRequestsBrowserSubmission/, 'an explicit submit instruction must not require the same approval twice')
assert.match(desk, /explicitlyRequestsBrowserSubmission\(prompt\)/, 'the chat must pass explicit submission authority to this run')
assert.match(desk, /browserTaskRuns = new Map/, 'one chat turn must never execute twice under React Strict Mode')
assert.match(desk, /expanded && kind !== 'browser'/, 'heavy artifact studios must mount only after the user opens them')
assert.match(desk, /max-h-\[760px\] overflow-auto/, 'embedded studios must stay bounded inside the conversation')

for (const locale of ['extraUz', 'extraRu', 'extraEn']) {
  assert.match(translations, new RegExp(`export const ${locale} = \\{[\\s\\S]*?"smartTaskDesk"`), `${locale} must translate Chat & Tasks`)
}

console.log('[OK] Minimal navigation and on-demand smart chat artifacts')
