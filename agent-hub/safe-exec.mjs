import { spawn } from 'node:child_process'
import { createLogSanitizer } from './log-sanitizer.mjs'

const separator = process.argv.indexOf('--')
const argv = separator >= 0 ? process.argv.slice(separator + 1) : process.argv.slice(2)
if (!argv.length) {
  console.error('Usage: npm run safe:exec -- <command> [args...]')
  process.exit(2)
}

const child = spawn(argv[0], argv.slice(1), {
  cwd: process.cwd(),
  env: process.env,
  shell: process.platform === 'win32',
  stdio: ['inherit', 'pipe', 'pipe'],
})
const stdout = createLogSanitizer((text) => process.stdout.write(text))
const stderr = createLogSanitizer((text) => process.stderr.write(text))
child.stdout.on('data', (chunk) => stdout.write(chunk))
child.stderr.on('data', (chunk) => stderr.write(chunk))
child.on('error', (error) => {
  stderr.write(`safe-exec failed: ${error.message}\n`)
  stderr.flush()
  process.exitCode = 1
})
child.on('close', (code, signal) => {
  stdout.flush()
  stderr.flush()
  if (signal) console.error(`safe-exec: child stopped by ${signal}`)
  process.exitCode = code ?? 1
})
