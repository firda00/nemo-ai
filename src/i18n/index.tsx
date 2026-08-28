import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react'
import type { Lang } from '../types'
import { translations, type Dict } from './translations'
import { makeT } from './translate'

const STORAGE_KEY = 'nemo.lang'
const PAGE_TITLES: Record<Lang, string> = {
  en: 'Nemo AI - AI Team Builder for Business Workflows',
  ru: 'Nemo AI - платформа AI-команд для бизнеса',
  uz: 'Nemo AI - biznes uchun AI-komandalar platformasi',
}

interface I18nContextValue {
  lang: Lang
  setLang: (lang: Lang) => void
  /** Resolve a dot-path to a string. Supports {var} interpolation. */
  t: (path: string, vars?: Record<string, string | number>) => string
  /** Current language's full dictionary for structured (array/object) access. */
  dict: Dict
}

const I18nContext = createContext<I18nContextValue | null>(null)

function getInitialLang(): Lang {
  if (typeof window !== 'undefined') {
    const stored = window.localStorage.getItem(STORAGE_KEY)
    if (stored === 'uz' || stored === 'ru' || stored === 'en') return stored
  }
  // Продукт для Узбекистана: узбекский по умолчанию (CLAUDE.md), сохранённый выбор всегда важнее.
  return 'uz'
}

export function I18nProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>(getInitialLang)

  const setLang = useCallback((next: Lang) => {
    setLangState(next)
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(STORAGE_KEY, next)
      document.documentElement.lang = next
    }
  }, [])

  useEffect(() => {
    document.documentElement.lang = lang
    document.title = PAGE_TITLES[lang]
  }, [lang])

  const t = useMemo(() => makeT(lang), [lang])

  const value = useMemo<I18nContextValue>(
    () => ({ lang, setLang, t, dict: translations[lang] }),
    [lang, setLang, t],
  )

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>
}

// eslint-disable-next-line react-refresh/only-export-components
export function useI18n(): I18nContextValue {
  const ctx = useContext(I18nContext)
  if (!ctx) throw new Error('useI18n must be used within I18nProvider')
  return ctx
}
