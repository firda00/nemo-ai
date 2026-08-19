// Аудит сайта и репозитория: разбор наблюдений в находки, оценка, отчёт.
//
// ЧТО ЗДЕСЬ ЗАЩИЩАЕТСЯ:
//
// 1. ОЦЕНКА, КОТОРАЯ НЕ ВСЕГДА ХОРОШАЯ. Отчёт с «здоровье 92%» на сайте, отдающем пятисотую, хуже
//    отсутствия отчёта: он даёт основание не смотреть. Проверяется, что критическая находка обрушивает
//    оценку, а не отнимает пару процентов.
//
// 2. РАЗЛИЧИЕ «НЕ ПРОВЕРЯЛОСЬ» И «ПРОВЕРЕНО, ЧИСТО». Отчёт, где непроверенные ссылки выглядят как
//    целые, врёт молча — и это единственный вид лжи, который никто не заметит.
//
// 3. ЧЕСТНОСТЬ ПРО ПАДЕНИЕ ГЕЙТА. Разбор вывода может не найти ни одного шага (гейт упал до первого),
//    и считать такой прогон успешным по пустому списку падений — прямая ложь о состоянии репозитория.
//
// Наблюдение подменяется заглушкой: суждения проверяются за миллисекунды и без Chromium. Живой прогон
// на настоящей странице делается отдельно, вручную, и его результат записан в сообщении коммита.

import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  DESKTOP_VIEWPORT, MOBILE_VIEWPORT, THRESHOLDS, auditFindings, buildQaAuditTool, parseQualityOutput,
  renderCodeReport, renderSiteReport, runCodeQa, runSiteAudit, scoreFindings, summarizeAudit,
} from './tools/qa-runner.ts'
import { OSM_ATTRIBUTION, buildFsExportTool, withAttribution } from './tools/platform.ts'
import { resolveGatewayEnv } from './server/env.ts'

let checks = 0
const check = (fn) => { fn(); checks++ }
const checkAsync = async (fn) => { await fn(); checks++ }

/** Здоровая страница. Всё остальное — отклонения от неё. */
const HEALTHY = {
  url: 'https://example.com', finalUrl: 'https://example.com/', status: 200,
  ttfbMs: 120, loadMs: 800, lcpMs: 1_200,
  title: 'Клиника', text: 'Стоматология в Ташкенте. Запись онлайн.',
  links: ['https://example.com/about', 'https://t.me/klinika'],
  consoleErrors: [], failedRequests: [],
  hasViewportMeta: true, hasHorizontalOverflow: false, forms: 1,
  html: '<html><body><form></form></body></html>',
}
const observe = (overrides = {}) => ({ ...HEALTHY, ...overrides })
const judge = (overrides = {}, extra = {}) => auditFindings({
  observation: observe(overrides),
  brokenLinks: [], linksChecked: true, messengers: [], bookingWidgets: [], mobileChecked: true,
  ...extra,
})

// ─── Здоровая страница ────────────────────────────────────────────────────────────────────────────

check(() => {
  const findings = judge({}, { messengers: [{ kind: 'telegram', url: 'https://t.me/k' }] })
  assert.deepEqual(findings, [], `на здоровой странице найдено лишнее: ${JSON.stringify(findings)}`)
  assert.equal(scoreFindings(findings), 100)
})

// ─── Оценка обрушивается на критическом ───────────────────────────────────────────────────────────

/*
 * ГЛАВНАЯ ПРОВЕРКА ФАЙЛА.
 *
 * Страница, отдающая 500, не «на 95% здорова». Если критическая находка стоит пару процентов, отчёт
 * становится основанием НЕ смотреть — то есть вреднее отсутствия отчёта.
 */
check(() => {
  const score = scoreFindings(judge({ status: 500 }))
  assert.ok(score <= 60, `пятисотая оставила здоровье ${score}%`)
})
check(() => {
  // Две критические находки оставляют оценку в самом низу шкалы.
  const dead = judge({ status: 503, consoleErrors: ['a', 'b', 'c', 'd'] })
  assert.ok(scoreFindings(dead) <= 25, `мёртвая страница получила ${scoreFindings(dead)}%`)
})
check(() => {
  // Три критические находки обнуляют оценку. Это правильный ответ, а не крайность.
  const hopeless = judge({
    status: 200, text: '', consoleErrors: ['a', 'b', 'c', 'd'],
    failedRequests: [{ url: 'https://example.com/api', status: 502 }],
  })
  assert.equal(scoreFindings(hopeless), 0, `безнадёжная страница получила ${scoreFindings(hopeless)}%`)
})
// Одна мелочь оценку почти не двигает: иначе всё подряд оказывается «требует вмешательства».
check(() => assert.ok(scoreFindings(judge({ ttfbMs: 900 })) >= 90))

// ─── Отдельные находки ────────────────────────────────────────────────────────────────────────────

const kinds = (overrides, extra) => judge(overrides, extra).map((one) => one.kind)

check(() => assert.ok(kinds({ status: 404 }).includes('http')))
check(() => assert.equal(judge({ status: 500 })[0].severity, 'critical'))
// Пустая страница при коде 200 — критическая: обычно это неотработавший скрипт, и человек видит белый
// экран, не понимая, что сервер ответил успешно.
check(() => assert.ok(kinds({ text: '   ' }).includes('empty')))
// А при 404 отдельной находки про пустоту НЕ нужно: она следствие, и дублировать её значит удвоить
// штраф за одну неисправность.
check(() => assert.equal(kinds({ status: 404, text: '' }).filter((one) => one === 'empty').length, 0))

check(() => assert.ok(kinds({ consoleErrors: ['TypeError: x is not a function'] }).includes('console')))
// Двадцать однотипных сообщений от одного скрипта — одна неисправность, а не двадцать находок.
check(() => {
  const many = judge({ consoleErrors: new Array(20).fill('TypeError: x') })
  assert.equal(many.filter((one) => one.kind === 'console').length, 1)
  assert.ok(many.find((one) => one.kind === 'console').message.includes('различных 1'))
})
// А четыре РАЗНЫЕ ошибки — уже критично: сломан не один скрипт.
check(() => {
  const varied = judge({ consoleErrors: ['a', 'b', 'c', 'd'] })
  assert.equal(varied.find((one) => one.kind === 'console').severity, 'critical')
})

check(() => {
  const server = judge({ failedRequests: [{ url: 'https://example.com/api', status: 502 }] })
  assert.equal(server.find((one) => one.kind === 'requests').severity, 'critical', '5xx в запросах не критичен')
})
check(() => {
  const client = judge({ failedRequests: [{ url: 'https://example.com/logo.png', status: 404 }] })
  assert.equal(client.find((one) => one.kind === 'requests').severity, 'major')
})
// Не состоявшийся запрос отличается от четырёхсотого: там нет ответа вообще, и причина другая.
check(() => {
  const dead = judge({ failedRequests: [{ url: 'https://cdn.dead/x.js', status: null, reason: 'ERR_NAME_NOT_RESOLVED' }] })
  assert.ok(dead.find((one) => one.kind === 'requests').message.includes('не состоялось'))
})

check(() => assert.ok(kinds({}, { brokenLinks: [{ url: 'https://example.com/404', status: 404 }] }).includes('links')))

// ─── Скорость ─────────────────────────────────────────────────────────────────────────────────────

check(() => assert.deepEqual(kinds({ lcpMs: THRESHOLDS.lcpGoodMs - 1 }).filter((one) => one === 'performance'), []))
check(() => assert.equal(judge({ lcpMs: THRESHOLDS.lcpGoodMs + 100 }).find((one) => one.kind === 'performance').severity, 'minor'))
check(() => assert.equal(judge({ lcpMs: THRESHOLDS.lcpPoorMs + 100 }).find((one) => one.kind === 'performance').severity, 'major'))
check(() => assert.ok(kinds({ ttfbMs: THRESHOLDS.ttfbSlowMs + 1 }).includes('performance')))
check(() => assert.ok(kinds({ loadMs: THRESHOLDS.loadSlowMs + 1 }).includes('performance')))

/*
 * НЕИЗМЕРЕННОЕ — НЕ НОЛЬ.
 *
 * Показатель отрисовки не фиксируется на части страниц. Считать null нулём значит объявить такую
 * страницу мгновенной; считать бесконечностью — обвинить её в медлительности. Правильный ответ —
 * промолчать.
 */
check(() => assert.deepEqual(kinds({ lcpMs: null, ttfbMs: null }).filter((one) => one === 'performance'), []))

// ─── Телефон ──────────────────────────────────────────────────────────────────────────────────────

check(() => assert.ok(kinds({ hasViewportMeta: false }).includes('mobile')))
check(() => assert.ok(kinds({ hasHorizontalOverflow: true }).includes('mobile')))
// Без проверки на телефоне о телефоне не говорим: находка о том, чего не смотрели, — выдумка.
check(() => assert.deepEqual(
  kinds({ hasViewportMeta: false, hasHorizontalOverflow: true }, { mobileChecked: false }).filter((one) => one === 'mobile'),
  [],
))

// ─── Способы связи ────────────────────────────────────────────────────────────────────────────────

check(() => assert.ok(kinds({ forms: 0 }).includes('conversion'), 'сайт без единого способа связаться — это находка'))
check(() => assert.ok(!kinds({ forms: 1 }).includes('conversion')))
check(() => assert.ok(!kinds({ forms: 0 }, { messengers: [{ kind: 'whatsapp', url: 'https://wa.me/1' }] }).includes('conversion')))
check(() => assert.ok(!kinds({ forms: 0 }, { bookingWidgets: ['yclients'] }).includes('conversion')))

// У каждой находки есть направление: находка без указания, что делать, заставляет искать заново.
check(() => {
  for (const finding of judge({ status: 500, consoleErrors: ['x'], forms: 0, hasViewportMeta: false })) {
    assert.ok(finding.fix.length > 10, `находка «${finding.kind}» без указания, что делать`)
    assert.ok(finding.message.length > 5, `находка «${finding.kind}» без описания`)
  }
})

// ─── Полный аудит с заглушкой зонда ───────────────────────────────────────────────────────────────

function fakeProbe(observation, options = {}) {
  const seen = { observed: [], links: [], screenshots: 0 }
  return {
    seen,
    async observe(url, opts) {
      seen.observed.push({ url, viewport: opts.viewport })
      return { ...observation, url }
    },
    async checkLinks(urls, opts) {
      seen.links.push({ urls: [...urls], limit: opts.limit })
      return options.broken ?? []
    },
    async screenshot() {
      seen.screenshots += 1
      if (options.screenshotFails) throw new Error('снимок не сделался')
      return new Uint8Array([137, 80, 78, 71])
    },
    async close() {},
  }
}

await checkAsync(async () => {
  const probe = fakeProbe(observe())
  const audit = await runSiteAudit(probe, { url: 'https://example.com' })
  assert.equal(audit.score, 100)
  assert.deepEqual(probe.seen.observed[0].viewport, MOBILE_VIEWPORT, 'по умолчанию не проверяется телефон')
})
await checkAsync(async () => {
  const probe = fakeProbe(observe())
  await runSiteAudit(probe, { url: 'https://example.com', mobile: false })
  assert.deepEqual(probe.seen.observed[0].viewport, DESKTOP_VIEWPORT)
})

/*
 * ССЫЛКИ ОБХОДЯТСЯ ТОЛЬКО СВОЕГО ДОМЕНА.
 *
 * Страница ссылается на десятки внешних адресов. Обходить их — устроить чужим серверам всплеск
 * запросов с одной машины, за который справедливо блокируют по адресу.
 */
await checkAsync(async () => {
  const probe = fakeProbe(observe({
    links: [
      'https://example.com/a', 'https://example.com/b',
      'https://t.me/klinika', 'https://facebook.com/klinika', 'https://other.com/x',
    ],
  }))
  await runSiteAudit(probe, { url: 'https://example.com' })
  assert.deepEqual(probe.seen.links[0].urls, ['https://example.com/a', 'https://example.com/b'])
  assert.ok(probe.seen.links[0].limit <= 50, 'предел обхода снят')
})

/*
 * «НЕ ПРОВЕРЯЛОСЬ» ОТЛИЧАЕТСЯ ОТ «ПРОВЕРЕНО, ЧИСТО».
 *
 * Отчёт, где непроверенные ссылки выглядят целыми, врёт молча — и это единственный вид лжи, который
 * никто не заметит.
 */
await checkAsync(async () => {
  const audit = await runSiteAudit(fakeProbe(observe()), { url: 'https://example.com', checkLinks: false })
  assert.equal(audit.linksChecked, false)
  const report = renderSiteReport(audit, '2026-08-19')
  assert.ok(report.includes('НЕ проверялись'), 'в отчёте не видно, что ссылки не проверялись')
})
// Ссылок своего домена нет вовсе — тоже «не проверялось», а не «чисто».
await checkAsync(async () => {
  const audit = await runSiteAudit(fakeProbe(observe({ links: ['https://t.me/x'] })), { url: 'https://example.com' })
  assert.equal(audit.linksChecked, false)
  assert.equal(audit.linksSeen, 0)
})

// Мессенджеры и виджеты определяются из ссылок страницы, а не задаются вручную.
await checkAsync(async () => {
  const audit = await runSiteAudit(
    fakeProbe(observe({ links: ['https://t.me/klinika', 'https://n123456.yclients.com/company/1'] })),
    { url: 'https://example.com' },
  )
  assert.ok(audit.messengers.some((one) => one.kind === 'telegram'), JSON.stringify(audit.messengers))
  assert.ok(audit.bookingWidgets.length > 0, 'виджет записи не распознан')
})

// ─── Снимок ───────────────────────────────────────────────────────────────────────────────────────

/*
 * СНИМОК ТОЛЬКО ПРИ КРИТИЧЕСКОЙ НАХОДКЕ.
 *
 * Снимать каждую проверенную страницу — засорять диск картинками, на которые никто не посмотрит.
 */
await checkAsync(async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nemo-qa-'))
  try {
    const written = []
    const healthy = await runSiteAudit(fakeProbe(observe()), {
      url: 'https://example.com',
      screenshotPath: path.join(dir, 'a.png'),
      writeFile: async (p, data) => { written.push(p); await fs.writeFile(p, data) },
    })
    assert.equal(healthy.screenshotPath, null, 'снимок сделан на здоровой странице')
    assert.deepEqual(written, [])

    const broken = await runSiteAudit(fakeProbe(observe({ status: 500 })), {
      url: 'https://example.com',
      screenshotPath: path.join(dir, 'b.png'),
      writeFile: async (p, data) => { written.push(p); await fs.writeFile(p, data) },
    })
    assert.equal(broken.screenshotPath, path.join(dir, 'b.png'))
    assert.ok((await fs.stat(written[0])).size > 0)
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

// Неудавшийся снимок НЕ отменяет аудит: находки уже собраны и они важнее картинки.
await checkAsync(async () => {
  const audit = await runSiteAudit(fakeProbe(observe({ status: 500 }), { screenshotFails: true }), {
    url: 'https://example.com',
    screenshotPath: '/nowhere/x.png',
    writeFile: async () => {},
  })
  assert.equal(audit.screenshotPath, null)
  assert.ok(audit.findings.length > 0, 'аудит потерян из-за неудавшегося снимка')
})

// ─── Отчёт ────────────────────────────────────────────────────────────────────────────────────────

await checkAsync(async () => {
  const audit = await runSiteAudit(
    fakeProbe(observe({ status: 500, consoleErrors: ['TypeError: boom'], ttfbMs: 1_500 })),
    { url: 'https://example.com' },
  )
  const report = renderSiteReport(audit, '2026-08-19')
  assert.ok(report.includes(`Здоровье: ${audit.score}%`), 'в отчёте нет оценки')
  assert.ok(report.includes('TypeError: boom'), 'в отчёте нет ошибки консоли')
  assert.ok(report.includes('1500 мс') || report.includes('1500'), 'в отчёте нет замера')
  assert.ok(report.includes('Что делать'), 'отчёт без раздела с рекомендациями')
  // Каждая находка попадает в отчёт вместе со своим направлением.
  for (const finding of audit.findings) assert.ok(report.includes(finding.fix), `в отчёт не попало: ${finding.fix}`)
})

await checkAsync(async () => {
  const audit = await runSiteAudit(fakeProbe(observe()), { url: 'https://example.com' })
  const summary = summarizeAudit(audit)
  assert.ok(summary[0].includes('100%'))
  assert.ok(summary.length <= 7, 'сводка в терминал длиннее семи строк — это уже отчёт')
})

// ─── Аудит репозитория ────────────────────────────────────────────────────────────────────────────

const GATE_OUTPUT = [
  '[RUN] Agent loop contracts',
  '[OK] Agent loop contracts',
  '[RUN] CLI slash commands',
  '[OK] no TraceCard on a dialogue without a trace',
  '[OK] CLI slash commands',
  '[RUN] Website smoke test',
  '[FAIL] Website smoke test',
].join('\n')

check(() => {
  const parsed = parseQualityOutput(GATE_OUTPUT)
  assert.deepEqual(parsed.steps.map((one) => one.name), ['Agent loop contracts', 'CLI slash commands', 'Website smoke test'])
  assert.deepEqual(parsed.failed, ['Website smoke test'])
})

/*
 * МЕТКА [OK] ВНУТРИ ШАГА — НЕ ШАГ.
 *
 * Гейт печатает [OK] и для отдельных проверок внутри шага. Считать их шагами значит показать в отчёте
 * список из полусотни строк, где настоящие шаги неотличимы от внутренних проверок.
 */
check(() => {
  const parsed = parseQualityOutput(GATE_OUTPUT)
  assert.ok(!parsed.steps.some((one) => one.name.includes('TraceCard')), 'внутренняя проверка стала шагом')
})

/*
 * ШАГ БЕЗ ЗАВЕРШЕНИЯ СЧИТАЕТСЯ УПАВШИМ.
 *
 * Так выглядит шаг, оборвавший процесс. Промолчать о нём — показать зелёный отчёт по красному прогону.
 */
check(() => {
  const parsed = parseQualityOutput('[RUN] Оборвался посередине\nчто-то напечатал и умер')
  assert.deepEqual(parsed.failed, ['Оборвался посередине'])
})
check(() => assert.deepEqual(parseQualityOutput('').steps, []))
check(() => assert.deepEqual(parseQualityOutput(null).steps, []))

await checkAsync(async () => {
  const result = await runCodeQa(async () => ({ code: 0, output: '[RUN] A\n[OK] A', durationMs: 1_000 }))
  assert.equal(result.ok, true)
  assert.deepEqual(result.failed, [])
})

/*
 * КОД ВОЗВРАТА — ГЛАВНЫЙ ПРИЗНАК.
 *
 * Гейт может упасть до первого шага: разбор не найдёт ни одной метки, список падений будет пуст.
 * Объявить такой прогон успешным по пустому списку — прямая ложь о состоянии репозитория.
 */
await checkAsync(async () => {
  const result = await runCodeQa(async () => ({ code: 1, output: 'npm ERR! отсутствует модуль', durationMs: 50 }))
  assert.equal(result.ok, false, 'красный прогон без распознанных шагов объявлен зелёным')
  assert.ok(result.tail.includes('npm ERR!'), 'единственная зацепка потеряна')
})
await checkAsync(async () => {
  const result = await runCodeQa(async () => ({ code: 1, output: GATE_OUTPUT, durationMs: 90_000 }))
  const report = renderCodeReport(result, '2026-08-19')
  assert.ok(report.includes('КРАСНЫЙ'))
  assert.ok(report.includes('Website smoke test'))
})
// Красный прогон без шагов всё равно даёт человеку зацепку, а не «шагов не найдено».
await checkAsync(async () => {
  const result = await runCodeQa(async () => ({ code: 2, output: 'фатальная ошибка сборки', durationMs: 10 }))
  const report = renderCodeReport(result, '2026-08-19')
  assert.ok(report.includes('фатальная ошибка сборки'), 'причина падения не дошла до отчёта')
})

// ─── Инструмент агента ────────────────────────────────────────────────────────────────────────────

await checkAsync(async () => {
  const tool = buildQaAuditTool({ probe: fakeProbe(observe({ status: 500, text: 'x'.repeat(300_000) })) })
  assert.equal(tool.permission, 'read_only')
  // Аудит открывает страницу и обходит ссылки: стандартные пятнадцать секунд реестра оборвали бы его.
  assert.ok(tool.timeoutMs > 60_000, `таймаут инструмента ${tool.timeoutMs} мс — аудит не успеет`)

  const result = await tool.execute({ url: 'https://example.com' }, {})
  assert.equal(result.score, (await runSiteAudit(fakeProbe(observe({ status: 500, text: 'x'.repeat(300_000) })), { url: 'https://example.com' })).score)
  // Модели уходит СВОДКА: полный текст страницы весит сотню килобайт и к решению «что чинить» ничего
  // не добавляет, зато съедает контекст и стоит денег.
  assert.ok(JSON.stringify(result).length < 20_000, `сводка весит ${JSON.stringify(result).length} знаков`)
  assert.ok(!JSON.stringify(result).includes('x'.repeat(1_000)), 'текст страницы утёк в результат инструмента')
  assert.ok(Array.isArray(result.findings) && result.findings.length > 0)
})

// ─── Переменные шлюза ─────────────────────────────────────────────────────────────────────────────

/*
 * ЗАПАСНОЙ ПЕРЕЦ ЕСТЬ В РАЗРАБОТКЕ И НЕТ В БОЮ.
 *
 * Перец подмешивается в отпечаток токена. Постоянное значение по умолчанию, зашитое в репозиторий,
 * было бы одинаковым у всех и однажды уехало бы в боевую среду — а там оно означает, что отпечатки
 * токенов может посчитать любой, кто читал этот файл.
 */
check(() => {
  const dev = resolveGatewayEnv({ SUPABASE_URL: 'https://x.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'k' })
  assert.equal(dev.ok, true, 'шлюз не поднимается локально без перца')
  assert.equal(dev.generatedPepper, true, 'подстановка перца не отмечена')
  assert.ok(dev.pepper.length >= 32, `перец слишком короткий: ${dev.pepper.length}`)
})
check(() => {
  for (const mode of [{ NODE_ENV: 'production' }, { NEMO_ENV: 'PRODUCTION' }]) {
    const prod = resolveGatewayEnv({ SUPABASE_URL: 'u', SUPABASE_SERVICE_ROLE_KEY: 'k', ...mode })
    assert.equal(prod.ok, false, `в бою (${JSON.stringify(mode)}) перец подставился сам`)
    assert.deepEqual(prod.missing, ['NEMO_TOKEN_PEPPER'])
  }
})
// Запасной перец СЛУЧАЙНЫЙ: постоянный был бы общим секретом, известным всем, кто видел репозиторий.
check(() => {
  const env = { SUPABASE_URL: 'u', SUPABASE_SERVICE_ROLE_KEY: 'k' }
  assert.notEqual(resolveGatewayEnv(env).pepper, resolveGatewayEnv(env).pepper, 'перец одинаков между запусками')
})
// Заданный перец не подменяется: иначе перезапуск обесценил бы все выданные токены.
check(() => {
  const set = resolveGatewayEnv({ SUPABASE_URL: 'u', SUPABASE_SERVICE_ROLE_KEY: 'k', NEMO_TOKEN_PEPPER: 'свой' })
  assert.equal(set.pepper, 'свой')
  assert.equal(set.generatedPepper, false)
})
// Отсутствующие переменные называются ВСЕ сразу: падать на первой значит запускать шлюз трижды.
check(() => {
  const empty = resolveGatewayEnv({ NODE_ENV: 'production' })
  assert.equal(empty.missing.length, 3, JSON.stringify(empty.missing))
})
check(() => {
  const byRef = resolveGatewayEnv({ SUPABASE_PROJECT_REF: 'abc', SUPABASE_SECRET_KEY: 'k' })
  assert.equal(byRef.ok, true)
  assert.equal(byRef.url, 'https://abc.supabase.co')
})

// ─── Атрибуция источника данных ───────────────────────────────────────────────────────────────────

/*
 * ЭТО ТРЕБОВАНИЕ ЛИЦЕНЗИИ, А НЕ ВЕЖЛИВОСТЬ.
 *
 * Компании ищутся через OpenStreetMap, чьи данные под ODbL: производные наборы обязаны называть
 * источник. Выгруженный файл уходит в почту, в чат и в CRM заказчика — то есть распространяется.
 */
check(() => assert.ok(withAttribution('имя,телефон\nА,+998', 'csv').startsWith(`# ${OSM_ATTRIBUTION}`)))
check(() => assert.ok(withAttribution('# Отчёт', 'markdown').includes(OSM_ATTRIBUTION)))
// В JSON комментариев нет: атрибуция становится полем, иначе файл перестанет разбираться.
check(() => {
  const wrapped = JSON.parse(withAttribution('[{"a":1}]', 'json'))
  assert.equal(wrapped.attribution, OSM_ATTRIBUTION)
  assert.deepEqual(wrapped.data, [{ a: 1 }])
})
check(() => {
  const merged = JSON.parse(withAttribution('{"leads":[]}', 'json'))
  assert.equal(merged.attribution, OSM_ATTRIBUTION)
  assert.deepEqual(merged.leads, [])
})
// Негодный JSON не чиним и не портим: строка возвращается как прислали.
check(() => assert.equal(withAttribution('{обрыв', 'json'), '{обрыв'))
// Повторная выгрузка не удваивает строку.
check(() => {
  const once = withAttribution('a,b', 'csv')
  assert.equal(withAttribution(once, 'csv'), once)
})
// CSV: строка СВЕРХУ. Снизу её съедают программы, читающие файл до первой пустой строки.
check(() => {
  const lines = withAttribution('имя\nА', 'csv').split('\n')
  assert.ok(lines[0].includes(OSM_ATTRIBUTION))
  assert.equal(lines[1], 'имя')
})

await checkAsync(async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nemo-attr-'))
  try {
    const tool = buildFsExportTool({ directory: dir })
    const result = await tool.execute({ format: 'csv', filename: 'leads', content: 'имя,телефон\nА,+998' }, {})
    const written = await fs.readFile(result.path, 'utf8')
    assert.ok(written.includes(OSM_ATTRIBUTION), 'файл выгружен без указания источника данных')
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

console.log(`[OK] QA runner: ${checks} assertions`)
