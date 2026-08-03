export type ThemePreference = 'light' | 'dark' | 'system'

const THEME_KEY = 'nemo.theme'

export function themePreference(): ThemePreference {
  if (typeof window === 'undefined') return 'system'
  const saved = window.localStorage.getItem(THEME_KEY)
  return saved === 'light' || saved === 'dark' || saved === 'system' ? saved : 'system'
}

export function applyTheme(preference: ThemePreference) {
  if (typeof window === 'undefined') return
  window.localStorage.setItem(THEME_KEY, preference)
  document.documentElement.dataset.theme = preference
}
