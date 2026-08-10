export type CategoryLabel = { category: string; label_ru: string | null; label_en: string | null }

/**
 * Имя полки Uzum на языке интерфейса.
 *
 * Uzum отдаёт только узбекское имя, поэтому над списком стояло «Выберите категорию», а в списке —
 * `Ko'ylaklar`. Владелец не мог не только прочитать, но и ПРОВЕРИТЬ выбор: `Ko'ylaklar` — это
 * платья, и по написанию это не следует.
 *
 * Живёт отдельно от компонента намеренно: файл с компонентами, экспортирующий ещё и функции,
 * ломает горячую перезагрузку — правило react-refresh об этом и говорит.
 *
 * Непереведённая полка показывается узбекским именем — тем самым, которое владелец видит в
 * кабинете Uzum, — а не прячется и не заменяется многоточием.
 */
export function categoryLabel(category: string, labels: Record<string, CategoryLabel>, lang: string): string {
  const row = labels[category]
  if (!row) return category
  if (lang === 'ru') return row.label_ru ?? category
  if (lang === 'en') return row.label_en ?? category
  return category
}
