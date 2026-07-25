import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate'
import {
  artifactHandoffContext,
  boundedArtifact,
  marketplaceInputMissing,
  MAX_AUTONOMOUS_TOTAL_CHARS,
} from '../src/lib/autonomousInputs.ts'
import {
  analyzeMarketplaceText,
  calculateMarketplaceRows,
  marketplaceEvidenceBlock,
} from '../supabase/functions/_shared/marketplaceData.ts'
import { repairXlsxDimensions } from '../src/lib/xlsxDimensions.ts'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8')

assert.equal(
  marketplaceInputMissing('Проанализируй продажи и рассчитай закупку товаров Uzum на неделю', []),
  true,
  'data-dependent Uzum work must stop before spending tokens without source data',
)
assert.equal(
  marketplaceInputMissing('Напиши описание карточки товара Uzum на русском и узбекском', []),
  false,
  'a grounded writing task must not be blocked when it does not request factual sales calculations',
)
assert.equal(
  marketplaceInputMissing('Моя цель — увеличить продажи на маркетплейсе Uzum', []),
  false,
  'a marketplace growth goal must launch a strategy team without requiring a sales export',
)
assert.equal(
  marketplaceInputMissing('Проанализируй продажи и остатки на маркетплейсе Uzum', []),
  true,
  'an explicit factual marketplace analysis must still require source data',
)
assert.equal(
  marketplaceInputMissing(
    'Проанализируй продажи Uzum',
    [{ name: 'sales.csv', content: 'sku,sales\nA,10', originalChars: 14, truncated: false }],
  ),
  false,
  'an attached marketplace export satisfies the preflight',
)

const bounded = boundedArtifact('sales.csv', 'x'.repeat(MAX_AUTONOMOUS_TOTAL_CHARS + 100), MAX_AUTONOMOUS_TOTAL_CHARS)
assert.ok(bounded)
assert.equal(bounded.content.length, 24_000)
assert.equal(bounded.truncated, true)

const handoff = artifactHandoffContext([
  { name: 'Planner', role: 'lead', output: 'plan' },
  { name: 'Analyst', role: 'analyst', output: 'analysis' },
])
assert.match(handoff, /HANDOFF 1: Planner/)
assert.match(handoff, /HANDOFF 2: Analyst/)

const marketplaceRows = calculateMarketplaceRows(
  'sku,sales_7d,stock,cost,price,fee_percent,lead_time_days\n' +
  'UZ-001,14,5,50000,79000,15,3\n' +
  'UZ-002,3,40,70000,99000,15,5',
)
assert.equal(marketplaceRows.length, 2)
assert.deepEqual(
  {
    target: marketplaceRows[0].baselineTargetUnits,
    baseline: marketplaceRows[0].baselineReorderUnits,
    final: marketplaceRows[0].reorderUnits,
  },
  { target: 20, baseline: 15, final: null },
  'server calculation must produce a baseline of 15 and never invent safety stock',
)
assert.equal(marketplaceRows[0].missing.includes('safety_stock'), true)
assert.equal(marketplaceRows[1].baselineTargetUnits, 6)
assert.equal(marketplaceRows[1].baselineReorderUnits, 0)
assert.equal(marketplaceRows[1].stockCoverDays, 93.3)
assert.equal(marketplaceRows[1].classification, 'clear')
assert.match(marketplaceEvidenceBlock('sku,sales_7d,stock,lead_time_days\nA,14,5,3'), /SERVER-CALCULATED/)

// Regression: a real export names its columns in prose and ships as a Markdown table.
// This exact shape (velocity 6/day, 6-day lead, 12 on hand) is what produced the published
// "77.22 - 12 = 65.22, rounded to 78" contradiction when the parser silently gave up and
// the specialist did the arithmetic in prose. The deterministic answer is 66, and integral.
const pipeTable = analyzeMarketplaceText(
  '| SKU | Продажи за 7 дней | Остаток на складе | Срок поставки, дней |\n' +
  '|---|---|---|---|\n' +
  '| A-1 | 42 | 12 | 6 |\n' +
  '| A-2 | 0 | 30 | 6 |',
)
assert.equal(pipeTable.status, 'calculated', 'a Markdown table with prose headers must still be parsed')
assert.equal(pipeTable.rows.length, 2)
assert.equal(pipeTable.rows[0].baselineTargetUnits, 78)
assert.equal(pipeTable.rows[0].baselineReorderUnits, 66, 'target 78 minus 12 on hand is 66, never 78')
assert.equal(Number.isInteger(pipeTable.rows[0].baselineReorderUnits), true)
assert.equal(pipeTable.rows[0].reorderUnits, null, 'a purchase-ready quantity needs a supplied safety stock')
assert.equal(pipeTable.rows[1].classification, 'pause', 'stock with zero sales must not be reordered')
assert.deepEqual(
  pipeTable.looseColumns.slice().sort(),
  ['sales7d', 'stock'],
  'columns matched by meaning rather than canonical name must be reported as assumptions',
)
assert.match(marketplaceEvidenceBlock('| SKU | Продажи за 7 дней | Остаток |\n| A-1 | 42 | 12 |'), /LOOSELY MATCHED COLUMNS/)

// Regression: the production failure was a ONE-LINE paste — canonical headers, comma
// delimiter, zero newlines, which is what Telegram, chat and a plain textarea all produce.
// The line-splitter found the header and no rows, and the silent no_table path let the
// specialist do purchase arithmetic in prose. Rows must be rebuilt from the column count.
const oneLine = analyzeMarketplaceText(
  'Составь план закупки на 14 дней. Данные: sku,sales_7d,stock,cost,price,lead_time_days ' +
  'A-1,30,12,40000,65000,4 A-2,2,90,70000,99000,6 A-3,14,5,50000,79000,3',
)
assert.equal(oneLine.status, 'calculated', 'a single-line paste must not fall through to silence')
assert.equal(oneLine.rows.length, 3, 'all three SKUs must be recovered from one line')
assert.equal(oneLine.rows[0].sku, 'A-1', 'the leading prose must not leak into the first SKU')
assert.equal(oneLine.rows[0].baselineTargetUnits, 48)
assert.equal(oneLine.rows[0].baselineReorderUnits, 36, 'ceil(30/7*11) = 48, minus 12 on hand = 36')
assert.equal(oneLine.rows[1].classification, 'clear')
assert.equal(oneLine.rows[2].baselineReorderUnits, 15)

// Trailing prose after a recovered table must end the table, not become a row.
const oneLineWithTail = analyzeMarketplaceText(
  'Данные: sku,sales_7d,stock,lead_time_days A-1,30,12,4 A-2,14,5,3 и подготовь план на неделю',
)
assert.equal(oneLineWithTail.status, 'calculated')
assert.equal(oneLineWithTail.rows.length, 2, 'words after the last row must not be parsed as data')

// Whatever the shape, a request carrying numbers must never take the silent path.
const truncatedPaste = analyzeMarketplaceText(
  'план закупки на 14 дней. Данные: sku,sales_7d,stock,cost,price,lead_time_days A-1,30,12,40000,65000,4 A-2,2,90,',
)
assert.notEqual(truncatedPaste.status, 'no_table', 'silence is only legitimate for a request with no data at all')
assert.equal(
  truncatedPaste.status === 'calculated' || marketplaceEvidenceBlock(
    'план закупки на 14 дней. Данные: sku,sales_7d,stock,cost,price,lead_time_days A-1,30,12,40000,65000,4 A-2,2,90,',
  ).includes('NOT SERVER-VERIFIED'),
  true,
  'a partially readable paste must either compute or say the numbers are unverified',
)

// A header the mapper cannot read must fail LOUDLY — the silent empty block is what let
// unverified arithmetic reach the client as a purchase decision.
const unreadable = analyzeMarketplaceText(
  'Проанализируй ассортимент и рассчитай закупку\n' +
  'Позиция;Оборот за месяц;Доля\n' +
  'Кресло;12000000;18\n' +
  'Стол;7400000;11',
)
assert.equal(unreadable.status, 'unparsed', 'an unmappable table must not degrade to silence')
assert.equal(unreadable.rows.length, 0)
assert.match(
  marketplaceEvidenceBlock(
    'Проанализируй ассортимент и рассчитай закупку\nПозиция;Оборот;Доля\nКресло;12000000;18\nСтол;7400000;11',
  ),
  /NUMBERS ARE NOT SERVER-VERIFIED[\s\S]*purchase-ready/,
  'an unreadable table must forbid purchase-ready quantities explicitly',
)
assert.equal(
  analyzeMarketplaceText('Составь план роста продаж на маркетплейсе на 90 дней').status,
  'no_table',
  'a pure strategy goal must stay silent instead of warning about numbers it was never given',
)
assert.equal(marketplaceEvidenceBlock('Составь план роста продаж на маркетплейсе на 90 дней'), '')

// "Закупочная цена" must resolve to cost, not price, or the margin flips sign.
const costPriceTable = analyzeMarketplaceText(
  'Артикул,Продажи за 7 дней,Остаток,Закупочная цена,Цена продажи,Комиссия %,Срок поставки дней\n' +
  'B-1,14,5,50000,79000,15,3',
)
assert.equal(costPriceTable.status, 'calculated')
assert.equal(costPriceTable.rows[0].unitMarginBeforeAdsAndFulfillment, 17150, '79000 - 50000 - 15% of 79000')

const runner = read('src/components/platform/AutonomousRunner.tsx')
const extractor = read('src/lib/extractText.ts')
const orchestrator = read('supabase/functions/orchestrate/index.ts')
const migration = read('supabase/migrations/20260723143000_sub_agent_capability_skills.sql')

assert.match(
  extractor,
  /\.readSheet as \([\s\S]*input: File \| Blob \| ArrayBuffer[\s\S]*Promise<unknown\[\]\[\]>/,
  'XLSX uploads must use the current read-excel-file single-sheet API',
)
assert.doesNotMatch(
  extractor,
  /\.default as \(input: File\) => Promise<unknown\[\]\[\]>/,
  'the v9 default export returns sheet objects and must not be treated as rows',
)
assert.equal(
  typeof repairXlsxDimensions,
  'function',
  'malformed official exports must have their worksheet dimension repaired before parsing',
)
const malformedXlsx = zipSync({
  'xl/worksheets/sheet1.xml': strToU8(
    '<worksheet><dimension ref="A1"/><sheetData><row r="1"><c r="A1"/></row><row r="3"><c r="D3"/></row></sheetData></worksheet>',
  ),
})
const repairedArchive = unzipSync(repairXlsxDimensions(malformedXlsx.buffer))
assert.match(
  strFromU8(repairedArchive['xl/worksheets/sheet1.xml']),
  /<dimension ref="A1:D3"\/>/,
  'Uzum-style A1 metadata must expand to the real last cell',
)
assert.match(runner, /use_skills: true/)
assert.match(runner, /input_artifacts: inputArtifacts/)
assert.match(runner, /marketplacePlanningWithoutData/)
assert.doesNotMatch(
  runner,
  /if \(marketplaceInputMissing\([^)]*\)\) \{[\s\S]{0,200}return/,
  'missing marketplace data must warn and create the team instead of blocking it',
)
assert.match(runner, /skills: created\[i\]\.skills/)
assert.match(runner, /artifactHandoffContext\(done\)/)
assert.match(runner, /author_task: done\[i\]\.prompt\.tasks/)
assert.doesNotMatch(runner, /ctx\.slice\(-4000\)/)
assert.match(orchestrator, /orchestrationSkillCatalog\(\)/)
assert.match(orchestrator, /marketplace-growth-manager/)
assert.match(orchestrator, /artifactContext\(artifacts/)
assert.match(orchestrator, /marketplaceEvidence\(goal, artifacts\)/)
assert.equal(
  (orchestrator.match(/marketplaceEvidence\(goal, artifacts\)/g) ?? []).length,
  3,
  'work, review and synth must each receive the evidence — never gated on which skills the architect happened to assign',
)
assert.match(
  orchestrator,
  /ARITHMETIC CHECK[\s\S]{0,400}CRITICAL accuracy failure/,
  'the reviewer must recompute stated arithmetic instead of judging the formula by taste',
)
assert.match(orchestrator, /server-calculated values as the numeric source of truth/)
assert.match(orchestrator, /Nemo does not have a verified production Uzum executor/)
assert.match(orchestrator, /prioritized 7-day experiment plan/)
assert.match(orchestrator, /NO SOURCE DATA IS ATTACHED/)
assert.match(orchestrator, /Do not require this author to perform work explicitly assigned to a downstream specialist/)
assert.match(orchestrator, /\.slice\(-18_000\)/)
assert.match(migration, /skills jsonb not null default '\[\]'/)

console.log('Autonomous input behavior passed: preflight, bounded files, skills and structured handoffs are wired.')
