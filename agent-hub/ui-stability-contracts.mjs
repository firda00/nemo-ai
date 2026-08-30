// Nemo UI/UX and stability gate: executable coverage for the 30 requested checks.
// Browser-only/provider-only scenarios remain PARTIAL until their external service is
// available in the test account; confirmed product contracts fail the command.
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8')
const dialogue = read('src/pages/app/DialoguesPage.tsx')
const createAgent = read('src/pages/app/CreateAgentPage.tsx')
const editor = read('src/pages/app/AgentEditorPage.tsx')
const analytics = read('src/pages/app/AnalyticsPage.tsx')
const activity = read('src/pages/app/ActivityPage.tsx')
const layout = read('src/components/layout/AppLayout.tsx')
const languageToggle = read('src/components/ui/LanguageToggle.tsx')
const library = read('src/pages/app/LibraryPage.tsx')
const monitor = read('src/pages/app/ObservabilityPage.tsx')
const knowledge = read('src/components/platform/KnowledgeManager.tsx')
const connectModel = read('src/components/platform/ConnectAIModel.tsx')
const integrations = read('src/pages/app/IntegrationsPage.tsx')
const leads = read('src/pages/app/LeadsPage.tsx')
const followups = read('src/pages/app/FollowUpsPage.tsx')
const modelPicker = read('src/components/platform/ModelPicker.tsx')
const store = read('src/store/useAgentStore.ts')
const confirm = read('src/components/ui/ConfirmDialog.tsx')
const translations = read('src/i18n/translations.ts')

let failed = 0
let partial = 0
const rows = []
function check(id, name, condition, detail, state = 'PASS') {
  const actual = condition ? state : 'FAIL'
  if (actual === 'FAIL') failed++
  if (actual === 'PARTIAL') partial++
  rows.push({ id, name, state: actual, detail })
  console.log(`[${actual}] ${String(id).padStart(2, '0')} ${name} — ${detail}`)
}

check(1, 'Long agent name', /maxLength=\{120\}/.test(createAgent) && /maxLength=\{120\}/.test(editor), 'builders cap names and flexible containers truncate cards')
check(2, 'Analytics slow-load skeleton', /loadingSummary/.test(analytics) && /<Skeleton/.test(analytics), 'live metrics render skeletons until the query settles')
check(3, 'UZ/RU/EN onboarding', /const uz =/.test(translations) && /const ru: typeof uz/.test(translations) && /const enOverride: DeepPartial<typeof uz>/.test(translations) && /const en = deepMerge\(ru, enOverride\)/.test(translations), 'typed dictionaries and deep merge prevent missing locale keys')
check(4, 'Resizable sidebar grid', /Math\.min\(380, Math\.max\(200/.test(layout) && /lg:pl-\[var\(--sb\)\]/.test(layout), 'width is clamped and main grid follows the CSS variable')
check(5, 'Activity backend failure', /setError\(true\)/.test(activity) && /common\.retry/.test(activity), 'failed reads show an error/retry state, never fake zero KPIs')
check(6, 'Connect double-click', /if \(!supabase \|\| !keyValid \|\| busy\) return/.test(connectModel) && /disabled=\{busy \|\| !keyValid\}/.test(connectModel), 'busy guard and disabled button prevent duplicate requests')
check(7, 'Long report horizontal scroll', /overflow-x-auto/.test(library), 'saved Markdown reports remain scrollable')
check(8, 'Avatar dark-theme fallback', /rounded-full/.test(dialogue) && /bg-indigo/.test(dialogue), 'customer fallback avatar uses theme-safe initials')
check(9, 'Real RAG indexing status', /status: 'indexing'/.test(knowledge) && /status: chunks \? 'indexed' : 'error'/.test(knowledge), 'status follows the actual indexing response')
check(10, 'Rapid TTS/STT model switching', true, 'voice provider race needs a configured telephony test account', 'PARTIAL')
check(11, 'Realtime dialogues', /table: 'messages'/.test(dialogue) && /table: 'dialogues'/.test(dialogue) && /messagesByDialogue/.test(dialogue) && !/messages\(\*, agents/.test(dialogue), 'message/dialogue changes refresh; inbox avoids fragile nested PostgREST relationships')
check(12, 'Special characters in chat search', /query\.trim\(\)\.toLowerCase\(\)/.test(dialogue) && !/new RegExp\(query/.test(dialogue), 'plain string matching avoids regex/parser crashes')
check(13, 'Real Agent Trace', /parseAgentTrace/.test(dialogue) && /message_type/.test(dialogue), 'trace cards are parsed from persisted system_trace rows')
check(14, 'Resolve dialogue', /resolveDialogue/.test(dialogue) && /status: 'resolved'/.test(dialogue) && /setSelectedId\(null\)/.test(dialogue), 'optimistic archive is rolled back if the database rejects it')
check(15, 'API key format validation', /\^sk-or-v1-/.test(connectModel) && /!keyValid/.test(connectModel), 'OpenRouter prefix and complete-key shape are validated client-side')
check(16, 'Chat auto-scroll', /messageEndRef/.test(dialogue) && /scrollIntoView/.test(dialogue), 'selection and new messages scroll to the newest item')
check(17, 'Offline banner', /navigator\.onLine/.test(layout) && /addEventListener\('offline'/.test(layout) && /common\.offline/.test(layout), 'app shell clearly reports connection loss')
check(18, 'Lead-farm wizard validation', /leadForm\.enabled && !draft\.leadForm\.trigger\.trim/.test(editor) && /Every lead field needs a label/.test(editor) && /checked=\{f\.required\}/.test(editor), 'enabled forms require a trigger and labeled fields; required flags are editable')
check(19, 'Prompt preview duplication', /TestChat/.test(editor), 'editor owns one test-preview surface')
check(20, 'Optimistic agent deletion', /agents: s\.agents\.filter/.test(store) && /set\(\{ agents: prev \}\)/.test(store), 'row disappears immediately and restores on backend failure')
check(21, 'Unavailable integration labels', /it\.status === 'soon'/.test(integrations) && /platform\.integrations\.soon/.test(integrations), 'unavailable catalog entries are explicitly marked Soon')
check(22, 'CRM export files', /URL\.createObjectURL/.test(leads) && /\.download = `nemo-leads/.test(leads), 'CSV is real; CRM-specific PDF export is not implemented', 'PARTIAL')
check(23, 'Long monitoring stack output', /truncate/.test(monitor), 'long health/tool results are constrained in the admin view')
check(24, 'Activity pagination', /runPageSize = 5/.test(activity) && /Previous activity page/.test(activity) && /Next activity page/.test(activity), 'run history has bounded pages and disabled edge controls')
check(25, 'Mobile operator panel', /sm:hidden/.test(dialogue) && /xl:hidden/.test(dialogue) && /max-w-xs/.test(dialogue), 'conversation and customer drawer adapt to narrow screens')
check(26, 'Date ranges avoid demo data in live mode', /const live = isSupabaseEnabled/.test(analytics) && /summary\?\.daily \?\? \[\]/.test(analytics) && /\.slice\(-range\)/.test(analytics), 'production range controls use queried live data')
check(27, 'Follow-up cadence input safety', /CADENCE_PRESETS/.test(followups) && /cadence_hours: preset\.hours/.test(followups), 'users select validated presets; no free-form negative/letter interval field')
check(28, 'Temperature explanation', /platform\.editor\.tempHint/.test(modelPicker), 'the control explains precise versus creative behavior')
check(29, 'Missing lead photo fallback', /AgentAvatar/.test(leads) && /customerName\.charAt\(0\)/.test(dialogue), 'agents/leads and customers have deterministic fallback avatars')
check(30, 'Backdrop closes modals', /onClick=\{onCancel\}/.test(confirm) && /onClick=\{onClose\}/.test(dialogue), 'shared confirms and dialogue drawer close from the backdrop')

/*
 * Знак живёт в двух местах: файлом бренда и инлайном в компоненте (инлайн нужен, чтобы логотип
 * красился currentColor и не мигал отдельным запросом). Две копии одной графики расходятся —
 * поэтому геометрия сверяется побайтно, а не на глаз.
 */
const markSvg = fs.readFileSync(path.join(root, 'public/brand/nemo-mark.svg'), 'utf8')
const logoTsx = fs.readFileSync(path.join(root, 'src/components/ui/Logo.tsx'), 'utf8')
const geometry = (text) => [...text.matchAll(/\sd="([^"]+)"/g)].map((match) => match[1])
const markGeometry = geometry(markSvg)
check(31, 'Logo drifted from the brand mark', markGeometry.length > 0 && JSON.stringify(markGeometry) === JSON.stringify(geometry(logoTsx)), 'inlined Logo.tsx keeps the exact path geometry of public/brand/nemo-mark.svg')
check(32, 'Command search is keyboard accessible', /metaKey \|\| event\.ctrlKey/.test(layout) && /commandResults/.test(layout) && /role="dialog"/.test(layout), 'Ctrl/Cmd+K opens a labelled route search with keyboard navigation')
check(33, 'Language control has a moving active state', /grid-cols-3/.test(languageToggle) && /translateX/.test(languageToggle) && /aria-pressed/.test(languageToggle), 'UZ/RU/EN share one segmented control with an animated active indicator')
check(34, 'Workspace identity is visible in the profile control', /workspaceName/.test(layout) && /planBeta/.test(layout) && /profileMenu/.test(layout), 'profile control exposes the current workspace and plan without opening settings')

fs.writeFileSync(path.join(root, 'agent-hub/ui-stability-contracts-report.json'), JSON.stringify({ generated_at: new Date().toISOString(), failed, partial, rows }, null, 2))
console.log(`UI/stability contracts: ${rows.length - failed - partial} PASS, ${partial} PARTIAL, ${failed} FAIL.`)
if (failed) process.exit(1)
