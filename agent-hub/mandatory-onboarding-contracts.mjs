import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8')
const app = read('src/App.tsx')
const setup = read('src/pages/SetupPage.tsx')
const api = read('supabase/functions/complete-onboarding/index.ts')
const migration = read('supabase/migrations/20260803130000_mandatory_onboarding.sql')

assert.match(app, /!user\?\.onboardingCompleted[\s\S]*Navigate to="\/setup"/, 'incomplete users must be gated into setup')
assert.match(app, /path="\/privacy"/)
assert.match(app, /path="\/terms"/)
assert.match(setup, /\[1,2,3\]/, 'setup must use three short business-first steps')
assert.match(setup, /form\.accept_privacy && form\.accept_terms/, 'legal acceptance must be required')
assert.match(setup, /Рассылки необязательны/, 'marketing consent must remain optional')
assert.match(api, /body\.accept_privacy !== true \|\| body\.accept_terms !== true/, 'the server must enforce legal acceptance')
assert.match(api, /eq\('id', user\.id\)/, 'onboarding must resolve the authenticated user account')
assert.match(migration, /revoke all on public\.user_consents from anon, authenticated/, 'consent records must be service-written')
console.log('Mandatory onboarding contracts passed.')
