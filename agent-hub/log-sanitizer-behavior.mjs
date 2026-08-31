import assert from 'node:assert/strict'
import { createLogSanitizer, redactLogLine } from './log-sanitizer.mjs'
import { redactText } from '../supabase/functions/_shared/redact.ts'

const token = `sk-or-v1-${'a'.repeat(48)}`
const databaseUrl = ['postgresql://admin', 'hunter2secret@db.example.test/app'].join(':')
const privateKeyBegin = ['-----BEGIN', 'PRIVATE KEY-----'].join(' ')
const privateKeyEnd = ['-----END', 'PRIVATE KEY-----'].join(' ')
assert.equal(redactLogLine(`OPENROUTER_API_KEY=${token}`).includes(token), false)
assert.equal(redactLogLine(`Authorization: Bearer ${token}`).includes(token), false)
assert.equal(redactLogLine(databaseUrl).includes('hunter2secret'), false)

let output = ''
const sanitizer = createLogSanitizer((text) => { output += text })
sanitizer.write(`before\nNEMO_EXTENSION_PRIVATE_KEY="${privateKeyBegin}\n`)
sanitizer.write(`synthetic-private-material\n${privateKeyEnd}"\nafter\n`)
sanitizer.flush()
assert.equal(output.includes('synthetic-private-material'), false)
assert.equal(output.includes('PRIVATE KEY REDACTED'), true)
assert.equal(output.includes('before'), true)
assert.equal(output.includes('after'), true)
assert.equal(redactText(`${privateKeyBegin}\nprivate-body\n${privateKeyEnd}`).includes('private-body'), false)
assert.equal(redactText(`DATABASE_URL=${databaseUrl}`).includes('hunter2secret'), false)

console.log('[OK] Log sanitizer masks assignments, tokens, credentials and multiline private keys')
