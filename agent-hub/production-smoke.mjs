// Смоук боевого контура: маршруты сайта и живость Edge Functions.
//
// ЧТО ЗДЕСЬ СЧИТАЕТСЯ УСПЕХОМ, И ПОЧЕМУ НЕ «200 OK».
//
// Для вебхука 200 — ПЛОХОЙ признак. telegram-webhook и stripe-webhook обязаны отвергать запрос без
// подписи: 200 на пустой POST означал бы, что кто угодно может прислать им что угодно. Здесь
// проверяется, что функция ЖИВА и ОТКАЗЫВАЕТ правильно — 400/401/405, но не 404 (не развёрнута) и
// не 500 (развёрнута и падает).
//
// Для страниц наоборот: 200 и HTML. Отдельно проверяется, что клиентские маршруты (/terms,
// /privacy, /app/*) возвращают index.html, а не 404 — без правила перезаписи SPA отдаёт 404 на
// любой адрес, кроме корня, и обнаруживается это первым же клиентом, открывшим ссылку из письма.
//
// Запуск:
//   node agent-hub/production-smoke.mjs                       # адреса из окружения
//   NEMO_SITE_URL=https://... node agent-hub/production-smoke.mjs
import process from 'node:process'

const SITE = process.env.NEMO_SITE_URL ?? ''
const SUPABASE = process.env.NEMO_SUPABASE_URL ?? process.env.VITE_SUPABASE_URL ?? ''
const GATEWAY = process.env.NEMO_GATEWAY_URL ?? process.env.VITE_API_GATEWAY_URL ?? ''

let failed = 0
let skipped = 0
const ok = (name, detail = '') => console.log(`[OK]   ${name}${detail ? ` — ${detail}` : ''}`)
const bad = (name, detail = '') => { failed += 1; console.error(`[FAIL] ${name}${detail ? ` — ${detail}` : ''}`) }
const skip = (name, why) => { skipped += 1; console.log(`[SKIP] ${name} — ${why}`) }

const get = async (url, init = {}) => {
  const control = new AbortController()
  const timer = setTimeout(() => control.abort(), 15_000)
  try {
    const response = await fetch(url, { redirect: 'manual', signal: control.signal, ...init })
    const body = await response.text().catch(() => '')
    return { status: response.status, location: response.headers.get('location') ?? '', body, headers: response.headers }
  } catch (error) {
    return { status: 0, location: '', body: '', error: String(error.message ?? error) }
  } finally { clearTimeout(timer) }
}

// ── Страницы ────────────────────────────────────────────────────────────────────────────────
if (!SITE) {
  skip('маршруты сайта', 'NEMO_SITE_URL не задан')
} else {
  const routes = ['/', '/terms', '/privacy', '/auth', '/app/integrations']
  for (const route of routes) {
    const res = await get(SITE.replace(/\/+$/, '') + route)
    if (res.status === 0) { bad(`GET ${route}`, res.error); continue }
    /*
     * Защита развёртывания Vercel уводит на SSO — это НЕ отказ приложения, но и не рабочий сайт.
     * Отдельная ветка, а не общий провал: путать «страница сломана» и «страница закрыта паролем»
     * нельзя, лечатся они разным.
     */
    if ([301, 302, 307, 308].includes(res.status) && /vercel\.com\/sso-api/.test(res.location)) {
      bad(`GET ${route}`, `закрыто защитой развёртывания Vercel (${res.status} → SSO)`)
      continue
    }
    if (res.status !== 200) { bad(`GET ${route}`, `статус ${res.status}`); continue }
    // Клиентский маршрут обязан вернуть тот же index.html, а не страницу ошибки хостинга.
    if (!/<div id="root"|<!doctype html/i.test(res.body)) { bad(`GET ${route}`, 'ответ не похож на index.html'); continue }
    ok(`GET ${route}`, `200, ${res.body.length} байт`)
  }

  const head = await get(SITE)
  if (head.status === 200) {
    for (const [header, expected] of [['x-content-type-options', 'nosniff'], ['x-frame-options', /SAMEORIGIN|DENY/i]]) {
      const value = head.headers?.get(header) ?? ''
      const good = expected instanceof RegExp ? expected.test(value) : value === expected
      good ? ok(`заголовок ${header}`, value) : bad(`заголовок ${header}`, `получено «${value}»`)
    }
  }
}

// ── Edge Functions ──────────────────────────────────────────────────────────────────────────
if (!SUPABASE) {
  skip('Edge Functions', 'NEMO_SUPABASE_URL / VITE_SUPABASE_URL не задан')
} else {
  const base = SUPABASE.replace(/\/+$/, '') + '/functions/v1'
  /*
   * Ожидаемые ответы взяты из САМИХ функций, а не «примерно так»:
   *   telegram-webhook — без заголовка x-telegram-bot-api-secret-token отвергает;
   *   stripe-webhook   — без Stripe-Signature отдаёт 400 «invalid signature»;
   *   connect-telegram — требует JWT вызывающего, без него 401.
   * 404 означает «не развёрнута», 5xx — «развёрнута и падает». Оба — провал.
   */
  /*
   * 404 БЫВАЕТ ДВУХ РАЗНЫХ ВИДОВ, И ПУТАТЬ ИХ НЕЛЬЗЯ.
   *
   * telegram-webhook берёт идентификатор канала ПОСЛЕДНИМ СЕГМЕНТОМ ПУТИ. Запрос на голый
   * /functions/v1/telegram-webhook делает channelId равным «telegram-webhook», такого канала нет —
   * и функция честно отвечает 404 «channel not found». Это признак ЖИВОЙ функции.
   *
   * Отсутствующая функция отвечает тоже 404, но телом платформы: {"code":"NOT_FOUND"}. Первая
   * редакция этой проверки различия не знала и объявила исправную функцию неразвёрнутой.
   *
   * С настоящим идентификатором канала (NEMO_TG_CHANNEL_ID) проверка сильнее: 403 доказывает, что
   * функция дошла до сверки секретного токена и отвергла запрос без него.
   */
  const tgChannel = process.env.NEMO_TG_CHANNEL_ID ?? ''
  const cases = [
    {
      name: 'telegram-webhook',
      path: tgChannel ? `telegram-webhook/${tgChannel}` : 'telegram-webhook',
      accept: tgChannel ? [403] : [404],
      expect: tgChannel ? 'отвергает запрос без секретного токена (403)' : 'жива, канал не найден (404)',
    },
    { name: 'stripe-webhook', path: 'stripe-webhook', accept: [400, 401, 405], expect: 'отвергает запрос без подписи' },
    { name: 'connect-telegram', path: 'connect-telegram', accept: [400, 401, 403], expect: 'требует JWT вызывающего' },
  ]
  for (const item of cases) {
    const res = await get(`${base}/${item.path}`, { method: 'POST', body: '{}', headers: { 'Content-Type': 'application/json' } })
    if (res.status === 0) { bad(item.name, res.error); continue }
    if (/"code"\s*:\s*"NOT_FOUND"/.test(res.body)) { bad(item.name, 'не развёрнута (ответ платформы NOT_FOUND)'); continue }
    if (res.status >= 500) { bad(item.name, `падает: ${res.status}`); continue }
    if (res.status === 200) { bad(item.name, '200 на запрос без подписи — проверка подлинности не работает'); continue }
    if (!item.accept.includes(res.status)) { bad(item.name, `неожиданный статус ${res.status}: ${res.body.slice(0, 60)}`); continue }
    ok(item.name, `${item.expect} (${res.status})`)
  }
}

// ── Шлюз ────────────────────────────────────────────────────────────────────────────────────
if (!GATEWAY) {
  skip('шлюз', 'NEMO_GATEWAY_URL / VITE_API_GATEWAY_URL не задан')
} else {
  const health = await get(GATEWAY.replace(/\/+$/, '') + '/health')
  health.status === 200 ? ok('шлюз /health', '200') : bad('шлюз /health', `статус ${health.status}${health.error ? ` (${health.error})` : ''}`)
  const widget = await get(GATEWAY.replace(/\/+$/, '') + '/widget.js')
  widget.status === 200 ? ok('шлюз /widget.js', `200, ${widget.body.length} байт`) : bad('шлюз /widget.js', `статус ${widget.status}`)
}

console.log()
if (failed) {
  console.error(`Смоук боевого контура: ${failed} проверок упало, пропущено ${skipped}.`)
  process.exit(1)
}
console.log(`Смоук боевого контура пройден${skipped ? `, пропущено ${skipped}` : ''}.`)
