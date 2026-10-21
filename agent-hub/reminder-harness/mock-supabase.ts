// Scenario-driven mock of src/lib/supabase for the MOUNTED reminder-form smoke. Per-USER
// scenarios keyed by the mock-auth identity, so the smoke can flip the signed-in user and
// assert ownership behavior. Deferred modes let the smoke settle an OLD identity's request
// AFTER a switch and prove the late completion changes nothing. Sources are served as ONE
// per-user array with real page-10 semantics (list = first page, action 'sources' = deeper).
interface SourceRow { file_sha256: string; file_name: string; uploaded_at: string; period_month: string | null }
interface UserScenario {
  list?: 'HANG' | 'DEFER' | { schedules?: unknown[]; occurrences?: unknown[]; recipient?: unknown }
  saveMode?: 'ok' | 'DEFER' | { reason: string }
  sources?: SourceRow[] | 'NULL'
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const g = globalThis as any
g.__reminderCalls = g.__reminderCalls ?? []
g.__reminderDefer = g.__reminderDefer ?? {}

const PAGE = 10
const currentUserId = (): string => String(g.__marginAuth?.user?.id ?? 'anon')
const scenarioOf = (uid: string): UserScenario => ((g.__reminder ?? {})[uid] ?? {}) as UserScenario
const sourcesOf = (scenario: UserScenario): SourceRow[] | null =>
  scenario.sources === 'NULL' ? null : (scenario.sources ?? [])

const defer = (uid: string) => new Promise((resolve) => {
  ;(g.__reminderDefer[uid] = g.__reminderDefer[uid] ?? []).push(resolve)
})

export const isSupabaseEnabled = true

export const supabase = {
  functions: {
    async invoke(_name: string, options: { body: Record<string, unknown> }) {
      const uid = currentUserId()
      const body = options.body
      g.__reminderCalls.push({ uid, action: body.action, page: body.page, sha: body.file_sha256 })
      const scenario = scenarioOf(uid)
      if (body.action === 'list') {
        if (scenario.list === 'HANG') return new Promise(() => {})
        if (scenario.list === 'DEFER') return defer(uid)
        const data = scenario.list ?? {}
        const sources = sourcesOf(scenario)
        return {
          data: {
            ok: true,
            schedules: data.schedules ?? [],
            occurrences: data.occurrences ?? [],
            recipient: data.recipient ?? { verified: true, channel_bound: true },
            sources: sources === null ? null : sources.slice(0, PAGE),
            sources_has_more: sources !== null && sources.length > PAGE,
          },
          error: null,
        }
      }
      if (body.action === 'sources') {
        const sources = sourcesOf(scenario)
        if (sources === null) return { data: null, error: { context: new Response('{"ok":false}', { status: 503 }) } }
        const page = Number(body.page) || 0
        const rows = sources.slice(page * PAGE, page * PAGE + PAGE)
        return { data: { ok: true, page, sources: rows, has_more: sources.length > (page + 1) * PAGE, truncated: false }, error: null }
      }
      if (body.action === 'set-period') {
        const sources = sourcesOf(scenario)
        const row = (sources ?? []).find((source) => source.file_sha256 === body.file_sha256)
        if (!row) return { data: { ok: false, error: 'not_found' }, error: null }
        row.period_month = String(body.period_month)
        return { data: { ok: true, source: row }, error: null }
      }
      if (body.action === 'save') {
        if (scenario.saveMode === 'DEFER') return defer(uid)
        if (scenario.saveMode && scenario.saveMode !== 'ok') {
          return { data: { ok: false, error: scenario.saveMode.reason }, error: null }
        }
        // a successful save lands in that user's OWN list so the reload shows it
        const saved = {
          id: `sch-${g.__reminderCalls.length}`,
          title: body.title, day_of_month: body.day_of_month, send_minute: body.send_minute,
          enabled: body.enabled === true, schedule_revision: 1,
          kind: body.kind ?? 'reminder', report_currency: body.report_currency ?? null,
        }
        const data = (scenario.list ?? {}) as { schedules?: unknown[] }
        data.schedules = [...(data.schedules ?? []), saved]
        scenario.list = { ...(scenario.list as object ?? {}), schedules: data.schedules }
        return { data: { ok: true, schedule: saved }, error: null }
      }
      return { data: { ok: false, error: 'unknown_action' }, error: null }
    },
  },
}
