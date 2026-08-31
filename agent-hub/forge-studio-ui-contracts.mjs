import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (file) => readFileSync(path.join(root, file), 'utf8')
const forge = read('src/pages/app/ForgePage.tsx')
const settings = read('src/pages/app/SettingsPage.tsx')
const vercel = JSON.parse(read('vercel.json'))

for (const key of ['livePreview', 'fileCode', 'console', 'downloadZip', 'openCli', 'publishWeb']) {
  assert.match(forge, new RegExp(`forgePage\\.${key}`), `Forge Studio must expose ${key}`)
}
assert.match(forge, /zipSync\(/, 'ZIP export must create a real archive')
assert.match(forge, /projectFiles\(forge\.prompt, stack\)/, 'the selected stack must change exported files')
assert.match(forge, /href="\/download\/cli"/, 'Forge must expose the direct CLI download')
assert.doesNotMatch(forge, /deterministic|детерминирован|computeProfile|routingMode/, 'internal orchestration vocabulary must stay out of Forge UI')

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

console.log('Forge Studio, CLI route and personalization UI contracts passed')
