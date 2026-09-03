import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8')
const widget = read('src/components/platform/FeedbackWidget.tsx')
const telemetry = read('src/lib/telemetry.ts')
const adminApi = read('supabase/functions/admin-api/index.ts')
const adminPage = read('src/pages/app/AdminPage.tsx')
const adminGate = read('src/components/auth/AdminMfaGate.tsx')
const setup = read('src/pages/SetupPage.tsx')
const migration = read('supabase/migrations/20260903103000_feedback_workflow.sql')

assert.match(widget, /agent_quality.*speed.*technical.*billing.*onboarding.*other/s, 'complaints must capture an actionable topic')
assert.match(widget, /contactRequested/, 'the user must control whether support may contact them')
assert.match(widget, /result\.id\?\.slice/, 'a submitted complaint must show a reference number')
assert.match(telemetry, /contact_requested: options\.contactRequested === true/, 'contact consent must be persisted explicitly')
assert.match(migration, /status text not null default 'new'/, 'feedback starts in the admin queue')
assert.match(migration, /'new', 'reviewing', 'resolved'/, 'feedback workflow statuses must be constrained')
assert.match(adminApi, /action === 'update_feedback_status'/, 'admins must be able to progress a complaint')
assert.match(adminPage, /Взять в работу.*Отметить решённым/s, 'the admin UI must expose complaint workflow actions')
assert.match(adminPage, /activeSection === 'feedback'/, 'admin modules must render as focused tabs instead of one long page')
assert.match(adminPage, /feedbackSearch.*feedbackFilter/s, 'the complaint queue must be searchable and filterable')
assert.match(adminPage, /visibleAccounts.*accountPlan/s, 'the account table must support focused search and plan filtering')
assert.match(adminPage, /runningAgents = moderatedAgents\.length > 0 \? activeAgents : totalAgents/, 'agent KPI must fall back to the authoritative account total')
assert.match(adminPage, /list_onboarding.*Ответы онбординга/s, 'completed onboarding answers must be visible to administrators')
assert.match(adminPage, /nemo:admin-reauth-required/, 'expired protected admin sessions must request reauthentication')
assert.match(adminGate, /addEventListener\('nemo:admin-reauth-required'/, 'the admin gate must relock when a protected session expires')
assert.match(setup, /sessionStorage\.setItem\('nemo\.setup\.draft'/, 'onboarding answers must survive an accidental refresh')
assert.match(setup, /<FeedbackWidget \/>/, 'users must be able to report an onboarding problem without leaving setup')

console.log('Feedback and onboarding workflow contracts passed.')
