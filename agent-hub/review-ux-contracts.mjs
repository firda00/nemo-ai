import { readFileSync } from 'node:fs'

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')
const runner = read('src/components/platform/AutonomousRunner.tsx')
const page = read('src/pages/app/AutonomousPage.tsx')
const i18n = read('src/i18n/extra.ts')
const orchestrate = read('supabase/functions/orchestrate/index.ts')
const llm = read('supabase/functions/_shared/llm.ts')

let failed = 0
const check = (name, ok) => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`)
  if (!ok) failed++
}

const autonomousBlocks = [...i18n.matchAll(/"autonomousRunner":\s*\{([\s\S]*?)\n\s*\},\n\s*"autopostPage"/g)].map((m) => m[1])
check('all three autonomous-runner dictionaries contain escalation copy', autonomousBlocks.length === 3 && autonomousBlocks.every((b) => b.includes('"escalatedNote"') && b.includes('"escalatedBanner"')))
check('department choice preserves a non-empty user draft', page.includes("setStarterGoal((current) => current.trim() ? current : p.goal)"))
check('example choice also preserves a non-empty user draft', page.includes("setStarterGoal((current) => current.trim() ? current : e)"))
check('autonomous goal input is controlled without remounting', page.includes('goalValue={starterGoal}') && page.includes('onGoalChange={setStarterGoal}') && !page.includes("key={starterGoal || 'blank-team'}"))
check('review loop keeps the highest-scoring version', runner.includes('bestReview') && runner.includes('review.score > bestReview.score') && runner.includes('done[i].output = bestOutput'))
check('revision review receives the prior verdict', runner.includes('previous_score: previousReview?.score') && orchestrate.includes('prior verdict scored'))
check('displayed review score is monotonic while approval stays current', orchestrate.includes('Math.max(previousScore, currentScore)') && orchestrate.includes('current_score: currentScore') && orchestrate.includes('currentScore >= 80'))
check('researcher explicitly enables grounded web search', runner.includes("web_research: role === 'researcher'") && orchestrate.includes("plugins: [{ id: 'web'"))
check('web citations flow into synthesis and persistence', runner.includes('runSources.add') && runner.includes('sources: [...runSources]') && orchestrate.includes('r.citations'))
check('LLM gateway supports request-scoped plugins', llm.includes('plugins?: Array<Record<string, unknown>>') && llm.includes('{ plugins: opts.plugins }'))
check('unsupported facts and placeholders are rejected', orchestrate.includes('Never output placeholder names') && orchestrate.includes('Unsupported numbers'))

if (failed) {
  console.error(`Review/UX contracts failed: ${failed}`)
  process.exit(1)
}
console.log('Review/UX contracts passed.')
