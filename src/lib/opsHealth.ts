// Watchdog liveness. The monitor writes one ops_checks row every ~10 minutes; the status page
// used to render the newest row as-is. When the cron job stopped on 13 July, the newest row
// still said `ok` / "Hammasi ishlayapti", so a dead monitor read as a healthy platform for
// twelve days. A status is only evidence for as long as it is fresh: past three missed
// intervals the last known value is discarded, not displayed.

export const OPS_CHECK_INTERVAL_MINUTES = 10
export const OPS_MISSED_INTERVALS_BEFORE_STALE = 3
export const OPS_STALE_AFTER_MINUTES = OPS_CHECK_INTERVAL_MINUTES * OPS_MISSED_INTERVALS_BEFORE_STALE

export type OpsLiveness = 'ok' | 'warn' | 'down' | 'stale' | 'unknown'

export interface OpsHealth {
  status: OpsLiveness
  ageMinutes: number | null
  /** True when the reported status is the watchdog's own verdict rather than a liveness fallback. */
  reported: boolean
}

export function opsLiveness(latestIso: string | null | undefined, reportedStatus: string | null | undefined, nowMs: number): OpsHealth {
  if (!latestIso) return { status: 'unknown', ageMinutes: null, reported: false }
  const writtenMs = Date.parse(latestIso)
  if (!Number.isFinite(writtenMs)) return { status: 'unknown', ageMinutes: null, reported: false }
  const ageMinutes = Math.max(0, Math.round((nowMs - writtenMs) / 60_000))
  if (ageMinutes > OPS_STALE_AFTER_MINUTES) return { status: 'stale', ageMinutes, reported: false }
  const reported = reportedStatus === 'ok' || reportedStatus === 'warn' || reportedStatus === 'down'
  return { status: reported ? (reportedStatus as OpsLiveness) : 'unknown', ageMinutes, reported }
}

export function formatCheckAge(ageMinutes: number | null): string {
  if (ageMinutes == null) return '—'
  if (ageMinutes < 60) return `${ageMinutes} мин назад`
  const hours = Math.floor(ageMinutes / 60)
  if (hours < 48) return `${hours} ч назад`
  return `${Math.floor(hours / 24)} сут назад`
}
