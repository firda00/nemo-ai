// Обогащение: сайт компании + поиск людей + разбор браузером, когда простого запроса не хватило.
//
// НЕ ДОЛЖЕН падать целиком из-за одного плохого источника — обогащение улучшает лид, а не решает,
// быть ли ему в списке. Каждый источник (сайт, LinkUp, браузер) отказывает НЕЗАВИСИМО, и его отказ
// уходит в поле failed, а не в исключение, которое остановило бы весь пайплайн ради одной компании.
//
// ПОЧЕМУ БРАУЗЕР ВНЕДРЯЕТСЯ, А НЕ ИМПОРТИРУЕТСЯ. Этот модуль лежит в слое, который выполняется и в
// Deno (Edge Functions), и в Node (воркер, CLI). Playwright существует только во втором. Статический
// импорт сломал бы первый, а условный импорт внутри функции — спрятал бы зависимость там, где её
// никто не ищет. Поэтому браузер приходит параметром: кто умеет его запустить, тот и передаёт.
//
// РЕШЕНИЕ «нужен ли браузер» живёт ЗДЕСЬ, а не в браузерном модуле. Это вопрос про результат запроса,
// который только что сделало обогащение, — а не про то, как работает Chromium.

import { z } from 'zod'
import type { Enricher } from './contracts.ts'
import { Enrichment, type CleanCompany } from './schemas.ts'

const FETCH_TIMEOUT_MS = 10_000
// 2 МБ — сайт-визитка, а не архив. Больше значит либо очень тяжёлая страница, либо бесконечный
// поток, и ни то ни другое не стоит того, чтобы держать пайплайн ради одной компании.
const MAX_HTML_BYTES = 2_000_000

/** Убирает <script>/<style>: минифицированный JS и CSS полны email- и ссылко-подобного мусора. */
function stripNoise(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
}

const IMAGE_EXT = /\.(png|jpe?g|gif|svg|webp|ico|bmp)$/i
const EmailSchema = z.string().email().max(200)

/**
 * HTML-сущности обратно в символы.
 *
 * Найдено на живой выдаче: ссылка на Instagram приехала как
 * `...share_sheet&amp;igsh=...`. В HTML это правильная запись амперсанда, но в АДРЕСЕ она означает
 * параметр с именем `amp;igsh` — по такой ссылке владелец попадёт не туда, а он её копирует из
 * отчёта и отправляет клиенту. Декодируются только те пять сущностей, что реально встречаются в
 * адресах; полноценный разбор HTML здесь не нужен и стоил бы зависимости.
 */
export function decodeEntities(text: string): string {
  return text
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#0*39;|&apos;/gi, "'")
}

/**
 * Адреса почты из текста страницы.
 *
 * `image@2x.png` из атрибута srcset проходит наивный email-регексп: у него есть «@» и точка перед
 * буквами. Фильтр по расширению плюс финальная проверка через z.string().email() отсеивают такое,
 * не отсеивая настоящие адреса вроде `info@company.uz`.
 */
export function extractEmails(html: string): string[] {
  const clean = stripNoise(html)
  const matches = clean.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9-]+\.[a-zA-Z]{2,24}/g) ?? []
  const seen = new Set<string>()
  for (const raw of matches) {
    const email = raw.toLowerCase()
    if (IMAGE_EXT.test(email)) continue
    if (!EmailSchema.safeParse(email).success) continue
    seen.add(email)
  }
  return [...seen].slice(0, 10)
}

type Socials = z.infer<typeof Enrichment>['socials']
const SOCIAL_PATTERNS: Record<keyof Socials, RegExp> = {
  linkedin: /https?:\/\/([\w.-]*\.)?linkedin\.com\/[^\s"'<>]+/i,
  instagram: /https?:\/\/([\w.-]*\.)?instagram\.com\/[^\s"'<>]+/i,
  telegram: /https?:\/\/(t\.me|telegram\.me)\/[^\s"'<>]+/i,
  facebook: /https?:\/\/([\w.-]*\.)?facebook\.com\/[^\s"'<>]+/i,
  // wa.me и api.whatsapp.com — две записи одного и того же. Обе встречаются на живых сайтах, причём
  // вторая чаще в кнопках «написать в WhatsApp», сделанных конструктором.
  whatsapp: /https?:\/\/(wa\.me|api\.whatsapp\.com)\/[^\s"'<>]+/i,
}

/** Пустой набор ссылок. Одно место на весь модуль: поле, забытое в одной из копий, ломает проверку схемы. */
function emptySocials(): Socials {
  return { linkedin: null, instagram: null, telegram: null, facebook: null, whatsapp: null }
}

/** Ссылки на соцсети из href-адресов страницы — по домену, а не по слову рядом со ссылкой. */
export function extractSocials(html: string): Socials {
  const clean = stripNoise(html)
  const out: Socials = emptySocials()
  for (const key of Object.keys(SOCIAL_PATTERNS) as Array<keyof Socials>) {
    const match = clean.match(SOCIAL_PATTERNS[key])
    if (!match) continue
    // Хвостовая пунктуация, попавшая в совпадение из окружающего текста («...instagram.com/foo).»).
    const url = decodeEntities(match[0]).replace(/[.,;)\]]+$/, '')
    out[key] = url.length <= 300 ? url : null
  }
  return out
}

/** Краткое описание из <meta name="description">. Атрибуты в HTML идут в любом порядке. */
export function extractDescription(html: string): string | null {
  const match = html.match(/<meta[^>]+name=["']description["'][^>]*content=["']([^"']*)["']/i)
    ?? html.match(/<meta[^>]+content=["']([^"']*)["'][^>]*name=["']description["']/i)
  const text = match?.[1]?.trim()
  return text ? text.slice(0, 1000) : null
}

/**
 * Стоило ли вообще звать браузер.
 *
 * Ровно тот вопрос, который решает fallback в обогащении. Браузер дорог, поэтому запускается только
 * когда простой способ ДОКАЗАННО не сработал:
 *   - сервер отказал или ответил ошибкой (403 Cloudflare, 503, 5xx);
 *   - тела почти нет, а тег каркаса SPA есть — значит содержимое рисует JavaScript;
 *   - тело есть, но ни телефона, ни почты, ни мессенджера в нём нет.
 *
 * Обратный случай тоже важен: нашли телефон обычным запросом — браузер НЕ нужен, и тратить на него
 * секунды и память нельзя.
 */
export function needsBrowserFallback(input: {
  status?: number
  html?: string
  foundPhones?: number
  foundEmails?: number
  foundSocials?: number
}): { needed: boolean; reason: string } {
  const { status, html = '', foundPhones = 0, foundEmails = 0, foundSocials = 0 } = input

  if (status !== undefined && (status === 403 || status === 429 || status >= 500)) {
    return { needed: true, reason: `сервер ответил ${status} — похоже на заслон или сбой` }
  }
  if (status !== undefined && status >= 400) {
    // 404 браузером не лечится: страницы просто нет, и второй заход её не создаст.
    return { needed: false, reason: `сервер ответил ${status} — страницы нет, браузер не поможет` }
  }
  if (foundPhones > 0 || foundEmails > 0 || foundSocials > 0) {
    return { needed: false, reason: 'контакты найдены простым запросом' }
  }
  if (looksLikeSpaShell(html)) {
    return { needed: true, reason: 'пустой каркас SPA — содержимое рисует JavaScript' }
  }
  if (!html.trim()) {
    return { needed: true, reason: 'пустой ответ' }
  }
  return { needed: true, reason: 'контактов в разметке нет — стоит посмотреть, что дорисует браузер' }
}

/**
 * Пустой каркас одностраничного приложения.
 *
 * Решает не наличие корневого div, а СООТНОШЕНИЕ: у каркаса почти нет текста при наличии точки
 * монтирования и скриптов. Проверять только по `id="root"` нельзя — так помечены и обычные страницы
 * с полным содержимым, и они бы уезжали в браузер зря.
 */
export function looksLikeSpaShell(html: string): boolean {
  if (!html) return false
  const withoutScripts = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
  const visibleText = withoutScripts.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
  const hasMountPoint = /<(?:div|main|app-root)[^>]*\bid=["'](?:root|app|__next|__nuxt|q-app)["']/i.test(html)
  const hasScripts = /<script[^>]+src=/i.test(html)
  return visibleText.length < 400 && hasMountPoint && hasScripts
}

/**
 * LinkUp — поиск руководителей по связке компания + домен.
 *
 * НЕ ПОДТВЕРЖДЕНО РЕАЛЬНОЙ ДОКУМЕНТАЦИЕЙ. Написано по общей форме API такого назначения
 * (Bearer-токен, компания и домен в теле запроса, массив людей в ответе) — сверить с настоящими
 * доками LinkUp ДО боевого использования этой части. Пока ключ не задан или запрос падает —
 * обогащение продолжается без людей, не роняя весь пайплайн.
 */
async function searchPeopleViaLinkUp(
  company: string,
  domain: string | null,
  env: NodeJS.ProcessEnv,
  fetchImpl: typeof fetch,
): Promise<{ people: z.infer<typeof Enrichment>['people']; failed: string[] }> {
  const apiKey = env.LINKUP_API_KEY
  if (!apiKey) return { people: [], failed: ['linkup_not_configured'] }
  if (!domain) return { people: [], failed: ['linkup_no_domain'] }

  const url = env.LINKUP_API_URL ?? 'https://api.linkupapi.com/v1/people/search'
  try {
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ company, domain }),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    })
    if (!res.ok) return { people: [], failed: [`linkup_http_${res.status}`] }
    const data = await res.json() as { people?: Array<{ name?: string; role?: string; profile_url?: string }> }
    const people = (data.people ?? [])
      .slice(0, 10)
      .map((one) => ({
        name: String(one.name ?? '').slice(0, 160),
        role: one.role ? String(one.role).slice(0, 160) : null,
        source: 'search' as const,
        profile_url: one.profile_url ? String(one.profile_url).slice(0, 300) : null,
      }))
      .filter((one) => one.name.length >= 2)
    return { people, failed: [] }
  } catch {
    return { people: [], failed: ['linkup_error'] }
  }
}

/**
 * Что обогащение хочет получить от браузера.
 *
 * Форма нарочно узкая: обогащению нужен ТЕКСТ и НАЙДЕННЫЕ ССЫЛКИ, а не страница, не браузер и не
 * возможность что-то на ней нажать. Чем меньше здесь полей, тем меньше шансов, что обогащение начнёт
 * зависеть от Playwright по существу, а не только по названию.
 *
 * Возврат `null` — законный отказ (браузер не настроен, страница не открылась). Исключение отсюда
 * тоже допустимо: оно поймано и превращено в запись в `failed`.
 */
export interface BrowserFallbackResult {
  text: string
  html?: string
  links?: string[]
  messengers?: Array<{ kind: string; url: string }>
  bookingWidgets?: string[]
  blocked?: boolean
}
export type BrowserFallback = (url: string) => Promise<BrowserFallbackResult | null>

/** Ссылки мессенджеров из браузера — в те же поля socials, что и при обычном разборе. */
function socialsFromMessengers(
  base: Socials,
  messengers: ReadonlyArray<{ kind: string; url: string }>,
): Socials {
  const out: Socials = { ...base }
  for (const { kind, url } of messengers) {
    if (url.length > 300) continue
    // Уже найденное простым запросом НЕ перезаписываем: первый найденный адрес обычно из шапки сайта,
    // а браузер добавляет ещё и футер со ссылками разработчика.
    if (kind === 'whatsapp' && !out.whatsapp) out.whatsapp = url
    else if (kind === 'telegram' && !out.telegram) out.telegram = url
    else if (kind === 'instagram' && !out.instagram) out.instagram = url
    else if (kind === 'facebook' && !out.facebook) out.facebook = url
  }
  return out
}

export class WebEnricher implements Enricher {
  private readonly env: NodeJS.ProcessEnv
  private readonly fetchImpl: typeof fetch
  private readonly browserFallback: BrowserFallback | null

  constructor(
    env: NodeJS.ProcessEnv = process.env,
    fetchImpl: typeof fetch = fetch,
    browserFallback: BrowserFallback | null = null,
  ) {
    this.env = env
    this.fetchImpl = fetchImpl
    this.browserFallback = browserFallback
  }

  async enrich(company: CleanCompany): Promise<Enrichment> {
    const failed: string[] = []
    let html = ''
    let domain: string | null = null
    let status: number | undefined

    if (company.website) {
      try {
        domain = new URL(company.website).hostname
        const res = await this.fetchImpl(company.website, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
        status = res.status
        if (res.ok) {
          const text = await res.text()
          html = text.length > MAX_HTML_BYTES ? text.slice(0, MAX_HTML_BYTES) : text
        } else {
          failed.push(`website_http_${res.status}`)
        }
      } catch {
        // Таймаут, DNS, TLS, что угодно — сайт компании не наш, чинить его не наша задача.
        failed.push('website_unreachable')
      }
    } else {
      failed.push('no_website')
    }

    let description = html ? extractDescription(html) : null
    let emails = html ? extractEmails(html) : []
    let socials: Socials = html
      ? extractSocials(html)
      : emptySocials()
    let bookingWidgets: string[] = []
    let renderedByBrowser = false

    // ── Браузер: только когда простой способ ДОКАЗАННО не сработал ────────────────────────────────
    //
    // Порядок «сначала fetch, потом решение, потом браузер» важен экономически: браузер стоит секунды
    // и полторы сотни мегабайт, а простой запрос — миллисекунды. Компания, у которой телефон лежит в
    // обычной разметке, не должна за это платить.
    if (company.website && this.browserFallback) {
      const verdict = needsBrowserFallback({
        status,
        html,
        foundPhones: company.phone ? 1 : 0,
        foundEmails: emails.length,
        foundSocials: Object.values(socials).filter(Boolean).length,
      })
      if (verdict.needed) {
        try {
          const rendered = await this.browserFallback(company.website)
          if (!rendered) {
            failed.push('browser_unavailable')
          } else if (rendered.blocked) {
            // Страница-заслон — НЕ содержимое сайта. Принять её текст за описание компании значит
            // отправить в модель «Checking your browser» и получить оценку несуществующего бизнеса.
            failed.push('browser_blocked')
          } else {
            renderedByBrowser = true
            const renderedHtml = rendered.html ?? ''
            const searchable = `${renderedHtml}\n${rendered.text}\n${(rendered.links ?? []).join('\n')}`
            // Почта ищется по СОБРАННОМУ тексту, а не только по разметке: в SPA телефон и адрес часто
            // лежат в отрисованном тексте, которого в исходном HTML не было вовсе.
            const extra = extractEmails(searchable)
            emails = [...new Set([...emails, ...extra])].slice(0, 10)
            socials = socialsFromMessengers(
              renderedHtml ? { ...socials, ...mergeMissing(socials, extractSocials(renderedHtml)) } : socials,
              rendered.messengers ?? [],
            )
            bookingWidgets = rendered.bookingWidgets ?? []
            description = description ?? firstSentences(rendered.text)
          }
        } catch (error) {
          // Отказ браузера — не повод потерять лид: телефон из справочника уже есть, и он важнее.
          failed.push(`browser_error_${shortReason(error)}`)
        }
      }
    }

    const linkup = await searchPeopleViaLinkUp(company.name, domain, this.env, this.fetchImpl)
    failed.push(...linkup.failed)

    const result = {
      description,
      emails,
      socials,
      people: linkup.people,
      booking_widgets: bookingWidgets,
      rendered_by_browser: renderedByBrowser,
      failed: failed.slice(0, 10),
    }
    // Провал здесь значил бы, что мусор прокрался мимо собственных фильтров извлечения — лучше
    // явная ошибка сейчас, чем невалидная запись, дошедшая до базы и до сообщения в Telegram.
    return Enrichment.parse(result)
  }
}

/** Только те поля, которых ещё нет: браузер дополняет обычный разбор, а не затирает его. */
function mergeMissing(base: Socials, extra: Socials): Partial<Socials> {
  const out: Partial<Socials> = {}
  for (const key of Object.keys(extra) as Array<keyof Socials>) {
    if (!base[key] && extra[key]) out[key] = extra[key]
  }
  return out
}

/**
 * Первые предложения текста как описание.
 *
 * Нужно ровно для SPA: у них нет <meta name="description">, потому что его тоже подставляет
 * JavaScript. Берётся начало отрисованного текста — там почти всегда заголовок и подзаголовок.
 */
function firstSentences(text: string, limit = 400): string | null {
  const clean = text.replace(/\s+/g, ' ').trim()
  if (clean.length < 20) return null
  return clean.slice(0, limit)
}

/** Короткий машинный признак причины: поле failed ограничено 60 знаками, и текст ошибки туда не влезет. */
function shortReason(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  if (/timeout|timed out/i.test(message)) return 'timeout'
  if (/net::|ERR_|ENOTFOUND|ECONNREFUSED/i.test(message)) return 'network'
  if (/executable|install/i.test(message)) return 'not_installed'
  return 'failed'
}
