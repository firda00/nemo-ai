import type { Lang } from '../types'
import { translations } from './translations'

/**
 * Перевод как обычная функция — вне React.
 *
 * Отдельный файл, а не соседство с провайдером: правило fast refresh требует, чтобы модуль с
 * компонентами экспортировал только компоненты. Но выгода не в правиле. Пока переводчик жил внутри
 * хука, единственным способом проверить, что на английском экране не всплывает русский текст, было
 * поднять DOM — поэтому такой проверки просто не существовало, и владелец нашёл русскую строку на
 * EN-экране Forge сам.
 */
function resolve(obj: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((acc, key) => {
    if (acc && typeof acc === 'object' && key in (acc as Record<string, unknown>)) {
      return (acc as Record<string, unknown>)[key]
    }
    return undefined
  }, obj)
}

export function makeT(lang: Lang) {
  return (path: string, vars?: Record<string, string | number>): string => {
    const value = resolve(translations[lang], path)
    if (typeof value !== 'string') {
      // Fall back to the key so missing strings are visible, not blank.
      return path
    }
    if (!vars) return value
    return value.replace(/\{(\w+)\}/g, (_, k: string) => (k in vars ? String(vars[k]) : `{${k}}`))
  }
}
