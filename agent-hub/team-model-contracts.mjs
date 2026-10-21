// Each saved specialist owns its own model. The lead model and any other
// specialist must remain untouched when the owner changes one specialist.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8')
const page = read('src/pages/app/TeamDetailPage.tsx')
assert.match(page, /interface Sub \{[^}]*model: string/, 'each specialist must expose its saved model')
assert.match(page, /const updateSubModel = async \(subId: string, model: string\)/, 'model updates must target one specialist')
assert.match(page, /from\('sub_agents'\)\.update\(\{ model \}\)\.eq\('id', subId\)\.eq\('department_id', dept\.id\)/,
  'the update must be scoped to the selected specialist and its team')
assert.doesNotMatch(page, /update\(\{ model: selectedModel \}\)\.eq\('department_id', dept\.id\)/,
  'changing one specialist must never overwrite every team member')

// The picker must offer the same registry as the rest of the product, with premium marked.
assert.match(page, /PROVIDERS\.map/, 'models come from the single shared registry')
assert.match(page, /model\.premium \? ' 💎' : ''/, 'premium models must be visibly marked')
assert.match(page, /t\('teamDetailPage\.independentModels'\)/, 'the model picker must show the localized plan-limit explanation')
assert.match(read('src/i18n/extra.ts'), /The server enforces plan limits when the team runs/, 'the explanation must retain server-side plan authority')

console.log('Team model contracts passed.')
