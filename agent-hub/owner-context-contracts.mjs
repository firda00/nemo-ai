// Owner context for connected store data.
//
// The owner wrote "посмотри как идут дела в моем магазине uzum" to their own Telegram bot and got
// "Секунду, оператор скоро подключится." The cause: `workflow` (AI team) is on the customer-facing
// list, and CUSTOMER_DENY strips uzum_shops / uzum_products from customer-facing agents. With no
// way to read the store, the run fell through to the team path, peer review had nothing to verify,
// and the dialogue escalated to a human.
//
// The deny-list is right for an unknown person on a public channel and wrong for the owner. These
// contracts pin both halves: the owner gets the read-only store tools, everyone else still cannot.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8')
const tools = read('supabase/functions/_shared/tools.ts')
const agent = read('supabase/functions/_shared/agent.ts')
const telegram = read('supabase/functions/_shared/tgProcess.ts')

// The deny-list itself must stay: it is what stops a public-channel stranger from dumping stock.
assert.match(tools, /const CUSTOMER_DENY = new Set\(\[[^\]]*'uzum_shops', 'uzum_products'/,
  'customer-facing agents must still be denied the store tools')
assert.match(tools, /'workflow'/, 'the team agent type must remain classified as customer-facing')

// The exemption is narrow: read-only views of the owner's own store, and nothing else.
const ownerSet = tools.match(/const OWNER_READ_TOOLS = new Set\(\[([^\]]*)\]\)/)
assert.ok(ownerSet, 'the owner exemption must be an explicit, reviewable list')
const exempt = [...ownerSet[1].matchAll(/'([^']+)'/g)].map((m) => m[1]).sort()
assert.deepEqual(exempt, ['ozon_orders', 'uzum_products', 'uzum_shops', 'wb_orders'],
  'only read-only marketplace reads may be exempted — never a send/write/browse tool')
for (const writeTool of ['slack_send_message', 'github_create_issue', 'notion_create_page', 'airtable_create_record', 'browser_task', 'gmail_send']) {
  assert.ok(!exempt.includes(writeTool), `${writeTool} must never be owner-exempted`)
}

// The exemption applies only when owner context was actually established.
assert.match(tools, /!\(ownerContext && OWNER_READ_TOOLS\.has\(name\)\)/,
  'the exemption must be gated on ownerContext, not granted unconditionally')
assert.match(tools, /runAgentTools\([^)]*ownerContext = false\)/,
  'ownerContext must default to false so every existing caller stays customer-scoped')

// Owner identity comes from the Telegram envelope, never from anything the writer can type.
assert.match(agent, /notify_chat_id/, 'owner identity must be checked against the stored owner chat')
assert.match(agent, /ownerChat\.length > 0 && ownerChat === tgCtx\.chatId/,
  'an empty notify_chat_id must not match an empty chat id and grant access to everyone')
assert.doesNotMatch(agent, /ownerContext = true(?!\s*&&)/, 'owner context must be derived, never hardcoded')

// The model must be told which of the two situations it is in, from one shared definition.
assert.match(tools, /const safetyBlock = ownerContext/, 'the two safety framings must come from one variable')
assert.match(tools, /assisting the OWNER of this business/)
assert.match(tools, /assisting an EXTERNAL customer of the business/)
assert.doesNotMatch(tools, /\.replace\(\s*'SAFETY/, 'the framing must not depend on a fragile string replace')

// A connected store query must never fall through to an ungrounded normal-chat answer. The owner
// gets a server-fetched snapshot; an unverified Telegram user gets the ownership instructions.
assert.match(tools, /const uzumRequested = Boolean\(keyByProvider\.uzum\) && asksForPrivateStoreData/)
assert.match(tools, /каталог\|карточ\|описан\|sku/, 'a listing or description audit must load the owner\'s verified store snapshot')
assert.match(tools, /if \(uzumRequested && !ownerContext\)/)
assert.match(tools, /await storeSnapshot\(db, accountId, 200\)/,
  'verified owner marketplace questions must fetch facts before model generation')
assert.match(tools, /Answer the owner's marketplace question ONLY from this snapshot/)
assert.match(tools, /Treat blank values as unknown, never as zero/)
assert.match(tools, /let ranAny = Boolean\(liveStore\)/,
  'a prefetched snapshot must count as a real tool run so its grounded answer is not discarded')

// Owners can discover the exact id without trusting a third-party Telegram bot.
assert.match(telegram, /\/myid/)
assert.match(telegram, /Ваш Telegram chat_id:/)

// A field that decides access must be reachable in the UI. notify_chat_id existed in the type, the
// loader, the saver and all three languages, but was missing from the form's FIELDS list — so no
// account could ever set it and owner context could never resolve for anyone.
const companyBrain = read('src/pages/app/CompanyBrainPage.tsx')
const fieldsBlock = companyBrain.match(/const FIELDS: \{ k: Key; area\?: boolean \}\[\] = \[([\s\S]*?)\n\]/)
assert.ok(fieldsBlock, 'the company profile form must expose its field list')
assert.match(fieldsBlock[1], /\{ k: 'notify_chat_id' \}/,
  'the owner chat field must be rendered, not just stored')

console.log('Owner context contracts passed.')
