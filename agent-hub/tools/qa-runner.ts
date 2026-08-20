// Аудит сайта и аудит репозитория.
//
// РАЗДЕЛЕНИЕ ФАЙЛА НА ДВЕ ЧАСТИ НЕ КОСМЕТИЧЕСКОЕ. Наблюдение (что браузер увидел на странице) отделено
// от суждения (что из увиденного считать неисправностью). Наблюдение требует Chromium и сети; суждение
// — чистая функция над данными. Слитые вместе, они дают проверки, которые можно выполнить только
// вручную и только на живом сайте, то есть которые никто не выполняет.
//
// ЧТО ЗДЕСЬ ЛЕГКО СДЕЛАТЬ НЕПРАВИЛЬНО:
//
// 1. ОЦЕНКА, КОТОРАЯ ВСЕГДА ХОРОШАЯ. Отчёт с «Health Score 92%» на сайте с пятисотой ошибкой хуже
//    отсутствия отчёта: он даёт основание не смотреть. Поэтому критическая находка обрушивает оценку,
//    а не отнимает пару процентов.
//
// 2. МОЛЧАНИЕ О ТОМ, ЧТО НЕ ПРОВЕРЯЛОСЬ. Если ссылки не проверялись — этого не должно быть видно как
//    «битых ссылок нет». Непроверенное и проверенное-и-чистое — разные вещи.
//
// 3. ЧУЖОЙ ДОМЕН В ПРОВЕРКЕ ССЫЛОК. Страница ссылается на сотню внешних адресов; обходить их все —
//    значит устроить чужим серверам всплеск запросов с одной машины и получить бан.

import { z } from 'zod'
import { defineTool, type ToolDefinition } from './registry.ts'
import { detectBookingWidgets, detectMessengers } from './browser.ts'

// ─── Наблюдение ───────────────────────────────────────────────────────────────────────────────────

/** Что браузер увидел. Только факты, без суждений. */
export interface QaObservation {
  url: string
  finalUrl: string
  status: number | null
  /** Время до первого байта. null — измерить не удалось, и это не то же самое, что ноль. */
  ttfbMs: number | null
  loadMs: number
  /** Отрисовка крупнейшего элемента. null на страницах, где браузер её не зафиксировал. */
  lcpMs: number | null
  title: string
  text: string
  links: string[]
  consoleErrors: string[]
  failedRequests: Array<{ url: string; status: number | null; reason?: string }>
  hasViewportMeta: boolean
  hasHorizontalOverflow: boolean
  forms: number
  html: string
  /** Отдала ли страница защиту от ботов. Не всякий зонд это различает — отсюда необязательность. */
  blocked?: boolean
}

export interface QaProbe {
  observe(url: string, options: { timeoutMs: number; viewport: { width: number; height: number } }): Promise<QaObservation>
  /** Проверка ссылок. Возвращает только НЕИСПРАВНЫЕ, чтобы не таскать сотню исправных. */
  checkLinks(urls: readonly string[], options: { limit: number; timeoutMs: number }): Promise<Array<{ url: string; status: number | null; reason?: string }>>
  screenshot(url: string, options: { timeoutMs: number; fullPage: boolean }): Promise<Uint8Array>
  close(): Promise<void>
}

export const MOBILE_VIEWPORT = { width: 390, height: 844 }
export const DESKTOP_VIEWPORT = { width: 1280, height: 800 }

// ─── Суждение ─────────────────────────────────────────────────────────────────────────────────────

export type QaSeverity = 'critical' | 'major' | 'minor'

export interface QaFinding {
  severity: QaSeverity
  kind: string
  message: string
  /** Что делать. Находка без указания направления заставляет искать заново. */
  fix: string
}

/**
 * Вес находки в оценке.
 *
 * Критическая отнимает сорок, а не пять: страница, отдающая 500, не «на 95% здорова». Три критические
 * находки обнуляют оценку — и это правильный ответ, а не крайность.
 */
const WEIGHT: Record<QaSeverity, number> = { critical: 40, major: 12, minor: 4 }

/** Пороги. Взяты из Core Web Vitals, а не выдуманы: LCP хороший до 2.5 с, плохой после 4 с. */
export const THRESHOLDS = {
  lcpGoodMs: 2_500,
  lcpPoorMs: 4_000,
  ttfbSlowMs: 800,
  loadSlowMs: 3_000,
}

export interface QaAudit {
  url: string
  finalUrl: string
  status: number | null
  score: number
  observation: QaObservation
  brokenLinks: Array<{ url: string; status: number | null; reason?: string }>
  /** Проверялись ли ссылки вообще. Непроверенное нельзя показывать как чистое. */
  linksChecked: boolean
  linksSeen: number
  messengers: Array<{ kind: string; url: string }>
  bookingWidgets: string[]
  mobile: { checked: boolean; viewportMeta: boolean; horizontalOverflow: boolean }
  screenshotPath: string | null
  findings: QaFinding[]
}

/** Оценка здоровья: сто минус веса находок, не ниже нуля. */
export function scoreFindings(findings: readonly QaFinding[]): number {
  const penalty = findings.reduce((sum, one) => sum + WEIGHT[one.severity], 0)
  return Math.max(0, 100 - penalty)
}

/**
 * Разбор наблюдения в находки.
 *
 * Чистая функция: те же данные — те же выводы, и проверяется без браузера. Именно здесь живёт всё, что
 * считается неисправностью, — чтобы это можно было обсуждать и менять, не трогая работу с Chromium.
 */
export function auditFindings(input: {
  observation: QaObservation
  brokenLinks: readonly { url: string; status: number | null; reason?: string }[]
  linksChecked: boolean
  messengers: readonly { kind: string; url: string }[]
  bookingWidgets: readonly string[]
  mobileChecked: boolean
}): QaFinding[] {
  const { observation: page } = input
  const findings: QaFinding[] = []

  if (page.status !== null && page.status >= 500) {
    findings.push({
      severity: 'critical', kind: 'http',
      message: `сервер ответил ${page.status}`,
      fix: 'смотреть журнал приложения: до вёрстки и виджетов дело не доходит',
    })
  } else if (page.status !== null && page.status >= 400) {
    findings.push({
      severity: 'critical', kind: 'http',
      message: `страница отдала ${page.status}`,
      fix: 'проверить адрес и правила маршрутизации',
    })
  }

  if (!page.text.trim() && (page.status === null || page.status < 400)) {
    findings.push({
      severity: 'critical', kind: 'empty',
      message: 'страница открылась, но текста на ней нет',
      fix: 'вероятно, разметку рисует скрипт, который не отработал — смотреть ошибки консоли',
    })
  }

  // Ошибки консоли перечисляются НЕ все: двадцать однотипных сообщений от одного скрипта — это одна
  // неисправность, а список из двадцати строк прячет остальные находки.
  const uniqueErrors = [...new Set(page.consoleErrors.map((one) => one.slice(0, 200)))]
  if (uniqueErrors.length) {
    findings.push({
      severity: uniqueErrors.length > 3 ? 'critical' : 'major',
      kind: 'console',
      message: `ошибок в консоли: ${page.consoleErrors.length} (различных ${uniqueErrors.length}) — ${uniqueErrors[0]}`,
      fix: 'открыть страницу в браузере с консолью и починить первую по порядку: остальные часто её следствия',
    })
  }

  const serverFailures = page.failedRequests.filter((one) => one.status !== null && one.status >= 500)
  const clientFailures = page.failedRequests.filter((one) => one.status !== null && one.status >= 400 && one.status < 500)
  const networkFailures = page.failedRequests.filter((one) => one.status === null)
  if (serverFailures.length) {
    findings.push({
      severity: 'critical', kind: 'requests',
      message: `запросов с ответом 5xx: ${serverFailures.length} — ${serverFailures[0].url}`,
      fix: 'страница зависит от сломанного сервиса; починить его или убрать зависимость',
    })
  }
  if (clientFailures.length) {
    findings.push({
      severity: 'major', kind: 'requests',
      message: `запросов с ответом 4xx: ${clientFailures.length} — ${clientFailures[0].url}`,
      fix: 'обычно отсутствующий файл или сменившийся адрес API',
    })
  }
  if (networkFailures.length) {
    findings.push({
      severity: 'major', kind: 'requests',
      message: `не состоялось запросов: ${networkFailures.length} — ${networkFailures[0].url}`,
      fix: 'адрес не отвечает или заблокирован: проверить домен и CORS',
    })
  }

  if (input.brokenLinks.length) {
    findings.push({
      severity: 'major', kind: 'links',
      message: `битых ссылок: ${input.brokenLinks.length} — ${input.brokenLinks.slice(0, 3).map((one) => `${one.url} (${one.status ?? one.reason})`).join(', ')}`,
      fix: 'поправить адреса или убрать ссылки',
    })
  }

  if (page.lcpMs !== null && page.lcpMs > THRESHOLDS.lcpPoorMs) {
    findings.push({
      severity: 'major', kind: 'performance',
      message: `отрисовка главного элемента ${Math.round(page.lcpMs)} мс при пороге ${THRESHOLDS.lcpPoorMs}`,
      fix: 'сжать картинку первого экрана и убрать блокирующие скрипты из <head>',
    })
  } else if (page.lcpMs !== null && page.lcpMs > THRESHOLDS.lcpGoodMs) {
    findings.push({
      severity: 'minor', kind: 'performance',
      message: `отрисовка главного элемента ${Math.round(page.lcpMs)} мс — выше хорошего порога ${THRESHOLDS.lcpGoodMs}`,
      fix: 'проверить вес картинок первого экрана',
    })
  }
  if (page.ttfbMs !== null && page.ttfbMs > THRESHOLDS.ttfbSlowMs) {
    findings.push({
      severity: 'minor', kind: 'performance',
      message: `первый байт через ${Math.round(page.ttfbMs)} мс`,
      fix: 'смотреть время ответа сервера и кэширование',
    })
  }
  if (page.loadMs > THRESHOLDS.loadSlowMs) {
    findings.push({
      severity: 'minor', kind: 'performance',
      message: `полная загрузка ${Math.round(page.loadMs)} мс`,
      fix: 'отложить неглавные скрипты',
    })
  }

  if (input.mobileChecked) {
    if (!page.hasViewportMeta) {
      findings.push({
        severity: 'major', kind: 'mobile',
        message: 'нет мета-тега viewport — на телефоне страница откроется в масштабе рабочего стола',
        fix: '<meta name="viewport" content="width=device-width, initial-scale=1">',
      })
    }
    if (page.hasHorizontalOverflow) {
      findings.push({
        severity: 'major', kind: 'mobile',
        message: 'на ширине телефона содержимое вылезает за экран и появляется горизонтальная прокрутка',
        fix: 'найти элемент шире экрана: обычно таблица, картинка без max-width или фиксированная ширина',
      })
    }
  }

  // Отсутствие способа связаться — это находка по существу задачи: сайт, на который льют рекламу и с
  // которого нельзя написать, теряет заявки молча.
  const contactWays = input.messengers.length + input.bookingWidgets.length + page.forms
  if (contactWays === 0) {
    findings.push({
      severity: 'major', kind: 'conversion',
      message: 'ни формы, ни мессенджера, ни виджета записи — связаться со страницы нечем',
      fix: 'добавить форму заявки или кнопку мессенджера',
    })
  }

  if (page.blocked === true) {
    findings.push({
      severity: 'minor', kind: 'antibot',
      message: 'страница отдала защиту от ботов: часть проверок недостоверна',
      fix: 'проверять такой сайт руками или с настоящим профилем браузера',
    })
  }

  return findings
}

/** Собрать аудит: наблюдение + суждение. */
export async function runSiteAudit(
  probe: QaProbe,
  options: {
    url: string
    mobile?: boolean
    checkLinks?: boolean
    linkLimit?: number
    timeoutMs?: number
    screenshotPath?: string | null
    writeFile?: (path: string, data: Uint8Array) => Promise<void>
  },
): Promise<QaAudit> {
  const timeoutMs = options.timeoutMs ?? 30_000
  const mobile = options.mobile ?? true
  const observation = await probe.observe(options.url, {
    timeoutMs,
    viewport: mobile ? MOBILE_VIEWPORT : DESKTOP_VIEWPORT,
  })

  const messengers = detectMessengers(observation.links)
  const bookingWidgets = detectBookingWidgets(observation.links, observation.html)

  // Ссылки проверяются ТОЛЬКО своего домена и с пределом. Обход сотни внешних адресов — всплеск
  // запросов к чужим серверам с одной машины, за который справедливо банят.
  const origin = safeOrigin(observation.finalUrl || options.url)
  const sameOrigin = [...new Set(observation.links.filter((one) => safeOrigin(one) === origin))]
  const linksChecked = options.checkLinks !== false && sameOrigin.length > 0
  const brokenLinks = linksChecked
    ? await probe.checkLinks(sameOrigin, { limit: options.linkLimit ?? 25, timeoutMs: 10_000 })
    : []

  const findings = auditFindings({
    observation, brokenLinks, linksChecked, messengers, bookingWidgets, mobileChecked: mobile,
  })

  // Снимок делается ТОЛЬКО при критической находке: снимать каждую проверенную страницу — засорять
  // диск гигабайтами картинок, на которые никто не посмотрит.
  let screenshotPath: string | null = null
  const critical = findings.some((one) => one.severity === 'critical')
  if (critical && options.screenshotPath && options.writeFile) {
    try {
      const png = await probe.screenshot(options.url, { timeoutMs, fullPage: false })
      await options.writeFile(options.screenshotPath, png)
      screenshotPath = options.screenshotPath
    } catch {
      // Неудавшийся снимок не отменяет аудит: находки уже собраны и они важнее картинки.
      screenshotPath = null
    }
  }

  return {
    url: options.url,
    finalUrl: observation.finalUrl,
    status: observation.status,
    score: scoreFindings(findings),
    observation,
    brokenLinks,
    linksChecked,
    linksSeen: sameOrigin.length,
    messengers,
    bookingWidgets,
    mobile: {
      checked: mobile,
      viewportMeta: observation.hasViewportMeta,
      horizontalOverflow: observation.hasHorizontalOverflow,
    },
    screenshotPath,
    findings,
  }
}

function safeOrigin(url: string): string | null {
  try {
    return new URL(url).origin
  } catch {
    return null
  }
}

// ─── Аудит репозитория ────────────────────────────────────────────────────────────────────────────

export interface QualityStep { name: string; ok: boolean }
export interface CodeQaResult {
  ok: boolean
  steps: QualityStep[]
  failed: string[]
  durationMs: number
  /** Хвост вывода. Нужен, когда разбор не нашёл ни одного шага: тогда причина видна только в тексте. */
  tail: string
}

/**
 * Разбор вывода гейта качества.
 *
 * Гейт печатает `[RUN] Имя`, потом вывод шага, потом `[OK] Имя` или `[FAIL] Имя`. Разбор идёт по этим
 * меткам, а не по коду возврата: код возврата говорит только «что-то упало», а человеку нужно ЧТО
 * именно.
 *
 * Шаг, у которого есть [RUN], но нет ни [OK], ни [FAIL], считается УПАВШИМ. Это не придирка: так
 * выглядит шаг, оборвавший процесс, — и промолчать о нём значит показать зелёный отчёт по красному
 * прогону.
 */
export function parseQualityOutput(text: string): { steps: QualityStep[]; failed: string[] } {
  const started: string[] = []
  const finished = new Map<string, boolean>()
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const run = /^\[RUN\]\s+(.+?)\s*$/.exec(line)
    if (run) { started.push(run[1]); continue }
    const ok = /^\[OK\]\s+(.+?)\s*$/.exec(line)
    // Метка [OK] печатается и внутри шагов, для отдельных проверок. Засчитываем её только тем именам,
    // которые действительно начинались: иначе «[OK] no TraceCard on a dialogue» станет шагом гейта.
    if (ok && started.includes(ok[1])) { finished.set(ok[1], true); continue }
    const fail = /^\[FAIL\]\s+(.+?)\s*$/.exec(line)
    if (fail) { finished.set(fail[1], false); if (!started.includes(fail[1])) started.push(fail[1]) }
  }
  const steps = started.map((name) => ({ name, ok: finished.get(name) === true }))
  return { steps, failed: steps.filter((one) => !one.ok).map((one) => one.name) }
}

/** Прогнать гейт качества и разобрать вывод. */
export async function runCodeQa(
  exec: () => Promise<{ code: number; output: string; durationMs: number }>,
): Promise<CodeQaResult> {
  const { code, output, durationMs } = await exec()
  const { steps, failed } = parseQualityOutput(output)
  return {
    // Код возврата — ГЛАВНЫЙ признак. Разбор вывода может не найти ни одной метки (гейт упал до
    // первого шага), и считать такой прогон успешным по пустому списку падений — прямая ложь.
    ok: code === 0 && failed.length === 0,
    steps,
    failed,
    durationMs,
    tail: output.split(/\r?\n/).filter((one) => one.trim()).slice(-25).join('\n'),
  }
}

// ─── Отчёт ────────────────────────────────────────────────────────────────────────────────────────

const SEVERITY_TITLE: Record<QaSeverity, string> = {
  critical: 'критично', major: 'важно', minor: 'мелочь',
}

export function renderSiteReport(audit: QaAudit, at: string): string {
  const page = audit.observation
  const lines = [
    `# Аудит ${audit.url}`,
    '',
    `Проверено: ${at}`,
    `**Здоровье: ${audit.score}%**${audit.score < 60 ? ' — требует вмешательства' : audit.score < 85 ? ' — есть что поправить' : ''}`,
    '',
    '## Скорость',
    '',
    `| Показатель | Значение |`,
    `| --- | --- |`,
    `| Ответ сервера | ${audit.status ?? 'не получен'} |`,
    `| Первый байт | ${page.ttfbMs === null ? 'не измерен' : `${Math.round(page.ttfbMs)} мс`} |`,
    `| Отрисовка главного элемента | ${page.lcpMs === null ? 'не зафиксирована' : `${Math.round(page.lcpMs)} мс`} |`,
    `| Полная загрузка | ${Math.round(page.loadMs)} мс |`,
    '',
    '## Ошибки',
    '',
  ]

  if (!page.consoleErrors.length && !page.failedRequests.length && !audit.brokenLinks.length) {
    lines.push(audit.linksChecked
      ? 'Ошибок консоли, сбойных запросов и битых ссылок не найдено.'
      : `Ошибок консоли и сбойных запросов не найдено. Ссылки НЕ проверялись.`)
  } else {
    for (const error of [...new Set(page.consoleErrors)].slice(0, 10)) lines.push(`- консоль: \`${error.slice(0, 300)}\``)
    for (const one of page.failedRequests.slice(0, 10)) lines.push(`- запрос ${one.status ?? one.reason ?? 'не состоялся'}: ${one.url}`)
    for (const one of audit.brokenLinks.slice(0, 10)) lines.push(`- ссылка ${one.status ?? one.reason}: ${one.url}`)
  }

  lines.push(
    '',
    '## Связь и адаптивность',
    '',
    `- мессенджеры: ${audit.messengers.length ? audit.messengers.map((one) => one.kind).join(', ') : 'не найдены'}`,
    `- виджеты записи: ${audit.bookingWidgets.length ? audit.bookingWidgets.join(', ') : 'не найдены'}`,
    `- форм на странице: ${page.forms}`,
    audit.mobile.checked
      ? `- телефон: viewport ${audit.mobile.viewportMeta ? 'есть' : 'НЕТ'}, горизонтальная прокрутка ${audit.mobile.horizontalOverflow ? 'ЕСТЬ' : 'нет'}`
      : '- телефон: не проверялся',
    `- ссылок своего домена: ${audit.linksSeen}${audit.linksChecked ? '' : ' (не проверялись)'}`,
    '',
    '## Что делать',
    '',
  )

  if (!audit.findings.length) lines.push('Ничего не найдено.')
  for (const finding of audit.findings) {
    lines.push(`### ${SEVERITY_TITLE[finding.severity]}: ${finding.message}`, '', finding.fix, '')
  }
  if (audit.screenshotPath) lines.push('', `Снимок при критической находке: \`${audit.screenshotPath}\``)
  return lines.join('\n')
}

export function renderCodeReport(result: CodeQaResult, at: string): string {
  const lines = [
    '# Аудит репозитория',
    '',
    `Проверено: ${at}`,
    `**${result.ok ? 'Гейт качества зелёный' : 'Гейт качества КРАСНЫЙ'}** — шагов ${result.steps.length}, упало ${result.failed.length}, ${Math.round(result.durationMs / 1000)} с`,
    '',
  ]
  if (result.failed.length) {
    lines.push('## Упавшие шаги', '')
    for (const name of result.failed) lines.push(`- ${name}`)
    lines.push('', '## Хвост вывода', '', '```', result.tail, '```')
  } else if (!result.ok) {
    // Красный прогон без единого распознанного шага: причина видна только в тексте, и прятать её
    // за «шагов не найдено» значит оставить человека без единой зацепки.
    lines.push('Гейт завершился с ошибкой, но ни один шаг не распознан — смотреть вывод целиком.', '',
      '## Хвост вывода', '', '```', result.tail, '```')
  } else {
    lines.push('## Шаги', '')
    for (const step of result.steps) lines.push(`- ${step.name}`)
  }
  return lines.join('\n')
}

/** Одна строка для терминала: то, что человек прочитает, не открывая отчёт. */
export function summarizeAudit(audit: QaAudit): string[] {
  const bySeverity = (severity: QaSeverity) => audit.findings.filter((one) => one.severity === severity).length
  return [
    `  здоровье ${audit.score}%  ·  критично ${bySeverity('critical')}, важно ${bySeverity('major')}, мелочь ${bySeverity('minor')}`,
    `  ответ ${audit.status ?? '—'}, загрузка ${Math.round(audit.observation.loadMs)} мс`
      + `${audit.observation.lcpMs === null ? '' : `, отрисовка ${Math.round(audit.observation.lcpMs)} мс`}`,
    ...audit.findings.slice(0, 5).map((one) => `  ${one.severity === 'critical' ? '×' : '!'} ${one.message.slice(0, 110)}`),
  ]
}

// ─── Инструмент агента ────────────────────────────────────────────────────────────────────────────

export const QaAuditParams = z.object({
  url: z.string().url().describe('Полный адрес страницы вместе с http:// или https://'),
  mobile: z.boolean().optional().describe('Проверять на ширине телефона (по умолчанию да)'),
  checkLinks: z.boolean().optional().describe('Обходить ссылки своего домена (по умолчанию да)'),
})

export function buildQaAuditTool(deps: {
  probe: QaProbe
  screenshotDir?: string
  writeFile?: (path: string, data: Uint8Array) => Promise<void>
  now?: () => number
}): ToolDefinition {
  return defineTool({
    name: 'run_qa_audit',
    description: [
      'Проверить сайт: скорость (первый байт, отрисовка, загрузка), ошибки консоли, сбойные запросы,',
      'битые ссылки своего домена, наличие форм, мессенджеров и виджетов записи, вид на телефоне.',
      'Применять, когда просят «проверь сайт», «почему медленно», «работает ли форма», «сделай аудит».',
    ].join(' '),
    parameters: QaAuditParams,
    permission: 'read_only',
    // Аудит открывает страницу и обходит до двадцати пяти ссылок: стандартные пятнадцать секунд
    // реестра оборвали бы его на середине обхода.
    timeoutMs: 180_000,
    execute: async (args) => {
      const stamp = deps.now?.() ?? Date.now()
      const audit = await runSiteAudit(deps.probe, {
        url: args.url,
        mobile: args.mobile,
        checkLinks: args.checkLinks,
        screenshotPath: deps.screenshotDir ? `${deps.screenshotDir}/qa-${stamp}.png` : null,
        writeFile: deps.writeFile,
      })
      // Модели уходит СВОДКА без полного текста страницы: он весит сотню килобайт и к решению
      // «что чинить» ничего не добавляет.
      return {
        url: audit.url,
        finalUrl: audit.finalUrl,
        status: audit.status,
        score: audit.score,
        loadMs: Math.round(audit.observation.loadMs),
        ttfbMs: audit.observation.ttfbMs === null ? null : Math.round(audit.observation.ttfbMs),
        lcpMs: audit.observation.lcpMs === null ? null : Math.round(audit.observation.lcpMs),
        consoleErrors: [...new Set(audit.observation.consoleErrors)].slice(0, 10),
        failedRequests: audit.observation.failedRequests.slice(0, 10),
        brokenLinks: audit.brokenLinks.slice(0, 10),
        linksChecked: audit.linksChecked,
        messengers: audit.messengers,
        bookingWidgets: audit.bookingWidgets,
        forms: audit.observation.forms,
        mobile: audit.mobile,
        screenshot: audit.screenshotPath,
        findings: audit.findings,
      }
    },
  }) as unknown as ToolDefinition
}

export { WEIGHT, SEVERITY_TITLE }
