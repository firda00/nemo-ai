// Schema drift between the repo's migrations and what the runtime actually reads.
//
// `messages.message_type` and `messages.agent_id` were declared in a migration that was only
// PARTIALLY applied to production: departments and sub_agents from the same file existed, these
// two columns did not. The runtime loads chat history with `.eq('message_type','chat')`, so every
// history read returned an error instead of rows, the error was discarded, and the agent saw an
// empty conversation with an empty customer question — for months, on every channel.
//
// Nothing in the gate could catch that, because the code was right and the database was behind.
// This suite pins the columns the runtime depends on, so a partially applied migration is a
// failing test instead of a silent, permanent outage.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8')

// Columns the shared runtime reads or writes, and where each one is declared.
const REQUIRED = [
  ['messages', 'message_type'],
  ['messages', 'agent_id'],
  ['dialogues', 'operator_takeover'],
  ['sub_agents', 'model'],
  ['business_profiles', 'notify_chat_id'],
  ['usage', 'stage'],
  ['usage', 'run_ref'],
  ['research_runs', 'cost'],
]

const migrations = fs.readdirSync(path.join(root, 'supabase/migrations'))
  .filter((f) => f.endsWith('.sql'))
  .map((f) => read(`supabase/migrations/${f}`))
  .join('\n')

for (const [table, column] of REQUIRED) {
  // String.raw: in a plain template literal `\b` is a backspace character, not a word boundary.
  const declared = new RegExp(
    String.raw`(alter table (public\.)?${table} add column if not exists ${column}\b)|(create table[^;]*${table}[^;]*\b${column}\b)`,
    'is',
  )
  assert.match(migrations, declared, `${table}.${column} is used by the runtime but declared in no migration`)
}

// The history filter is the specific read that fails closed-but-silent when the column is absent.
const agent = read('supabase/functions/_shared/agent.ts')
assert.match(agent, /\.eq\('message_type', 'chat'\)/, 'the history allowlist must stay explicit')

// Whoever adds a new required column must extend this list — that is the point of the file.
assert.ok(REQUIRED.length >= 8)

console.log(`Schema drift contracts passed (${REQUIRED.length} runtime columns declared).`)
