// Auth/RLS hardening contracts (2026-07-10). Static but EXECUTABLE checks:
//  A. src/lib/supabase.ts — extracts the real validator functions from source and
//     runs them against placeholder/malformed/valid values (demo-mode selection),
//     plus structural contracts (secret-key rejection, gating, no value leakage).
//  B. supabase/migrations — replays every create/drop policy on public.messages in
//     migration order and asserts the FINAL policy set: reads stay tenant-wide,
//     writes are tenant-scoped AND message_type = 'chat' only (system_trace audit
//     rows are read-only for clients; service_role Edge Functions bypass RLS).
//  C. Write-path compatibility — the only caller-JWT message writers (operator-send,
//     test-agent) must keep writing plain chat rows; frontend must not write
//     messages directly.
//  D. Trace retention guard — replays trigger/function DDL across migrations and
//     asserts the FINAL state: BEFORE DELETE guards on BOTH parent paths (agents,
//     dialogues) run a SECURITY DEFINER + fixed-search_path function that blocks
//     client-role deletion while system_trace rows exist underneath, but keeps
//     service_role / direct admin cleanup possible (the cascade hole documented
//     as a known limitation in 20260710120000 is closed forward-only).
// Run: node agent-hub/auth-rls-contracts.mjs   (exits non-zero on any failure)

import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8').replace(/^﻿/, '')

let failed = 0
const check = (name, cond, detail = '') => {
  if (cond) console.log(`[OK] ${name}`)
  else { failed += 1; console.error(`[FAIL] ${name}${detail ? `: ${detail}` : ''}`) }
}

// ---------- A. supabase.ts config validation ----------
const supabaseSrc = read('src/lib/supabase.ts')
const mfaSetup = read('src/components/platform/MfaSetupPanel.tsx')
const mfaGate = read('src/components/auth/MfaChallengeGate.tsx')
const adminMfaGate = read('src/components/auth/AdminMfaGate.tsx')
const adminApi = read('supabase/functions/admin-api/index.ts')
const assurance = read('supabase/functions/_shared/authAssurance.ts')
const appSrc = read('src/App.tsx')
const authContext = read('src/context/AuthContext.tsx')

check('TOTP enrollment requires a verified six-digit challenge', /mfa\.enroll\(\{ factorType: 'totp'/.test(mfaSetup) && /mfa\.challenge/.test(mfaSetup) && /mfa\.verify/.test(mfaSetup) && /\^\\d\{6\}\$/.test(mfaSetup))
check('authenticated app is gated on AAL2 when a verified factor exists', /getAuthenticatorAssuranceLevel/.test(mfaGate) && /nextLevel === 'aal2'/.test(mfaGate) && /currentLevel !== 'aal2'/.test(mfaGate) && /MfaChallengeGate/.test(appSrc))
check('MFA assurance inspection fails closed', /aalError \|\| factorsError/.test(mfaGate) && /setCheckFailed\(true\)/.test(mfaGate) && /if \(checkFailed\) return/.test(mfaGate))
check('super-admin enrollment is mandatory before the admin UI opens', /AdminMfaGate/.test(appSrc) && /state === 'enroll'/.test(adminMfaGate) && /MfaSetupPanel/.test(adminMfaGate))
check('super-admin API requires a validated AAL2 session', /auth\.getUser\(\)/.test(adminApi) && /hasAal2\(authHeader\)/.test(adminApi) && /claims\.aal === 'aal2'/.test(assurance))
check('logout explicitly revokes sessions on all devices', /signOut\(\{ scope: 'global' \}\)/.test(authContext))

// Extract PLACEHOLDER_RE and both validator functions from the actual source,
// strip the two TS annotations they use, and evaluate them as real JS.
const placeholderMatch = supabaseSrc.match(/const PLACEHOLDER_RE = (\/[^\n]+\/i?)/)
check('supabase.ts defines PLACEHOLDER_RE', Boolean(placeholderMatch))

function extractValidator(name) {
  const m = supabaseSrc.match(new RegExp(`export function ${name}[\\s\\S]*?\\n\\}`))
  if (!m) return null
  const js = m[0]
    .replace('export function', 'function')
    .replace(/: string \| undefined/g, '')
    .replace(/\): boolean \{/, ') {')
  try {
    return new Function(`const PLACEHOLDER_RE = ${placeholderMatch?.[1] ?? '/$^/'};\n${js}\nreturn ${name};`)()
  } catch {
    return null
  }
}

const isValidSupabaseUrl = extractValidator('isValidSupabaseUrl')
const isValidSupabaseAnonKey = extractValidator('isValidSupabaseAnonKey')
check('validators extract and evaluate from source', typeof isValidSupabaseUrl === 'function' && typeof isValidSupabaseAnonKey === 'function')

if (isValidSupabaseUrl && isValidSupabaseAnonKey) {
  const b64url = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url')
  const jwt = (payload) => `${b64url({ alg: 'HS256', typ: 'JWT' })}.${b64url(payload)}.c2lnbmF0dXJl`

  // URL: .env.example placeholder and malformed values → demo mode; real URL → live.
  check('url: .env.example placeholder rejected', !isValidSupabaseUrl('https://YOUR_PROJECT_REF.supabase.co'))
  check('url: empty/undefined rejected', !isValidSupabaseUrl('') && !isValidSupabaseUrl(undefined) && !isValidSupabaseUrl('   '))
  check('url: literal undefined/null strings rejected', !isValidSupabaseUrl('undefined') && !isValidSupabaseUrl('null'))
  check('url: non-URL garbage rejected', !isValidSupabaseUrl('not a url') && !isValidSupabaseUrl('ftp://x.supabase.co'))
  check('url: realistic project URL accepted (outage stays visible)', isValidSupabaseUrl('https://abcdwxyz1234.supabase.co'))
  check('url: untrimmed valid URL accepted', isValidSupabaseUrl('  https://abcdwxyz1234.supabase.co  '))

  // Anon key: placeholders and privileged keys → rejected; anon-role keys → accepted.
  check('key: .env.example placeholder rejected', !isValidSupabaseAnonKey('your-anon-public-key'))
  check('key: empty/undefined rejected', !isValidSupabaseAnonKey('') && !isValidSupabaseAnonKey(undefined))
  check('key: sb_secret_ rejected', !isValidSupabaseAnonKey('sb_secret_abcdef1234567890'))
  check('key: bare sb_publishable_ prefix rejected', !isValidSupabaseAnonKey('sb_publishable_'))
  check('key: stub publishable suffixes rejected', !isValidSupabaseAnonKey('sb_publishable_x') && !isValidSupabaseAnonKey('sb_publishable_!') && !isValidSupabaseAnonKey('sb_publishable_short'))
  check('key: sb_publishable_ key accepted', isValidSupabaseAnonKey('sb_publishable_abcdef1234567890'))
  check('key: service_role JWT rejected', !isValidSupabaseAnonKey(jwt({ role: 'service_role', iss: 'supabase' })))
  check('key: role-less JWT rejected', !isValidSupabaseAnonKey(jwt({ iss: 'supabase' })))
  check('key: malformed JWT rejected', !isValidSupabaseAnonKey('eyJhbGciOiJIUzI1NiJ9.not-base64-json.sig'))
  const anonJwt = jwt({ role: 'anon', iss: 'supabase' })
  check('key: anon JWT with empty/garbage signature rejected', !isValidSupabaseAnonKey(anonJwt.replace(/\.[^.]+$/, '.')) && !isValidSupabaseAnonKey(anonJwt.replace(/\.[^.]+$/, '.!')))
  check('key: legacy anon JWT accepted', isValidSupabaseAnonKey(anonJwt))
}

// Structural contracts on the module itself.
check('isSupabaseEnabled requires BOTH validators', /isSupabaseEnabled = isValidSupabaseUrl\(url\) && isValidSupabaseAnonKey\(anon\)/.test(supabaseSrc))
check('createClient is gated by isSupabaseEnabled', /isSupabaseEnabled\s*\?\s*createClient\(/.test(supabaseSrc))
check('env values are trimmed before use', /VITE_SUPABASE_URL[\s\S]{0,60}\.trim\(\)/.test(supabaseSrc) && /VITE_SUPABASE_ANON_KEY[\s\S]{0,60}\.trim\(\)/.test(supabaseSrc))
check('validators are offline (no fetch/await)', !/fetch\(|await /.test(supabaseSrc.match(/export function isValidSupabaseUrl[\s\S]*?\n\}/)?.[0] ?? 'await ') && !/fetch\(|await /.test(supabaseSrc.match(/export function isValidSupabaseAnonKey[\s\S]*?\n\}/)?.[0] ?? 'await '))
{
  const warn = supabaseSrc.match(/console\.warn\(([\s\S]*?)\)\n/)
  check('demo-mode warning exists and never prints the env values', Boolean(warn) && !/\$\{|\burl\b|\banon\b/.test(warn?.[1] ?? '${'), 'warning missing or interpolates url/anon')
}

// ---------- B. migrations — final RLS policy set on public.messages ----------
const migrationDir = path.join(root, 'supabase', 'migrations')
const migrationFiles = fs.readdirSync(migrationDir).filter((n) => n.endsWith('.sql')).sort()
const stripSql = (sql) => sql.replace(/--[^\n]*/g, '')

check('hardening migration file exists', migrationFiles.includes('20260710120000_messages_system_trace_rls.sql'))
const blockedAccountGuard = read('supabase/migrations/20260723121000_blocked_accounts_fail_closed.sql')
check('blocked accounts fail closed for all tenant RLS access', /create or replace function public\.current_account_id/.test(blockedAccountGuard) && /join public\.accounts/.test(blockedAccountGuard) && /coalesce\(a\.blocked, false\) = false/.test(blockedAccountGuard))

// Replay create/drop policy statements in migration order → final policy set.
const policies = new Map()
let alterPolicySeen = null
for (const file of migrationFiles) {
  const sql = stripSql(read(path.join('supabase', 'migrations', file)))
  for (const stmt of sql.match(/(create|drop|alter)\s+policy[\s\S]*?;/gi) ?? []) {
    if (!/on\s+(?:public\.)?"?messages"?\b/i.test(stmt)) continue
    const name = stmt.match(/policy\s+(?:if\s+exists\s+)?(\w+)/i)?.[1]
    if (/^create/i.test(stmt)) policies.set(name, stmt)
    else if (/^drop/i.test(stmt)) policies.delete(name)
    else alterPolicySeen = `${file}: ${name}`
  }
}
check('no ALTER POLICY on public.messages (replay cannot model it)', !alterPolicySeen, alterPolicySeen ?? '')
check(
  'final policy set is exactly the four hardened policies',
  JSON.stringify([...policies.keys()].sort()) === JSON.stringify(['messages_delete_chat', 'messages_insert_chat', 'messages_select_acc', 'messages_update_chat']),
  `got: ${[...policies.keys()].sort().join(', ')}`
)

// A clause must contain the approved predicate AND no OR that could widen it
// (the approved clauses are pure AND chains; any `or` is a red flag).
const noOr = (clause) => !/\bor\b/i.test(clause ?? 'or')
const tenant = (clause) => /current_account_id\(\)/.test(clause ?? '') && noOr(clause)
const chatOnly = (clause) => /message_type\s*=\s*'chat'/.test(clause ?? '') && noOr(clause)

const sel = policies.get('messages_select_acc') ?? ''
check('SELECT: tenant-scoped, applies to all message types', /for\s+select/i.test(sel) && tenant(sel) && !/message_type/i.test(sel))

const ins = policies.get('messages_insert_chat') ?? ''
const insCheck = ins.split(/with\s+check/i)[1]
check("INSERT: WITH CHECK is tenant-scoped AND message_type = 'chat'", /for\s+insert/i.test(ins) && tenant(insCheck) && chatOnly(insCheck))

const upd = policies.get('messages_update_chat') ?? ''
const [updUsing, updCheck] = upd.split(/with\s+check/i)
check("UPDATE: USING is tenant-scoped AND chat-only (trace rows untouchable)", /for\s+update/i.test(upd) && tenant(updUsing) && chatOnly(updUsing))
check("UPDATE: WITH CHECK is tenant-scoped AND chat-only (no chat→trace rewrite)", tenant(updCheck) && chatOnly(updCheck))

const del = policies.get('messages_delete_chat') ?? ''
check("DELETE: USING is tenant-scoped AND chat-only", /for\s+delete/i.test(del) && tenant(del) && chatOnly(del))

check('no FOR ALL policy remains on public.messages', ![...policies.values()].some((p) => /for\s+all/i.test(p)))
check('all four policies are TO authenticated', [...policies.values()].every((p) => /to\s+authenticated/i.test(p)))

// ---------- C. write-path compatibility ----------
// Caller-JWT writers must stay on plain chat rows (column default), so the new
// INSERT policy keeps them working; only the service-role runtime writes traces.
for (const fn of ['supabase/functions/operator-send/index.ts', 'supabase/functions/test-agent/index.ts']) {
  const src = read(fn)
  check(`${fn} still inserts messages (contract target exists)`, /\.from\('messages'\)[\s\S]{0,120}?\.insert\(|\.from\('messages'\)\.insert\(/.test(src))
  check(`${fn} never writes system_trace/internal_monologue`, !/message_type\s*:\s*'(system_trace|internal_monologue)'/.test(src))
}
check(
  'trace writer (agent.ts buildReply) persists system_trace rows',
  /message_type:\s*'system_trace'/.test(read('supabase/functions/_shared/agent.ts'))
)
for (const fn of ['supabase/functions/telegram-webhook/index.ts', 'supabase/functions/whatsapp-webhook/index.ts', 'supabase/functions/widget-webhook/index.ts']) {
  check(`${fn} uses a service_role client (trace writes bypass RLS)`, /SUPABASE_SERVICE_ROLE_KEY/.test(read(fn)))
}

// The frontend must never mutate messages directly; it reads and lets Edge
// Functions write. (Reads via joins are fine — only .from('messages') write
// chains are flagged.)
const srcFiles = []
;(function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name)
    if (entry.isDirectory()) walk(p)
    else if (/\.(ts|tsx)$/.test(entry.name)) srcFiles.push(p)
  }
})(path.join(root, 'src'))
const frontendWriters = srcFiles.filter((p) => /\.from\(['"]messages['"]\)[\s\S]{0,200}?\.(insert|update|delete)\(/.test(fs.readFileSync(p, 'utf8')))
check('frontend has no direct messages writes', frontendWriters.length === 0, frontendWriters.join(', '))

// ---------- D. trace retention guard — parent cascade deletes ----------
// RLS cannot stop FK ON DELETE CASCADE from erasing system_trace rows, so the
// guard lives in BEFORE DELETE triggers on both parents. Replay trigger DDL in
// migration order (same approach as the policy replay in B) so a later
// migration silently dropping a guard fails this contract.

check('trace retention guard migration exists', migrationFiles.includes('20260710130000_trace_retention_guard.sql'))
check(
  'guard is forward-only (not retrofitted into the RLS migration)',
  !/guard_trace_parent_delete/.test(read('supabase/migrations/20260710120000_messages_system_trace_rls.sql'))
)

// Statement-ordered replay per file: CREATE/DROP TRIGGER, CREATE OR REPLACE
// FUNCTION (dollar-quote aware) and DROP FUNCTION (incl. CASCADE, which also
// kills dependent triggers) are applied in source order, so a later migration
// dropping the guard — even one that drops and recreates in the same file —
// is modeled and would fail the final-state checks below.
const guardTriggers = new Map() // "table.trigger" -> statement
const traceGuardCreates = []
let guardFnSql = null
for (const file of migrationFiles) {
  const sql = stripSql(read(path.join('supabase', 'migrations', file)))
  const events = []
  for (const m of sql.matchAll(/create\s+trigger[\s\S]*?;|drop\s+trigger[\s\S]*?;/gi)) events.push({ i: m.index, kind: 'trigger', stmt: m[0] })
  for (const m of sql.matchAll(/create\s+or\s+replace\s+function\s+public\.guard_trace_parent_delete\s*\(\)[\s\S]*?\$\$[\s\S]*?\$\$\s*;/gi)) events.push({ i: m.index, kind: 'createFn', stmt: m[0] })
  for (const m of sql.matchAll(/drop\s+function[^;]*guard_trace_parent_delete[^;]*;/gi)) events.push({ i: m.index, kind: 'dropFn', stmt: m[0] })
  for (const e of events.sort((a, b) => a.i - b.i)) {
    if (e.kind === 'createFn') {
      guardFnSql = e.stmt
    } else if (e.kind === 'dropFn') {
      guardFnSql = null
      if (/\bcascade\b/i.test(e.stmt)) {
        for (const [key, stmt] of [...guardTriggers]) if (/guard_trace_parent_delete/i.test(stmt)) guardTriggers.delete(key)
      }
    } else {
      const name = e.stmt.match(/trigger\s+(?:if\s+exists\s+)?"?(\w+)"?/i)?.[1]
      const table = e.stmt.match(/\bon\s+(?:only\s+)?"?((?:\w+\.)?\w+)"?/i)?.[1]?.replace(/^(?!\w+\.)/, 'public.')
      if (!name || !table) continue
      if (/^create/i.test(e.stmt)) {
        guardTriggers.set(`${table}.${name}`, e.stmt)
        if (/guard_trace|prevent_trace/i.test(name ?? '')) traceGuardCreates.push(`${table}.${name}`)
      } else {
        guardTriggers.delete(`${table}.${name}`)
      }
    }
  }
}

check('guard function defined (survives migration replay)', Boolean(guardFnSql))
if (guardFnSql) {
  const body = guardFnSql
  check('guard fn: SECURITY DEFINER', /security\s+definer/i.test(body))
  check("guard fn: fixed empty search_path", /set\s+search_path\s*=\s*''/i.test(body))
  check(
    'guard fn: all relations schema-qualified (required under empty search_path)',
    /public\.messages/.test(body) && /public\.dialogues/.test(body) && !/\b(from|join)\s+(messages|dialogues)\b/i.test(body)
  )
  check(
    'guard fn: service_role requests may still delete (cleanup path)',
    /requester\s*=\s*'service_role'[\s\S]{0,40}?return\s+old/i.test(body)
  )
  check(
    'guard fn: direct admin sessions may still delete, gated on session_user',
    /requester\s+is\s+null\s+and\s+session_user\s+in\s*\(\s*'postgres'\s*,\s*'supabase_admin'\s*\)/i.test(body)
  )
  check(
    'guard fn: no bypass branch for client or unknown API roles',
    !/'authenticated'|'anon'/.test(body),
    'client roles must fall through to the trace check, never be special-cased'
  )
  check(
    'guard fn: agents path checks traces via dialogues join',
    /d\.agent_id\s*=\s*old\.id/i.test(body) && /join\s+public\.dialogues/i.test(body)
  )
  check('guard fn: dialogues path checks traces directly', /m\.dialogue_id\s*=\s*old\.id/i.test(body))
  check(
    'guard fn: both paths filter on system_trace only',
    (body.match(/message_type\s*=\s*'system_trace'/g) ?? []).length === 2 && !/message_type\s*(!=|<>)/.test(body)
  )
  check('guard fn: raises a clear error (insufficient_privilege)', /raise\s+exception[\s\S]*?errcode\s*=\s*'42501'/i.test(body))
  check('guard fn: unexpected table is an error, not a guess', /else\s+raise\s+exception/i.test(body))
  check('guard fn: trace-free entities remain deletable (RETURN OLD after check)', /if\s+has_trace\s+then[\s\S]*?end\s+if\s*;\s*return\s+old/i.test(body))
}

for (const parent of ['agents', 'dialogues']) {
  const trg = guardTriggers.get(`public.${parent}.${parent}_guard_trace_delete`) ?? ''
  check(
    `${parent}: BEFORE DELETE row trigger runs the guard`,
    /before\s+delete/i.test(trg) && /for\s+each\s+row/i.test(trg) && /execute\s+function\s+public\.guard_trace_parent_delete\s*\(\)/i.test(trg),
    trg ? 'trigger exists but is misconfigured' : 'trigger missing from final migration state'
  )
}

const expectedTraceGuards = ['public.agents.agents_guard_trace_delete', 'public.dialogues.dialogues_guard_trace_delete']
const actualTraceGuards = [...guardTriggers.keys()].filter((key) => /guard_trace|prevent_trace/i.test(key)).sort()
check(
  'final trace guard trigger set is exact (no obsolete or extra guards)',
  JSON.stringify(actualTraceGuards) === JSON.stringify([...expectedTraceGuards].sort()),
  `got: ${actualTraceGuards.join(', ')}`
)
const traceCreateCounts = new Map()
for (const key of traceGuardCreates) traceCreateCounts.set(key, (traceCreateCounts.get(key) ?? 0) + 1)
check(
  'trace guard triggers are each created exactly once',
  expectedTraceGuards.every((key) => traceCreateCounts.get(key) === 1) && traceGuardCreates.every((key) => expectedTraceGuards.includes(key)),
  `creates: ${traceGuardCreates.join(', ')}`
)

check(
  'guard join path is indexed (dialogues.agent_id)',
  migrationFiles.some((f) => /dialogues_agent_id_idx|create\s+index[^;]*on\s+public\.dialogues\s*\(\s*agent_id\s*\)/i.test(stripSql(read(path.join('supabase', 'migrations', f)))))
)

// ---------- verdict ----------
/*
 * E. ПУБЛИЧНЫЕ ВЕБХУКИ ОБЪЯВЛЕНЫ ПУБЛИЧНЫМИ В МАНИФЕСТЕ, А НЕ ТОЛЬКО В КОММЕНТАРИИ.
 *
 * verify_jwt по умолчанию ИСТИНА, и это правильно. Но Telegram и Stripe не умеют присылать JWT
 * Supabase: функция без записи `verify_jwt = false` в config.toml отвергнет каждый их запрос
 * заголовком 401. Снаружи это выглядит как полностью исправная выкладка — функция развёрнута,
 * логи чистые, — а сообщения клиентов и уведомления об оплате просто не доходят.
 *
 * Проверка идёт ОТ КОДА К МАНИФЕСТУ: признак публичности берётся из самой функции (она обязана
 * проверять подпись своим способом — секретным токеном или HMAC), и для каждой такой обязана
 * найтись запись в манифесте. Обратная проверка тоже нужна: `verify_jwt = false` у функции, которая
 * подпись не проверяет, — это открытая наружу ручка со служебным ключом внутри.
 */
{
  const config = fs.readFileSync(path.join(root, 'supabase/config.toml'), 'utf8')
  const dir = path.join(root, 'supabase/functions')
  const names = fs.readdirSync(dir).filter((name) => name !== '_shared'
    && fs.statSync(path.join(dir, name)).isDirectory()
    && fs.existsSync(path.join(dir, name, 'index.ts')))

  const declaredPublic = new Set(
    [...config.matchAll(/\[functions\.([\w-]+)\]([\s\S]*?)(?=\n\[|$)/g)]
      .filter(([, , body]) => /verify_jwt\s*=\s*false/.test(body))
      .map(([, name]) => name),
  )

  const selfVerified = []
  for (const name of names) {
    const source = fs.readFileSync(path.join(dir, name, 'index.ts'), 'utf8')
    // Функция сама проверяет подлинность: секретный токен Telegram, подпись Stripe, подпись Click/Payme.
    if (/x-telegram-bot-api-secret-token|Stripe-Signature|verifyClickSignature|verifyPaymeAuth|PUBLIC endpoint|verify_jwt = false/i.test(source)) {
      selfVerified.push(name)
    }
  }

  check('публичные вебхуки объявлены в манифесте', selfVerified.every((n) => declaredPublic.has(n)),
    `без записи verify_jwt = false: ${selfVerified.filter((n) => !declaredPublic.has(n)).join(', ') || '—'}`)

  for (const name of declaredPublic) {
    if (!names.includes(name)) continue // запись есть, папки нет — отдельный случай, ниже
    const source = fs.readFileSync(path.join(dir, name, 'index.ts'), 'utf8')
    const verifies = /secret|signature|hmac|token|verify/i.test(source)
    check(`${name}: открыта наружу и проверяет подлинность сама`, verifies,
      'verify_jwt = false без собственной проверки подписи — ручка со служебным ключом открыта всем')
  }

  const orphaned = [...declaredPublic].filter((n) => !names.includes(n))
  check('в манифесте нет публичных записей без функции', orphaned.length === 0, orphaned.join(', '))
}

if (failed) {
  console.error(`${failed} auth/RLS contract(s) failed.`)
  process.exit(1)
}
console.log('All auth/RLS hardening contracts passed.')
