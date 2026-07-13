import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8').replace(/^\uFEFF/, '')
let failed = 0
const check = (name, ok, detail = '') => {
  if (ok) console.log(`[OK] ${name}`)
  else { failed += 1; console.error(`[FAIL] ${name}${detail ? `: ${detail}` : ''}`) }
}

const ui = read('src/data/agentSkills.ts')
const runtime = read('supabase/functions/_shared/capabilitySkills.ts')
const editor = read('src/pages/app/AgentEditorPage.tsx')
const catalog = read('src/pages/app/IntegrationsToolsPage.tsx')
const i18n = read('src/i18n/extra.ts')
const tools = read('supabase/functions/_shared/tools.ts')
const llm = read('supabase/functions/_shared/llm.ts')
const testAgent = read('supabase/functions/test-agent/index.ts')
const testChat = read('src/hooks/useAgentChat.ts')

const idsFrom = (text) => [...text.matchAll(/\bid:\s*'([a-z0-9-]+)'/g)].map((match) => match[1])
const uiIds = idsFrom(ui)
const runtimeIds = idsFrom(runtime)
const sorted = (xs) => [...xs].sort()

check('15 user-selectable skills are exposed', uiIds.length === 15, `found ${uiIds.length}`)
check('frontend skill ids are unique', new Set(uiIds).size === uiIds.length)
check('runtime skill ids are unique', new Set(runtimeIds).size === runtimeIds.length)
check('frontend and backend skill catalogs match', JSON.stringify(sorted(uiIds)) === JSON.stringify(sorted(runtimeIds)))
check('editor renders the canonical catalog', /AGENT_SKILLS\.map/.test(editor) && /MAX_AGENT_SKILLS/.test(editor))
check('skills overview renders the canonical catalog', /AGENT_SKILLS\.map/.test(catalog))

for (const id of uiIds) {
  const nameCount = (i18n.match(new RegExp(`"skill_${id}"`, 'g')) ?? []).length
  const descCount = (i18n.match(new RegExp(`"skill_${id}Desc"`, 'g')) ?? []).length
  check(`${id} has UZ/RU/EN labels`, nameCount === 3 && descCount === 3, `name=${nameCount}, desc=${descCount}`)
}

const allowedKeylessTools = new Set(['run_code', 'web_search', 'read_webpage', 'book_appointment'])
const skillTools = [...runtime.matchAll(/tools:\s*\[([^\]]*)\]/g)].flatMap((match) => [...match[1].matchAll(/'([^']+)'/g)].map((tool) => tool[1]))
check('skills unlock only approved keyless tools', skillTools.every((tool) => allowedKeylessTools.has(tool)), skillTools.filter((tool) => !allowedKeylessTools.has(tool)).join(', '))
check('unknown skill ids fail closed', /SKILL_INDEX\.get\(id\)/.test(runtime) && /filter\(\(skill\).*Boolean\(skill\)/s.test(runtime))
check('selected methods are injected into real prompts', /selectedSkillBlock\(agent\?\.skills\)/.test(llm))
check('tool runtime uses the canonical skill registry', /import \{ SKILL_TOOLS \} from '\.\/capabilitySkills\.ts'/.test(tools))
check('customer-facing agents cannot receive account-wide custom HTTP/MCP tools', /\.\.\.\(customerFacing \? \[\] : customSpecs\)/.test(tools))
check('test UI sends type and skills', /type: agent\.type/.test(testChat) && /skills: agent\.skills \?\? \[\]/.test(testChat))
check('test runtime passes type and skills to tool selection', /runAgentTools\([^\n]+agent\?\.type[^\n]+agent\.skills/s.test(testAgent))
check('saved test agent is tenant-scoped before knowledge retrieval', /\.eq\('id', agentId\)\.eq\('account_id', accountId\)/.test(testAgent) && testAgent.indexOf(".eq('account_id', accountId)") < testAgent.indexOf('retrieveKnowledge(admin, agentId'))
check('saved test agent uses authoritative server config', /agent = savedAgent/.test(testAgent))

if (failed) {
  console.error(`${failed} skills contract(s) failed.`)
  process.exit(1)
}
console.log('Skills contracts passed: catalog, i18n, prompt injection, test parity and safety gates verified.')
