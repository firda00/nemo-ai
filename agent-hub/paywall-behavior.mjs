import assert from 'node:assert/strict'
import { payloadOf, paywallFrom } from '../src/lib/paywall.ts'

// --- Тело отказа лежит НЕ в data --------------------------------------------------------------
// `supabase.functions.invoke` на любой не-2xx возвращает FunctionsHttpError с data === null, а
// исходный Response прячет в error.context. Наивная проверка `data.error === 'subscription_required'`
// не сработала бы никогда: владелец видел бы «не удалось собрать черновик» и не узнал бы про
// подписку.

const lockedBody = { error: 'subscription_required', reason: 'trial_expired', message: 'Пробные три дня закончились.' }
const httpError = { context: { json: async () => lockedBody } }

assert.deepEqual(await payloadOf(httpError, null), lockedBody, 'тело читается из error.context')
assert.deepEqual(await payloadOf(null, { ok: true }), { ok: true }, 'при 2xx берётся data')
// data главнее: если оба есть, читать Response второй раз нельзя — он уже вычитан.
assert.deepEqual(await payloadOf(httpError, { ok: true }), { ok: true })

// Битое тело не роняет страницу: разобранный ответ здесь бонус, а не обязательство.
assert.equal(await payloadOf({ context: { json: async () => { throw new Error('not json') } } }, null), null)
assert.equal(await payloadOf(new Error('network down'), null), null, 'обычная ошибка без context')
assert.equal(await payloadOf(null, null), null)

// --- Пейволл узнаётся по строке, а не по коду -------------------------------------------------

const locked = paywallFrom(lockedBody)
assert.equal(locked.reason, 'trial_expired')
assert.equal(locked.message, 'Пробные три дня закончились.', 'слово сервера доходит до экрана дословно')

// Причина по умолчанию есть всегда: без неё заголовок окна был бы пустым.
assert.equal(paywallFrom({ error: 'subscription_required' }).reason, 'trial_expired')
assert.equal(paywallFrom({ error: 'subscription_required' }).message, '', 'нет текста — нет и выдуманного текста')
assert.equal(paywallFrom({ error: 'subscription_required', message: '   ' }).message, '')

// Всё остальное — не пейволл, и подменять им обычную ошибку нельзя.
for (const other of [
  null,
  { ok: true },
  { error: 'draft still missing inputs' },
  { error: 'owner role required' },
  { reason: 'trial_expired' },
]) {
  assert.equal(paywallFrom(other), null, `не пейволл: ${JSON.stringify(other)}`)
}

console.log('[OK] Paywall behaviour: 15 assertions')
