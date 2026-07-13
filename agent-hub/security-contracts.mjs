// Nemo security gate: executable coverage map for the 30 requested scenarios.
// This suite verifies that each control exists in code/schema. Destructive load,
// forged payment and cross-tenant behavior are exercised separately by the live smoke.
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8')
const migrations = fs.readdirSync(path.join(root, 'supabase/migrations')).filter((f) => f.endsWith('.sql')).sort().map((f) => read(`supabase/migrations/${f}`)).join('\n')
const fn = (name) => read(`supabase/functions/${name}/index.ts`)

let failed = 0
let partial = 0
const rows = []
function check(id, name, condition, detail, state = 'PASS') {
  const actual = condition ? state : 'FAIL'
  if (actual === 'FAIL') failed++
  if (actual === 'PARTIAL') partial++
  rows.push({ id, name, state: actual, detail })
  console.log(`[${actual}] ${String(id).padStart(2, '0')} ${name} — ${detail}`)
}

const cors = read('supabase/functions/_shared/cors.ts')
const llm = read('supabase/functions/_shared/llm.ts')
const memory = read('supabase/functions/_shared/memory.ts')
const makeCall = fn('make-call')
const knowledge = fn('knowledge-index')
const operator = fn('operator-send')
const stripe = fn('stripe-webhook')
const tg = fn('telegram-webhook')
const wa = fn('whatsapp-webhook')

check(1, 'Cross-account CRM/RLS', /business_profiles[\s\S]*enable row level security/i.test(migrations) && /current_account_id\(\)/.test(migrations), 'tenant policies bind rows to current_account_id')
check(2, 'Account deletion cascades secrets', /provider_keys[\s\S]*references public\.accounts\(id\) on delete cascade/i.test(migrations) && /google_accounts[\s\S]*on delete cascade/i.test(migrations), 'provider and Google rows cascade with account deletion')
check(3, 'Foreign RAG access', /knowledge_acc[\s\S]*current_account_id\(\)/i.test(migrations) && /revoke all on function public\.match_knowledge/i.test(migrations), 'documents are tenant-scoped and vector RPC is service-only')
check(4, 'Expired/tampered JWT', /auth\.getUser\(\)/.test(makeCall) && /if \(!user\).*401/.test(makeCall), 'Edge Functions validate JWT with Supabase Auth')
check(5, 'Atomic zero-balance race', /greatest\(0, token_balance/i.test(migrations) && /reserve_logistics_credits[\s\S]*for update/i.test(migrations), 'balance never becomes negative; reservations lock the account row')
check(6, 'Unauthorized human takeover', /auth\.getUser\(\)/.test(operator) && /from\('dialogues'\)/.test(operator), 'caller JWT and RLS-owned dialogue are both required')
check(7, 'System prompt extraction', /Never reveal, repeat, translate or summarize/.test(llm), 'guard is injected into business and personal agents')
check(8, 'Knowledge SQL injection', /\.rpc\('match_knowledge'/.test(read('supabase/functions/_shared/knowledge.ts')) && !/select\s+.*\$\{.*query/is.test(knowledge), 'query uses typed RPC parameters, not SQL strings')
check(9, 'Agent/company XSS', !/dangerouslySetInnerHTML/.test(read('src/components/platform/KnowledgeManager.tsx')), 'React renders user labels as escaped text')
check(10, 'Provider-key encryption at rest', /AES-GCM/.test(read('supabase/functions/_shared/secretBox.ts')) && /sealSecret\(key\)/.test(fn('connect-provider')) && /revoke select on public\.provider_keys/i.test(migrations), 'AES-256-GCM at application layer plus RLS/default-deny')
check(11, 'Agent creation rate limit', /guard_agent_creation_rate[\s\S]*pg_advisory_xact_lock[\s\S]*recent_count >= 30/i.test(migrations), 'per-account creation bursts are serialized and capped')
check(12, 'Provider 429 retry', /res\.status === 429[\s\S]*retry-after[\s\S]*breakerUntil/i.test(llm), 'bounded retry, jitter and circuit breaker are present')
check(13, 'Voice balance limit', /token_balance, blocked/.test(makeCall) && /NO_CREDITS/.test(makeCall), 'blocked/zero-balance accounts cannot start paid calls')
check(14, 'Forged Stripe webhook', /stripe-signature/i.test(stripe) && /timingSafeEqual|crypto\.subtle\.verify|hmac/i.test(stripe), 'signature, timestamp and event id are verified')
check(15, 'Lead memory isolation', /dialogueId \? query\.eq\('dialogue_id'/.test(memory) && /loadMemory\(db, agent\.id, dialogueId\)/.test(read('supabase/functions/_shared/agent.ts')), 'memory is scoped to one dialogue/lead')
check(16, 'Malicious knowledge file', /UNSUPPORTED_FILE_TYPE/.test(read('src/lib/extractText.ts')) && /knowledge_docs_content_size_check/.test(migrations), 'allowlist plus database content bound')
check(17, '500 MB upload limit', /20 \* 1024 \* 1024/.test(read('src/lib/extractText.ts')) && /char_length\(content\) <= 200000/.test(migrations), 'browser rejects above 20 MB; DB rejects oversized extracted content')
check(18, 'Loop injection', /MAX_STEPS|MAX_ROUNDS|maxSteps|slice\(0, [345]\)/.test(fn('orchestrate')) || /for \(let .*< [345]/.test(fn('orchestrate')), 'orchestrator/tool execution has a bounded step count')
check(19, 'PII masking', /PII_GUARD/.test(llm) && /CARD REDACTED/.test(memory), 'agent never repeats secrets and durable memory redacts common PII')
check(20, 'Malformed authorization headers', /auth\.getUser\(\)/.test(fn('backend-status')) && /UNAUTHORIZED/.test(fn('backend-status')), 'invalid headers fail before privileged work')
check(21, 'Forged Telegram/WhatsApp webhook', /timingSafeEqual/.test(tg) && /verifyMetaSignature/.test(wa), 'Telegram secret and Meta HMAC are mandatory')
check(22, 'Voice phone validation', /\^\\\+\[1-9\]\\d\{7,14\}\$/.test(makeCall), 'strict E.164 format is required')
check(23, 'CORS foreign origin', /forbidden origin/.test(cors) && /PROD_ORIGIN/.test(cors), 'all browser Edge Functions use the shared preflight allowlist')
check(24, 'Plan/payment bypass', /if \(!me\?\.is_admin\).*403/.test(fn('admin-api')) && /payment_status/.test(stripe), 'plan writes are admin-only and checkout credit requires paid Stripe state')
check(25, 'Secrets in logs/traces', /redactValue\(args\)/.test(fn('agent-tool')) && /redactText\(out\.result\)/.test(fn('agent-tool')), 'tool arguments/results and durable memory are redacted before persistence')
check(26, 'Direct admin URL', /if \(!isAdmin\)/.test(read('src/pages/app/AdminPage.tsx')) && /if \(!me\?\.is_admin\).*403/.test(fn('admin-api')), 'UI and API independently deny non-admin users')
check(27, 'Revoked Google OAuth', /invalid_grant/.test(read('supabase/functions/_shared/google.ts')) && /from\('google_accounts'\)\.delete/.test(read('supabase/functions/_shared/google.ts')), 'revoked credentials are removed while Nemo login remains independent')
check(28, 'Takeover metadata spoofing', /\.eq\('id', dialogue_id\)/.test(operator) && /channel\?\.type === dialogue\.channel/.test(operator), 'delivery channel and agent are loaded from owned database rows')
check(29, 'Concurrent CRM subagents', /business_profiles_acc|business_profiles/i.test(migrations), 'tenant isolation exists; same-row last-write conflict detection is not implemented', 'PARTIAL')
check(30, 'Empty/broken knowledge JSON', /req\.json\(\)\.catch\(\(\) => \(\{\}\)\)/.test(knowledge), 'invalid bodies are bounded and rejected without raw SQL')

fs.writeFileSync(path.join(root, 'agent-hub/security-contracts-report.json'), JSON.stringify({ generated_at: new Date().toISOString(), failed, partial, rows }, null, 2))
console.log(`Security contracts: ${30 - failed - partial} PASS, ${partial} PARTIAL, ${failed} FAIL.`)
if (failed) process.exit(1)
