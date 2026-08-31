import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (file) => readFileSync(path.join(root, file), 'utf8')
const sandbox = read('src/components/platform/LiveCodeSandboxArtifact.tsx')
const desk = read('src/components/platform/SmartTaskDesk.tsx')
const room = read('src/pages/app/TeamDetailPage.tsx')
const app = read('src/App.tsx')
const layout = read('src/components/layout/AppLayout.tsx')
const settings = read('src/pages/app/SettingsPage.tsx')
const translations = read('src/i18n/extra.ts')
const vercel = JSON.parse(read('vercel.json'))

for (const key of ['preview', 'code', 'console']) assert.match(sandbox, new RegExp(`(?:id|key): '${key}'`), `Live Sandbox artifact must expose ${key}`)
for (const key of ['downloadZip', 'cli']) assert.match(sandbox, new RegExp(`liveSandbox\\.${key}`), `Live Sandbox artifact must expose ${key}`)
assert.match(sandbox, /zipSync\(/, 'ZIP export must create a real archive')
assert.match(sandbox, /sandbox="allow-scripts"/, 'preview must run in an isolated iframe')
assert.match(desk, /LiveCodeSandboxArtifact/, 'main chat must render the code artifact')
assert.match(room, /isCodeCreationIntent\(latestRun\.task\)[\s\S]*LiveCodeSandboxArtifact/, 'team room must render the artifact for development runs')
assert.match(app, /path="forge" element=\{<Navigate to="\/app\/teams" replace \/>\}/, 'Forge route must redirect to teams')
assert.doesNotMatch(layout, /to: '\/app\/forge'/, 'Forge must not appear in navigation')
for (const locale of ['extraUz', 'extraRu', 'extraEn']) assert.match(translations, new RegExp(`export const ${locale} = \\{[\\s\\S]*?"liveSandbox"`), `${locale} must translate Live Sandbox`)

for (const field of ['companyContext', 'codingRules', 'communicationTone', 'forbiddenApproaches', 'workspaceName']) {
  assert.match(settings, new RegExp(`settingsPage\\.${field}`), `personalisation must include ${field}`)
}
assert.match(settings, /connect-provider[\s\S]+provider: 'github'/, 'GitHub token must use the server-side provider vault')
assert.match(settings, /ConnectAIModel/, 'OpenRouter key management must remain available')
assert.doesNotMatch(settings, /localStorage\.setItem\([^\n]*(?:github|token|api.?key)/i, 'provider secrets must never be written to localStorage')

const cliRewrite = vercel.rewrites?.find((item) => item.source === '/download/cli')
assert.equal(cliRewrite?.destination, '/nemo-cli.tgz', 'the short CLI route must serve the built archive')
const cliHeaders = vercel.headers?.find((item) => item.source === '/download/cli')?.headers ?? []
assert.ok(cliHeaders.some((item) => item.key === 'Content-Disposition' && /attachment/.test(item.value)), 'CLI route must download instead of opening as app HTML')

console.log('Live Code Sandbox, CLI route, navigation and personalization UI contracts passed')
