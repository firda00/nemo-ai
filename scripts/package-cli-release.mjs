/*
 * Publishes an installable CLI tarball into Vite's public directory.
 *
 * The source repository is private, so a customer cannot install from GitHub. The website build
 * instead serves /nemo-cli.tgz. npm installs that public tarball and resolves ordinary runtime
 * dependencies from the public npm registry.
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..')
const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'nemo-cli-release-'))
const windows = process.platform === 'win32'
const npm = windows ? (process.env.ComSpec || 'cmd.exe') : 'npm'
const run = (args) => spawnSync(npm, windows ? ['/d', '/s', '/c', 'npm', ...args] : args, {
  cwd: root,
  encoding: 'utf8',
  windowsHide: true,
})

try {
  const built = run(['run', 'build:cli'])
  if (built.status !== 0) throw new Error((built.stderr || built.stdout || 'CLI build failed').trim())

  // Prevent npm pack from invoking prepare and rebuilding the same bundle twice.
  const packed = run(['pack', '--ignore-scripts', '--pack-destination', stage])
  if (packed.status !== 0) throw new Error((packed.stderr || packed.stdout || 'npm pack failed').trim())

  const tarball = fs.readdirSync(stage).find((name) => name.endsWith('.tgz'))
  if (!tarball) throw new Error('npm pack did not produce a tarball')

  const target = path.join(root, 'public', 'nemo-cli.tgz')
  fs.copyFileSync(path.join(stage, tarball), target)
  console.log(`public/nemo-cli.tgz готов: ${Math.ceil(fs.statSync(target).size / 1024)} КБ`)
} finally {
  fs.rmSync(stage, { recursive: true, force: true })
}
