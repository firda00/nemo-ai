import { readFileSync } from 'node:fs'
import ts from 'typescript'

const expectedKeys = [
  'local-services',
  'real-estate',
  'b2b-sales',
  'restaurant-catering',
  'hotel-tourism',
  'hr-recruiting',
  'clinic-front-desk',
  'construction-procurement',
  'agriculture-distribution',
  'accounting-collections',
  'legal-office',
  'insurance-operations',
]

const checks = []
const check = (name, ok, detail = '') => checks.push([name, Boolean(ok), detail])
const propertyName = (node) => {
  if (!node?.name) return ''
  if (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name) || ts.isNumericLiteral(node.name)) return node.name.text
  return node.name.getText().replace(/^['"]|['"]$/g, '')
}
const findProperty = (object, name) => object?.properties.find((property) => propertyName(property) === name)
const asObject = (property) => property && ts.isPropertyAssignment(property) && ts.isObjectLiteralExpression(property.initializer) ? property.initializer : null
const sourceText = (node, sourceFile) => node ? node.getText(sourceFile).toLowerCase() : ''

let source = ''
let marketplaceSource = ''
let teamDetailSource = ''
let persistenceSource = ''
let connectTelegramSource = ''
let connectChannelSource = ''
let setupTelegramSource = ''
let setupMetaSource = ''
let telegramProcessSource = ''
let whatsappProcessSource = ''
let instagramProcessSource = ''
let widgetSource = ''
let operatorSendSource = ''
let followUpSource = ''
let riskPolicySource = ''
let agentStoreSource = ''
let riskMigrationSource = ''
let channelGrantMigrationSource = ''
let deploySource = ''
try {
  source = readFileSync(new URL('../src/lib/industryTeams.ts', import.meta.url), 'utf8')
  marketplaceSource = readFileSync(new URL('../src/pages/app/MarketplacePage.tsx', import.meta.url), 'utf8')
  teamDetailSource = readFileSync(new URL('../src/pages/app/TeamDetailPage.tsx', import.meta.url), 'utf8')
  persistenceSource = readFileSync(new URL('../src/lib/ustudyTeam.ts', import.meta.url), 'utf8')
  connectTelegramSource = readFileSync(new URL('../supabase/functions/connect-telegram/index.ts', import.meta.url), 'utf8')
  connectChannelSource = readFileSync(new URL('../supabase/functions/connect-channel/index.ts', import.meta.url), 'utf8')
  setupTelegramSource = readFileSync(new URL('../supabase/functions/setup-telegram/index.ts', import.meta.url), 'utf8')
  setupMetaSource = readFileSync(new URL('../supabase/functions/setup-meta/index.ts', import.meta.url), 'utf8')
  telegramProcessSource = readFileSync(new URL('../supabase/functions/_shared/tgProcess.ts', import.meta.url), 'utf8')
  whatsappProcessSource = readFileSync(new URL('../supabase/functions/_shared/waProcess.ts', import.meta.url), 'utf8')
  instagramProcessSource = readFileSync(new URL('../supabase/functions/_shared/igProcess.ts', import.meta.url), 'utf8')
  widgetSource = readFileSync(new URL('../supabase/functions/widget-webhook/index.ts', import.meta.url), 'utf8')
  operatorSendSource = readFileSync(new URL('../supabase/functions/operator-send/index.ts', import.meta.url), 'utf8')
  followUpSource = readFileSync(new URL('../supabase/functions/follow-up/index.ts', import.meta.url), 'utf8')
  riskPolicySource = readFileSync(new URL('../supabase/functions/_shared/riskPolicy.ts', import.meta.url), 'utf8')
  agentStoreSource = readFileSync(new URL('../src/store/useAgentStore.ts', import.meta.url), 'utf8')
  riskMigrationSource = readFileSync(new URL('../supabase/migrations/20260711200000_industry_risk_policy.sql', import.meta.url), 'utf8')
  channelGrantMigrationSource = readFileSync(new URL('../supabase/migrations/20260711210000_channel_safe_read_columns.sql', import.meta.url), 'utf8')
  deploySource = readFileSync(new URL('../deploy.ps1', import.meta.url), 'utf8')
} catch (error) {
  console.error(`FAIL industry team sources are readable: ${error.code ?? error.message}`)
  process.exit(1)
}

const sourceFile = ts.createSourceFile('industryTeams.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
let blueprintObject = null
const visit = (node) => {
  if (ts.isObjectLiteralExpression(node)) {
    const names = new Set(node.properties.map(propertyName))
    if (expectedKeys.every((key) => names.has(key))) blueprintObject = node
  }
  if (!blueprintObject) ts.forEachChild(node, visit)
}
visit(sourceFile)

check('industry blueprint object exists', blueprintObject)
const actualKeys = blueprintObject?.properties.map(propertyName).filter(Boolean) ?? []
check(
  'exactly the 12 approved industry keys exist',
  actualKeys.length === expectedKeys.length && expectedKeys.every((key) => actualKeys.includes(key)),
  `found: ${actualKeys.join(', ') || 'none'}`,
)

const block = (key) => sourceText(asObject(findProperty(blueprintObject, key)), sourceFile)

for (const key of expectedKeys) {
  const blueprint = asObject(findProperty(blueprintObject, key))
  const specialists = findProperty(blueprint, 'specialists')
  const count = specialists && ts.isPropertyAssignment(specialists) && ts.isArrayLiteralExpression(specialists.initializer)
    ? specialists.initializer.elements.length
    : -1
  check(`${key} has exactly 5 specialists`, count === 5, `found ${count < 0 ? 'no specialists array' : count}`)
}

const regulatedKeys = new Set(['hr-recruiting', 'clinic-front-desk', 'accounting-collections', 'legal-office', 'insurance-operations'])
for (const key of expectedKeys) {
  check(
    `${key} has the expected risk tier`,
    new RegExp(`riskTier\\s*:\\s*['"]${regulatedKeys.has(key) ? 'regulated' : 'standard'}['"]`, 'i').test(block(key)),
  )
}

const hotel = block('hotel-tourism')
check('hotel-tourism explicitly supports multilingual guests', /multilingual|multiple languages|guest language|input language/.test(hotel))
check('hotel-tourism treats reservations as booking requests', /booking.{0,60}request|reservation request|preliminary booking/.test(hotel))
check(
  'hotel-tourism does not autonomously confirm bookings',
  /human approval|human confirmation|requires approval|never confirm|do not confirm|request only/.test(hotel)
    && /availability|reservation|booking/.test(hotel),
)

const safetyContracts = [
  ['clinic-front-desk', /diagnos|medical advice|emergency|clinical decision/],
  ['legal-office', /legal advice|lawyer|attorney|court|filing/],
  ['hr-recruiting', /hir(e|ing)|reject|discrimin|protected characteristic|employment decision/],
  ['accounting-collections', /payment|write-off|tax|bank|financial transaction/],
  ['insurance-operations', /claim|coverage|underwriting|payout|policy decision/],
]
for (const [key, safetyPattern] of safetyContracts) {
  const text = block(key)
  check(
    `${key} keeps consequential actions under human approval`,
    /human approval|human review|requires approval|approved by a human/.test(text),
  )
  check(`${key} declares domain safety boundaries`, safetyPattern.test(text) && /never|must not|do not|cannot|only/.test(text))
}

check('industry teams persist through saveDynamicTeam', /saveDynamicTeam\s*\(\s*addAgent\s*,\s*(?:bp|blueprint|opts)\s*,\s*deleteAgent\s*\)/.test(source))
check('industry team factory uses workflowMode generic', /workflowMode\s*:\s*['"]generic['"]/.test(source))
check('industry team factory is exported', /export\s+async\s+function\s+createIndustryTeam\b/.test(source))
check(
  'all industry templates are exposed in the catalog',
  expectedKeys.every((key) => marketplaceSource.includes(`industryKey: '${key}'`)),
)
check(
  'catalog creates only complete persisted industry teams',
  /createIndustryTeam\(tpl\.industryKey, addAgent, deleteAgent, \{ name: localized\.title, niche: localized\.market \}\)/.test(marketplaceSource)
    && /!res\.error && res\.agentId && res\.departmentId/.test(marketplaceSource),
)
check(
  'localized industry name and niche are persisted',
  /localization\?\.name/.test(source) && /localization\?\.niche/.test(source)
    && /const localized = localizeTemplate/.test(marketplaceSource),
)
check(
  'catalog has industry search and category filters',
  /type="search"/.test(marketplaceSource) && /setCategory\(item\.id\)/.test(marketplaceSource),
)
check(
  'regulated filter includes HR',
  /industryKey: 'hr-recruiting'/.test(marketplaceSource)
    && /secondaryCategories: \['regulated'\]/.test(marketplaceSource)
    && /secondaryCategories\?\.includes\(category\)/.test(marketplaceSource),
)
check(
  'generic workflow marker prevents accidental planerka routing',
  /nemo-workflow:\(generic\|operations\|logistics\)/.test(teamDetailSource)
    && /!explicitWorkflowMode && !isCommerceWorkspace/.test(teamDetailSource),
)
check(
  'regulated teams persist an explicit risk marker',
  /nemo-risk:\$\{opts\.riskTier \?\? 'standard'\}/.test(persistenceSource)
    && /riskTier: blueprint\.riskTier/.test(source)
    && /riskTier: opts\.riskTier \?\? 'standard'/.test(persistenceSource),
)
check(
  'risk tier is persisted as a dedicated agent column',
  /risk_tier: a\.riskTier \?\? 'standard'/.test(agentStoreSource)
    && /riskTier: row\.risk_tier === 'regulated'/.test(agentStoreSource)
    && /template_key: a\.templateKey/.test(agentStoreSource)
    && /add column if not exists risk_tier/.test(riskMigrationSource)
    && /add column if not exists template_key/.test(riskMigrationSource),
)
check(
  'database classifies immutable regulated template identities',
  /templateKey: kind/.test(source)
    && /new\.template_key in \([\s\S]*?'clinic-front-desk'/.test(riskMigrationSource)
    && /new\.risk_tier := 'regulated'/.test(riskMigrationSource)
    && /agent template key cannot be changed or removed/.test(riskMigrationSource),
)
check(
  'regulated teams cannot connect live Telegram channels in the team hub',
  /team\?\.riskTier === 'regulated'/.test(teamDetailSource)
    && /Live channel connection is blocked in this beta/.test(teamDetailSource)
    && /isRegulated \? \(/.test(teamDetailSource),
)
check(
  'regulated channel policy is enforced by every setup endpoint',
  [connectTelegramSource, connectChannelSource, setupTelegramSource, setupMetaSource].every((text) => (
    /isRegulatedAgent/.test(text) && /REGULATED_CHANNEL_BLOCKED/.test(text) && /403/.test(text)
  )),
)
check(
  'every live channel processor stops regulated agents',
  [telegramProcessSource, whatsappProcessSource, instagramProcessSource, widgetSource].every((text) => (
    /isRegulatedAgent\(agent\)/.test(text) && /status: 'safety_blocked'/.test(text)
  )),
)
check(
  'operator delivery is blocked before persisting or sending a regulated reply',
  /isRegulatedAgent\(dialogueAgent\)/.test(operatorSendSource)
    && /REGULATED_CHANNEL_BLOCKED/.test(operatorSendSource)
    && operatorSendSource.indexOf('isRegulatedAgent(dialogueAgent)') < operatorSendSource.indexOf("from('messages').insert"),
)
check(
  'human takeover has Telegram, WhatsApp, Instagram and widget delivery paths',
  /dialogue\.channel === 'widget'/.test(operatorSendSource)
    && /tgSend\(/.test(operatorSendSource)
    && /waSend\(/.test(operatorSendSource)
    && /igSend\(/.test(operatorSendSource)
    && /channel\?\.status === 'connected'/.test(operatorSendSource)
    && /channel\?\.agent_id === dialogue\.agent_id/.test(operatorSendSource)
    && /channel\?\.type === dialogue\.channel/.test(operatorSendSource),
)
check(
  'database blocks direct channel inserts for regulated agents',
  /create trigger channels_regulated_agent_guard/.test(riskMigrationSource)
    && /before insert or update of agent_id, status, credentials/.test(riskMigrationSource)
    && /target_tier = 'regulated'/.test(riskMigrationSource)
    && /for update/.test(riskMigrationSource)
    && /errcode = '42501'/.test(riskMigrationSource),
)
check(
  'regulated risk tier cannot be downgraded and channels are quarantined reversibly',
  /old\.risk_tier = 'regulated' and new\.risk_tier <> 'regulated'/.test(riskMigrationSource)
    && /create trigger agents_risk_tier_guard/.test(riskMigrationSource)
    && /agent\?\.risk_tier === 'regulated'/.test(riskPolicySource)
    && /status = 'safety_blocked'/.test(riskMigrationSource)
    && /quarantined_credentials/.test(riskMigrationSource)
    && /credentials = '\{\}'::jsonb/.test(riskMigrationSource)
    && !/delete from public\.channels/.test(riskMigrationSource),
)
check(
  'scheduled outbound cannot reuse quarantined credentials',
  /or new\.credentials <> '\{\}'::jsonb/.test(riskMigrationSource)
    && /before insert or update of agent_id, status, credentials/.test(riskMigrationSource)
    && /stopped_regulated_agent/.test(followUpSource)
    && /isRegulatedAgent\(sourceAgent\)/.test(followUpSource)
    && /isRegulatedAgent\(dialogueAgent\)/.test(followUpSource),
)
check(
  'browser can read only non-secret channel metadata',
  /grant select \([\s\S]*?sub_agent_id[\s\S]*?scope[\s\S]*?label[\s\S]*?\) on public\.channels to anon, authenticated/i.test(channelGrantMigrationSource)
    && !/grant select \([\s\S]*?credentials[\s\S]*?\) on public\.channels/i.test(channelGrantMigrationSource)
    && /revoke select on public\.channels from anon, authenticated/i.test(channelGrantMigrationSource),
)
check(
  'regulated channel guards are included in deployment',
  ['connect-telegram', 'connect-channel', 'setup-telegram', 'setup-meta', 'telegram-webhook', 'whatsapp-webhook', 'instagram-webhook', 'widget-webhook', 'agent-worker', 'operator-send']
    .every((name) => deploySource.includes(`'${name}'`))
    && /20260711200000_industry_risk_policy\.sql/.test(deploySource)
    && /20260711210000_channel_safe_read_columns\.sql/.test(deploySource),
)
check(
  'deployment fails closed on function or verification failure',
  /if \(-not \$ok\) \{ \$failed \+= "verify:\$fn" \}/.test(deploySource)
    && /if \(\$failed\.Count\)[\s\S]*?exit 1/.test(deploySource)
    && /regulated-channel behavior probe passed/.test(deploySource)
    && /@\(200, 204, 400, 401, 403, 405\) -contains \$code/.test(deploySource),
)
check(
  'catalog truthfully labels prompt guardrails and safety beta',
  /not an enforced approval queue yet/.test(marketplaceSource)
    && /Safety beta · Nemo only/.test(marketplaceSource),
)
check(
  'failed local or demo persistence cleans up the lead agent',
  /UUID_RE/.test(persistenceSource)
    && /cleanupLead/.test(persistenceSource)
    && /deleteAgent\(agentId\)/.test(persistenceSource),
)
check(
  'legacy custom teams are not force-marked generic',
  /opts\.workflowMode \? `nemo-workflow:\$\{opts\.workflowMode\}` : ''/.test(persistenceSource),
)

let failed = 0
for (const [name, ok, detail] of checks) {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${!ok && detail ? ` (${detail})` : ''}`)
  if (!ok) failed++
}

if (failed) {
  console.error(`Industry team contracts: ${checks.length - failed}/${checks.length} passed; ${failed} failed.`)
  process.exit(1)
}

console.log(`Industry team contracts: ${checks.length}/${checks.length} passed.`)
