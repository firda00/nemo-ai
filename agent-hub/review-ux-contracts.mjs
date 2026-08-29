import { readFileSync } from 'node:fs'

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')
const runner = read('src/components/platform/AutonomousRunner.tsx')
const page = read('src/pages/app/AutonomousPage.tsx')
const i18n = read('src/i18n/extra.ts')
const orchestrate = read('supabase/functions/orchestrate/index.ts')
const llm = read('supabase/functions/_shared/llm.ts')
const contentNav = read('src/components/platform/ContentSalesNav.tsx')
const contentPage = read('src/pages/app/ContentStudioPage.tsx')
const autopostPage = read('src/pages/app/AutopostPage.tsx')
const followupsPage = read('src/pages/app/FollowUpsPage.tsx')
const coordinator = read('src/components/platform/CoordinatorAgentPanel.tsx')
const dashboard = read('src/pages/app/DashboardPage.tsx')
const companyBrain = read('src/pages/app/CompanyBrainPage.tsx')
const appLayout = read('src/components/layout/AppLayout.tsx')

let failed = 0
const check = (name, ok) => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`)
  if (!ok) failed++
}

// \r?\n: working-tree files may be CRLF on Windows (core.autocrlf), LF in CI
const autonomousBlocks = [...i18n.matchAll(/"autonomousRunner":\s*\{([\s\S]*?)\r?\n\s*\},\r?\n\s*"autopostPage"/g)].map((m) => m[1])
check('all three autonomous-runner dictionaries contain concise progress and result-location copy', autonomousBlocks.length === 3 && autonomousBlocks.every((b) => b.includes('"workingHint"') && b.includes('"resultLocation"') && b.includes('"saveAndOpen"')))
check('department choice replaces the generated prompt for the newly selected department', page.includes('setStarterGoal(p.goal[templateLanguage])'))
check('example choice replaces the generated prompt predictably', page.includes('setStarterGoal(e)'))
check('autonomous goal input is controlled without remounting', page.includes('goalValue={starterGoal}') && page.includes('onGoalChange={setStarterGoal}') && !page.includes("key={starterGoal || 'blank-team'}"))
check('review loop keeps the highest-scoring version', runner.includes('bestReview') && runner.includes('review.score > bestReview.score') && runner.includes('done[i].output = bestOutput'))
check('create-team UI hides internal agent reviews and exposes a focused progress stage', runner.includes('team-run-stage') && !runner.includes("t('autonomousRunner.reviewedBy'") && !runner.includes("t('autonomousRunner.escalatedBanner'") && page.includes('builderMode'))
check('internal peer-review disagreement does not create a fake customer approval gate', runner.includes('needsHumanReview: false') && orchestrate.includes('Show only the client-facing deliverable'))
check('revision review receives the prior verdict', runner.includes('previous_score: previousReview?.score') && orchestrate.includes('prior verdict scored'))
check('displayed review score is monotonic while approval stays current', orchestrate.includes('Math.max(previousScore, currentScore)') && orchestrate.includes('current_score: currentScore') && orchestrate.includes('currentScore >= 80'))
check('researcher explicitly enables grounded web search', runner.includes("web_research: role === 'researcher'") && orchestrate.includes("plugins: [{ id: 'web'"))
check('web citations flow into synthesis and persistence', runner.includes('runSources.add') && runner.includes('sources: [...runSources]') && orchestrate.includes('r.citations'))
check('LLM gateway supports request-scoped plugins', llm.includes('plugins?: Array<Record<string, unknown>>') && llm.includes('{ plugins: opts.plugins }'))
check('unsupported facts and placeholders are rejected', orchestrate.includes('Never output placeholder names') && orchestrate.includes('Unsupported numbers'))
check('content, autoposting and funnel share reversible navigation', contentNav.includes('/app/content') && contentNav.includes('/app/autopost') && contentNav.includes('/app/followups') && contentPage.includes('ContentSalesNav') && autopostPage.includes('ContentSalesNav') && followupsPage.includes('ContentSalesNav'))
check('coordinator is compact by default and expands workflow stages on demand', coordinator.includes('const [expanded, setExpanded]') && coordinator.includes('aria-expanded={expanded}') && coordinator.includes('line-clamp-2'))
check('dashboard always exposes separate team and standalone-agent counts', dashboard.includes('standaloneAgents') && dashboard.includes("mvp.dashboard.activeAgents"))
check('business profile collects company email and employee count without showing Google Sheet setup', companyBrain.includes("'company_email'") && companyBrain.includes("'employee_count'") && !/FIELDS[\s\S]{0,220}tasks_sheet_id/.test(companyBrain))
check('collapsed desktop sidebar keeps the compact Nemo mark', appLayout.includes('showWordmark={false}') && appLayout.includes("'--sb': collapsed ? '64px'"))

if (failed) {
  console.error(`Review/UX contracts failed: ${failed}`)
  process.exit(1)
}
console.log('Review/UX contracts passed.')
