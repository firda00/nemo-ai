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
const { loginWithBrowser } = await import('./cli/browser-login.ts')
const { parseCliAuthRequest } = await import('../src/lib/cliAuth.ts')

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
const nemoEntry = fs.readFileSync(path.join(import.meta.dirname, 'nemo.mjs'), 'utf8')
assert.ok(nemoEntry.indexOf("process.argv.includes('login')") < nemoEntry.indexOf('if (!isInteractiveTerminal())'), 'nemo login должен работать без TTY')
assert.equal(/askPassword|askEmail|askHidden/.test(nemoEntry), false, 'пользовательский CLI всё ещё спрашивает пароль')

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

// ── Browser OAuth + loopback callback ───────────────────────────────────────────────────────
{
  const goodState = 's'.repeat(43)
  assert.deepEqual(
    parseCliAuthRequest(`?callback=${encodeURIComponent('http://127.0.0.1:3333/callback')}&state=${goodState}`),
    { callback: 'http://127.0.0.1:3333/callback', state: goodState },
  )
  assert.equal(parseCliAuthRequest(`?callback=${encodeURIComponent('https://attacker.test/callback')}&state=${goodState}`), null)
  assert.equal(parseCliAuthRequest(`?callback=${encodeURIComponent('http://127.0.0.1:3333/other')}&state=${goodState}`), null)
  assert.equal(parseCliAuthRequest('?callback=http://127.0.0.1:3333/callback&state=short'), null)

  let openedUrl = ''
  let validated = 0
  const result = await loginWithBrowser({
    appUrl: 'https://nemo.test',
    state: goodState,
    timeoutMs: 5_000,
    validate: async (payload) => {
      validated += 1
      assert.equal(payload.access_token, 'ACCESS')
      return { access_token: 'ACCESS', refresh_token: 'REFRESH', expires_at: 9_999, email: 'x@y.z', name: 'Test User' }
    },
    openUrl: async (url) => {
      openedUrl = url
      const authUrl = new URL(url)
      const callback = authUrl.searchParams.get('callback')
      assert.equal(authUrl.origin, 'https://nemo.test')
      assert.equal(authUrl.pathname, '/cli/auth')
      assert.equal(authUrl.searchParams.get('state'), goodState)

      const deniedState = await fetch(callback, {
        method: 'POST',
        headers: { Origin: 'https://nemo.test', 'Content-Type': 'application/json' },
        body: JSON.stringify({ state: 'x'.repeat(43), access_token: 'ACCESS' }),
      })
      assert.equal(deniedState.status, 403, 'чужой state принят loopback-сервером')

      const accepted = await fetch(callback, {
        method: 'POST',
        headers: { Origin: 'https://nemo.test', 'Content-Type': 'application/json' },
        body: JSON.stringify({ state: goodState, access_token: 'ACCESS', refresh_token: 'REFRESH', expires_at: 9_999 }),
      })
      assert.equal(accepted.status, 200)
    },
  })
  assert.ok(openedUrl)
  assert.equal(result.ok, true)
  assert.equal(result.session.name, 'Test User')
  assert.equal(validated, 1, 'неверный state дошёл до проверки токена')
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
    browserLogin: async () => { throw new Error('открывать браузер не нужно') },
    say: () => {},
    now: () => 1_000,
    fetchImpl: async () => { calls += 1; return okToken() },
  })
  assert.equal(session.access_token, 'A')
  assert.equal(calls, 0, 'при живом токене CLI не должен ходить в сеть')
}

/*
 * ПРОДЛЕНИЕ ПРОБУЕТСЯ ДО ОТКРЫТИЯ БРАУЗЕРА.
 *
 * Иначе человек, оставивший CLI на ночь, утром получает новый OAuth при живом refresh-токене.
 */
{
  let opened = 0
  let written = null
  const session = await ensureSession({
    read: () => ({ access_token: 'old', refresh_token: 'R', expires_at: 1_000, email: 'x@y.z' }),
    write: (value) => { written = value },
    clear: () => { throw new Error('стирать нечего — продление удалось') },
    browserLogin: async () => { opened += 1; throw new Error('браузер не нужен') },
    say: () => {},
    now: () => 2_000,
    fetchImpl: async () => okToken(),
  })
  assert.equal(opened, 0, 'открыли браузер при годном refresh-токене')
  assert.equal(session.access_token, 'A')
  assert.equal(written.expires_at, 2_000 + 3600, 'срок пересчитан от текущего времени')
}

// Отказ продления стирает файл и ведёт к browser login.
{
  let cleared = 0
  const said = []
  let opened = 0
  const session = await ensureSession({
    read: () => ({ access_token: 'old', refresh_token: 'dead', expires_at: 1, email: 'x@y.z' }),
    write: () => {},
    clear: () => { cleared += 1 },
    browserLogin: async () => {
      opened += 1
      return { ok: true, session: { access_token: 'B', refresh_token: 'BR', expires_at: 9_000, email: 'x@y.z' } }
    },
    say: (line) => said.push(line),
    now: () => 2_000,
    fetchImpl: async () => denied('refresh token expired'),
  })
  assert.equal(cleared, 1, 'мёртвый refresh-токен обязан быть стёрт: иначе CLI ходит за отказом каждый запуск')
  assert.equal(opened, 1)
  assert.equal(session.access_token, 'B')
  assert.ok(said.some((line) => /истекла/i.test(line)), 'человеку не сказали, почему спрашивают заново')
}

// Отказ browser login не зацикливается и причина названа.
{
  const said = []
  const session = await ensureSession({
    read: () => null,
    write: () => {},
    clear: () => {},
    browserLogin: async () => ({ ok: false, error: 'пользователь отменил вход' }),
    say: (line) => said.push(line),
    now: () => 0,
    fetchImpl: async () => { throw new Error('сеть не нужна без сохранённой сессии') },
  })
  assert.equal(session, null)
  assert.ok(said.some((line) => /отменил/.test(line)), 'причина отказа не показана')
}

// Успешная browser-сессия сохраняется ровно один раз.
{
  let writes = 0
  const session = await ensureSession({
    read: () => null,
    write: () => { writes += 1 },
    clear: () => {},
    browserLogin: async () => ({
      ok: true,
      session: { access_token: 'A', refresh_token: 'R', expires_at: 3_600, email: 'x@y.z', name: 'Nemo User' },
    }),
    say: () => {},
    now: () => 0,
  })
  assert.equal(session.name, 'Nemo User')
  assert.equal(writes, 1)
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
