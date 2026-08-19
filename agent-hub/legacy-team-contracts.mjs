import { readFileSync } from 'node:fs'
import ts from 'typescript'

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')
const legacySource = read('src/lib/legacyMarketplaceTeams.ts')
const marketplaceSource = read('src/pages/app/MarketplacePage.tsx')
const wizardSource = read('src/pages/app/EducationSalesWorkflowPage.tsx')
const persistenceSource = read('src/lib/dynamicTeams.ts')
const atomicMigration = read('supabase/migrations/20260803140000_atomic_agent_teams.sql')

const expectedCounts = new Map([
  ['sales', 4],
  ['education-admin', 5],
  ['content', 4],
  ['student-support', 3],
  ['custom', 3],
])

const checks = []
const check = (name, ok, detail = '') => checks.push([name, Boolean(ok), detail])
const propertyName = (node) => {
  if (!node?.name) return ''
  if (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name)) return node.name.text
  return node.name.getText().replace(/^['"]|['"]$/g, '')
}
const findProperty = (object, name) => object?.properties.find((property) => propertyName(property) === name)

const sourceFile = ts.createSourceFile('legacyMarketplaceTeams.ts', legacySource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
let blueprints = null
const visit = (node) => {
  if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === 'LEGACY_MARKETPLACE_TEAM_BLUEPRINTS' && node.initializer && ts.isObjectLiteralExpression(node.initializer)) {
    blueprints = node.initializer
  }
  ts.forEachChild(node, visit)
}
visit(sourceFile)

check('legacy blueprint catalog exists', blueprints)
const actualKeys = blueprints?.properties.map(propertyName).filter(Boolean) ?? []
check(
  'legacy catalog has exactly the five approved team keys',
  actualKeys.length === expectedCounts.size && [...expectedCounts.keys()].every((key) => actualKeys.includes(key)),
  `found: ${actualKeys.join(', ') || 'none'}`,
)

for (const [key, expectedCount] of expectedCounts) {
  const property = findProperty(blueprints, key)
  const blueprint = property && ts.isPropertyAssignment(property) && ts.isObjectLiteralExpression(property.initializer) ? property.initializer : null
  const specialistsProperty = findProperty(blueprint, 'specialists')
  const count = specialistsProperty && ts.isPropertyAssignment(specialistsProperty) && ts.isArrayLiteralExpression(specialistsProperty.initializer)
    ? specialistsProperty.initializer.elements.length
    : -1
  check(`${key} has the catalog specialist count`, count === expectedCount, `expected ${expectedCount}, found ${count}`)
}

for (const [title, key] of [
  ['Sales Team', 'sales'],
  ['Education Admin Team', 'education-admin'],
  ['Content Team', 'content'],
  ['Student Support Team', 'student-support'],
  ['Custom Team', 'custom'],
]) {
  check(
    `${title} is explicitly mapped to its legacy factory key`,
    new RegExp(`title:\\s*['"]${title}['"][^\\n]+legacyKey:\\s*['"]${key}['"]`).test(marketplaceSource),
  )
}

check(
  'legacy factory persists through the rollback-aware helper',
  /export\s+async\s+function\s+createLegacyMarketplaceTeam\b/.test(legacySource)
    && /saveDynamicTeam\(addAgent,[\s\S]*?\},\s*deleteAgent\)/.test(legacySource),
)
check(
  'legacy factory persists stable type and workflow markers',
  /templateKey:\s*`legacy-\$\{kind\}`/.test(legacySource)
    && /workflowMode:\s*['"]generic['"]/.test(legacySource)
    && /riskTier:\s*['"]standard['"]/.test(legacySource),
)
check(
  'sales and education admin retain lead capture',
  /enabled:\s*kind === ['"]sales['"] \|\| kind === ['"]education-admin['"]/.test(legacySource)
    && /leadForm:\s*leadCaptureForm\(kind\)/.test(legacySource),
)
check(
  'wizard creates the complete legacy team and supplies rollback',
  /const deleteAgent = useAgentStore\(\(s\) => s\.deleteAgent\)/.test(wizardSource)
    && /createLegacyMarketplaceTeam\([\s\S]*?addAgent,\s*deleteAgent,/.test(wizardSource),
)
check(
  'wizard requires both persisted lead and department before success',
  /res\.error \|\| !res\.agentId \|\| !res\.departmentId/.test(wizardSource)
    && /nemo-team-blueprint:\$\{res\.agentId\}/.test(wizardSource)
    && /departmentId:\s*res\.departmentId/.test(wizardSource),
)
check(
  'wizard never invents a local team id after persistence failure',
  !/team_\$\{Date\.now\(\)\}/.test(wizardSource)
    && /setCreateTeamError\(res\.error \?\? ['"]Could not create the complete team['"]\)/.test(wizardSource),
)
check(
  'dynamic persistence rejects failed atomic creation',
  /rpc\(['"]create_agent_team['"]/.test(persistenceSource)
    && /error \|\| !result\?\.agent_id \|\| !result\.department_id/.test(persistenceSource),
)
check(
  'manager department and specialists share one database transaction',
  /insert into public\.agents[\s\S]*insert into public\.departments[\s\S]*insert into public\.sub_agents/.test(atomicMigration)
    && /security invoker/.test(atomicMigration),
)
check(
  'edited specialist model and status are persisted',
  /model:\s*specialist\.model\?\.trim\(\) \|\| OPS_MODEL/.test(persistenceSource)
    && /status:\s*specialist\.status === ['"]inactive['"] \? ['"]paused['"] : ['"]active['"]/.test(persistenceSource),
)

let failed = 0
for (const [name, ok, detail] of checks) {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${!ok && detail ? ` (${detail})` : ''}`)
  if (!ok) failed++
}

if (failed) {
  console.error(`Legacy team contracts: ${checks.length - failed}/${checks.length} passed; ${failed} failed.`)
  process.exit(1)
}

console.log(`Legacy team contracts: ${checks.length}/${checks.length} passed.`)
