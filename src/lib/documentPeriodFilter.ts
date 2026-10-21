import { filterSourcePeriod as filter } from '../../supabase/functions/_shared/sourcePeriodFilter'
import type { DocumentSource } from './documentSources'
import type { DocumentPeriod } from './documentPeriod'
export type { PeriodIssue, PeriodRowEvidence } from '../../supabase/functions/_shared/sourcePeriodFilter'
export function filterSourcePeriod(source: DocumentSource, period: DocumentPeriod) {
  if (source.data.format !== 'xlsx') throw new Error('xlsx_required')
  return filter({ id: source.id, data: source.data }, period)
}
