// Сквозной прогон аудита: настоящий Chromium на настоящей странице с намеренными дефектами.
//
// ОТДЕЛЬНО ОТ qa-behavior.mjs и ВНЕ гейта качества намеренно. Здесь запускается браузер: прогон стоит
// секунды и требует установленного Chromium, а гейт должен оставаться быстрым и работать на машине без
// него. Разбор наблюдений в находки проверяется заглушкой в qa-behavior.mjs; здесь проверяется ровно
// то, что заглушкой проверить нельзя, — что браузер ДЕЙСТВИТЕЛЬНО видит эти дефекты.
//
// Запуск: npm run test:qa-live

import assert from 'node:assert/strict'
import http from 'node:http'
import { PlaywrightQaProbe } from './tools/qa-probe.ts'
import { runSiteAudit } from './tools/qa-runner.ts'

/**
 * Страница с шестью намеренными дефектами.
 *
 * Каждый поставлен под конкретную проверку, и все шесть должны найтись за один проход — иначе зонд
 * умеет что-то одно, а отчёт по остальному молчит.
 */
const BROKEN_PAGE = `<!doctype html>
<html lang="ru">
<head>
  <meta charset="utf-8">
  <title>Сломанная клиника</title>
</head>
<body>
  <h1>Стоматология «Проверка»</h1>
  <p>Текст, чтобы страница не считалась пустой.</p>
  <a href="/missing-page">Битая ссылка</a>
  <a href="/">Целая ссылка</a>
  <img src="/missing-image.png" alt="картинка, которой нет">
  <div style="width: 3000px; height: 10px; background: #eee"></div>
  <script>
    console.error('намеренная ошибка в консоли');
    setTimeout(() => { throw new Error('намеренное необработанное исключение') }, 0);
  </script>
</body>
</html>`

const HEALTHY_PAGE = `<!doctype html>
<html lang="ru">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Здоровая клиника</title>
</head>
<body>
  <h1>Стоматология «Порядок»</h1>
  <p>Записаться можно через форму ниже.</p>
  <a href="https://t.me/klinika">Telegram</a>
  <form><input name="phone"><button>Отправить</button></form>
</body>
</html>`

const server = http.createServer((request, response) => {
  if (request.url === '/' || request.url === '/broken') {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    response.end(BROKEN_PAGE)
    return
  }
  if (request.url === '/healthy') {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    response.end(HEALTHY_PAGE)
    return
  }
  if (request.url === '/boom') {
    response.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' })
    response.end('всё сломалось')
    return
  }
  response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
  response.end('нет такой страницы')
})

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const base = `http://127.0.0.1:${server.address().port}`
const probe = new PlaywrightQaProbe()
let failures = 0
const report = (label, fn) => {
  try { fn(); console.log(`  ✓ ${label}`) } catch (error) { failures++; console.log(`  × ${label}: ${error.message}`) }
}

try {
  console.log(`сервер поднят на ${base}\n`)

  // ── Сломанная страница ──────────────────────────────────────────────────────────────────────────
  const broken = await runSiteAudit(probe, { url: `${base}/broken`, mobile: true })
  console.log(`сломанная страница: здоровье ${broken.score}%, находок ${broken.findings.length}`)
  for (const finding of broken.findings) console.log(`    [${finding.severity}] ${finding.message.slice(0, 110)}`)
  console.log('')

  report('код ответа снят', () => assert.equal(broken.status, 200))
  report('замер загрузки получен', () => assert.ok(broken.observation.loadMs > 0))
  report('первый байт измерен', () => assert.ok(broken.observation.ttfbMs !== null, 'ttfb остался null'))
  report('ошибка консоли поймана', () => assert.ok(
    broken.observation.consoleErrors.some((one) => one.includes('намеренная ошибка')),
    JSON.stringify(broken.observation.consoleErrors),
  ))
  // Необработанное исключение — не то же самое, что console.error: оно останавливает скрипт, и
  // молчать о нём нельзя даже при чистой консоли.
  report('необработанное исключение поймано', () => assert.ok(
    broken.observation.consoleErrors.some((one) => one.includes('намеренное необработанное')),
    JSON.stringify(broken.observation.consoleErrors),
  ))
  report('сбойный запрос картинки замечен', () => assert.ok(
    broken.observation.failedRequests.some((one) => one.url.includes('missing-image') && one.status === 404),
    JSON.stringify(broken.observation.failedRequests),
  ))
  report('битая ссылка найдена обходом', () => assert.ok(
    broken.brokenLinks.some((one) => one.url.includes('missing-page')),
    JSON.stringify(broken.brokenLinks),
  ))
  report('целая ссылка не объявлена битой', () => assert.ok(
    !broken.brokenLinks.some((one) => one.url === `${base}/`),
    JSON.stringify(broken.brokenLinks),
  ))
  report('отсутствие viewport замечено', () => assert.equal(broken.observation.hasViewportMeta, false))
  report('горизонтальная прокрутка замечена', () => assert.equal(broken.observation.hasHorizontalOverflow, true))
  report('нет способа связаться — находка', () => assert.ok(broken.findings.some((one) => one.kind === 'conversion')))
  report('оценка упала', () => assert.ok(broken.score < 60, `здоровье ${broken.score}%`))

  // ── Здоровая страница ───────────────────────────────────────────────────────────────────────────
  const healthy = await runSiteAudit(probe, { url: `${base}/healthy`, mobile: true })
  console.log(`\nздоровая страница: здоровье ${healthy.score}%, находок ${healthy.findings.length}`)
  for (const finding of healthy.findings) console.log(`    [${finding.severity}] ${finding.message.slice(0, 110)}`)

  report('здоровая страница без ошибок консоли', () => assert.deepEqual(healthy.observation.consoleErrors, []))
  report('viewport найден', () => assert.equal(healthy.observation.hasViewportMeta, true))
  report('форма найдена', () => assert.equal(healthy.observation.forms, 1))
  report('мессенджер найден', () => assert.ok(healthy.messengers.some((one) => one.kind === 'telegram')))
  // Ложная тревога на здоровой странице обесценивает отчёт быстрее, чем пропущенная находка: после
  // двух выдуманных проблем отчёт перестают читать.
  report('на здоровой странице оценка высокая', () => assert.ok(
    healthy.score >= 85,
    `здоровье ${healthy.score}%, находки: ${JSON.stringify(healthy.findings.map((one) => one.message))}`,
  ))

  // ── Пятисотая ───────────────────────────────────────────────────────────────────────────────────
  const boom = await runSiteAudit(probe, { url: `${base}/boom`, mobile: false })
  console.log(`\nстраница с 500: здоровье ${boom.score}%`)
  report('пятисотая распознана', () => assert.equal(boom.status, 500))
  report('пятисотая обрушила оценку', () => assert.ok(boom.score <= 60, `здоровье ${boom.score}%`))
} finally {
  await probe.close()
  await new Promise((resolve) => server.close(resolve))
}

if (failures) {
  console.log(`\n[FAIL] QA live: не сошлось ${failures}`)
  process.exit(1)
}
console.log('\n[OK] QA live: браузер видит все намеренные дефекты')
