// Read-only Vercel source inspection. A passing report is required before upload.
// Credentials stay inside the installed CLI; no tokens are accepted in arguments.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PROJECT = 'prj_AeIX44p4mEoqGy9ZArT6v2N6YrPD'
const SCOPE = 'team_Sz7W4cZQXPnH07woFH9URbij'
const TOP_LEVEL = new Set([
  'package.json', 'package-lock.json', 'README.md', 'index.html', 'tsconfig.json',
  'tsconfig.app.json', 'tsconfig.node.json', 'vite.config.ts', 'postcss.config.js',
  'tailwind.config.js', 'vercel.json', 'scripts/build-cli.mjs', 'scripts/package-cli-release.mjs',
])
const PUBLIC = new Set(['public/widget.js', 'public/icons.svg', 'public/install.ps1', 'public/install.sh'])
const REQUIRED = [...TOP_LEVEL, 'agent-hub/nemo.mjs', 'agent-hub/agent-capabilities.json', 'src/main.tsx',
  'public/brand/nemo-app-icon.svg', 'vendor/marketingskills/LICENSE']
const RUNTIME_DIR = /(^|\/)(node_modules|dist|dist-ssr|artifacts|state|storage|uploads|customer-uploads|customeruploads|qa-reports|chrome-profile|browser-profile)(\/|$)/i
const SECRET_FILE = /(^|\/)(auth|credentials)\.json$|\.(local|log|jsonl|snapshot|tsbuildinfo|pem|key|p12|pfx)$/i

export function allowedUploadPath(file) {
  if (typeof file !== 'string' || !file || file.includes('\\') || file.includes(':') || file.includes('%')
    || path.posix.isAbsolute(file) || file.split('/').some((part) => !part || part.startsWith('.'))
    || RUNTIME_DIR.test(file) || SECRET_FILE.test(file)) return false
  if (TOP_LEVEL.has(file) || PUBLIC.has(file)) return true
  if (/^public\/brand\//.test(file)) return /\.(svg|png|jpe?g|webp|ico|css|json)$/i.test(file)
  if (/^src\//.test(file)) return /\.(ts|tsx|css|svg)$/i.test(file)
  if (/^agent-hub\//.test(file)) {
    return file === 'agent-hub/agent-capabilities.json' || /\.(ts|tsx|mjs|js)$/i.test(file)
  }
  if (/^supabase\/functions\//.test(file)) return /\.(ts|json|lock)$/i.test(file)
  if (/^vendor\/marketingskills\//.test(file)) return /\.(md|json)$/i.test(file) || file === 'vendor/marketingskills/LICENSE'
  return false
}

export function validateUploadManifest(manifest) {
  assert.ok(manifest && Array.isArray(manifest.files), 'dry-run must return an explicit file list')
  assert.equal(manifest.fileCount, manifest.files.length, 'dry-run file count must match the list')
  const names = new Set()
  let bytes = 0
  for (const file of manifest.files) {
    assert.ok(allowedUploadPath(file.path), `Upload blocked by path policy: ${String(file.path).slice(0, 200)}`)
    assert.ok(!names.has(file.path), `Duplicate upload path: ${file.path}`)
    assert.ok(Number.isSafeInteger(file.size) && file.size >= 0, `Invalid upload size: ${file.path}`)
    assert.ok(Number.isInteger(file.mode) && (file.mode & 0o170000) === 0o100000, `Only regular files may upload: ${file.path}`)
    assert.match(file.sha, /^[a-f0-9]{40}$/i, `Missing content hash: ${file.path}`)
    names.add(file.path)
    bytes += file.size
  }
  for (const required of REQUIRED) assert.ok(names.has(required), `Required build input missing: ${required}`)
  assert.equal(manifest.totalSize, bytes, 'dry-run total bytes must match the list')
  return { files: [...names].sort(), fileCount: names.size, totalBytes: bytes }
}

function selfTest() {
  let count = 0
  const test = (name, run) => { run(); count++; console.log(`PASS ${name}`) }
  const baseline = () => ({ files: REQUIRED.map((file) => ({ path: file, size: 1, mode: 0o100644, sha: 'a'.repeat(40) })), fileCount: REQUIRED.length, totalSize: REQUIRED.length })
  test('minimal required build inputs pass', () => assert.equal(validateUploadManifest(baseline()).fileCount, REQUIRED.length))
  for (const file of ['.secrets.local', '.env.local', '.ssh/id_ed25519', '.git/config', '.claude/worktrees/old/src/app.tsx',
    'docs/SERVER_SSH_ACCESS_RU.md', 'agent-hub/artifacts/browser/auth.json', 'agent-hub/state/accounts.json',
    'src/uploads/customer.json', 'public/storage/customer.png', 'agent-hub/customeruploads/data.json',
    'public/nemo-cli.tgz', 'agent-hub/qa-reports/customer.json', 'src/.env', 'agent-hub/auth.json',
    'agent-hub/security-contracts-report.json', 'agent-hub/security-live-report.json', 'agent-hub/accounts.json',
    'src/../private.ts', '/src/main.tsx', 'src\\main.tsx', 'C:/src/main.tsx',
    'src/%2e%2e/private.ts', 'agent-hub/fixtures/accounts.csv']) {
    test(`reject ${file}`, () => {
      const data = baseline(); data.files.push({ path: file, size: 1, mode: 0o100644, sha: 'a'.repeat(40) }); data.fileCount++; data.totalSize++
      assert.throws(() => validateUploadManifest(data), /Upload blocked/)
    })
  }
  test('reject symlink', () => { const data = baseline(); data.files[0].mode = 0o120777; assert.throws(() => validateUploadManifest(data), /regular files/) })
  test('reject omitted CLI packaging input', () => { const data = baseline(); data.files.pop(); data.fileCount--; data.totalSize--; assert.throws(() => validateUploadManifest(data), /Required build input/) })
  test('reject duplicate paths', () => { const data = baseline(); data.files.push(data.files[0]); data.fileCount++; data.totalSize++; assert.throws(() => validateUploadManifest(data), /Duplicate/) })
  test('reject truncated list', () => { const data = baseline(); data.fileCount++; assert.throws(() => validateUploadManifest(data), /file count/) })
  test('reject unexpected byte count', () => { const data = baseline(); data.totalSize++; assert.throws(() => validateUploadManifest(data), /total bytes/) })
  test('reject unbound content hash', () => { const data = baseline(); data.files[0].sha = ''; assert.throws(() => validateUploadManifest(data), /content hash/) })
  console.log(`${count} upload-boundary assertions passed; no network used.`)
}

async function main() {
  if (process.argv.includes('--self-test')) { selfTest(); return }
  const option = (name) => { const at = process.argv.indexOf(name); return at < 0 ? undefined : process.argv[at + 1] }
  const cli = option('--cli')
  assert.ok(cli && path.isAbsolute(cli) && fs.existsSync(cli), 'Pass --cli with the absolute installed Vercel CLI entry path')
  const reportPath = path.resolve(ROOT, option('--output') ?? 'agent-hub/artifacts/employee-deploy-stage/upload-preflight.json')
  const artifactRoot = path.join(ROOT, 'agent-hub', 'artifacts') + path.sep
  assert.ok(reportPath.startsWith(artifactRoot), 'Report must stay inside agent-hub/artifacts')
  const result = spawnSync(process.execPath, [cli, 'deploy', '--dry', '--json', '--scope', SCOPE, '--project', PROJECT], {
    cwd: ROOT, encoding: 'utf8', timeout: 60_000, maxBuffer: 10 * 1024 * 1024, windowsHide: true,
    env: { ...process.env, VERCEL_TELEMETRY_DISABLED: '1' },
  })
  assert.equal(result.status, 0, 'Vercel read-only dry-run failed; no upload attempted')
  const manifest = JSON.parse(result.stdout)
  const summary = validateUploadManifest(manifest)
  // Bind the result to the actual bytes and reject links even if a CLI lists their target as a file.
  for (const file of manifest.files) {
    const local = path.resolve(ROOT, file.path)
    assert.ok(local.startsWith(ROOT + path.sep) && fs.lstatSync(local).isFile() && !fs.lstatSync(local).isSymbolicLink(), `Unsafe local path: ${file.path}`)
    assert.ok(fs.realpathSync(local).startsWith(fs.realpathSync(ROOT) + path.sep), `Path escapes source tree: ${file.path}`)
    assert.equal(createHash('sha1').update(fs.readFileSync(local)).digest('hex'), file.sha, `Source changed after dry-run: ${file.path}`)
  }
  const report = { recordedAt: new Date().toISOString(), projectId: PROJECT, scope: SCOPE,
    readOnly: true, uploaded: false, passed: true, ...summary,
    ignoreSha256: createHash('sha256').update(fs.readFileSync(path.join(ROOT, '.vercelignore'))).digest('hex'),
    manifestSha256: createHash('sha256').update(JSON.stringify(manifest.files)).digest('hex'),
    sourceManifest: manifest.files }
  fs.mkdirSync(path.dirname(reportPath), { recursive: true })
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify({ passed: true, fileCount: summary.fileCount, totalBytes: summary.totalBytes,
    sensitivePaths: 0, uploaded: false, report: path.relative(ROOT, reportPath), manifestSha256: report.manifestSha256 }))
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(error instanceof Error ? error.message : 'Upload preflight failed'); process.exitCode = 1 })
}
