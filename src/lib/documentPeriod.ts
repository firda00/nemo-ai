import { z } from 'zod'
import { isCalendarDate } from '../../supabase/functions/_shared/calendarPeriod'
export { isCalendarDate, sourceCellDate, isSourceDateHeader, type DocumentPeriod } from '../../supabase/functions/_shared/calendarPeriod'
export const DocumentPeriodSchema = z.object({
  from: z.string().refine(isCalendarDate), to: z.string().refine(isCalendarDate),
}).strict().refine((p) => p.from <= p.to)
