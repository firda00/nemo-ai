// Мост между обогащением лидов и браузерным инструментом.
//
// Существует потому, что обогащение (supabase/functions/_shared/leadgen) не имеет права знать про
// Playwright: оно выполняется и в Deno, где Playwright нет. Мост живёт в Node-слое, где браузер есть,
// и передаёт обогащению ровно текст и ссылки — через узкий интерфейс BrowserFallback.
//
// ЗАЧЕМ ЗДЕСЬ РЕЕСТР, а не прямой вызов движка. Через реестр проходят таймаут, проверка аргументов и
// граница прав — то есть браузер вызывается ровно на тех условиях, что и любой другой инструмент
// агента. Прямой вызов движка обошёл бы всё это, и первый же зависший сайт остановил бы прогон.

import { createRequire } from 'node:module'
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

/**
 * Установлен ли Playwright.
 *
 * Разрешением модуля, а не запуском `npx playwright --version`: `.cmd` на Windows Node отказывается
 * запускать без оболочки, а с оболочкой аргументы не экранируются. Разрешение отвечает на тот же
 * вопрос мгновенно и без подпроцесса.
 */
export function playwrightInstalled(resolve?: (id: string) => string): boolean {
  try {
    const resolver = resolve ?? createRequire(import.meta.url).resolve
    resolver('playwright')
    return true
  } catch {
    return false
  }
}

/** Значения, выключающие браузер явно. Нужны, чтобы отменить автоопределение. */
const DISABLING_VALUES = new Set(['0', 'off', 'false', 'no'])

/**
 * Доступен ли БРАУЗЕРНЫЙ ИНСТРУМЕНТ агента.
 *
 * Это НЕ то же самое, что `browserFallbackEnabled`, и разница существенная.
 *
 * Обогащение открывает браузером КАЖДУЮ компанию прогона: пятьдесят компаний, половина из них SPA —
 * минута вместо десяти секунд. Такое решение принимает владелец прогона, поэтому там умолчание
 * «выключено».
 *
 * Инструмент агента открывает страницу ТОЛЬКО когда человек попросил. Держать его выключенным по
 * умолчанию значит отвечать «у меня нет такого инструмента» на прямую просьбу открыть сайт — при
 * установленном Playwright. Поэтому здесь умолчание «включено, если пакет установлен», а
 * `SDR_BROWSER=0` по-прежнему выключает всё.
 */
export function browserToolsAvailable(
  env: Record<string, string | undefined> = process.env,
  installed: () => boolean = playwrightInstalled,
): boolean {
  const setting = (env.SDR_BROWSER ?? '').trim().toLowerCase()
  if (DISABLING_VALUES.has(setting)) return false
  if (ENABLING_VALUES.has(setting)) return true
  return installed()
}

export interface BrowserBridge {
  /** Передаётся в WebEnricher третьим аргументом. null — обогащение работает как раньше. */
  fallback: BrowserFallback | null
  /**
   * Движок для инструментов агента. null — Playwright не установлен или браузер выключен.
   *
   * ОТДЕЛЬНО ОТ fallback намеренно. Раньше вызывающий код писал `browser.fallback ? browser.engine :
   * undefined`, а поля `engine` в мосте не было вовсе — то есть браузерные инструменты не
   * регистрировались НИКОГДА, включая режим SDR_BROWSER=1. Модель на просьбу открыть сайт отвечала,
   * что такого инструмента у неё нет, и по коду это выглядело как настройка, а не как поломка.
   */
  engine: BrowserEngine | null
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
  /** Регистрировать ли инструменты агента. Умолчание — по наличию Playwright. */
  tools?: boolean
  engine?: BrowserEngine
  registry?: ToolRegistry
  env?: Record<string, string | undefined>
} = {}): BrowserBridge {
  // Два РАЗНЫХ решения: открывать ли браузером каждую компанию прогона (дорого, по умолчанию нет) и
  // давать ли агенту инструмент открыть страницу по просьбе (дёшево, по умолчанию да).
  const fallbackEnabled = options.enabled ?? browserFallbackEnabled(options.env)
  const toolsEnabled = options.tools ?? (fallbackEnabled || browserToolsAvailable(options.env))

  if (!fallbackEnabled && !toolsEnabled) {
    return {
      fallback: null, engine: null,
      stats: () => ({ calls: 0, blocked: 0, failures: 0 }), close: async () => {},
    }
  }

  const registry = options.registry ?? new ToolRegistry()
  const engine = options.engine ?? new PlaywrightEngine()
  const { close } = registerBrowserTools(registry, engine)

  // Браузер выключен для обогащения, но инструмент нужен: движок есть, автоматического использования
  // нет. Именно это различение и было потеряно.
  if (!fallbackEnabled) {
    return { fallback: null, engine, stats: () => ({ calls: 0, blocked: 0, failures: 0 }), close }
  }

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

  return { fallback, engine, stats: () => ({ calls, blocked, failures }), close }
}
