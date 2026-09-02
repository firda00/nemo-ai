/**
 * Cheap, deterministic routing for read-only store snapshots.
 * Mutations, audits and planning stay in the autonomous workflow.
 */
export function isStoreSnapshotIntent(task: string): boolean {
  const normalized = task.toLowerCase().trim()
  const asksForSnapshot = /как\s+(?:сейчас\s+)?(?:обстоят\s+)?дела|что\s+(?:сейчас\s+)?(?:происходит|с\s+магазин)|(?:покажи|дай)\s+(?:мне\s+)?(?:цифр|дашборд|сводк|статус|продаж|остат)|(?:быстр|кратк).*(?:обзор|сводк)|состояни[ея]\s+магазин|store\s+(?:status|health|snapshot)|do.?kon.*(?:holat|ko.?rsatkich)/i.test(normalized)
  const asksForLongWork = /полный\s+аудит|стратег|план\s+на|проанализируй\s+кажд|измен|редакт|загруз|созда|опубликуй|отправ|модерац|full\s+audit|change|publish|submit|upload/i.test(normalized)
  return normalized.length <= 260 && asksForSnapshot && !asksForLongWork
}
