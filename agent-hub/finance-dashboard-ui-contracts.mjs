import assert from 'node:assert/strict'
import fs from 'node:fs'

const read = (path) => fs.readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')
const dashboard = read('src/components/finance/FinanceCashFlowDashboard.tsx')
const page = read('src/pages/app/FinancePage.tsx')
const app = read('src/App.tsx')
const layout = read('src/components/layout/AppLayout.tsx')

assert.match(app, /path="finance" element=\{<FinancePage \/>\}/, 'finance dashboard must have a dedicated route')
assert.match(layout, /to: '\/app\/finance'/, 'finance dashboard must be discoverable in the product navigation')
assert.match(page, /<FinanceCashFlowDashboard \/>/, 'finance page must mount the dashboard')
assert.match(dashboard, /CashFlowAnalyticsOutputSchema\.safeParse\(body\?\.analysis\)/, 'backend analysis must be validated with the canonical Zod schema')
assert.match(dashboard, /fetch\('\/api\/finance\/analyze-cashflow'/, 'dashboard must call the product cash-flow endpoint')
assert.match(dashboard, /Authorization: `Bearer \$\{token\}`/, 'cash-flow request must include the authenticated session')
assert.match(dashboard, /MAX_BYTES = 8 \* 1024 \* 1024/, 'ingestion must enforce the 8 MB file limit')
assert.match(dashboard, /MAX_ROWS = 10_000/, 'ingestion must enforce the 10,000-row limit')
assert.match(dashboard, /format !== 'excel_json' && format !== 'pdf_json'/, 'binary Excel/PDF must be represented by safe JSON dumps')
assert.match(dashboard, /accept="\.csv,\.json,text\/csv,application\/json"/, 'dropzone must reject raw binary formats')
assert.match(dashboard, /requires_human_approval: true/, 'recommendations must preserve the human approval invariant')
assert.match(dashboard, /decide\(draft\.id, 'approved'\)/)
assert.match(dashboard, /decide\(draft\.id, 'rejected'\)/)
assert.match(dashboard, /buildPrintableDocument/, 'order drafts must support printable PDF export')
assert.doesNotMatch(dashboard, /functions\.invoke\([^)]*(execute|publish|send|pay)/i, 'approval UI must not execute external actions')

console.log('[OK] Finance dashboard UI: grounded cash flow, safe ingestion and human-reviewed order drafts')
