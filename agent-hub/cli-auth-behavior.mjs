// Вход в CLI: решения о сессии, хранение токенов и живая проверка против Supabase.
//
// Разделено намеренно: решения (пора ли продлевать, что делать при отказе) проверяются без сети,
// а сеть проверяется отдельно и только при заданных учётных данных. Набор без сети обязан работать
// в любом окружении — иначе его отключат в CI и он перестанет ловить что-либо.
//
// Запуск: npm run test:cli-auth
import assertStrict from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const { authPath, needsRefresh, readSession, writeSession, clearSession, signIn, refresh } =
  await import('./cli/auth.ts')
const { ensureSession } = await import('./cli/login.ts')

let checks = 0
const assert = new Proxy(assertStrict, {
  get: (target, key) => {
    const value = target[key]
    if (typeof value !== 'function') return value
    return (...args) => { checks++; return value.apply(target, args) }
  },
})

// ── Куда кладётся сессия ─────────────────────────────────────────────────────────────────────
assert.equal(authPath('/home/x'), path.join('/home/x', '.nemo', 'auth.json'))

/*
 * ЗАПАС ПЕРЕД ИСТЕЧЕНИЕМ.
 *
 * Токен, годный ещё десять секунд, негоден: пока запрос дойдёт до сервера, он истечёт, и человек
 * увидит отказ на ровном месте. Проверяется именно граница, а не «где-то около».
 */
assert.equal(needsRefresh({ expires_at: 1_000 }, 900), false, 'сто секунд в запасе — продлевать рано')
assert.equal(needsRefresh({ expires_at: 1_000 }, 941), true, 'меньше минуты — пора продлевать')
assert.equal(needsRefresh({ expires_at: 1_000 }, 940), true, 'ровно минута — уже пора')
assert.equal(needsRefresh({ expires_at: 1_000 }, 939), false, 'минута и одна секунда — ещё рано')
assert.equal(needsRefresh({ expires_at: NaN }, 0), true, 'испорченный срок считается истёкшим')
assert.equal(needsRefresh({ expires_at: 0 }, 0), true)

// ── Чтение и запись ──────────────────────────────────────────────────────────────────────────
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nemo-auth-'))
  const file = path.join(dir, '.nemo', 'auth.json')

  assert.equal(readSession(file), null, 'отсутствующий файл — не ошибка, а отсутствие сессии')

  const session = { access_token: 'a', refresh_token: 'r', expires_at: 123, email: 'x@y.z' }
  writeSession(session, file)
  assert.deepEqual(readSession(file), session)

  /*
   * ПРАВА 0600 — ЭТО НЕ ФОРМАЛЬНОСТЬ.
   *
   * В файле лежит refresh-токен: кто его прочитал, тот входит как владелец без пароля. На общей
   * машине файл с правами 0644 читает любой пользователь.
   *
   * На Windows прав POSIX нет, и проверять там нечего — защищает ACL профиля. Пропуск помечен,
   * а не замаскирован: «проверка не выполнялась» и «проверка прошла» — разные вещи.
   */
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(file).mode & 0o777, 0o600, 'файл сессии доступен не только владельцу')
  } else {
    console.log('[SKIP] права 0600 — на Windows прав POSIX нет')
  }

  // Перезапись поверх существующего файла обязана сохранять права: mode в writeFileSync
  // применяется только при создании, и без chmod старые 0644 остались бы навсегда.
  writeSession({ ...session, access_token: 'b' }, file)
  assert.equal(readSession(file).access_token, 'b')
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(file).mode & 0o777, 0o600, 'перезапись потеряла права')
  }

  // Повреждённый файл — не повод падать: человек чинит это повторным входом, а не удалением руками.
  fs.writeFileSync(file, '{ это не json')
  assert.equal(readSession(file), null)
  fs.writeFileSync(file, JSON.stringify({ access_token: 'a' }))
  assert.equal(readSession(file), null, 'сессия без refresh-токена бесполезна и считается отсутствующей')

  clearSession(file)
  assert.equal(readSession(file), null)
  clearSession(file) // повторное удаление не должно бросать
  fs.rmSync(dir, { recursive: true, force: true })
}

// ── Порядок входа ────────────────────────────────────────────────────────────────────────────
const okToken = (expiresIn = 3600) => ({
  ok: true, status: 200,
  json: async () => ({ access_token: 'A', refresh_token: 'R', expires_in: expiresIn, user: { email: 'x@y.z' } }),
})
const denied = (message) => ({ ok: false, status: 400, json: async () => ({ error_description: message }) })

// Живая сессия — сеть не трогается вовсе.
{
  let calls = 0
  const session = await ensureSession({
    read: () => ({ access_token: 'A', refresh_token: 'R', expires_at: 10_000, email: 'x@y.z' }),
    write: () => { throw new Error('перезапись не нужна') },
    clear: () => { throw new Error('очистка не нужна') },
    askEmail: async () => { throw new Error('спрашивать не о чем') },
    askPassword: async () => { throw new Error('спрашивать не о чем') },
    say: () => {},
    now: () => 1_000,
    fetchImpl: async () => { calls += 1; return okToken() },
  })
  assert.equal(session.access_token, 'A')
  assert.equal(calls, 0, 'при живом токене CLI не должен ходить в сеть')
}

/*
 * ПРОДЛЕНИЕ ПРОБУЕТСЯ ДО ВОПРОСА О ПАРОЛЕ.
 *
 * Иначе человек, оставивший CLI на ночь, утром получает форму входа при живом refresh-токене — и
 * решает, что «оно опять разлогинилось». Проверяется, что пароля НЕ спросили.
 */
{
  let asked = 0
  let written = null
  const session = await ensureSession({
    read: () => ({ access_token: 'old', refresh_token: 'R', expires_at: 1_000, email: 'x@y.z' }),
    write: (value) => { written = value },
    clear: () => { throw new Error('стирать нечего — продление удалось') },
    askEmail: async () => { asked += 1; return 'x@y.z' },
    askPassword: async () => { asked += 1; return 'p' },
    say: () => {},
    now: () => 2_000,
    fetchImpl: async () => okToken(),
  })
  assert.equal(asked, 0, 'спросили пароль при годном refresh-токене')
  assert.equal(session.access_token, 'A')
  assert.equal(written.expires_at, 2_000 + 3600, 'срок пересчитан от текущего времени')
}

// Отказ продления стирает файл и ведёт к обычному входу.
{
  let cleared = 0
  const said = []
  let stage = 0
  const session = await ensureSession({
    read: () => ({ access_token: 'old', refresh_token: 'dead', expires_at: 1, email: 'x@y.z' }),
    write: () => {},
    clear: () => { cleared += 1 },
    askEmail: async () => 'x@y.z',
    askPassword: async () => 'p',
    say: (line) => said.push(line),
    now: () => 2_000,
    fetchImpl: async () => (stage++ === 0 ? denied('refresh token expired') : okToken()),
  })
  assert.equal(cleared, 1, 'мёртвый refresh-токен обязан быть стёрт: иначе CLI ходит за отказом каждый запуск')
  assert.equal(session.access_token, 'A')
  assert.ok(said.some((line) => /истекла/i.test(line)), 'человеку не сказали, почему спрашивают заново')
}

// Неверный пароль — переспрос, а не выход. И причина отказа названа.
{
  const said = []
  let attempt = 0
  const session = await ensureSession({
    read: () => null,
    write: () => {},
    clear: () => {},
    askEmail: async () => 'x@y.z',
    askPassword: async () => 'p',
    say: (line) => said.push(line),
    now: () => 0,
    fetchImpl: async () => (attempt++ === 0 ? denied('Invalid login credentials') : okToken()),
  })
  assert.equal(session.access_token, 'A', 'вторая попытка обязана сработать')
  assert.ok(said.some((line) => /Invalid login credentials/.test(line)), 'причина отказа не показана')
}

// Попытки не бесконечны: CLI, спрашивающий пароль по кругу, невозможно прервать в скрипте.
{
  const session = await ensureSession({
    read: () => null,
    write: () => {},
    clear: () => {},
    askEmail: async () => 'x@y.z',
    askPassword: async () => 'p',
    say: () => {},
    now: () => 0,
    attempts: 2,
    fetchImpl: async () => denied('Invalid login credentials'),
  })
  assert.equal(session, null)
}

/*
 * ПАРОЛЬ НЕ ВЫТЕКАЕТ В СООБЩЕНИЕ ОБ ОТКАЗЕ.
 *
 * Сообщение уходит в буфер прокрутки терминала, в запись демонстрации экрана и в переписку с
 * поддержкой. Пароль внутри него — утечка, растянутая во времени.
 */
{
  const said = []
  await ensureSession({
    read: () => null, write: () => {}, clear: () => {},
    askEmail: async () => 'x@y.z',
    askPassword: async () => 'СуперСекрет123',
    say: (line) => said.push(line),
    now: () => 0, attempts: 1,
    fetchImpl: async () => denied('Invalid login credentials'),
  })
  assert.equal(said.join(' ').includes('СуперСекрет123'), false, 'пароль попал в сообщение об отказе')
}

// Сетевой сбой и неверные учётные данные — разные беды, и лечатся они по-разному.
// Свести их к одному сообщению значит отправить человека чинить не то.
{
  const result = await signIn(
    { supabaseUrl: 'https://x', anonKey: 'k', fetchImpl: async () => { throw new Error('getaddrinfo ENOTFOUND') } },
    'x@y.z', 'p',
  )
  assert.equal(result.ok, false)
  assert.match(result.error, /связаться с сервером/, 'сетевой сбой выдан за отказ входа')
}

// ── Живая проверка (только если заданы учётные данные) ────────────────────────────────────────
const liveEmail = process.env.NEMO_CLI_TEST_EMAIL
const livePassword = process.env.NEMO_CLI_TEST_PASSWORD
if (liveEmail && livePassword) {
  const { SUPABASE_URL, SUPABASE_ANON_KEY } = await import('./cli/defaults.ts')
  const io = { supabaseUrl: SUPABASE_URL, anonKey: SUPABASE_ANON_KEY }

  const entered = await signIn(io, liveEmail, livePassword)
  assert.equal(entered.ok, true, `живой вход не удался: ${entered.ok ? '' : entered.error}`)
  assert.equal(entered.session.email, liveEmail)
  assert.ok(entered.session.access_token.split('.').length === 3, 'выдан не JWT')

  const renewed = await refresh(io, entered.session)
  assert.equal(renewed.ok, true, `продление не удалось: ${renewed.ok ? '' : renewed.error}`)
  assert.notEqual(renewed.session.refresh_token, '', 'продление вернуло пустой refresh-токен')

  const wrong = await signIn(io, liveEmail, `${livePassword}-неверный`)
  assert.equal(wrong.ok, false, 'сервер принял неверный пароль')
  console.log('[LIVE] вход, продление и отказ по неверному паролю проверены на боевом Supabase')
} else {
  console.log('[SKIP] живая проверка — не заданы NEMO_CLI_TEST_EMAIL / NEMO_CLI_TEST_PASSWORD')
}

console.log(`[OK] CLI auth: ${checks} assertions`)
