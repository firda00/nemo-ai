// Глубокий разбор сайта настоящим браузером.
//
// Зачем это нужно поверх обычного fetch. Половина сайтов малого бизнеса в 2026 — это SPA: сервер
// отдаёт пустой каркас с одним <div id="root">, а телефон, адрес и кнопка «Записаться» появляются
// после выполнения JavaScript. Обычный fetch видит каркас и честно сообщает «контактов нет» — и лид
// с работающим телефоном уходит в отсев. Отдельно стоит Cloudflare: он отвечает 403 или страницей
// проверки, и это тоже выглядит как «сайта нет».
//
// ЧЕГО ЭТОТ МОДУЛЬ НЕ ДЕЛАЕТ. Он не обходит проверки на робота. Страница проверки Cloudflare
// РАСПОЗНАЁТСЯ и возвращается как таковая — с честным признаком `blocked`, чтобы вызывающий код не
// принял её текст за содержимое сайта. Проходить капчу, притворяться человеком и подбирать
// user-agent'ы под обход защиты здесь нечем и не будет: это чужая инфраструктура, и владелец сайта
// выразил своё отношение к автоматическому доступу вполне однозначно.
//
// ЦЕНА. Браузер — самый дорогой инструмент в наборе: ~150 МБ памяти на процесс и секунды на страницу.
// Поэтому: тяжёлые ресурсы (картинки, шрифты, видео, аналитика) не загружаются вовсе, экземпляр
// браузера переиспользуется между страницами, а закрытие гарантировано в finally. Незакрытый Chromium
// остаётся зомби-процессом в системе, и через сутки такой воркер съедает всю память машины.
//
// ДВИЖОК ПОДМЕНЯЕМ. По умолчанию Playwright, как требует ТЗ V5. Но в проекте уже живёт puppeteer (им
// работают дымовые тесты сайта), и он умеет ровно то же самое. Поэтому запуск вынесен в интерфейс
// BrowserEngine: перевести модуль на puppeteer — это подстановка одной реализации, а не переписывание.

import { z } from 'zod'
import { defineTool } from './registry.ts'

/** Что не грузим никогда. Экономия здесь измеряется секундами и десятками мегабайт на страницу. */
const BLOCKED_RESOURCE_TYPES = new Set(['image', 'font', 'media', 'stylesheet'])

/**
 * Домены аналитики и рекламы.
 *
 * Блокируются не из принципа, а потому что их скрипты — главная причина, по которой networkidle не
 * наступает никогда: счётчики держат открытые соединения и опрашивают сервер по таймеру.
 */
const BLOCKED_HOSTS = [
  'google-analytics.com', 'googletagmanager.com', 'doubleclick.net', 'facebook.net',
  'connect.facebook.com', 'mc.yandex.ru', 'top-fwz1.mail.ru', 'vk.com/rtrg',
  'hotjar.com', 'clarity.ms', 'sentry.io',
]

/** Бюджет на страницу. ТЗ просит < 2.5 с; 2500 мс — цель, 8000 мс — потолок, за которым мы уходим. */
const NAVIGATION_TIMEOUT_MS = 8_000
const IDLE_TIMEOUT_MS = 2_500

/** Сколько текста забираем. Больше 200 КБ в модель всё равно не поедет, а память съест. */
const MAX_TEXT_CHARS = 200_000

// ── Признаки, которые мы ищем на странице ──────────────────────────────────────────────────────────

/**
 * Ссылки на мессенджеры. Именно они превращают «нашли сайт» в «есть куда написать».
 *
 * Порядок проверки от точного к общему: t.me/joinchat — приглашение в чат, а не аккаунт компании, и
 * писать туда бессмысленно, поэтому такие ссылки отбрасываются отдельно.
 */
const MESSENGER_PATTERNS: Array<{ kind: string; test: RegExp }> = [
  { kind: 'whatsapp', test: /(?:wa\.me|api\.whatsapp\.com|whatsapp:\/\/)/i },
  { kind: 'telegram', test: /(?:t\.me|telegram\.me|tg:\/\/)/i },
  { kind: 'instagram', test: /instagram\.com\/[a-z0-9._]+/i },
  { kind: 'facebook', test: /(?:facebook\.com|fb\.me|m\.me)\//i },
  { kind: 'viber', test: /viber:\/\//i },
]

/**
 * Виджеты онлайн-записи и чата.
 *
 * Признак сильный: компания, у которой стоит YClients или Jivo, уже платит за автоматизацию приёма
 * заявок — значит понимает её ценность и говорит с нами на одном языке.
 */
const BOOKING_WIDGET_PATTERNS: Array<{ kind: string; test: RegExp }> = [
  { kind: 'yclients', test: /yclients\.com|n\d+\.yclients/i },
  { kind: 'dikidi', test: /dikidi\.(?:net|ru)/i },
  { kind: 'calendly', test: /calendly\.com/i },
  { kind: 'jivosite', test: /jivo(?:site)?\.(?:ru|com)|code\.jivosite/i },
  { kind: 'bitrix24', test: /bitrix24|cdn-ru\.bitrix24/i },
  { kind: 'tawk', test: /tawk\.to/i },
  { kind: 'intercom', test: /intercom\.(?:io|com)/i },
  { kind: 'crisp', test: /crisp\.chat/i },
  { kind: 'tidio', test: /tidio(?:chat)?\.(?:com|co)/i },
]

/**
 * Признаки страницы-заслона, а не сайта.
 *
 * Нужны, чтобы НЕ соврать вызывающему коду. Текст «Checking your browser before accessing» —
 * не содержимое сайта, и принять его за описание компании значит отправить в модель мусор, а оттуда
 * получить уверенную оценку несуществующего бизнеса.
 */
const CHALLENGE_MARKERS = [
  'checking your browser', 'cf-browser-verification', 'cf_chl_opt', 'ray id',
  'enable javascript and cookies to continue', 'проверка браузера', 'ddos-guard',
  'attention required! | cloudflare', 'just a moment...',
]

// ── Разбор собранного: чистые функции, проверяемые без браузера ─────────────────────────────────────

export interface DetectedLink { kind: string; url: string }

/** Ссылки на мессенджеры среди всех href страницы. Дубли по kind+url убираются. */
export function detectMessengers(urls: readonly string[]): DetectedLink[] {
  const seen = new Set<string>()
  const out: DetectedLink[] = []
  for (const url of urls) {
    // Приглашение в закрытый чат — не канал связи с компанией: писать в него нельзя, можно только войти.
    if (/t\.me\/(?:joinchat|\+)/i.test(url)) continue
    for (const { kind, test } of MESSENGER_PATTERNS) {
      if (!test.test(url)) continue
      const key = `${kind}:${url}`
      if (!seen.has(key)) { seen.add(key); out.push({ kind, url }) }
      break
    }
  }
  return out
}

/**
 * Виджеты записи и чата — по адресам подключённых скриптов и iframe.
 *
 * Возвращается ВИД виджета, а не адрес: адрес скрипта YClients владельцу лида ни о чём не говорит,
 * а «стоит YClients» — говорит сразу.
 */
export function detectBookingWidgets(urls: readonly string[], html = ''): string[] {
  const found = new Set<string>()
  for (const { kind, test } of BOOKING_WIDGET_PATTERNS) {
    if (urls.some((url) => test.test(url)) || test.test(html)) found.add(kind)
  }
  return [...found]
}

/** Похоже ли на страницу-заслон вместо сайта. */
export function looksLikeChallenge(title: string, text: string): boolean {
  const haystack = `${title}\n${text}`.toLowerCase()
  return CHALLENGE_MARKERS.some((marker) => haystack.includes(marker))
}

/** Надо ли блокировать запрос: тип ресурса или домен аналитики. */
export function shouldBlockRequest(resourceType: string, url: string): boolean {
  if (BLOCKED_RESOURCE_TYPES.has(resourceType)) return true
  return BLOCKED_HOSTS.some((host) => url.includes(host))
}

// ── Движок ─────────────────────────────────────────────────────────────────────────────────────────

export interface PageHarvest {
  url: string
  finalUrl: string
  title: string
  text: string
  links: string[]
  requestedUrls: string[]
  html: string
  status: number | null
}

/**
 * То, что от браузера вообще требуется.
 *
 * Интерфейс существует ради двух вещей: подменяемости движка (Playwright по ТЗ, puppeteer уже в
 * проекте) и проверяемости — тесты подставляют сюда заглушку и проверяют разбор без запуска Chromium.
 */
export interface BrowserEngine {
  harvest(url: string, options: { timeoutMs: number; idleMs: number }): Promise<PageHarvest>
  screenshot(url: string, options: { timeoutMs: number; fullPage: boolean }): Promise<Uint8Array>
  close(): Promise<void>
}

// Минимальная форма того, что мы используем у Playwright.
//
// Описано структурно, а не через `Record<string, unknown>` с приведениями на каждом вызове: такое
// приведение позволяет ОТОРВАТЬ метод от объекта (`const evaluate = page.evaluate`), и он теряет
// this — Playwright падает изнутри с «Cannot read properties of undefined (reading '_mainFrame')».
// Типы здесь ловят это на месте. Полные типы playwright не импортируются нарочно: модуль обязан
// собираться и там, где playwright не установлен, — движок подменяемый.
interface PwRequest { resourceType(): string; url(): string }
interface PwRoute { abort(): Promise<void>; continue(): Promise<void> }
interface PwResponse { status(): number }
interface PwPage {
  route(pattern: string, handler: (route: PwRoute, request: PwRequest) => unknown): Promise<void>
  goto(url: string, options: { waitUntil: string; timeout: number }): Promise<PwResponse | null>
  waitForLoadState(state: string, options: { timeout: number }): Promise<void>
  evaluate(expression: string): Promise<unknown>
  screenshot(options: { fullPage: boolean; type: string }): Promise<Uint8Array>
  url(): string
}
interface PwContext { newPage(): Promise<PwPage>; close(): Promise<void> }
interface PwBrowser {
  newContext(options: Record<string, unknown>): Promise<PwContext>
  close(): Promise<void>
}

/**
 * Playwright поверх headless Chromium.
 *
 * Экземпляр браузера ОДИН на объект и создаётся лениво: запуск Chromium стоит ~300 мс, и платить их
 * на каждой из пятнадцати страниц прогона незачем. Контекст и страница — свои на каждый вызов: общий
 * контекст тащит cookies с предыдущего сайта на следующий, а это уже не разбор, а слежка.
 */
export class PlaywrightEngine {
  private browser: PwBrowser | null = null
  private launching: Promise<PwBrowser> | null = null
  // Поле объявлено отдельно, а не сокращением в параметрах конструктора: node --experimental-strip-types
  // работает в режиме «только стирание типов» и parameter properties не понимает — они требуют
  // генерации кода, а не удаления аннотаций.
  private readonly launcher: (() => Promise<PwBrowser>) | undefined

  constructor(launcher?: () => Promise<PwBrowser>) {
    this.launcher = launcher
  }

  private async browserInstance(): Promise<PwBrowser> {
    if (this.browser) return this.browser
    // Запуск сериализуется: два одновременных вызова harvest() иначе поднимут два Chromium, и один
    // из них останется без ссылки — то есть навсегда.
    if (!this.launching) this.launching = (this.launcher ?? defaultLauncher)()
    this.browser = await this.launching
    return this.browser
  }

  async harvest(url: string, options: { timeoutMs: number; idleMs: number }): Promise<PageHarvest> {
    const browser = await this.browserInstance()
    let context: PwContext | null = null
    try {
      context = await browser.newContext({
        // Честный признак: мы не притворяемся человеком, но и не молчим о том, кто пришёл.
        userAgent: 'Mozilla/5.0 (compatible; NemoAI-SDR/1.0; +https://nemo.ai/bot)',
        viewport: { width: 1280, height: 900 },
        javaScriptEnabled: true,
      })
      const page = await context.newPage()
      const requestedUrls: string[] = []

      await page.route('**/*', (route, request) => {
        const type = request.resourceType()
        const href = request.url()
        // Адреса запросов собираются ДО блокировки: именно по ним опознаются виджеты. Скрипт
        // YClients можно не выполнять, но знать, что его подключили, обязательно.
        requestedUrls.push(href)
        return shouldBlockRequest(type, href) ? route.abort() : route.continue()
      })

      const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: options.timeoutMs })

      // networkidle — ОТДЕЛЬНЫМ ожиданием и с мягким отказом. Сайт со счётчиком, опрашивающим сервер
      // по таймеру, не затихает никогда, и goto({waitUntil:'networkidle'}) на нём падает целиком,
      // выбрасывая уже отрисованную страницу. Здесь неудача ожидания — не повод терять содержимое.
      await page.waitForLoadState('networkidle', { timeout: options.idleMs })
        .catch(() => { /* сеть не затихла — забираем то, что уже отрисовано */ })

      // Методы вызываются НА объекте page, а не через оторванную ссылку: `const e = page.evaluate`
      // теряет this, и Playwright падает изнутри с «Cannot read properties of undefined
      // (reading '_mainFrame')». Ошибка при этом выглядит как сбой сайта, а не как наша.
      const title = String(await page.evaluate('document.title') ?? '')
      const text = String(await page.evaluate('document.body ? document.body.innerText : ""') ?? '')
      const html = String(await page.evaluate('document.documentElement.outerHTML') ?? '')
      const links = await page.evaluate('Array.from(document.querySelectorAll("a[href]")).map(a => a.href)')

      return {
        url,
        finalUrl: page.url(),
        title,
        text: text.slice(0, MAX_TEXT_CHARS),
        links: Array.isArray(links) ? links as string[] : [],
        requestedUrls,
        html: html.slice(0, MAX_TEXT_CHARS),
        status: response ? response.status() : null,
      }
    } finally {
      // Контекст закрывается ВСЕГДА. Незакрытый контекст держит процесс рендерера, и после сотни
      // страниц машина уходит в свап — это ровно тот зомби, о котором предупреждает ТЗ.
      await context?.close().catch(() => {})
    }
  }

  async screenshot(url: string, options: { timeoutMs: number; fullPage: boolean }): Promise<Uint8Array> {
    const browser = await this.browserInstance()
    let context: PwContext | null = null
    try {
      context = await browser.newContext({ viewport: { width: 1280, height: 900 } })
      const page = await context.newPage()
      // Для скриншота картинки и шрифты НУЖНЫ: снимок без них не годится для проверки глазами, а
      // именно для неё скриншот и делается. Блокируем только аналитику.
      await page.route('**/*', (route, request) => {
        const href = request.url()
        return BLOCKED_HOSTS.some((host) => href.includes(host)) ? route.abort() : route.continue()
      })
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: options.timeoutMs })
      return await page.screenshot({ fullPage: options.fullPage, type: 'png' })
    } finally {
      await context?.close().catch(() => {})
    }
  }

  /** Закрыть браузер. Идемпотентно: повторный вызов из finally не должен падать. */
  async close(): Promise<void> {
    const browser = this.browser
    this.browser = null
    this.launching = null
    await browser?.close().catch(() => {})
  }
}

/**
 * Запуск Chromium.
 *
 * Импорт ДИНАМИЧЕСКИЙ и это важно: playwright тянет за собой тяжёлый модуль, и статический импорт
 * заставлял бы платить за него каждый прогон CLI, включая те, где браузер не нужен вовсе.
 */
async function defaultLauncher(): Promise<PwBrowser> {
  const { chromium } = await import('playwright')
  const browser = await chromium.launch({
    headless: true,
    // Флаги под контейнер: без --no-sandbox Chromium не стартует под root в Docker, а именно так
    // воркер и будет жить в production по спецификации V5 (§6).
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
  })
  return browser as unknown as PwBrowser
}

// ── Инструменты для реестра ────────────────────────────────────────────────────────────────────────

export const NavigateAndExtractParams = z.object({
  url: z.string().url('нужен полный адрес, включая https://').describe('Адрес страницы для разбора'),
  fullText: z.boolean().default(false).describe('Вернуть весь текст страницы, а не первые 8000 знаков'),
})

export interface ExtractResult {
  finalUrl: string
  title: string
  text: string
  textLength: number
  status: number | null
  blocked: boolean
  messengers: DetectedLink[]
  bookingWidgets: string[]
  linkCount: number
  durationMs: number
}

/**
 * Разбор одной страницы: текст, мессенджеры, виджеты записи.
 *
 * Заслон возвращается ПРИЗНАКОМ, а не ошибкой: вызывающий код должен уметь отличить «сайт закрыт от
 * роботов» от «на сайте нет контактов». Первое — повод оставить лид с пометкой, второе — повод его
 * отсеять, и путать их нельзя.
 */
export function buildNavigateAndExtractTool(engine: BrowserEngine) {
  return defineTool({
    name: 'browser_navigate_and_extract',
    description: 'Открыть страницу в настоящем браузере, дождаться отрисовки JavaScript и извлечь '
      + 'текст, ссылки на мессенджеры (WhatsApp, Telegram, Instagram) и виджеты онлайн-записи '
      + '(YClients, Calendly, Jivo). Применять, когда обычная загрузка страницы вернула пустой '
      + 'каркас, отказ доступа или не нашла контактов.',
    permission: 'read_only',
    parameters: NavigateAndExtractParams,
    // Свой таймаут выше бюджета страницы: внутри уже есть навигация (8 с) и ожидание тишины (2.5 с),
    // и внешний предел должен их накрывать, а не срезать на середине.
    timeoutMs: NAVIGATION_TIMEOUT_MS + IDLE_TIMEOUT_MS + 4_000,
    execute: async (args): Promise<ExtractResult> => {
      const startedAt = Date.now()
      const harvest = await engine.harvest(args.url, {
        timeoutMs: NAVIGATION_TIMEOUT_MS,
        idleMs: IDLE_TIMEOUT_MS,
      })
      const blocked = looksLikeChallenge(harvest.title, harvest.text)
      return {
        finalUrl: harvest.finalUrl,
        title: harvest.title,
        // Текст режется по умолчанию: страница на 200 КБ в поручении модели стоит дороже, чем
        // приносит, а полный текст доступен явным флагом.
        text: args.fullText ? harvest.text : harvest.text.slice(0, 8_000),
        textLength: harvest.text.length,
        status: harvest.status,
        blocked,
        messengers: detectMessengers(harvest.links),
        bookingWidgets: detectBookingWidgets([...harvest.requestedUrls, ...harvest.links], harvest.html),
        linkCount: harvest.links.length,
        durationMs: Date.now() - startedAt,
      }
    },
  })
}

export const ScreenshotParams = z.object({
  url: z.string().url('нужен полный адрес, включая https://').describe('Адрес страницы'),
  fullPage: z.boolean().default(false).describe('Снять страницу целиком, а не только первый экран'),
})

/**
 * Снимок страницы для проверки глазами.
 *
 * Возвращается base64, а не путь к файлу: инструмент может выполняться в контейнере, чья файловая
 * система исчезнет вместе с ним, и «сохранил в /tmp/shot.png» в таком случае — обещание без покрытия.
 * Куда положить снимок, решает вызывающая сторона.
 */
export function buildScreenshotTool(engine: BrowserEngine) {
  return defineTool({
    name: 'browser_screenshot',
    description: 'Сделать снимок страницы (PNG в base64) для проверки того, что именно видит '
      + 'посетитель. Применять для сверки, когда разбор текста дал неожиданный результат.',
    permission: 'read_only',
    parameters: ScreenshotParams,
    timeoutMs: NAVIGATION_TIMEOUT_MS + 6_000,
    execute: async (args) => {
      const bytes = await engine.screenshot(args.url, {
        timeoutMs: NAVIGATION_TIMEOUT_MS, fullPage: args.fullPage,
      })
      return {
        url: args.url,
        format: 'png',
        base64: Buffer.from(bytes).toString('base64'),
        byteLength: bytes.byteLength,
      }
    },
  })
}

/**
 * Зарегистрировать браузерные инструменты и вернуть способ всё закрыть.
 *
 * Возвращается именно `close`, а не сам движок: вызывающий код обязан закрыть браузер, и напоминание
 * об этом должно попасть ему в руки в момент регистрации, а не остаться в документации.
 */
export function registerBrowserTools(
  registry: { register: (tool: ReturnType<typeof buildScreenshotTool>) => unknown },
  engine: BrowserEngine = new PlaywrightEngine(),
): { engine: BrowserEngine; close: () => Promise<void> } {
  registry.register(buildNavigateAndExtractTool(engine) as ReturnType<typeof buildScreenshotTool>)
  registry.register(buildScreenshotTool(engine))
  return { engine, close: () => engine.close() }
}

export { NAVIGATION_TIMEOUT_MS, IDLE_TIMEOUT_MS, BLOCKED_HOSTS, BLOCKED_RESOURCE_TYPES }
