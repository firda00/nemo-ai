// Scenario-driven mock of src/lib/supabase for the MOUNTED margin-card smoke (live transport).
// Every invoke is recorded in globalThis.__marginCalls so the smoke can assert that an auth
// switch never triggers an automatic re-upload of the old user's file.
interface Scenario {
  mode?: 'done' | 'hang' | 'slow-done' | 'registry-fail'
  slowMs?: number
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const g = globalThis as any
g.__marginCalls = g.__marginCalls ?? []

const scenario = (): Scenario => (g.__margin ?? {}) as Scenario
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

const DONE_BODY = {
  ok: true,
  file_sha256: 'a'.repeat(64),
  summary: {
    currency: 'UZS',
    totalsComplete: true,
    completenessReasons: [],
    totals: {
      revenue: '300.00', costComplete: '100.00', marginComplete: '200.00',
      marginPctComplete: 66.7, rowsComplete: 1, rowsTotal: 1, returnsCount: 0,
    },
    topProducts: [{ name: 'Плов', sku: null, coveredMargin: '200.00', coveredMarginPct: 66.7, complete: true }],
  },
  files: {
    csv: { url: 'https://signed.example/report.csv', expires_in_seconds: 600 },
    xlsx: { url: 'https://signed.example/report.xlsx', expires_in_seconds: 600 },
    html: { url: 'https://signed.example/report.html', expires_in_seconds: 600 },
  },
}

export const isSupabaseEnabled = true

export const supabase = {
  functions: {
    async invoke(name: string, options: Record<string, unknown>) {
      const body = options.body as Record<string, unknown> | Blob | undefined
      const isShaFollowUp = !!body && typeof body === 'object' && !(body instanceof Blob)
        && typeof (body as Record<string, unknown>).file_sha256 === 'string'
      g.__marginCalls.push({ name, hasBody: body !== undefined, isShaFollowUp })
      const s = scenario()
      if (s.mode === 'hang') return new Promise(() => {})
      if (s.mode === 'slow-done') await delay(s.slowMs ?? 800)
      // registry-fail: the FIRST (binary) call reports the registry gap; the sha follow-up
      // repairs it — exactly the server's contract
      if (s.mode === 'registry-fail' && !isShaFollowUp) {
        return { data: { ...DONE_BODY, registry_saved: false }, error: null }
      }
      return { data: DONE_BODY, error: null }
    },
  },
}
