// ЖИВАЯ проверка: двойное параллельное начисление по одному счёту.
//
// Требует боевых ключей и потому НЕ входит в npm run quality — гейт обязан быть воспроизводимым
// без доступа к продакшену. Запускать вручную после любой правки apply_invoice_entitlement:
//   set -a; . ./.secrets.local; set +a; node agent-hub/billing-entitlement-live.mjs
//
// Тест возвращает аккаунт ровно в исходное состояние. Работает на мёртвом тестовом аккаунте, а не
// на пилотном: играть подпиской продавца, который на ней работает, нельзя даже ради теста.
//
// Последовательный вызов проверил бы только ветку «уже начислено». Настоящая гонка — это два
// запроса, вышедшие одновременно из РАЗНЫХ сессий базы: именно так ретраит провайдер, и именно
// там ломается идемпотентность, построенная на чтении перед записью.
const ref = process.env.SUPABASE_PROJECT_REF
const key = process.env.SUPABASE_ACCESS_TOKEN

const sql = async (query) => {
  const res = await fetch(`https://api.supabase.com/v1/projects/${ref}/database/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
  })
  const body = await res.json()
  if (!res.ok) throw new Error(JSON.stringify(body))
  return body
}

// Тестовый аккаунт — любой из мёртвых июльских, но НЕ пилотный.
const [{ id: account }] = await sql(
  `select id from public.accounts where id <> '319eac6f-72e0-4664-a45f-da7474efd999' order by created_at limit 1`,
)
console.log('тестовый аккаунт:', account)

const before = await sql(`select status, paid_until from public.billing_subscriptions where account_id = '${account}'`)
console.log('до:', JSON.stringify(before[0] ?? null))

const [{ id: invoice }] = await sql(`
  insert into public.billing_invoices (account_id, plan_code, amount_tiyin, duration_days)
  values ('${account}', 'test-concurrency', 29000000, 30)
  returning id`)
console.log('счёт:', invoice)

// Оба запроса уходят ДО того, как любой из них ответит.
const [a, b] = await Promise.all([
  sql(`select public.apply_invoice_entitlement('${invoice}') as r`),
  sql(`select public.apply_invoice_entitlement('${invoice}') as r`),
])
const results = [a[0].r, b[0].r]
console.log('ответ 1:', JSON.stringify(results[0]))
console.log('ответ 2:', JSON.stringify(results[1]))

const applied = results.filter((r) => r.ok && r.already_applied === false)
const repeats = results.filter((r) => r.ok && r.already_applied === true)
const after = await sql(`select status, paid_until from public.billing_subscriptions where account_id = '${account}'`)

console.log('\n--- проверки ---')
console.log('начислено ровно один раз:', applied.length === 1)
console.log('второй ответил «уже начислено»:', repeats.length === 1)
console.log('обе даты совпадают:', String(results[0].paid_until) === String(results[1].paid_until))
console.log('после:', JSON.stringify(after[0]))

// Ровно 30 дней от now(), а не 60: два вызова не должны сложиться.
const granted = (new Date(after[0].paid_until) - Date.now()) / 86_400_000
console.log('выдано дней:', granted.toFixed(2), '→ ожидалось ~30:', Math.abs(granted - 30) < 0.1)

// Третий вызов — уже после всего — тоже не должен ничего добавить.
const third = (await sql(`select public.apply_invoice_entitlement('${invoice}') as r`))[0].r
const afterThird = await sql(`select paid_until from public.billing_subscriptions where account_id = '${account}'`)
console.log('поздний ретрай не продлил:', String(afterThird[0].paid_until) === String(after[0].paid_until), '|', JSON.stringify(third.already_applied))

// Условия счёта неизменны после выставления.
let frozen = false
try { await sql(`update public.billing_invoices set amount_tiyin = 1 where id = '${invoice}'`) }
catch { frozen = true }
console.log('сумму счёта изменить нельзя:', frozen)

// Уборка: аккаунт возвращается ровно в то состояние, в каком был.
await sql(`delete from public.billing_invoices where id = '${invoice}'`)
const prev = before[0]
await sql(prev
  ? `update public.billing_subscriptions set status = '${prev.status}', paid_until = ${prev.paid_until ? `'${prev.paid_until}'` : 'null'}, plan_code = null where account_id = '${account}'`
  : `delete from public.billing_subscriptions where account_id = '${account}'`)
const restored = await sql(`select status, paid_until from public.billing_subscriptions where account_id = '${account}'`)
console.log('состояние восстановлено:', JSON.stringify(restored[0] ?? null))

const passed = applied.length === 1 && repeats.length === 1
  && String(results[0].paid_until) === String(results[1].paid_until)
  && Math.abs(granted - 30) < 0.1
  && String(afterThird[0].paid_until) === String(after[0].paid_until)
  && frozen
if (!passed) { console.error('[FAIL] начисление НЕ идемпотентно'); process.exit(1) }
console.log('\n[OK] Billing entitlement: начисление ровно один раз при гонке')