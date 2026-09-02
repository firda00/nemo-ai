/**
 * Cheap, deterministic routing for read-only store snapshots.
 * Mutations, audits and planning stay in the autonomous workflow.
 */
export function isStoreSnapshotIntent(task: string): boolean {
  const normalized = task.toLowerCase().trim()
  const asksForSnapshot = /как\s+(?:сейчас\s+)?(?:обстоят\s+)?дела|что\s+(?:сейчас\s+)?(?:происходит|с\s+магазин)|(?:покажи|дай|предоставь)\s+(?:мне\s+)?(?:цифр|дашборд|сводк|статус|продаж|остат|недельн)|(?:быстр|кратк|недельн).*(?:обзор|сводк|отч[её]т)|(?:отч[её]т|итог).*(?:недел|магазин|продаж)|(?:что|как).*(?:улучш|исправ).*(?:магазин|продаж)?|состояни[ея]\s+магазин|другие\s+магазин|все\s+магазин|store\s+(?:status|health|snapshot|weekly\s+report)|(?:weekly\s+report|what\s+to\s+improve)|(?:other|all)\s+stores|do.?kon.*(?:holat|ko.?rsatkich|hisobot)/i.test(normalized)
  const asksForLongWork = /полный\s+аудит|стратег|план\s+на|проанализируй\s+кажд|измен|редакт|загруз|созда|опубликуй|отправ|модерац|full\s+audit|change|publish|submit|upload/i.test(normalized)
  return normalized.length <= 260 && asksForSnapshot && !asksForLongWork
}
