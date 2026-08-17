// Платформенные токены: разрешения и отпечаток.
//
// Здесь проверяется не «обычно работает», а «неправильное НЕ проходит». Утёкший долгоживущий ключ —
// главный риск этой части системы, и каждая проверка ниже соответствует конкретному способу
// превратить его в доступ, которого выдавать не собирались.

import assert from 'node:assert/strict'
import {
  REFUSAL_STATUS,
  SDR_ACTIONS,
  TOKEN_PREFIX,
  TOKEN_SHAPE,
  authorizeAction,
  generateToken,
  hashToken,
  tokenFromHeader,
} from '../supabase/functions/_shared/apiTokens.ts'

// --- Форма токена ---------------------------------------------------------------------------------

{
  const token = generateToken()
  assert.ok(TOKEN_SHAPE.test(token), 'выданный токен должен проходить собственную проверку формы')
  assert.ok(token.startsWith(TOKEN_PREFIX))
  assert.equal(token.length, TOKEN_PREFIX.length + 32)

  // Два вызова не должны совпасть. Совпадение означало бы предсказуемый источник случайности —
  // то есть ключ, который можно угадать.
  const many = new Set(Array.from({ length: 200 }, () => generateToken()))
  assert.equal(many.size, 200, 'двести выданных токенов — двести разных')
}

// Короткая или неполная строка не «почти токен», а не токен: пропустив её, мы бы искали в базе
// отпечаток мусора и полагались на то, что он не найдётся.
for (const bad of ['nemo_live_', 'nemo_live_short', `${TOKEN_PREFIX}${'a'.repeat(31)}`, `${TOKEN_PREFIX}${'a'.repeat(33)}`, 'sk-or-v1-abc', '']) {
  assert.equal(TOKEN_SHAPE.test(bad), false, `не токен: ${bad.slice(0, 20)}`)
}
// Символы вне алфавита не проходят: дефисы и подчёркивания в хвосте — признак чужого формата.
assert.equal(TOKEN_SHAPE.test(`${TOKEN_PREFIX}${'a'.repeat(30)}-!`), false)

// --- Разбор заголовка -----------------------------------------------------------------------------

{
  const token = generateToken()
  assert.equal(tokenFromHeader(`Bearer ${token}`), token)
  assert.equal(tokenFromHeader(`bearer ${token}`), token, 'схема регистронезависима по RFC')
  assert.equal(tokenFromHeader(`  Bearer   ${token}  `), token)
  assert.equal(tokenFromHeader(token), null, 'без схемы Bearer — не наш заголовок')
  assert.equal(tokenFromHeader('Bearer eyJhbGciOiJIUzI1NiJ9.abc.def'), null, 'JWT — не платформенный токен')
  assert.equal(tokenFromHeader(null), null)
  assert.equal(tokenFromHeader(undefined), null)
  assert.equal(tokenFromHeader(''), null)
}

// --- Отпечаток ------------------------------------------------------------------------------------

{
  const token = generateToken()
  const a = await hashToken(token, 'pepper-one')
  const b = await hashToken(token, 'pepper-one')
  const c = await hashToken(token, 'pepper-two')

  assert.equal(a, b, 'один токен и один перец — один отпечаток, иначе поиск по индексу невозможен')
  assert.ok(/^[0-9a-f]{64}$/.test(a), 'hex-64 — ровно то, что требует ограничение колонки token_hash')
  assert.notEqual(a, c, 'смена перца меняет отпечаток: украденный дамп базы без секрета сервера бесполезен')
  assert.notEqual(await hashToken(generateToken(), 'pepper-one'), a, 'разные токены — разные отпечатки')

  // Без перца считать нечем, и молча считать «как-нибудь» нельзя: это дало бы отпечатки, которые
  // сойдутся у кого угодно с тем же кодом.
  await assert.rejects(() => hashToken(token, ''), /token_pepper_missing/)
}

// --- DENY BY DEFAULT ------------------------------------------------------------------------------
// Единственное правило, которое здесь нельзя ослаблять. Каждый случай ниже — это способ получить
// доступ по недосмотру, и все они должны заканчиваться отказом.

const live = { id: 'tok', account_id: 'acct', rate_limit_per_minute: 30, is_active: true, expires_at: null }

assert.equal(authorizeAction({ ...live, allowed_actions: ['sdr:trigger'] }, 'sdr:trigger').ok, true)

// Пустой список, отсутствующее поле, null и не-массив — всё это «нельзя», а не «не указано значит всё».
for (const actions of [[], null, undefined, 'sdr:trigger', {}, 0]) {
  const verdict = authorizeAction({ ...live, allowed_actions: actions }, 'sdr:trigger')
  assert.equal(verdict.ok, false, `список ${JSON.stringify(actions)} не даёт прав`)
  assert.equal(verdict.refusal, 'action_not_allowed')
}

// САМОЕ ВАЖНОЕ: токен с правами на SDR не должен дотягиваться до опасных операций кабинета.
// Эти действия живут в другой функции, и здесь проверяется, что даже в теории список их не пускает.
for (const dangerous of ['set_auto_submit', 'apply_proposal', 'report_extension_result', 'agent_plan', 'onboard']) {
  const verdict = authorizeAction({ ...live, allowed_actions: [...SDR_ACTIONS] }, dangerous)
  assert.equal(verdict.ok, false, `${dangerous} недоступно токену SDR`)
  assert.equal(verdict.refusal, 'action_not_allowed')
}

// Отсутствующая строка (отпечаток не найден) — отказ, а не исключение: неизвестный токен обычное
// дело, и падать на нём значит превратить перебор в отказ в обслуживании.
assert.equal(authorizeAction(null, 'sdr:trigger').refusal, 'unknown_token')
assert.equal(authorizeAction(undefined, 'sdr:trigger').refusal, 'unknown_token')

// Отключённый и просроченный различаются: первое — решение владельца, второе — время.
assert.equal(authorizeAction({ ...live, is_active: false, allowed_actions: ['sdr:trigger'] }, 'sdr:trigger').refusal, 'token_inactive')
assert.equal(
  authorizeAction({ ...live, allowed_actions: ['sdr:trigger'], expires_at: new Date(Date.now() - 1000).toISOString() }, 'sdr:trigger').refusal,
  'token_expired',
)
assert.equal(
  authorizeAction({ ...live, allowed_actions: ['sdr:trigger'], expires_at: new Date(Date.now() + 60_000).toISOString() }, 'sdr:trigger').ok,
  true,
  'ещё не истёкший срок не мешает',
)
// Отключённый И просроченный — сначала отключён: это ближе к решению человека, чем к календарю.
assert.equal(
  authorizeAction({ ...live, is_active: false, allowed_actions: ['sdr:trigger'], expires_at: new Date(0).toISOString() }, 'sdr:trigger').refusal,
  'token_inactive',
)

// --- Коды ответа ----------------------------------------------------------------------------------
// 401 — «мы не знаем, кто ты», 403 — «знаем, но нельзя», 429 — «слишком часто». Клиент различает их
// по коду и ведёт себя по-разному: повторять запрос осмысленно только на 429.

assert.equal(REFUSAL_STATUS.no_token, 401)
assert.equal(REFUSAL_STATUS.unknown_token, 401)
assert.equal(REFUSAL_STATUS.token_expired, 401)
assert.equal(REFUSAL_STATUS.action_not_allowed, 403)
assert.equal(REFUSAL_STATUS.rate_limited, 429)

// Действия шлюза перечислены явно и не включают ничего из кабинета.
assert.deepEqual([...SDR_ACTIONS], ['sdr:trigger', 'sdr:read'])

console.log('[OK] API token behaviour: 56 assertions')
