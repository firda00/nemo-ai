import assert from 'node:assert/strict'
import { entitled, lockMessage, TRIAL_DAYS } from '../supabase/functions/_shared/entitlement.ts'

const NOW = new Date('2026-08-11T12:00:00Z')
const daysAgo = (n) => new Date(NOW.getTime() - n * 86_400_000).toISOString()
const daysAhead = (n) => new Date(NOW.getTime() + n * 86_400_000).toISOString()
const check = (subscription, accountCreatedAt, trialAllowed) => entitled({ subscription, accountCreatedAt, trialAllowed, now: NOW })

// --- Триал считается от создания аккаунта -----------------------------------------------------
// Не от первого платежа и не от первого входа: иначе «три дня» начинались бы в момент, который
// никто не может назвать, и два аккаунта было бы нечем сравнить.

assert.equal(TRIAL_DAYS, 3)

const fresh = check(null, daysAgo(1))
assert.equal(fresh.allowed, true, 'первый день триала — доступ есть')
assert.equal(fresh.trial_days_left, 2, 'и владельцу видно, сколько осталось')

assert.equal(check(null, daysAgo(2.5)).allowed, true, 'последние часы триала всё ещё триал')
const lapsed = check(null, daysAgo(4))
assert.equal(lapsed.allowed, false, 'четвёртый день — замок')
assert.equal(lapsed.reason, 'trial_expired')
assert.equal(lapsed.trial_days_left, 0)

// Явная дата в подписке главнее вычисленной: продлённый вручную триал обязан работать.
assert.equal(check({ status: 'trial', trial_ends_at: daysAhead(10), paid_until: null }, daysAgo(30)).allowed, true)

// --- Оплаченная подписка ----------------------------------------------------------------------

assert.equal(check({ status: 'active', trial_ends_at: null, paid_until: daysAhead(20) }, daysAgo(90)).allowed, true)
const overdue = check({ status: 'active', trial_ends_at: null, paid_until: daysAgo(1) }, daysAgo(90))
assert.equal(overdue.allowed, false, 'оплаченный срок кончился — замок, даже при статусе active')
assert.equal(overdue.reason, 'subscription_expired')

// Активная подписка без даты — это пробел платёжного модуля, а не вина владельца.
assert.equal(check({ status: 'active', trial_ends_at: null, paid_until: null }, daysAgo(90)).allowed, true)

assert.equal(check({ status: 'past_due', trial_ends_at: null, paid_until: daysAgo(3) }, daysAgo(90)).reason, 'subscription_expired')
assert.equal(check({ status: 'cancelled', trial_ends_at: null, paid_until: null }, daysAgo(90)).reason, 'cancelled')

// --- Пробелы в данных не превращаются в отказ -------------------------------------------------
// Аккаунты, созданные до появления биллинга, строки подписки не имеют. Трактовать её отсутствие
// как «не оплачено» значило бы в день выката отключить всех существующих клиентов разом.

assert.equal(check(null, null).allowed, true, 'ни подписки, ни даты — доступ, а не тихий отказ')
assert.equal(check(null, 'не дата').allowed, true, 'испорченная дата тоже не повод отключить')

// --- Отказ говорит и то, что данные на месте --------------------------------------------------
// Иначе владелец решит, что потерял каталог, и уйдёт вместо того, чтобы оплатить.

assert.equal(lockMessage(fresh), '', 'когда доступ есть, сказать нечего')
const text = lockMessage(lapsed)
assert.ok(text.includes('Пробные три дня закончились'))
assert.ok(text.includes('остаётся доступным'), 'отказ обязан сказать, что данные не отобрали')
assert.ok(lockMessage(overdue).includes('Срок подписки истёк'))

// --- Магазин, уже отработавший триал -----------------------------------------------------------
// Триал по почте обходится новым ящиком раз в три дня и стоит ноль. Привязка к магазину поднимает
// цену обхода до «другой настоящий магазин».

const taken = check(null, daysAgo(1), false)
assert.equal(taken.allowed, false, 'магазин уже пробовал Nemo под другой почтой')
assert.equal(taken.reason, 'trial_taken')
assert.ok(lockMessage(taken).includes('по этому магазину уже был использован'), 'отказ называет причину, а не «закрыто»')
assert.ok(lockMessage(taken).includes('остаётся доступным'), 'и по-прежнему говорит, что данные на месте')

// ЗАПЛАТИЛ — работает, чей бы магазин ни был. Правило про бесплатный период, а не про доступ.
assert.equal(check({ status: 'active', trial_ends_at: null, paid_until: daysAhead(10) }, daysAgo(90), false).allowed, true)

// Неизвестность трактуется в пользу владельца: сбой запроса о магазине не должен закрывать доступ.
assert.equal(check(null, daysAgo(1), undefined).allowed, true, 'по умолчанию право есть')
assert.equal(check(null, daysAgo(1), true).allowed, true)

console.log('[OK] Entitlement behaviour: 24 assertions')
