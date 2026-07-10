import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/(?:[A-Za-z]:)/, (m) => m.slice(1))), '..')
const manifestPath = path.join(root, 'agent-hub', 'agent-capabilities.json')
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8').replace(/^\uFEFF/, ''))

const normalize = (value) => value.toLowerCase().replace(/\s+/g, ' ')
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8').replace(/^\uFEFF/, '')
const migrationDir = path.join(root, 'supabase', 'migrations')
const migrationText = fs.existsSync(migrationDir)
  ? fs.readdirSync(migrationDir).filter((name) => name.endsWith('.sql')).map((name) => read(path.join('supabase', 'migrations', name))).join('\n')
  : ''

let failed = 0
for (const capability of manifest.capabilities) {
  const errors = []
  for (const relative of capability.requiredFiles ?? []) {
    if (!fs.existsSync(path.join(root, relative))) errors.push(`missing ${relative}`)
  }
  for (const contract of capability.requiredText ?? []) {
    const absolute = path.join(root, contract.file)
    if (!fs.existsSync(absolute)) continue
    const content = read(contract.file)
    for (const needle of contract.contains) {
      if (!content.includes(needle)) errors.push(`${contract.file} lacks ${JSON.stringify(needle)}`)
    }
  }
  for (const needle of capability.migrationText ?? []) {
    if (!normalize(migrationText).includes(normalize(needle))) errors.push(`migrations lack ${JSON.stringify(needle)}`)
  }

  if (errors.length) {
    failed += 1
    console.error(`[FAIL] ${capability.id}: ${errors.join('; ')}`)
  } else {
    console.log(`[OK] ${capability.id} - ${capability.description}`)
  }
}

if (failed) {
  console.error(`${failed} capability contract(s) failed.`)
  process.exit(1)
}
console.log(`${manifest.capabilities.length} Nemo capability contracts passed.`)
