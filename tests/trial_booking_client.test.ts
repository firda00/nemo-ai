import { afterEach, expect, test, vi } from 'vitest'
import { createTrialBookingClient } from '../src/lib/trialBookingClient'

const config = { url: 'http://127.0.0.1:55431', apiKey: 'synthetic-anon', accessToken: 'synthetic-jwt', accountId: 'tenant-a' }
afterEach(() => vi.unstubAllGlobals())

test.each(['https://production.example', 'http://127.0.0.1.evil.test', 'file:///tmp/db'])('rejects non-local target %s before network', url => {
  const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher)
  expect(() => createTrialBookingClient({ ...config, url })).toThrow('TRIAL_LOCAL_ONLY')
  expect(fetcher).not.toHaveBeenCalled()
})

test('binds JWT and tenant, reuses the exact operation key, rejects redirects', async () => {
  const fetcher = vi.fn().mockImplementation(() => Promise.resolve(new Response(JSON.stringify({ operation_id: 'op' }))))
  vi.stubGlobal('fetch', fetcher)
  const client = createTrialBookingClient(config)
  await client.request('slot-a', 'same-operation', 'Synthetic')
  await client.request('slot-a', 'same-operation', 'Synthetic')
  const options = fetcher.mock.calls[0][1]
  expect(options.headers.Authorization).toBe('Bearer synthetic-jwt')
  expect(options.redirect).toBe('error')
  expect(JSON.parse(options.body)).toEqual({ p_account_id: 'tenant-a', p_session_id: 'slot-a', p_operation_key: 'same-operation', p_attendee_label: 'Synthetic' })
  expect(fetcher.mock.calls[1][1].body).toEqual(options.body)
})

test('never retries an uncertain mutation and recovers with a separate read', async () => {
  const fetcher = vi.fn().mockRejectedValueOnce(new TypeError('connection lost'))
    .mockResolvedValueOnce(new Response(JSON.stringify({ operation_id: 'op', status: 'completed', booking_id: 'booking' })))
  vi.stubGlobal('fetch', fetcher)
  const client = createTrialBookingClient(config)
  await expect(client.execute('op')).rejects.toThrow('connection lost')
  expect(fetcher).toHaveBeenCalledTimes(1)
  expect((await client.result('op')).booking_id).toBe('booking')
  expect(fetcher.mock.calls[1][0]).toContain('/trial_booking_result')
})

test('does not expose SQL error body or invent a successful result', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('private database detail', { status: 403 })))
  await expect(createTrialBookingClient(config).schedule()).rejects.toThrow('TRIAL_REQUEST_FAILED_403')
})
