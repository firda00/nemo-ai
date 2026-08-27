import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const functionsRoot = path.join(root, 'supabase', 'functions')
const migrationsRoot = path.join(root, 'supabase', 'migrations')
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
// 30 после касс Payme и Click, 32 после формы waitlist, 33 после кассы Uzum. Публичны они по
// необходимости: ни платёжный провайдер, ни незалогиненный посетитель формы не пришлют JWT
// Supabase; авторизация своя — Basic/подпись у касс, honeypot + HMAC-лимит с обязательным перцем
// у waitlist.
assert.equal(publicFunctions.length, 37)
assert.equal(authenticatedFunctions.length, 49)
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
// Шлюз платформенных токенов публичен по той же причине, что и кассы: шлюз Supabase отверг бы
// заголовок `Bearer nemo_live_...` как невалидный JWT ещё до функции. Значит проверка целиком на нас,
// и она обязана ОТКАЗЫВАТЬ при недостающем секрете, а не работать «пока без проверки» — иначе
// публичная функция принимала бы любой токен.
const sdrApiSource = fs.readFileSync(path.join(functionsRoot, 'sdr-api', 'index.ts'), 'utf8')
assert.match(sdrApiSource, /if \(!PEPPER\)/, 'public token gateway must fail closed without its pepper')
assert.match(sdrApiSource, /gateway_not_configured/, 'a gateway without a pepper must refuse, not accept')
assert.match(sdrApiSource, /authorizeAction\(row, action\)/, 'the gateway must run the deny-by-default action check')
assert.ok(
  !sdrApiSource.includes('runSdrPipeline'),
  'the gateway must enqueue, never run the multi-minute pipeline inside an Edge Function',
)

const computeApiSource = fs.readFileSync(path.join(functionsRoot, 'compute-worker-api', 'index.ts'), 'utf8')
assert.match(computeApiSource, /runtime_claim_compute_jobs/, 'compute broker exposes the fenced claim RPC')
assert.match(computeApiSource, /runtime_finish_compute_job/, 'compute broker exposes the fenced finish RPC')
assert.doesNotMatch(computeApiSource, /runtime_enqueue_compute_job/, 'render workers cannot enqueue arbitrary compute jobs')
assert.match(computeApiSource, /constantTimeTokenMatch/, 'compute broker verifies scoped tokens in constant time')

for (const [fn, provider] of [
  ['amocrm-event-hook', 'amocrm'],
  ['telegram-forge-hook', 'telegram'],
  ['uzum-event-hook', 'uzum'],
]) {
  const source = fs.readFileSync(path.join(functionsRoot, fn, 'index.ts'), 'utf8')
  assert.match(source, /handleForgeWebhook\(request,/, `${fn} must delegate to the tested Forge gateway`)
  assert.match(source, new RegExp(`provider:\\s*['\"]${provider}['\"]`), `${fn} must bind the expected provider`)
  assert.doesNotMatch(source, /JSON\.parse|request\.json\(/, `${fn} must not parse unverified payloads in its entry point`)
}

// Публичная форма waitlist: без перца достаточной длины функция обязана отказывать (503),
// а не принимать заявки с перебираемыми IP-хэшами.
const waitlistSource = fs.readFileSync(path.join(functionsRoot, 'waitlist', 'index.ts'), 'utf8')
assert.match(waitlistSource, /IP_PEPPER\.length < MIN_PEPPER/, 'public waitlist must fail closed without its pepper')
assert.match(waitlistSource, /unavailable/, 'a waitlist without a pepper must refuse, not accept')

/*
 * Касса Uzum отвечает 400 на отказ и 200 на успех — в отличие от Payme и Click, которые в этом
 * проекте намеренно всегда отдают 200. Перепутанный код здесь означает либо вечные ретраи банка,
 * либо сообщение об успехе там, где мы отказали.
 */
const uzumHandler = fs.readFileSync(path.join(functionsRoot, '_shared', 'uzumHandler.ts'), 'utf8')
assert.match(uzumHandler, /\(\{ status: 400, body: uzumFailure\(/, 'Uzum must answer 400 on failure')
// И обратная сторона: успех обязан быть 200. Одна проверка без другой ловит только половину
// перепутанных кодов.
assert.match(uzumHandler, /=> \(\{ status: 200, body \}\)/, 'Uzum success must be 200')
assert.doesNotMatch(uzumHandler, /status: 200, body: uzumFailure/, 'a refusal answered 200 reads to the bank as success')

// Basic проверяется ДО разбора тела: иначе касса становится справочником действующих счетов
// для любого, кто умеет слать POST — 10002 против 10007 это уже ответ.
const authAt = uzumHandler.indexOf('checkUzumAuth(req.authorization')
const bodyAt = uzumHandler.indexOf('parseUzumRequest(req.body)')
assert.ok(authAt > 0 && bodyAt > authAt, 'Uzum must check Basic before parsing the body')

/*
 * Переходник обязан ОСТАВАТЬСЯ переходником.
 *
 * Решения, переехавшие обратно в index.ts, перестают проверяться вызовом: под Node этот файл не
 * выполнить. Здесь сторожится ровно это — маршрутизация зовётся, а не переписывается заново.
 */
const uzumEntry = fs.readFileSync(path.join(functionsRoot, 'uzum-merchant', 'index.ts'), 'utf8')
assert.match(uzumEntry, /await handleUzum\(/, 'the Uzum entry point must delegate to the testable handler')
assert.doesNotMatch(uzumEntry, /UZUM_ERRORS\./, 'protocol decisions belong in uzumHandler.ts, where they are executed by tests')

/*
 * ДЕНЕЖНАЯ ЛОГИКА КАССЫ ЖИВЁТ В SQL, И ПРОВЕРЯЕТСЯ ОНА ЗДЕСЬ — ПО ТЕКСТУ.
 *
 * Честно про слабость этих проверок: они смотрят на исходник, а не выполняют его. Набор
 * uzum-merchant-behavior.mjs гоняет маршрутизацию с заглушкой базы и до SQL не достаёт, а
 * поднимать Postgres в гейте здесь нечем. Текстовая проверка ловит СНЯТИЕ защиты — именно то, что
 * случается при правке, — но не поймает защиту, написанную с ошибкой. Живой прогон миграции
 * остаётся отдельным шагом выкладки.
 *
 * Каждая строка ниже отвечает конкретной беде, а не «хорошему стилю».
 */
const uzumSql = fs.readFileSync(path.join(migrationsRoot, '20260822140000_uzum_merchant.sql'), 'utf8')

// Полный тариф за один тийин: /confirm суммы не знает, он доводит до конца созданное.
assert.match(uzumSql, /p_amount <> v_invoice\.amount_tiyin/, 'Uzum /create must verify the amount against the invoice')

// Второй путь начисления = вторая реализация правила «продлеваем от остатка, а не от сегодня».
assert.match(uzumSql, /v_applied := public\.apply_invoice_entitlement\(v_tx\.invoice_id\)/,
  'Uzum must credit through the shared entitlement RPC, not its own')

// Возврат денег после подтверждения обязан забирать и права: иначе /reverse — это способ
// получить тариф даром.
assert.match(uzumSql, /v_revoked := public\.revoke_invoice_entitlement\(v_tx\.invoice_id\)/,
  'a reversal after CONFIRMED must revoke the entitlement')

// Срок не уводится в прошлое дальше сегодняшнего дня: минус в подписке — это аккаунт, который не
// откроется даже после следующей оплаты, пока не «отработает» долг.
assert.match(uzumSql, /pg_catalog\.greatest\(\s*\r?\n?\s*pg_catalog\.now\(\),/,
  'a revoked entitlement must clamp paid_until at now(), never below')

// Одновременные /confirm и /reverse обязаны выстроиться в очередь: без блокировки оба прочитают
// CREATED, деньги вернутся покупателю, а тариф останется выданным.
for (const fn of ['uzum_confirm_transaction', 'uzum_reverse_transaction']) {
  const body = uzumSql.slice(uzumSql.indexOf(`function public.${fn}`))
  assert.match(body.slice(0, 900), /where trans_id = p_trans_id for update/,
    `${fn} must lock the transaction row before deciding`)
}

/*
 * У ТРАНЗАКЦИИ НЕТ СВОЕГО ВРЕМЕНИ ЖИЗНИ — СРОК ЕЙ ЗАДАЁТ СЧЁТ.
 *
 * apply_invoice_entitlement на expires_at не смотрит вовсе: ей достаточно, что начисления ещё не
 * было. Без этой проверки транзакцию, созданную полгода назад по давно протухшему счёту, можно
 * подтвердить сегодня и получить тариф по прошлогодней цене.
 */
assert.match(uzumSql, /v_invoice\.entitlement_applied_at is null and v_invoice\.expires_at <= pg_catalog\.now\(\)/,
  'confirm must re-check the invoice deadline, apply_invoice_entitlement does not')

/*
 * Счёт блокируется ДО проверок в /create.
 *
 * uzum_find_invoice читает без блокировки, и между чтением и вставкой другой провайдер успевает
 * закрыть тот же счёт: транзакция всё равно станет CREATED, а /confirm потом упрётся в уже
 * начисленный счёт и навсегда останется в CREATED.
 */
assert.match(uzumSql, /select \* into v_invoice from public\.billing_invoices where id = v_invoice\.id for update;/,
  'create must re-read the invoice under a row lock')

/*
 * Возврат восстанавливает ТАРИФ, а не только дни.
 *
 * Купили Starter, потом Business, Business вернули — дни сойдутся, а plan_code останется Business,
 * и покупатель продолжит пользоваться тем, за что ему вернули деньги.
 */
assert.match(uzumSql, /plan_code = coalesce\(v_plan, plan_code\)/, 'a reversal must restore the previous paid plan')

/*
 * Статус подписки берётся из РАЗРЕШЁННОГО схемой набора.
 *
 * billing_subscriptions разрешает trial, active, past_due, cancelled. Первая версия писала сюда
 * 'expired' — значения, которого в ограничении нет, — и возврат подтверждённого платежа откатился
 * бы целиком на constraint violation. Проверка ниже сверяется с самим ограничением, а не с
 * запомненным списком: разойтись они не смогут.
 */
{
  const subscriptions = fs.readFileSync(path.join(migrationsRoot, '20260811120000_billing_subscriptions.sql'), 'utf8')
  const allowed = new Set(
    (subscriptions.match(/status\s+text[^\n]*check \(status in \(([^)]*)\)\)/)?.[1] ?? '')
      .split(',').map((one) => one.trim().replace(/'/g, '')).filter(Boolean),
  )
  assert.ok(allowed.size >= 3, 'не удалось прочитать разрешённые статусы подписки')
  for (const written of uzumSql.matchAll(/status = case when v_until <= pg_catalog\.now\(\) then '([a-z_]+)' else '([a-z_]+)' end/g)) {
    for (const status of [written[1], written[2]]) {
      assert.ok(allowed.has(status), `revoke пишет в подписку статус «${status}», которого нет в ограничении схемы`)
    }
  }
}

// Уникальный конфликт различается по ИМЕНИ ограничения: иначе под «по брони уже есть транзакция»
// прячется любая наша поломка, и искать её будут у банка.
assert.match(uzumSql, /get stacked diagnostics v_constraint = constraint_name;/,
  'a unique violation must be told apart by constraint name, not guessed')

// UUID разбирается по точной форме: свободная пропускала тридцать шесть дефисов, а cast потом
// бросал исключение — банк получал «внутренняя ошибка» вместо «счёта нет».
assert.match(uzumSql, /\^\[0-9a-f\]\{8\}-\[0-9a-f\]\{4\}-\[0-9a-f\]\{4\}-\[0-9a-f\]\{4\}-\[0-9a-f\]\{12\}\$/,
  'order_id as UUID must be matched by exact shape')

/*
 * ПРОКСИРОВАНИЕ КАССЫ ЧЕРЕЗ VERCEL.
 *
 * Здесь, а не комментарием в vercel.json: у него строгая схема, и лишний ключ — даже «//» —
 * отвергается при выкладке с «Invalid vercel.json». Проверено собственным неудачным деплоем.
 *
 * Порядок правил решает всё: они применяются сверху вниз, а правило SPA перехватывает любой путь
 * без расширения — включая /api/uzum/check. Стоя вторым, правило кассы не сработает никогда, и
 * банк будет получать HTML главной страницы вместо ответа протокола.
 */
{
  const vercel = JSON.parse(fs.readFileSync(path.join(root, 'vercel.json'), 'utf8'))
  const rewrites = vercel.rewrites ?? []
  const uzumAt = rewrites.findIndex((one) => String(one.source).startsWith('/api/uzum'))
  const spaAt = rewrites.findIndex((one) => String(one.destination) === '/index.html')

  assert.ok(uzumAt >= 0, 'проксирование кассы Uzum исчезло из vercel.json')
  assert.ok(spaAt >= 0, 'правило SPA исчезло из vercel.json')
  assert.ok(uzumAt < spaAt, 'правило кассы стоит после SPA — банк получит HTML вместо ответа протокола')

  // Ручки перечислены поимённо: произвольный :action открыл бы наружу любой путь функции.
  assert.match(String(rewrites[uzumAt].source), /\(check\|create\|confirm\|reverse\|status\)/,
    'путь кассы открыт шаблоном — наружу уйдёт любой путь функции')
  // SPA обязана пропускать api/, иначе она снова перехватит запросы банка.
  assert.match(String(rewrites[spaAt].source), /\?!api\//, 'правило SPA снова перехватывает /api/')
  // Схема Vercel не терпит посторонних ключей — ни в одном правиле.
  for (const rule of rewrites) {
    assert.deepEqual(Object.keys(rule).sort(), ['destination', 'source'],
      'в правиле vercel.json лишний ключ — выкладка упадёт на проверке схемы')
  }
}

/*
 * ОШИБКА БАЗЫ — ИСКЛЮЧЕНИЕ, А НЕ ПУСТОЙ ОТВЕТ.
 *
 * Обоих обращений к базе это касается одинаково: и вызова RPC, и чтения транзакции для /status.
 * Проглоченная ошибка чтения превращается в 10014 «транзакции нет» — банк поверит, перестанет
 * спрашивать, а транзакция существует и деньги списаны.
 *
 * Считаются ОБА вхождения, а не проверяется наличие хотя бы одного: строка одинакова, и проверка
 * «встречается» осталась бы зелёной, потеряй мы любое из двух.
 */
assert.equal(
  (uzumEntry.match(/if \(error\) throw error/g) ?? []).length, 2,
  'both the RPC call and the /status read must surface a database error instead of swallowing it',
)

// Две живые транзакции на один счёт — два CONFIRMED и два списания у покупателя.
assert.match(uzumSql, /create unique index if not exists uzum_transactions_live_invoice_idx[\s\S]{0,200}where status in \('CREATED', 'CONFIRMED'\)/,
  'only one live transaction per invoice')

// Таблица платежей закрыта: телефон плательщика и источник платежа — не содержимое кабинета.
assert.match(uzumSql, /alter table public\.uzum_transactions enable row level security/, 'uzum_transactions needs RLS')
assert.match(uzumSql, /revoke all on public\.uzum_transactions from anon, authenticated/,
  'uzum_transactions must be revoked from application roles on top of RLS')
assert.doesNotMatch(uzumSql, /create policy [^\n]*on public\.uzum_transactions/,
  'a policy on uzum_transactions would open it to a client role')

// Все функции кассы — только service_role. Выданный anon доступ к ним означает кассу без кассира.
for (const fn of ['uzum_check_order', 'uzum_create_transaction', 'uzum_confirm_transaction', 'uzum_reverse_transaction', 'revoke_invoice_entitlement']) {
  assert.ok(
    new RegExp(`revoke all on function public\\.${fn}\\([^)]*\\) from public, anon, authenticated`).test(uzumSql),
    `${fn} must be revoked from public/anon/authenticated`,
  )
}

/*
 * Basic сравнивается ПОСТОЯННЫМ ВРЕМЕНЕМ.
 *
 * Единственная проверка в этом файле, которую нельзя сделать поведением: обычное === и
 * constantTimeEqual дают одинаковые ответы, разница только во времени. А по времени пароль
 * подбирается побайтово — за часы, а не за годы.
 */
const uzumBank = fs.readFileSync(path.join(functionsRoot, '_shared', 'uzumBank.ts'), 'utf8')
assert.match(uzumBank, /const userOk = constantTimeEqual\(/, 'Uzum login must be compared in constant time')
assert.match(uzumBank, /const passOk = constantTimeEqual\(/, 'Uzum password must be compared in constant time')

const qtest = fs.readFileSync(path.join(functionsRoot, 'qtest', 'index.ts'), 'utf8')
assert.match(qtest, /QTEST_ENABLED.*!== 'true'/, 'excluded staging load rig must remain disabled by default')

console.log(`Edge deployment manifest covers ${publicFunctions.length + authenticatedFunctions.length} production functions and ${excludedFunctions.length} explicit exclusion.`)
