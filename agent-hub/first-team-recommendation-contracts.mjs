import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8')
const factory = read('src/pages/OnboardingPage.tsx')
const recommendation = read('src/lib/firstTeamRecommendation.ts')
const migration = read('supabase/migrations/20260803130000_mandatory_onboarding.sql')

assert.match(factory, /from\('business_profiles'\)[\s\S]*\.eq\('account_id', accountId\)/, 'Factory must load only the current account profile')
assert.match(factory, /recommendFirstTeam/, 'Factory must derive its first-team blueprint from onboarding')
assert.match(factory, /actionPolicy: recommendation\?\.actionPolicy/, 'recommended safety policy must reach the agent draft')
assert.match(factory, /recommendation \? recommendation\.channels/, 'AI composition must not invent unselected channels')
assert.match(factory, /Automatic execution is unavailable/, 'Factory must describe the execution boundary')
assert.match(recommendation, /sources\.includes\('telegram'\)/)
assert.match(recommendation, /sources\.includes\('website'\)/)
assert.match(recommendation, /preserve evidence in Agent Trace/)
assert.match(migration, /using \(account_id = public\.current_account_id\(\)\)/, 'business profile reads must remain tenant scoped')

console.log('First-team recommendation contracts passed.')
