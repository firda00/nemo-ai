// Scenario-driven mock of src/lib/supabase for the MOUNTED briefing-form smoke.
// The harness page sets globalThis.__briefing before each mount; every network-shaped call is
// recorded in globalThis.__briefingCalls so the smoke can assert exact write counts.
interface Scenario {
  forbidden?: boolean
  settings?: Record<string, unknown>
  saveMode?: 'ok' | 'slow-ok' | 'unknown'
  channelsMode?: 'ok' | 'hang'
  deliveryEnabled?: boolean
  deepLink?: boolean
  runs?: Array<Record<string, unknown>>
  outcomes?: Array<Record<string, unknown>>
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const g = globalThis as any
g.__briefingCalls = g.__briefingCalls ?? []

const scenario = (): Scenario => (g.__briefing ?? {}) as Scenario
const record = (entry: Record<string, unknown>) => { g.__briefingCalls.push(entry) }
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

const DEFAULT_SETTINGS = {
  morning_enabled: false, evening_enabled: false,
  weather_lat: null, weather_lon: null,
  notify_channel_id: null, notify_chat_id: null,
  recipient_status: 'not_configured', recipient_verified: false,
}
const VERIFY_PAYLOAD = `brf_${'c'.repeat(48)}`

const errorResponse = (body: Record<string, unknown>, status: number) => ({
  data: null,
  error: { context: new Response(JSON.stringify(body), { status }) },
})

export const isSupabaseEnabled = true

export const supabase = {
  functions: {
    async invoke(_name: string, options: { body: Record<string, unknown> }) {
      const body = options.body
      record({ kind: 'invoke', action: body.action, body })
      const s = scenario()
      if (body.action === 'settings-get') {
        if (s.forbidden) return errorResponse({ ok: false, error: 'owner_required' }, 403)
        return {
          data: {
            ok: true,
            settings: { ...DEFAULT_SETTINGS, ...(s.settings ?? {}) },
            delivery: { implemented: true, enabled: s.deliveryEnabled !== false },
          },
          error: null,
        }
      }
      if (body.action === 'settings-set') {
        if (s.saveMode === 'unknown') return errorResponse({ ok: false, error: 'save_outcome_unknown', hint: 'reload_settings' }, 503)
        if (s.saveMode === 'slow-ok') await delay(300)
        return {
          data: {
            ok: true,
            settings: {
              ...DEFAULT_SETTINGS,
              ...(s.settings ?? {}),
              morning_enabled: body.morning_enabled === true,
              evening_enabled: body.evening_enabled === true,
            },
          },
          error: null,
        }
      }
      if (body.action === 'verify-recipient') {
        return {
          data: {
            ok: true,
            start_payload: VERIFY_PAYLOAD,
            deep_link: s.deepLink === false ? null : `https://t.me/MockBriefingBot?start=${VERIFY_PAYLOAD}`,
            expires_in_seconds: 900,
            recipient_verified: false,
          },
          error: null,
        }
      }
      if (body.action === 'preview') return { data: { ok: true, text: `PREVIEW:${body.kind}`, sections: {} }, error: null }
      return errorResponse({ ok: false, error: 'unknown_action' }, 400)
    },
  },
  from(table: string) {
    record({ kind: 'query', table })
    const s = scenario()
    const result = table === 'channels'
      ? (s.channelsMode === 'hang'
        ? new Promise(() => {}) // ignores the abort signal on purpose — the panel must still release
        : Promise.resolve({ data: [{ id: '11111111-2222-4333-8444-555555555555', label: 'Sales bot', type: 'telegram' }], error: null }))
      : table === 'briefing_runs'
        ? Promise.resolve({ data: s.runs ?? [], error: null })
        : table === 'briefing_outcomes'
          ? Promise.resolve({ data: s.outcomes ?? [], error: null })
          : Promise.resolve({ data: [], error: null })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const chain: any = {
      select: () => chain,
      eq: () => chain,
      order: () => chain,
      limit: () => chain,
      abortSignal: () => result,
    }
    return chain
  },
}
