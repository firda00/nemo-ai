// Мост между обогащением лидов и браузерным инструментом.
//
// Существует потому, что обогащение (supabase/functions/_shared/leadgen) не имеет права знать про
// Playwright: оно выполняется и в Deno, где Playwright нет. Мост живёт в Node-слое, где браузер есть,
// и передаёт обогащению ровно текст и ссылки — через узкий интерфейс BrowserFallback.
//
// ЗАЧЕМ ЗДЕСЬ РЕЕСТР, а не прямой вызов движка. Через реестр проходят таймаут, проверка аргументов и
// граница прав — то есть браузер вызывается ровно на тех условиях, что и любой другой инструмент
// агента. Прямой вызов движка обошёл бы всё это, и первый же зависший сайт остановил бы прогон.

import { ToolRegistry } from './registry.ts'
import { PlaywrightEngine, registerBrowserTools } from './browser.ts'
import type { BrowserEngine } from './browser.ts'
import type { BrowserFallback, BrowserFallbackResult } from '../../supabase/functions/_shared/leadgen/enricher.ts'

/** Значения, включающие браузер. Всё остальное, включая пустоту и «0», означает «выключен». */
const ENABLING_VALUES = new Set(['1', 'true', 'on', 'yes'])

/**
 * Включён ли разбор браузером.
 *
 * По умолчанию ВЫКЛЮЧЕН, и это осознанно. Браузер стоит секунды и полторы сотни мегабайт на страницу;
 * прогон на пятьдесят компаний, где половина сайтов — SPA, займёт минуту вместо десяти секунд. Такое
 * решение принимает владелец прогона, а не значение по умолчанию.
 *
 * Отдельного списка выключающих значений здесь НЕТ намеренно. Он был, и мутационный прогон показал, что
 * он недостижим: при выключении по умолчанию «0» и так не попадает в список включающих, то есть проверка
 * ничего не решала и лишь создавала впечатление защиты, которую нельзя проверить тестом.
 */
export function browserFallbackEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return ENABLING_VALUES.has((env.SDR_BROWSER ?? '').trim().toLowerCase())
}

export interface BrowserBridge {
  /** Передаётся в WebEnricher третьим аргументом. null — обогащение работает как раньше. */
  fallback: BrowserFallback | null
  /** Сколько раз браузер реально понадобился. Нужно, чтобы видеть цену прогона. */
  stats: () => { calls: number; blocked: number; failures: number }
  /** Закрыть браузер. Вызывать ОБЯЗАТЕЛЬНО, иначе Chromium останется зомби-процессом. */
  close: () => Promise<void>
}

/**
 * Собрать мост.
 *
 * Выключенный режим возвращает `fallback: null` и пустой close() — вызывающий код при этом не меняется:
 * ему не нужно знать, включён браузер или нет, он всегда передаёт `bridge.fallback` и всегда закрывает.
 */
export function createBrowserBridge(options: {
  enabled?: boolean
  engine?: BrowserEngine
  registry?: ToolRegistry
  env?: Record<string, string | undefined>
} = {}): BrowserBridge {
  const enabled = options.enabled ?? browserFallbackEnabled(options.env)
  if (!enabled) {
    return { fallback: null, stats: () => ({ calls: 0, blocked: 0, failures: 0 }), close: async () => {} }
  }

  const registry = options.registry ?? new ToolRegistry()
  const engine = options.engine ?? new PlaywrightEngine()
  const { close } = registerBrowserTools(registry, engine)

  let calls = 0
  let blocked = 0
  let failures = 0

  const fallback: BrowserFallback = async (url) => {
    calls += 1
    const outcome = await registry.call('browser_navigate_and_extract', { url })
    if (!outcome.ok) {
      failures += 1
      // Причина возвращается ИСКЛЮЧЕНИЕМ, а не null: обогащение различает «браузера нет» (null) и
      // «браузер есть, но страница не открылась» (ошибка с текстом), и записывает это по-разному.
      throw new Error(outcome.error)
    }
    const result = outcome.result as {
      text: string
      blocked: boolean
      messengers: Array<{ kind: string; url: string }>
      bookingWidgets: string[]
    }
    if (result.blocked) blocked += 1
    const bridged: BrowserFallbackResult = {
      text: result.text,
      messengers: result.messengers,
      bookingWidgets: result.bookingWidgets,
      blocked: result.blocked,
    }
    return bridged
  }

  return { fallback, stats: () => ({ calls, blocked, failures }), close }
}
