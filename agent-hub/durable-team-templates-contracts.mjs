import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { DURABLE_TEAM_TEMPLATES } from '../src/data/durableTeamTemplates.ts'

assert.deepEqual(DURABLE_TEAM_TEMPLATES.map((template) => template.id), [
  'sales-department', 'content-marketing', 'customer-support',
])
for (const template of DURABLE_TEAM_TEMPLATES) {
  assert.equal(template.version, '1.0')
  assert.ok(template.roles.length >= 2 && template.roles.length <= 6)
  assert.ok(template.roles.every((member) => member.prompt.rules.includes('Never invent')))
  assert.ok(template.roles.every((member) => member.prompt.rules.includes('Human-in-the-Loop approval')))
  assert.ok(template.roles.every((member) => member.skills.length > 0))
}

const page = readFileSync('src/pages/app/AutonomousPage.tsx', 'utf8')
const runner = readFileSync('src/components/platform/AutonomousRunner.tsx', 'utf8')
const persistence = readFileSync('src/lib/dynamicTeams.ts', 'utf8')
assert.match(page, /presetSpecs=\{selectedDepartment\?\.roles\}/)
assert.match(page, /Durable team template/)
assert.match(runner, /saveDynamicTeam/)
assert.match(persistence, /rpc\('create_agent_team'/)

console.log('Durable 1-Click team templates: 3 templates and atomic persistence PASS')
