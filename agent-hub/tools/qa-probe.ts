// Зонд аудита на Playwright: единственное место, которому нужен настоящий Chromium.
//
// ОТДЕЛЬНО ОТ qa-runner.ts, потому что там живут суждения (что считать неисправностью), а здесь —
// наблюдения (что браузер увидел). Суждения проверяются заглушкой за миллисекунды; наблюдения —
// только запуском браузера. Смешать их значит сделать всю логику аудита непроверяемой.
//
// ЧТО ЗДЕСЬ ЛЕГКО СЛОМАТЬ:
//
// 1. ИЗМЕРЕНИЕ ОТРИСОВКИ (LCP). Наблюдатель обязан быть установлен ДО навигации: PerformanceObserver,
//    заведённый после загрузки, не увидит уже случившихся событий, и показатель молча станет null на
//    всех страницах. Отсюда addInitScript, а не evaluate после goto.
//
// 2. ЗАКРЫТИЕ БРАУЗЕРА. Незакрытый Chromium остаётся процессом на 150 МБ. Закрытие — в finally, и
//    отдельно от него закрывается контекст: страница может упасть, а браузер при этом жив.
//
// 3. ГОРИЗОНТАЛЬНАЯ ПРОКРУТКА. Сравнивать надо scrollWidth документа с шириной ОКНА, а не с
//    clientWidth того же элемента: у документа с overflow они совпадают, и проверка всегда проходит.

import { detectMessengers } from './browser.ts'
import type { QaObservation, QaProbe } from './qa-runner.ts'

/** Скрипт, который считает отрисовку главного элемента. Ставится до навигации. */
const LCP_SCRIPT = `
  window.__nemoLcp = null;
  try {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) window.__nemoLcp = entry.startTime;
    }).observe({ type: 'largest-contentful-paint', buffered: true });
  } catch (error) { /* браузер без поддержки — показатель останется null */ }
`

/** Что снимаем со страницы после загрузки. Одним заходом: каждый evaluate — это круг в браузер. */
const HARVEST_SCRIPT = `(() => {
  const links = [...document.querySelectorAll('a[href]')].map((a) => a.href).filter(Boolean);
  const doc = document.documentElement;
  return {
    title: document.title || '',
    text: (document.body && document.body.innerText || '').slice(0, 200000),
    html: doc.outerHTML.slice(0, 400000),
    links: links.slice(0, 500),
    forms: document.querySelectorAll('form').length,
    hasViewportMeta: Boolean(document.querySelector('meta[name="viewport"]')),
    // Ширина ОКНА, а не clientWidth того же элемента: у документа с переполнением они совпадают,
    // и сравнение с самим собой всегда даёт «всё в порядке».
    horizontalOverflow: doc.scrollWidth > window.innerWidth + 2,
    ttfb: (() => {
      const nav = performance.getEntriesByType('navigation')[0];
      return nav && typeof nav.responseStart === 'number' ? nav.responseStart : null;
    })(),
    lcp: window.__nemoLcp,
  };
})()`

interface PwConsoleMessage { type(): string; text(): string }
interface PwRequestLike { url(): string; failure(): { errorText: string } | null }
interface PwResponseLike { url(): string; status(): number }
interface PwPageLike {
  on(event: string, handler: (payload: never) => void): void
  addInitScript(script: string): Promise<void>
  goto(url: string, options: { waitUntil: string; timeout: number }): Promise<{ status(): number } | null>
  waitForLoadState(state: string, options: { timeout: number }): Promise<void>
  evaluate(expression: string): Promise<unknown>
  screenshot(options: { fullPage: boolean; type: string }): Promise<Uint8Array>
  url(): string
}
interface PwContextLike { newPage(): Promise<PwPageLike>; close(): Promise<void> }
interface PwBrowserLike {
  newContext(options: Record<string, unknown>): Promise<PwContextLike>
  close(): Promise<void>
}

export class PlaywrightQaProbe implements QaProbe {
  private browser: PwBrowserLike | null = null
  private readonly launch: () => Promise<PwBrowserLike>
  private readonly fetchImpl: typeof fetch

  constructor(options: { launch?: () => Promise<PwBrowserLike>; fetchImpl?: typeof fetch } = {}) {
    this.launch = options.launch ?? (async () => {
      const { chromium } = await import('playwright')
      return await chromium.launch({ headless: true }) as unknown as PwBrowserLike
    })
    this.fetchImpl = options.fetchImpl ?? fetch
  }

  private async browserInstance(): Promise<PwBrowserLike> {
    // Один браузер на зонд: запуск Chromium стоит ~300 мс, платить их на каждой странице незачем.
    if (!this.browser) this.browser = await this.launch()
    return this.browser
  }

  async observe(
    url: string,
    options: { timeoutMs: number; viewport: { width: number; height: number } },
  ): Promise<QaObservation> {
    const browser = await this.browserInstance()
    const context = await browser.newContext({
      viewport: options.viewport,
      // Телефонный размер без телефонного user-agent даёт страницы, которые верстальщик считает
      // десктопными: половина сайтов различает устройства по строке агента, а не по ширине.
      isMobile: options.viewport.width < 768,
      hasTouch: options.viewport.width < 768,
      ignoreHTTPSErrors: true,
    })

    const consoleErrors: string[] = []
    const failedRequests: Array<{ url: string; status: number | null; reason?: string }> = []

    try {
      const page = await context.newPage()
      await page.addInitScript(LCP_SCRIPT)

      page.on('console', ((message: PwConsoleMessage) => {
        if (message.type() === 'error') consoleErrors.push(message.text())
      }) as (payload: never) => void)
      page.on('pageerror', ((error: Error) => {
        // Необработанное исключение — это НЕ то же самое, что console.error: оно останавливает
        // выполнение скрипта, и молчать о нём нельзя даже при чистой консоли.
        consoleErrors.push(`необработанное исключение: ${error.message}`)
      }) as (payload: never) => void)
      page.on('requestfailed', ((request: PwRequestLike) => {
        failedRequests.push({ url: request.url(), status: null, reason: request.failure()?.errorText ?? 'запрос не состоялся' })
      }) as (payload: never) => void)
      page.on('response', ((response: PwResponseLike) => {
        if (response.status() >= 400) failedRequests.push({ url: response.url(), status: response.status() })
      }) as (payload: never) => void)

      const started = Date.now()
      const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: options.timeoutMs })
      const status = response?.status() ?? null

      // Тишина в сети — ОТДЕЛЬНОЕ ожидание с мягким отказом: сайты с опросом сервера не затихают
      // никогда, и падать из-за этого нельзя — страница уже загружена и пригодна к разбору.
      try {
        await page.waitForLoadState('networkidle', { timeout: Math.min(8_000, options.timeoutMs) })
      } catch { /* не затихла — разбираем как есть */ }
      const loadMs = Date.now() - started

      const harvested = await page.evaluate(HARVEST_SCRIPT) as {
        title: string; text: string; html: string; links: string[]; forms: number
        hasViewportMeta: boolean; horizontalOverflow: boolean; ttfb: number | null; lcp: number | null
      }

      return {
        url,
        finalUrl: page.url(),
        status,
        ttfbMs: harvested.ttfb,
        loadMs,
        lcpMs: harvested.lcp,
        title: harvested.title,
        text: harvested.text,
        html: harvested.html,
        links: harvested.links,
        consoleErrors,
        failedRequests,
        hasViewportMeta: harvested.hasViewportMeta,
        hasHorizontalOverflow: harvested.horizontalOverflow,
        forms: harvested.forms,
      }
    } finally {
      // Контекст закрывается ВСЕГДА, включая путь через исключение: иначе каждая упавшая проверка
      // оставляет открытую вкладку, и после десятка проверок Chromium съедает память машины.
      await context.close().catch(() => {})
    }
  }

  /**
   * Обход ссылок.
   *
   * Последовательно и с пределом. Двадцать пять параллельных запросов к одному домену выглядят со
   * стороны сервера как атака, и первое, что получит владелец инструмента, — блокировку по адресу.
   *
   * Метод HEAD с откатом на GET: часть серверов отвечает на HEAD четыреста пятым, и считать такую
   * ссылку битой — врать.
   */
  async checkLinks(
    urls: readonly string[],
    options: { limit: number; timeoutMs: number },
  ): Promise<Array<{ url: string; status: number | null; reason?: string }>> {
    const broken: Array<{ url: string; status: number | null; reason?: string }> = []
    for (const url of urls.slice(0, options.limit)) {
      const status = await this.probeUrl(url, options.timeoutMs)
      if (status.status !== null && status.status >= 400) broken.push({ url, status: status.status })
      else if (status.status === null) broken.push({ url, status: null, reason: status.reason })
    }
    return broken
  }

  private async probeUrl(url: string, timeoutMs: number): Promise<{ status: number | null; reason?: string }> {
    for (const method of ['HEAD', 'GET'] as const) {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), timeoutMs)
      try {
        const response = await this.fetchImpl(url, { method, signal: controller.signal, redirect: 'follow' })
        if (method === 'HEAD' && (response.status === 405 || response.status === 501)) continue
        return { status: response.status }
      } catch (error) {
        if (method === 'GET') {
          return { status: null, reason: error instanceof Error ? error.message.slice(0, 80) : 'не отвечает' }
        }
      } finally {
        clearTimeout(timer)
      }
    }
    return { status: null, reason: 'не отвечает' }
  }

  async screenshot(url: string, options: { timeoutMs: number; fullPage: boolean }): Promise<Uint8Array> {
    const browser = await this.browserInstance()
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, ignoreHTTPSErrors: true })
    try {
      const page = await context.newPage()
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: options.timeoutMs })
      return await page.screenshot({ fullPage: options.fullPage, type: 'png' })
    } finally {
      await context.close().catch(() => {})
    }
  }

  async close(): Promise<void> {
    if (!this.browser) return
    const browser = this.browser
    this.browser = null
    await browser.close().catch(() => {})
  }
}

export { LCP_SCRIPT, HARVEST_SCRIPT, detectMessengers }
