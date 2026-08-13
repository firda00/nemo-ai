import assert from 'node:assert/strict'
import {
  SUBMIT_MESSAGES,
  classifyProviderResponse,
  decideSubmit,
  ownerMessage,
  retryable,
} from '../supabase/functions/_shared/listingSubmit.ts'

const ready = {
  status: 'ready',
  title_ru: 'Антистресс-брелок',
  title_uz: null,
  uzum_category: 'Игрушки-антистресс',
  missing: [],
}
const allowed = { draft: ready, isOwner: true, entitled: true }

// --- Порядок отказов ---------------------------------------------------------------------------
// Сначала то, что владелец НЕ может исправить в карточке, потом то, что может. Иначе он услышит
// «заполните категорию», исправит её и упрётся в замок подписки, о котором не сказали сразу.

assert.deepEqual(decideSubmit(allowed), { attempt: true })
assert.equal(decideSubmit({ ...allowed, isOwner: false }).reason, 'not_owner')
// Замок подписки проверяется РАНЬШЕ готовности карточки — даже если карточка вообще пустая.
assert.equal(decideSubmit({ draft: null, isOwner: true, entitled: false }).reason, 'subscription_locked')
assert.equal(decideSubmit({ ...allowed, entitled: false }).reason, 'subscription_locked')
// И раньше прав сотрудника не проверяется ничего: чужая роль важнее пустого черновика.
assert.equal(decideSubmit({ draft: null, isOwner: false, entitled: false }).reason, 'not_owner')

// --- Что именно отправляется -------------------------------------------------------------------

assert.equal(decideSubmit({ ...allowed, draft: null }).reason, 'not_ready')
// «Полная автономия» решает КОГДА отправить одобренное, а не отменяет одобрение.
assert.equal(decideSubmit({ ...allowed, draft: { ...ready, status: 'draft' } }).reason, 'not_ready')
assert.equal(decideSubmit({ ...allowed, draft: { ...ready, status: 'discarded' } }).reason, 'not_ready')
// Повторная отправка создала бы дубль в чужом кабинете, и разбирать его пришлось бы руками.
assert.equal(decideSubmit({ ...allowed, draft: { ...ready, status: 'submitted' } }).reason, 'already_submitted')

// Карточка без названия или категории не пройдёт модерацию: сутки ожидания ради известного отказа.
assert.equal(decideSubmit({ ...allowed, draft: { ...ready, title_ru: null } }).reason, 'incomplete')
assert.equal(decideSubmit({ ...allowed, draft: { ...ready, title_ru: '   ' } }).reason, 'incomplete', 'пробелы — не название')
assert.deepEqual(decideSubmit({ ...allowed, draft: { ...ready, title_ru: null, title_uz: 'Antistress' } }), { attempt: true },
  'узбекского названия достаточно')
assert.equal(decideSubmit({ ...allowed, draft: { ...ready, uzum_category: null } }).reason, 'incomplete')
assert.equal(decideSubmit({ ...allowed, draft: { ...ready, missing: ['unit_cost_tiyin'] } }).reason, 'incomplete')

// --- Как читается ответ площадки ----------------------------------------------------------------
// 403 отделён от прочих отказов намеренно: это не поломка и не ошибка владельца. Тот, кому
// показали «ошибка 403», идёт проверять интернет; тот, кому назвали причину, идёт за правами.

assert.deepEqual(classifyProviderResponse(403), { status: 'refused', reason: 'no_write_access' })
assert.deepEqual(classifyProviderResponse(401), { status: 'refused', reason: 'no_write_access' })
assert.equal(classifyProviderResponse(200).status, 'sent')
assert.equal(classifyProviderResponse(201).status, 'sent')
assert.equal(classifyProviderResponse(400).reason, 'provider_rejected')
assert.equal(classifyProviderResponse(422).reason, 'provider_rejected')
// Недоступность — не приговор карточке, и говорить о ней надо иначе, чем об отказе.
for (const code of [0, 429, 500, 502, 503]) {
  assert.equal(classifyProviderResponse(code).reason, 'provider_unavailable', `HTTP ${code}`)
}
assert.equal(retryable('provider_unavailable'), true)
assert.equal(retryable('no_write_access'), false, 'повторять нечего — прав не прибавится')
assert.equal(retryable('incomplete'), false)

// --- Что прочитает владелец ---------------------------------------------------------------------
// Каждая строка обязана называть СЛЕДУЮЩИЙ ШАГ. «Не удалось отправить» — это извинение, а не
// сообщение: прочитав его, продавец не знает, чинить карточку, подписку или ничего.

for (const [reason, block] of Object.entries(SUBMIT_MESSAGES)) {
  for (const lang of ['ru', 'uz', 'en']) {
    assert.ok(block[lang] && block[lang].length > 20, `${reason}.${lang} — сообщение видит владелец`)
  }
  assert.ok(!/undefined|null|\bTODO\b/.test(block.ru), `${reason}: в текст не течёт мусор`)
}

// Самое важное сообщение: оно объясняет проверенный факт и отправляет туда, где это решается.
assert.ok(SUBMIT_MESSAGES.no_write_access.ru.includes('403'))
assert.ok(SUBMIT_MESSAGES.no_write_access.ru.includes('поддержк'), 'названо, к кому идти')
assert.ok(SUBMIT_MESSAGES.no_write_access.ru.includes('чтение каталога работает'),
  'сказано, что ключ рабочий — иначе владелец пойдёт его перевыпускать')

// Замок подписки обязан пообещать сохранность данных: это правило продукта, а не вежливость.
assert.ok(SUBMIT_MESSAGES.subscription_locked.ru.includes('остаются доступными'))

assert.equal(ownerMessage('no_key', 'uz'), SUBMIT_MESSAGES.no_key.uz)
assert.equal(ownerMessage('no_key', 'en'), SUBMIT_MESSAGES.no_key.en)
assert.equal(ownerMessage('no_key', 'fr'), SUBMIT_MESSAGES.no_key.ru, 'неизвестный язык — русский, а не пусто')
assert.equal(ownerMessage('no_key', ''), SUBMIT_MESSAGES.no_key.ru)

console.log('[OK] Listing submit behaviour: 47 assertions')
