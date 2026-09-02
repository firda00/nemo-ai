/**
 * Presentation routing only: the work still uses the normal team runtime, but
 * analytical results are rendered as an inspectable dashboard instead of a
 * long markdown wall. This applies to every team, not only commerce teams.
 */
export function isAnalyticalArtifactIntent(task: string): boolean {
  const normalized = task.toLowerCase().trim()
  if (!normalized) return false
  const asksForAnalysis = /дашборд|dashboard|аналитик|analysis|показател|метрик|kpi|цифр|статист|сводк|summary|отч[её]т|report|итог|результат|что\s+улучш|как\s+улучш|рекомендац|insight|hisobot|ko.?rsatkich/i.test(normalized)
  const hasBusinessScope = /недел|месяц|квартал|день|weekly|monthly|quarter|продаж|магазин|финанс|маркетинг|кампани|задач|команд|клиент|лид|остат|расход|доход|выруч|конверс|store|sales|finance|marketing|task|team|customer|revenue|xarid|savdo|moliya/i.test(normalized)
  return asksForAnalysis && (hasBusinessScope || /дашборд|dashboard/.test(normalized))
}
