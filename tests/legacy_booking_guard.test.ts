import { describe, expect, test, vi } from 'vitest'
import { executeLegacyBooking, guardLegacyBooking } from '../supabase/functions/_shared/legacyBooking'

function fixture(options: { row?: unknown; error?: unknown; thrown?: boolean; insertError?: unknown } = {}) {
  const filters: Array<[string, unknown]> = []
  const insert = vi.fn(async () => ({ error: options.insertError ?? null }))
  const db = { from: vi.fn((table: string) => {
    if (table === 'bookings') return { insert }
    if (table !== 'trial_courses') throw new Error('Unexpected table')
    const query = {
      select: () => query,
      eq: (key: string, value: unknown) => { filters.push([key, value]); return query },
      limit: () => query,
      maybeSingle: async () => {
        if (options.thrown) throw new Error('Synthetic unavailable database')
        return { data: 'row' in options ? options.row : null, error: options.error ?? null }
      },
    }
    return query
  }) }
  return { db, insert, filters }
}
const args = { datetime_iso: '2026-10-15T15:00:00+05:00', datetime_text: '15 October at 15:00', service: 'Synthetic appointment' }

describe('legacy booking cannot bypass canonical trial approval', () => {
  test.each([
    { ...args, service: 'ordinary haircut', trial: false },
    { ...args, service: 'пробный урок', approval: 'approved' },
    { ...args, service: 'sinov darsi', account_id: 'other-account' },
  ])('configured account is blocked regardless of model supplied labels/approval/account', async toolArgs => {
    const f = fixture({ row: { id: 'course-a', account_id: 'account-a' } })
    expect(await executeLegacyBooking(toolArgs, f.db, 'account-a')).toMatchObject({ ok: false })
    expect(f.filters).toEqual([['account_id', 'account-a']])
    expect(f.insert).not.toHaveBeenCalled()
  })

  test.each([
    { error: { code: '42P01' } }, // not deployed: cannot prove that legacy writes are safe
    { error: { code: '42501' } },
    { thrown: true },
    { row: undefined },
    { row: {} },
    { row: { id: 'course-b', account_id: 'account-b' } },
  ])('unknown or inconsistent canonical configuration fails closed: %j', async options => {
    const f = fixture(options)
    expect(await executeLegacyBooking(args, f.db, 'account-a')).toMatchObject({ ok: false })
    expect(f.insert).not.toHaveBeenCalled()
  })

  test('ordinary account with an explicitly empty canonical read retains legacy behavior', async () => {
    const f = fixture()
    expect(await executeLegacyBooking(args, f.db, 'account-a', 'dialogue-a')).toMatchObject({ ok: true })
    expect(f.insert).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      account_id: 'account-a', dialogue_id: 'dialogue-a', scheduled_at: '2026-10-15T10:00:00.000Z',
    }))
  })

  test('invalid date cannot create an ordinary booking', async () => {
    const f = fixture()
    expect(await executeLegacyBooking({ ...args, datetime_iso: 'later' }, f.db, 'account-a')).toMatchObject({ ok: false })
    expect(f.insert).not.toHaveBeenCalled()
  })

  test('booking database failure is not exposed or confirmed', async () => {
    const f = fixture({ insertError: { message: 'private database details' } })
    const response = await executeLegacyBooking(args, f.db, 'account-a')
    expect(response.ok).toBe(false)
    expect(response.result).not.toContain('private database details')
  })

  test('missing trusted account fails before query', async () => {
    const f = fixture()
    expect(await guardLegacyBooking(f.db, '')).toMatchObject({ ok: false })
    expect(f.db.from).not.toHaveBeenCalled()
  })
})
