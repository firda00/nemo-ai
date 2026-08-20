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
const agentShared = read('supabase/functions/_shared/agent.ts')
const deploy = read('deploy.ps1')
const leadsMigration = read('supabase/migrations/20260714090000_leads_concurrency.sql')
// every edge-function source file, for repo-wide "no direct leads writes" scanning
const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : e.name.endsWith('.ts') ? [path.join(dir, e.name)] : []))
const allFunctionSources = walk(path.join(root, 'supabase/functions')).map((p) => fs.readFileSync(p, 'utf8')).join('\n')
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
check(10, 'Provider-key encryption at rest',
  /AES-GCM/.test(read('supabase/functions/_shared/secretBox.ts'))
    && /sealSecret\(key,\s*providerSecretContext\(accountId,\s*provider\)\)/.test(fn('connect-provider'))
    && /sealSecret\(key,\s*providerSecretContext\(accountId,\s*'openrouter'\)\)/.test(fn('connect-model'))
    && /provider_keys_ciphertext_only[\s\S]*enc:v\[12\]/i.test(migrations)
    && /revoke insert, update, delete on public\.provider_keys from anon, authenticated/i.test(migrations)
    && /revoke select on public\.provider_keys/i.test(migrations),
  'tenant/provider-bound AES-256-GCM; database rejects plaintext and browser DML')
check(11, 'Agent creation rate limit', /guard_agent_creation_rate[\s\S]*pg_advisory_xact_lock[\s\S]*recent_count >= 30/i.test(migrations), 'per-account creation bursts are serialized and capped')
check(12, 'Provider 429 retry', /res\.status === 429[\s\S]*retry-after[\s\S]*breakerUntil/i.test(llm), 'bounded retry, jitter and circuit breaker are present')
check(13, 'Voice balance limit', /token_balance, blocked/.test(makeCall) && /NO_CREDITS/.test(makeCall), 'blocked/zero-balance accounts cannot start paid calls')
check(14, 'Forged Stripe webhook', /stripe-signature/i.test(stripe) && /timingSafeEqual|crypto\.subtle\.verify|hmac/i.test(stripe), 'signature, timestamp and event id are verified')
check(15, 'Lead memory isolation', /dialogueId \? query\.eq\('dialogue_id'/.test(memory) && /loadMemory\(db, agent\.account_id, agent\.id, dialogueId\)/.test(read('supabase/functions/_shared/agent.ts')), 'memory is scoped to one account, agent, and dialogue/lead')
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
check(26, 'Direct admin URL', /if \(!isAdmin\)/.test(read('src/pages/app/AdminPage.tsx')) && /if \(!me\?\.is_admin\).*403/.test(fn('admin-api')) && /hasAal2\(authHeader\)/.test(fn('admin-api')), 'UI denies non-admin users; API independently requires admin role and an AAL2 session')
check(27, 'Revoked Google OAuth', /invalid_grant/.test(read('supabase/functions/_shared/google.ts')) && /from\('google_accounts'\)\.delete/.test(read('supabase/functions/_shared/google.ts')), 'revoked credentials are removed while Nemo login remains independent')
check(28, 'Takeover metadata spoofing', /\.eq\('id', dialogue_id\)/.test(operator) && /channel\?\.type === dialogue\.channel/.test(operator), 'delivery channel and agent are loaded from owned database rows')
// per-function SQL bodies (assertions must not be satisfied by comments or other functions)
const sqlFnBody = (name) => leadsMigration.match(new RegExp(`create or replace function public\\.${name}\\([^)]*\\)[\\s\\S]*?\\$\\$;`, 'i'))?.[0] ?? ''
const mergeFn = sqlFnBody('merge_lead_fields')
const claimFn = sqlFnBody('claim_lead_crm_push')
const finishFn = sqlFnBody('finish_lead_crm_push')
const tenantChain = (body) => /join public\.agents a on a\.id = d\.agent_id/.test(body) && /a\.account_id = p_account_id/.test(body)
const rpcSignatures = ['merge_lead_fields(uuid, uuid, jsonb)', 'claim_lead_crm_push(uuid, uuid)', 'finish_lead_crm_push(uuid, uuid, uuid, text)']
check(29, 'Concurrent CRM subagents',
  Boolean(mergeFn && claimFn && finishFn)
    && [mergeFn, claimFn, finishFn].every((body) => /security invoker/.test(body) && /set search_path = ''/.test(body) && tenantChain(body))
    && /pg_advisory_xact_lock/.test(mergeFn) && /fields \|\| p_patch/.test(mergeFn)
    && /pushed_to_crm = false/.test(claimFn) && /interval '10 minutes'/.test(claimFn)
    && /crm_push_claim = p_token/.test(finishFn)
    && rpcSignatures.every((sig) => leadsMigration.includes(`revoke all on function public.${sig} from public, anon, authenticated`) && leadsMigration.includes(`grant execute on function public.${sig} to service_role`))
    && /drop policy if exists leads_acc on public\.leads/.test(leadsMigration)
    && /create policy leads_select_acc on public\.leads for select to authenticated/.test(leadsMigration)
    && /revoke insert, update, delete on public\.leads from anon, authenticated/.test(leadsMigration)
    && /rpc\('merge_lead_fields'/.test(agentShared)
    && /rpc\('claim_lead_crm_push'/.test(agentShared)
    && /rpc\('finish_lead_crm_push'/.test(agentShared)
    && !/from\s*\(\s*['"`]leads['"`]\s*\)\s*\.\s*(insert|update|upsert|delete)/.test(allFunctionSources)
    && /20260714090000_leads_concurrency\.sql/.test(deploy)
    && ['merge_lead_fields(uuid,uuid,jsonb)', 'claim_lead_crm_push(uuid,uuid)', 'finish_lead_crm_push(uuid,uuid,uuid,text)'].every((sig) => deploy.includes(sig)),
  'same-dialogue lead writes are serialized and merged atomically in SQL, browser DML on leads is revoked, and the CRM push is single-claimant behind a self-expiring lease')
check(30, 'Empty/broken knowledge JSON', /req\.json\(\)\.catch\(\(\) => \(\{\}\)\)/.test(knowledge), 'invalid bodies are bounded and rejected without raw SQL')
check(31, 'Worker lease browser access',
  /alter table public\.worker_lease enable row level security/i.test(migrations)
    && /revoke all on table public\.worker_lease from anon, authenticated/i.test(migrations),
  'worker lease is service-role infrastructure and cannot be accessed directly by browser roles')
check(32, 'Telegram queue RPC access',
  /revoke all on function public\.q_send\(jsonb\) from public, anon, authenticated/i.test(migrations)
    && /revoke all on function public\.q_read\(int,\s*int\) from public, anon, authenticated/i.test(migrations)
    && /revoke all on function public\.q_delete\(bigint\) from public, anon, authenticated/i.test(migrations)
    && /revoke all on function public\.q_len\(\) from public, anon, authenticated/i.test(migrations)
    && /grant execute on function public\.q_send\(jsonb\), public\.q_read\(int,\s*int\), public\.q_delete\(bigint\), public\.q_len\(\) to service_role/i.test(migrations),
  'queue payloads and queue controls are service-role only')
check(33, 'Agent memory tenant integrity',
  /enforce_agent_memory_tenant[\s\S]*agent does not belong to memory account/i.test(migrations)
    && /revoke insert, update, delete on public\.agent_memory from anon, authenticated/i.test(migrations)
    && /eq\('account_id', accountId\)[\s\S]*eq\('agent_id', agentId\)/.test(memory),
  'memory references are account-consistent and browser roles cannot inject durable prompt context')
check(34, 'Agent evolution tenant integrity',
  /enforce_agent_evolution_tenant[\s\S]*agent does not belong to evolution account/i.test(migrations)
    && /revoke insert, update, delete on public\.agent_evolutions from anon, authenticated/i.test(migrations),
  'evolution audit rows are server-generated and cannot reference a foreign agent')
check(35, 'Checkout redirect origin',
  /trustedAppOrigin\(req\)/.test(read('supabase/functions/create-checkout/index.ts')),
  'Stripe return URLs use the configured application origin, never an arbitrary Origin header')
check(36, 'Operations health visibility',
  /create or replace function public\.is_platform_admin\(\)/i.test(migrations)
    && /where id = auth\.uid\(\)/i.test(migrations)
    && /using \(public\.is_platform_admin\(\)\)/i.test(migrations)
    && /grant execute on function public\.is_platform_admin\(\) to authenticated, service_role/i.test(migrations),
  'operations health is visible only to the authenticated platform administrator')
check(37, 'Operations monitoring scheduling',
  /'nemo-ops-watchdog-every-ten-minutes'/.test(deploy)
    && /'\*\/10 \* \* \* \*'/.test(deploy)
    && /functions\/v1\/ops-watchdog/.test(deploy)
    && /'nemo-daily-digest-tashkent'/.test(deploy)
    && /'5 3 \* \* \*'/.test(deploy)
    && /functions\/v1\/daily-digest/.test(deploy),
  'watchdog and daily digest are deployed and scheduled through pg_cron')
check(38, 'Browser task write barrier',
  /validateReadOnlyMarketplaceBrowserTask/.test(read('supabase/functions/_shared/browser.ts'))
    && /READ_ONLY_MARKETPLACE_HOSTS/.test(read('supabase/functions/_shared/browser.ts'))
    && /validateReadOnlyMarketplaceBrowserTask\(url, taskText\)/.test(fn('agent-tool'))
    && /validateReadOnlyMarketplaceBrowserTask\(url, taskText\)/.test(read('supabase/functions/_shared/tools.ts')),
  'browser tasks are limited to approved marketplace domains and read-only work until owner approvals exist')

/*
 * 39. КОНТУР НА СВОЁМ СЕРВЕРЕ НЕ ВЫСТАВЛЯЕТ БАЗУ И ШЛЮЗ НАРУЖУ.
 *
 * UFW НЕ ЗАКРЫВАЕТ ПОРТЫ, ОПУБЛИКОВАННЫЕ DOCKER'ОМ: правила Docker живут в цепочке DOCKER-USER и
 * срабатывают раньше. Строка `ports: "5432:5432"`, добавленная на вечер отладки, открывает базу
 * интернету — при том что `ufw status` продолжает показывать «deny incoming» и выглядит настроенным.
 * На Oracle Cloud с белым IP такое находят сканером в первые сутки.
 *
 * Единственная защита — не публиковать порт вовсе. Проверяется РАЗБОРОМ YAML, а не поиском строки:
 * `ports:` можно записать десятком способов, и текстовый поиск обходится случайно.
 */
{
  const { parse } = await import('yaml')
  const compose = parse(read('docker-compose.prod.yml'))
  const services = compose.services ?? {}

  const exposed = Object.entries(services)
    .filter(([name]) => name !== 'caddy')
    .filter(([, service]) => Array.isArray(service?.ports) && service.ports.length > 0)
    .map(([name]) => name)
  check(39, 'Self-hosted contour keeps the database private', exposed.length === 0,
    exposed.length ? `порты опубликованы наружу: ${exposed.join(', ')}` : 'наружу выведен только Caddy (80/443)')

  const dbNetworks = services.postgres?.networks ?? []
  check(40, 'Database sits on an egress-free network',
    compose.networks?.backend?.internal === true
    && Array.isArray(dbNetworks) && dbNetworks.length === 1 && dbNetworks[0] === 'backend',
    'postgres подключён только к backend, а backend помечен internal: true')

  /*
   * Пароль и служебный ключ обязаны приходить переменными, а не лежать в файле под гитом.
   *
   * Проверяется КЛЮЧ YAML в начале строки, а не имя где угодно в тексте. Первая редакция искала
   * `POSTGRES_PASSWORD:` подстрокой — и находила его ВНУТРИ самой подстановки
   * `${POSTGRES_PASSWORD:?сообщение}`, объявляя дефект на исправном файле.
   */
  const raw = read('docker-compose.prod.yml')
  const literal = [...raw.matchAll(/^\s+(POSTGRES_PASSWORD|SUPABASE_SERVICE_ROLE_KEY|SUPABASE_SECRET_KEY|OPENROUTER_API_KEY|NEMO_TOKEN_PEPPER):\s*(.+)$/gm)]
    .filter(([, , value]) => !value.trim().startsWith('$'))
    .map(([, key]) => key)
  check(41, 'No literal secrets in the compose file', literal.length === 0,
    literal.length ? `вписаны значением: ${literal.join(', ')}` : 'секреты подставляются из окружения')

  /*
   * 42. КАЖДАЯ ПЕРЕМЕННАЯ КОНТУРА ОБЪЯВЛЕНА В ОБРАЗЦЕ.
   *
   * Переменная, которую compose читает, но образец не упоминает, — это «поднялось и не работает» на
   * чужой машине. У части из них есть значение по умолчанию, и тогда отказ ещё и молчаливый:
   * GOTRUE_URI_ALLOW_LIST пустым разрешит ровно один адрес возврата, и вход с любого другого
   * оборвётся без объяснений. Человек, разворачивающий контур, обязан узнать о переменной из
   * образца, а не из чужого журнала.
   */
  const declaredEnv = new Set(
    read('deploy/.env.server.example').split(/\r?\n/)
      .map((line) => line.split('=')[0].trim())
      .filter((key) => /^[A-Z_][A-Z0-9_]*$/.test(key)),
  )
  const usedEnv = [...new Set([...raw.matchAll(/\$\{([A-Z_][A-Z0-9_]*)[:?}-]/g)].map((m) => m[1]))]
  const undeclared = usedEnv.filter((key) => !declaredEnv.has(key))
  check(42, 'Every contour variable is documented', undeclared.length === 0,
    undeclared.length ? `нет в deploy/.env.server.example: ${undeclared.join(', ')}` : `${usedEnv.length} переменных объявлены`)

  /*
   * 43. ПУБЛИЧНЫЙ КЛЮЧ И СЛУЖЕБНЫЙ НЕ ПЕРЕПУТАНЫ МЕСТАМИ.
   *
   * ANON_KEY уезжает в браузер как VITE_SUPABASE_ANON_KEY. SERVICE_ROLE_KEY обходит RLS целиком.
   * Подстановка второго в сборку фронтенда выдала бы каждому посетителю права, которыми не
   * ограничена ни одна политика, — и выглядело бы это как полностью рабочее приложение.
   */
  const frontendArgs = JSON.stringify(services.caddy?.build?.args ?? {})
  check(43, 'Service-role key never reaches the frontend build', !/SERVICE_ROLE_KEY/.test(frontendArgs),
    'в аргументы сборки фронтенда уходит только ANON_KEY')
}

/*
 * 44–45. СПИСОК РАЗРЕШЁННЫХ ИСТОЧНИКОВ ЗАПРОСА.
 *
 * Здесь уже случился отказ, и он был шире, чем выглядел: боевого адреса фронтенда в списке не
 * было, предзапрос получал 403 ещё до функции, и БРАУЗЕР НЕ МОГ ВЫЗВАТЬ НИ ОДНУ Edge Function из
 * выложенного приложения. Снаружи это выглядело как «не удалось сохранить onboarding» — одна
 * видимая кнопка из нескольких десятков молча неработающих вызовов. В разработке всё было
 * исправно: localhost в списке есть.
 *
 * Проверяется НАСТОЯЩАЯ функция, вынутая из исходника и исполненная, а не наличие строк: список
 * можно расширить так, что текст останется похожим, а смысл изменится.
 */
{
  const source = read('supabase/functions/_shared/cors.ts')

  /*
   * Вынимаем константы и саму функцию, подменяя Deno.env заглушкой.
   *
   * Аннотации типов снимаются: new Function разбирает JavaScript, и `origin: string` для него —
   * синтаксическая ошибка. Снимаются ТОЧЕЧНО, только у параметров и возвращаемых значений: общая
   * замена «двоеточие и слово» съела бы объектные литералы и сама сломала бы разбор.
   */
  const slice = source
    .slice(source.indexOf('const PROD_ORIGIN'), source.indexOf('/** A safe browser return origin'))
    .replace(/\(([A-Za-z_$][\w$]*): [A-Za-z<>[\]|]+\)/g, '($1)')
    .replace(/\):\s*(?:string|boolean|void)\s*\{/g, ') {')
  const build = (env) => new Function('Deno', `${slice}; return originAllowed`)({ env: { get: (k) => env[k] } })

  /*
   * ОКРУЖЕНИЕ ПУСТОЕ НАМЕРЕННО.
   *
   * Первая редакция подставляла APP_URL с боевым адресом — и мутация «убрать этот адрес из списка
   * в коде» ВЫЖИЛА: переменная прикрывала пропажу. Но переменная окружения — настройка развёртывания,
   * её теряют при пересоздании проекта; список в коде обязан работать сам.
   */
  const allowed = build({})

  const MUST_PASS = [
    'https://nemo-ai-firda00s-projects.vercel.app',
    'https://nemo-ai-swart.vercel.app',
    'https://nemoai.uz',
    'https://app.nemoai.uz',
    'http://localhost:5173',
    '', // сервер-серверный вызов Origin не шлёт
  ]
  const MUST_FAIL = [
    // Любой человек за пять минут разворачивает свой сайт на vercel.app. Разрешив зону целиком,
    // мы позволили бы его странице обращаться к нашим функциям с токеном вошедшего пользователя.
    'https://evil-attacker.vercel.app',
    // Похожее имя — самый дешёвый обход проверки «содержит nemoai.uz».
    'https://nemoai.uz.evil.com',
    'https://notnemoai.uz',
    'http://nemoai.uz',                       // без шифрования
    'https://nemo-ai-firda00s-projects.vercel.app.evil.com',
    'chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', // чужое расширение
  ]

  const wrongPass = MUST_PASS.filter((origin) => !allowed(origin))
  const wrongFail = MUST_FAIL.filter((origin) => allowed(origin))
  check(44, 'Production origins can call the functions', wrongPass.length === 0,
    wrongPass.length ? `заблокированы: ${wrongPass.map((o) => o || '(пусто)').join(', ')}` : `${MUST_PASS.length} адресов`)
  check(45, 'Look-alike and foreign origins stay blocked', wrongFail.length === 0,
    wrongFail.length ? `ПРОПУЩЕНЫ: ${wrongFail.join(', ')}` : `${MUST_FAIL.length} адресов отклонено`)

  /*
   * Подстановка в списке сводит проверку на нет, и по тексту это незаметно.
   *
   * Смотрим на КОД БЕЗ КОММЕНТАРИЕВ. Первая редакция падала на исправном файле: в комментарии
   * рядом со списком «*.vercel.app» упомянут ровно затем, чтобы объяснить, почему так нельзя.
   * Пятый случай этого класса в репозитории — проверка ловит собственное объяснение.
   */
  const executable = slice
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/^\s*\/\/.*$/gm, '')
  check(46, 'The allowlist carries no wildcards', !/\*\.[a-z]/.test(executable) && !/\.endsWith\(['"]\.[a-z]/.test(executable),
    'источники перечислены поимённо')
}

fs.writeFileSync(path.join(root, 'agent-hub/security-contracts-report.json'), JSON.stringify({ generated_at: new Date().toISOString(), failed, partial, rows }, null, 2))
console.log(`Security contracts: ${rows.length - failed - partial} PASS, ${partial} PARTIAL, ${failed} FAIL.`)
if (failed) process.exit(1)
