import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const functionsRoot = path.join(root, 'supabase', 'functions')
const manifest = JSON.parse(fs.readFileSync(path.join(functionsRoot, 'deployment-manifest.json'), 'utf8'))
const deploy = fs.readFileSync(path.join(root, 'deploy.ps1'), 'utf8')
const config = fs.readFileSync(path.join(root, 'supabase', 'config.toml'), 'utf8')

const sourceFunctions = fs.readdirSync(functionsRoot, { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && fs.existsSync(path.join(functionsRoot, entry.name, 'index.ts')))
  .map((entry) => entry.name)
  .sort()
const publicFunctions = [...manifest.public].sort()
const authenticatedFunctions = [...manifest.authenticated].sort()
const excludedFunctions = Object.keys(manifest.excluded).sort()
const classified = [...publicFunctions, ...authenticatedFunctions, ...excludedFunctions].sort()

assert.equal(new Set(classified).size, classified.length, 'a function may appear in only one deployment class')
assert.deepEqual(classified, sourceFunctions, 'every Edge Function directory must be deployed or explicitly excluded')
// 30 после касс Payme и Click. Публичны они по необходимости: ни один провайдер не умеет
// присылать JWT Supabase, и авторизация у них своя — Basic и подпись, — проверяемая до базы.
assert.equal(publicFunctions.length, 30)
assert.equal(authenticatedFunctions.length, 48)
assert.deepEqual(excludedFunctions, ['qtest'])
assert.ok(Object.values(manifest.excluded).every((reason) => typeof reason === 'string' && reason.length >= 20), 'every exclusion needs a concrete reason')

for (const fn of publicFunctions) {
  const section = new RegExp(`\\[functions\\.${fn.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\]\\s*verify_jwt\\s*=\\s*false`)
  assert.match(config, section, `${fn} must be explicit verify_jwt=false in config.toml`)
}
assert.match(deploy, /deployment-manifest\.json/)
assert.match(deploy, /\$edgeManifest\.public/)
assert.match(deploy, /\$edgeManifest\.authenticated/)

const knowledgeIndex = fs.readFileSync(path.join(functionsRoot, 'knowledge-index', 'index.ts'), 'utf8')
assert.match(knowledgeIndex, /!CRON_SECRET\s*\|\|/, 'public knowledge indexing cron must fail closed without a configured secret')
for (const fn of ['commerce-worker', 'commerce-digest', 'org-memory-worker']) {
  const source = fs.readFileSync(path.join(functionsRoot, fn, 'index.ts'), 'utf8')
  assert.match(source, /!CRON(?:_SECRET)?\s*\|\|/, `public ${fn} cron must fail closed without a configured secret`)
  assert.match(source, /403/, `public ${fn} must reject unauthorized callers`)
}
const qtest = fs.readFileSync(path.join(functionsRoot, 'qtest', 'index.ts'), 'utf8')
assert.match(qtest, /QTEST_ENABLED.*!== 'true'/, 'excluded staging load rig must remain disabled by default')

console.log(`Edge deployment manifest covers ${publicFunctions.length + authenticatedFunctions.length} production functions and ${excludedFunctions.length} explicit exclusion.`)
