// Обогащение: сайт компании + поиск людей.
//
// НЕ ДОЛЖЕН падать целиком из-за одного плохого источника — обогащение улучшает лид, а не решает,
// быть ли ему в списке. Каждый источник (сайт, LinkUp) отказывает НЕЗАВИСИМО, и его отказ уходит
// в поле failed, а не в исключение, которое остановило бы весь пайплайн ради одной компании.

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
}

/** Ссылки на соцсети из href-адресов страницы — по домену, а не по слову рядом со ссылкой. */
export function extractSocials(html: string): Socials {
  const clean = stripNoise(html)
  const out: Socials = { linkedin: null, instagram: null, telegram: null, facebook: null }
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

export class WebEnricher implements Enricher {
  private readonly env: NodeJS.ProcessEnv
  private readonly fetchImpl: typeof fetch

  constructor(env: NodeJS.ProcessEnv = process.env, fetchImpl: typeof fetch = fetch) {
    this.env = env
    this.fetchImpl = fetchImpl
  }

  async enrich(company: CleanCompany): Promise<Enrichment> {
    const failed: string[] = []
    let html = ''
    let domain: string | null = null

    if (company.website) {
      try {
        domain = new URL(company.website).hostname
        const res = await this.fetchImpl(company.website, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
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

    const linkup = await searchPeopleViaLinkUp(company.name, domain, this.env, this.fetchImpl)
    failed.push(...linkup.failed)

    const result = {
      description: html ? extractDescription(html) : null,
      emails: html ? extractEmails(html) : [],
      socials: html ? extractSocials(html) : { linkedin: null, instagram: null, telegram: null, facebook: null },
      people: linkup.people,
      failed: failed.slice(0, 10),
    }
    // Провал здесь значил бы, что мусор прокрался мимо собственных фильтров извлечения — лучше
    // явная ошибка сейчас, чем невалидная запись, дошедшая до базы и до сообщения в Telegram.
    return Enrichment.parse(result)
  }
}
