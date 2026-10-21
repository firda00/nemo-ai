// Chat-client units for the margin card and the direct-answer path — offline, no network.
//   • createFileRunCache: Strict-Mode dedupe by File OBJECT, tenant/session scope isolation,
//     and independence of distinct files that share a name and size (the old string-key bug);
//   • fetchDirectAnswer: a hung cli-chat invoke resolves to an honest failure WITHIN its own
//     bound — the chat's answering state can never spin forever.
import { describe, expect, test } from 'vitest'
import { createFileRunCache, createSessionScope } from '../src/lib/marginRunCache'
import { fetchDirectAnswer } from '../src/lib/directAnswer'

const fileOf = (content: string, name: string) => new File([content], name)

describe('createFileRunCache', () => {
  test('same File + same scope runs ONCE and returns the same promise (Strict-Mode dedupe)', async () => {
    const cache = createFileRunCache<string>()
    const file = fileOf('abc', 'sales.xlsx')
    let runs = 0
    const execute = async () => { runs += 1; return `run-${runs}` }
    const first = cache.getOrRun(file, 'user-1', execute)
    const second = cache.getOrRun(file, 'user-1', execute)
    expect(second).toBe(first)
    expect(await second).toBe('run-1')
    expect(runs).toBe(1)
  })

  test('an auth/tenant switch makes the SAME File a miss — cached results never cross accounts', async () => {
    const cache = createFileRunCache<string>()
    const file = fileOf('abc', 'sales.xlsx')
    let runs = 0
    const execute = async () => { runs += 1; return `run-${runs}` }
    expect(await cache.getOrRun(file, 'user-1', execute)).toBe('run-1')
    expect(await cache.getOrRun(file, 'user-2', execute)).toBe('run-2') // other identity re-runs
    expect(runs).toBe(2)
  })

  test('distinct File objects with the SAME name and size stay independent', async () => {
    const cache = createFileRunCache<string>()
    const a = fileOf('aaa', 'report.xlsx')
    const b = fileOf('bbb', 'report.xlsx')
    expect(a.name).toBe(b.name)
    expect(a.size).toBe(b.size) // the collision the old string key could not distinguish
    const results = await Promise.all([
      cache.getOrRun(a, 'user-1', async () => 'from-a'),
      cache.getOrRun(b, 'user-1', async () => 'from-b'),
    ])
    expect(results).toEqual(['from-a', 'from-b'])
  })
})

describe('createSessionScope', () => {
  test('stable within a session; EVERY identity change is a new generation — logout+login as the same user included', () => {
    const scope = createSessionScope()
    const first = scope('u1')
    expect(scope('u1')).toBe(first) // Strict-Mode double render stays stable
    const anon = scope(null)
    expect(anon).not.toBe(first)
    const again = scope('u1')
    expect(again).not.toBe(first) // same user, NEW session — old cache entries must miss
    expect(scope('u2')).not.toBe(again)
  })
})

describe('fetchDirectAnswer', () => {
  test('a hung invoke resolves to an honest failure within its own bound', async () => {
    const started = Date.now()
    const result = await fetchDirectAnswer(() => new Promise(() => {}), 120)
    expect(result).toEqual({ ok: false })
    expect(Date.now() - started).toBeLessThan(5_000)
  })

  test('a well-formed answer passes through; errors and empty answers fail closed', async () => {
    const okInvoke = async () => ({ data: { message: { content: '  hello  ' } }, error: null })
    expect(await fetchDirectAnswer(okInvoke, 1_000)).toEqual({ ok: true, text: 'hello' })
    const errInvoke = async () => ({ data: null, error: {} })
    expect(await fetchDirectAnswer(errInvoke, 1_000)).toEqual({ ok: false })
    const emptyInvoke = async () => ({ data: { message: { content: '' } }, error: null })
    expect(await fetchDirectAnswer(emptyInvoke, 1_000)).toEqual({ ok: false })
  })
})
