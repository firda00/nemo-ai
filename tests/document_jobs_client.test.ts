// Chat-side document jobs client — the NO-DUPLICATE contract, offline:
//   • persistentRequestId: one uuid per (user, request key), surviving a simulated reload
//     (fresh module memory, same localStorage); identity-scoped keys — another user on the
//     same browser NEVER reuses the id; corrupted stored values are regenerated; a THROWING
//     localStorage degrades to tab-stable memory (honestly not cross-tab);
//   • enqueue sends the SAME request_id on retry/reload → the transport proves the server
//     would deduplicate, never generate twice;
//   • poll: terminal resolves; timeout returns still_processing (NOT an error) and the next
//     poll RESUMES the same job; a dead scope stops before ANY further request;
//   • typed errors map 1:1 to endpoint slugs for i18n.
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { createClient } from '@supabase/supabase-js'
import { invokeScopedFunction, type ScopedFunctionClient } from '../src/lib/scopedFunctionCall'
import {
  clearDocumentJobsStorage,
  DocumentJobsRequestError,
  enqueueDocumentJob,
  forgetDocumentJob,
  getDocumentJobDownload,
  getDocumentJobStatus,
  hasDocumentRecoveryIssue,
  listRecentDocumentJobs,
  persistentRequestId,
  prepareDocumentSubmission,
  pollDocumentJob,
  recallDocumentJob,
  recallGeneratedContent,
  releaseRequestId,
  rememberDocumentJob,
  stableRequestKey,
  storeGeneratedContent,
  type DocumentJobsTransport,
} from '../src/lib/documentJobs.ts'

const USER_A = 'user-aaaa'
const USER_B = 'user-bbbb'
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

// controllable localStorage stub (jsdom-free suite) — with the enumeration surface the
// prune/clear logic needs (length/key)
function installStorage(initial: Record<string, string> = {}, { throwing = false } = {}) {
  const map = new Map(Object.entries(initial))
  const storage = {
    getItem: (key: string) => {
      if (throwing) throw new Error('storage blocked')
      return map.get(key) ?? null
    },
    setItem: (key: string, value: string) => {
      if (throwing) throw new Error('storage blocked')
      map.set(key, value)
    },
    removeItem: (key: string) => {
      if (throwing) throw new Error('storage blocked')
      map.delete(key)
    },
    get length() {
      if (throwing) throw new Error('storage blocked')
      return map.size
    },
    key: (index: number) => {
      if (throwing) throw new Error('storage blocked')
      return [...map.keys()][index] ?? null
    },
  }
  Object.defineProperty(globalThis, 'localStorage', { value: storage, configurable: true })
  return map
}

beforeEach(() => {
  vi.resetModules()
  installStorage()
  clearDocumentJobsStorage()
})
afterEach(() => { vi.useRealTimers() })

describe('persistentRequestId — no duplicate generation', () => {
  test('stable per (user, key); distinct per user and per key', () => {
    installStorage()
    const first = persistentRequestId(USER_A, 'msg-1')
    expect(first).toMatch(UUID_RE)
    expect(persistentRequestId(USER_A, 'msg-1')).toBe(first)
    expect(persistentRequestId(USER_A, 'msg-2')).not.toBe(first)
    // identity scoping: the OTHER user on the same browser never reuses the id
    expect(persistentRequestId(USER_B, 'msg-1')).not.toBe(first)
  })

  test('survives a reload: fresh module memory, same localStorage', async () => {
    const map = installStorage()
    const before = persistentRequestId(USER_A, 'msg-reload')
    // «перезагрузка»: новый экземпляр модуля (памятная карта пуста), storage тот же
    const reloaded = await import('../src/lib/documentJobs.ts?reload=1')
    installStorage(Object.fromEntries(map))
    expect(reloaded.persistentRequestId(USER_A, 'msg-reload')).toBe(before)
  })

  test('corrupted stored value is regenerated; throwing storage stays tab-stable', () => {
    installStorage({ 'nemo.documentJobs.request.user-aaaa.msg-bad': 'not-a-uuid' })
    const regenerated = persistentRequestId(USER_A, 'msg-bad')
    expect(regenerated).toMatch(UUID_RE)
    // storage that throws (private window): stable WITHIN the tab via memory fallback
    installStorage({}, { throwing: true })
    const tabStable = persistentRequestId(USER_A, 'msg-private')
    expect(persistentRequestId(USER_A, 'msg-private')).toBe(tabStable)
    expect(() => persistentRequestId('', 'x')).toThrow(/REQUEST_KEY_REQUIRED/)
  })

  test('release clears both layers; next call gets a fresh id', () => {
    const first = persistentRequestId(USER_A, 'msg-done')
    releaseRequestId(USER_A, 'msg-done')
    expect(persistentRequestId(USER_A, 'msg-done')).not.toBe(first)
  })

  test('stableRequestKey: content-derived, deterministic across reloads, distinct per kind/content', async () => {
    const input = { kind: 'docx_document', title: 'Отчёт', blocks: [{ type: 'paragraph', text: 'x' }] }
    const key = await stableRequestKey('docx_document', input)
    expect(key).toMatch(/^[a-f0-9]{40}$/)
    expect(await stableRequestKey('docx_document', input)).toBe(key)
    expect(await stableRequestKey('pptx_presentation', input)).not.toBe(key)
    expect(await stableRequestKey('docx_document', { ...input, title: 'Другой' })).not.toBe(key)
  })

  test('entries EXPIRE by their timestamp: a stale record is absent and removed on read', () => {
    const staleAt = Date.now() - 25 * 60 * 60 * 1000 // за пределом суточного TTL
    const map = installStorage({
      [`nemo.documentJobs.content.${USER_A}.sub-stale`]: JSON.stringify({ at: staleAt, v: 'вчерашний текст' }),
      [`nemo.documentJobs.request.${USER_A}.sub-stale`]: JSON.stringify({ at: staleAt, v: 'cd55c5de-5555-4555-8555-5555555def55' }),
    })
    expect(recallGeneratedContent(USER_A, 'sub-stale')).toBeNull()
    expect(map.has(`nemo.documentJobs.content.${USER_A}.sub-stale`)).toBe(false)
    // просроченный request-id не переиспользуется: выдан свежий
    expect(persistentRequestId(USER_A, 'sub-stale')).not.toBe('cd55c5de-5555-4555-8555-5555555def55')
  })

  test('content cache is bounded and MEMORY stays in sync: evicted entries never resurrect', () => {
    const map = installStorage()
    for (let index = 0; index < 20; index += 1) {
      storeGeneratedContent(USER_A, `sub-${index}`, `текст ${index}`)
    }
    const contentKeys = [...map.keys()].filter((key) => key.startsWith('nemo.documentJobs.content.'))
    expect(contentKeys.length).toBeLessThanOrEqual(16)
    expect(recallGeneratedContent(USER_A, 'sub-19')).toBe('текст 19')
    expect(map.has(`nemo.documentJobs.content.${USER_A}.sub-0`)).toBe(false)
    // и из ПАМЯТИ вкладки тоже вычищено — воскрешения из безразмерной Map нет
    expect(recallGeneratedContent(USER_A, 'sub-0')).toBeNull()
  })

  test('logout clear wipes ALL namespaces and the tab memory', () => {
    const map = installStorage()
    persistentRequestId(USER_A, 'msg-clear')
    storeGeneratedContent(USER_A, 'intent-clear', 'секретный текст')
    rememberDocumentJob(USER_A, { submissionId: 'sub-clear', jobId: JOB, kind: 'docx_document', title: 'т', brief: 'б' })
    expect([...map.keys()].some((key) => key.startsWith('nemo.documentJobs.'))).toBe(true)
    clearDocumentJobsStorage()
    expect([...map.keys()].some((key) => key.startsWith('nemo.documentJobs.'))).toBe(false)
    // и память вкладки тоже: следующий вызов даёт СВЕЖИЙ id, старое не воскресает
    expect(recallGeneratedContent(USER_A, 'intent-clear')).toBeNull()
    expect(recallDocumentJob(USER_A, 'sub-clear')).toBeNull()
  })
})

describe('durable job metadata — restore polls, never regenerates', () => {
  test('remember/recall/list/forget round trip, identity-scoped', () => {
    installStorage()
    rememberDocumentJob(USER_A, { submissionId: 'sub-1', jobId: JOB, kind: 'docx_document', title: 'Отчёт', brief: 'Сделай Word: итоги' })
    const recalled = recallDocumentJob(USER_A, 'sub-1')
    expect(recalled).toMatchObject({ jobId: JOB, kind: 'docx_document', title: 'Отчёт' })
    // чужой пользователь не видит чужие задания
    expect(recallDocumentJob(USER_B, 'sub-1')).toBeNull()
    const listed = listRecentDocumentJobs(USER_A)
    expect(listed.length).toBe(1)
    expect(listed[0].submissionId).toBe('sub-1')
    forgetDocumentJob(USER_A, 'sub-1')
    expect(recallDocumentJob(USER_A, 'sub-1')).toBeNull()
    expect(listRecentDocumentJobs(USER_A)).toEqual([])
  })

  test('job metadata survives content-cache eviction: enqueued work never regenerates', () => {
    installStorage()
    rememberDocumentJob(USER_A, { submissionId: 'sub-keep', jobId: JOB, kind: 'pptx_presentation', title: 'Т', brief: 'б' })
    // текстовый кэш выдавлен полностью — метаданные задания живут отдельно
    for (let index = 0; index < 20; index += 1) storeGeneratedContent(USER_A, `flood-${index}`, `текст ${index}`)
    expect(recallGeneratedContent(USER_A, 'sub-keep')).toBeNull()
    expect(recallDocumentJob(USER_A, 'sub-keep')?.jobId).toBe(JOB)
  })

  test('stale job metadata expires by TTL and corrupted rows are ignored', () => {
    const staleAt = Date.now() - 25 * 60 * 60 * 1000
    installStorage({
      [`nemo.documentJobs.job.${USER_A}.sub-old`]: JSON.stringify({ at: staleAt, v: JSON.stringify({ submissionId: 'sub-old', jobId: JOB, kind: 'docx_document', title: '', brief: '' }) }),
      [`nemo.documentJobs.job.${USER_A}.sub-bad`]: JSON.stringify({ at: Date.now(), v: JSON.stringify({ jobId: 'not-a-uuid', kind: 'docx_document' }) }),
    })
    expect(recallDocumentJob(USER_A, 'sub-old')).toBeNull()
    expect(() => recallDocumentJob(USER_A, 'sub-bad')).toThrow('DOCUMENT_JOBS_RECOVERY_UNAVAILABLE')
    expect(listRecentDocumentJobs(USER_A)).toEqual([])
  })
})

describe('submission recovery regression cases', () => {
  const input = { kind: 'docx_document', title: 'Source report', blocks: [{ type: 'paragraph', text: 'The supplied original report content.' }] }
  const meta = (submissionId: string) => ({ submissionId, kind: 'docx_document' as const, title: 'Source report', brief: 'Source '.repeat(100) + 'IMPORTANT TAIL', input })

  test('lost accepted response + cold reload replays exact input and ID, including beyond cache TTL', async () => {
    const map = installStorage()
    const pending = prepareDocumentSubmission(USER_A, meta('lost-response'))
    const firstRequest = { userId: USER_A, requestKey: pending.submissionId, kind: pending.kind, input: pending.input!, requestId: pending.requestId }
    let serverRequest: Record<string, unknown> | undefined
    await expect(enqueueDocumentJob(async (body) => { serverRequest = body; throw new Error('lost'); }, firstRequest)).rejects.toThrow('lost')
    vi.useFakeTimers()
    vi.setSystemTime(Date.now() + 25 * 60 * 60 * 1000)
    const cold = await import('../src/lib/documentJobs.ts?lost-response')
    installStorage(Object.fromEntries(map))
    const restored = cold.listRecentDocumentJobs(USER_A)[0]
    expect(restored.brief).toBe(meta('lost-response').brief)
    expect(restored.state).toBe('submitting')
    expect(restored.input).toEqual(input)
    expect(cold.persistentRequestId(USER_A, restored.submissionId)).toBe(pending.requestId)
    await cold.enqueueDocumentJob(async (body) => {
      expect(body).toEqual(serverRequest)
      return { status: 200, body: { ok: true, job_id: JOB, deduplicated: true } }
    }, { ...firstRequest, input: restored.input!, requestId: restored.requestId })
  })

  test('full source survives accepted/failed/reload; legacy completeness is not assumed', async () => {
    const pending = prepareDocumentSubmission(USER_A, meta('full-source'))
    rememberDocumentJob(USER_A, { ...pending, jobId: JOB, state: 'accepted', terminal: true })
    const cold = await import('../src/lib/documentJobs.ts?full-source')
    expect(cold.recallDocumentJob(USER_A, 'full-source')?.brief).toBe(meta('full-source').brief)
    localStorage.setItem(`nemo.documentJobs.job.${USER_A}.legacy`, JSON.stringify({ at: Date.now(), v: JSON.stringify({ submissionId: 'legacy', jobId: JOB, kind: 'docx_document', title: '', brief: 'maybe truncated' }) }))
    expect(cold.recallDocumentJob(USER_A, 'legacy')?.briefComplete).toBe(false)
  })

  test('expiry clears warm memory and stable enumeration never skips fresh neighbours', () => {
    vi.useFakeTimers()
    const start = Date.now()
    storeGeneratedContent(USER_A, 'warm', 'old')
    const oldId = persistentRequestId(USER_A, 'warm')
    rememberDocumentJob(USER_A, { submissionId: 'warm', jobId: JOB, kind: 'docx_document', title: '', brief: '' })
    vi.setSystemTime(start + 23 * 60 * 60 * 1000)
    rememberDocumentJob(USER_A, { submissionId: 'fresh', jobId: JOB, kind: 'docx_document', title: '', brief: '' })
    vi.setSystemTime(start + 25 * 60 * 60 * 1000)
    expect(listRecentDocumentJobs(USER_A).map((j) => j.submissionId)).toEqual(['fresh'])
    expect(recallDocumentJob(USER_A, 'warm')).toBeNull()
    expect(recallGeneratedContent(USER_A, 'warm')).toBeNull()
    expect(persistentRequestId(USER_A, 'warm')).not.toBe(oldId)
  })

  test('blocked storage, oversized input and corruption fail before a new enqueue', () => {
    installStorage({}, { throwing: true })
    expect(() => prepareDocumentSubmission(USER_A, meta('blocked'))).toThrow('DOCUMENT_JOBS_STORAGE_UNAVAILABLE')
    installStorage()
    expect(() => prepareDocumentSubmission(USER_A, { ...meta('large'), brief: 'x'.repeat(192 * 1024) })).toThrow('DOCUMENT_JOBS_PAYLOAD_TOO_LARGE')
    prepareDocumentSubmission(USER_A, meta('corrupt'))
    localStorage.setItem(`nemo.documentJobs.job.${USER_A}.corrupt`, '{broken')
    expect(() => prepareDocumentSubmission(USER_A, meta('corrupt'))).toThrow('DOCUMENT_JOBS_RECOVERY_UNAVAILABLE')
    expect(() => recallDocumentJob(USER_A, 'corrupt')).toThrow('DOCUMENT_JOBS_RECOVERY_UNAVAILABLE')
  })

  test('unresolved submissions cannot be evicted for capacity; changed input conflicts', () => {
    for (let i = 0; i < 16; i++) prepareDocumentSubmission(USER_A, meta(`pending-${i}`))
    expect(() => prepareDocumentSubmission(USER_A, meta('seventeenth'))).toThrow('DOCUMENT_JOBS_STORAGE_UNAVAILABLE')
    expect(listRecentDocumentJobs(USER_A)).toHaveLength(16)
    expect(() => prepareDocumentSubmission(USER_A, { ...meta('pending-0'), input: { ...input, title: 'Changed' } })).toThrow('DOCUMENT_JOBS_IDEMPOTENCY_CONFLICT')
  })

  test('malformed timestamps remain visible as recovery issues; backward clock preserves pending work', () => {
    prepareDocumentSubmission(USER_A, meta('clock'))
    vi.useFakeTimers()
    vi.setSystemTime(Date.now() - 1_000)
    expect(listRecentDocumentJobs(USER_A)).toHaveLength(1)
    const key = `nemo.documentJobs.job.${USER_A}.clock`
    const entry = JSON.parse(localStorage.getItem(key)!)
    localStorage.setItem(key, JSON.stringify({ ...entry, at: null }))
    expect(listRecentDocumentJobs(USER_A)).toHaveLength(0)
    expect(localStorage.getItem(key)).not.toBeNull()
    expect(hasDocumentRecoveryIssue(USER_A)).toBe(true)
    expect(() => prepareDocumentSubmission(USER_A, meta('clock'))).toThrow('DOCUMENT_JOBS_RECOVERY_UNAVAILABLE')
  })

  test('coercible non-string PDF kind is a recovery issue, never a replayable submission', async () => {
    const input = { kind: 'typst_document', template: 'report', title: 'PDF', sections: [{ heading: '', body: 'Original source text' }] }
    prepareDocumentSubmission(USER_A, { ...meta('malformed-kind'), kind: 'typst_document', input })
    const key = `nemo.documentJobs.job.${USER_A}.malformed-kind`
    const entry = JSON.parse(localStorage.getItem(key)!)
    const stored = JSON.parse(entry.v)
    entry.v = JSON.stringify({ ...stored, kind: ['typst_document'] })
    localStorage.setItem(key, JSON.stringify(entry))
    const reloaded = await import('../src/lib/documentJobs.ts?malformed-kind')
    expect(reloaded.listRecentDocumentJobs(USER_A)).toEqual([])
    expect(reloaded.hasDocumentRecoveryIssue(USER_A)).toBe(true)
    expect(() => reloaded.recallDocumentJob(USER_A, 'malformed-kind')).toThrow('DOCUMENT_JOBS_RECOVERY_UNAVAILABLE')
  })
})

describe('session-bound function transport', () => {
  test('a session acquired after A -> B switch never sends A input', async () => {
    let resolveSession!: (v: Awaited<ReturnType<ScopedFunctionClient['auth']['getSession']>>) => void
    const invoke = vi.fn()
    const client: ScopedFunctionClient = {
      auth: { getSession: () => new Promise((resolve) => { resolveSession = resolve }) },
      functions: { invoke },
    }
    const controller = new AbortController()
    const result = invokeScopedFunction(client, 'document-jobs', { source: 'A-private' }, { userId: 'A', alive: () => true, signal: controller.signal })
    resolveSession({ data: { session: { user: { id: 'B' }, access_token: 'test-B' } } })
    await expect(result).rejects.toThrow('SESSION_SCOPE_LOST')
    expect(invoke).not.toHaveBeenCalled()
  })

  test('actual installed Supabase SDK cannot substitute B token after A session capture', async () => {
    let releaseToken!: (token: string) => void
    let tokenRequested!: () => void
    const waiting = new Promise<void>((resolve) => { tokenRequested = resolve })
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer test-A')
      expect(JSON.parse(String(init?.body))).toEqual({ source: 'A-private' })
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    })
    const sdk = createClient('https://offline.example.test', 'test-public-key', {
      accessToken: () => new Promise((resolve) => { releaseToken = resolve; tokenRequested() }),
      global: { fetch: fetchMock },
    })
    const client: ScopedFunctionClient = {
      auth: { getSession: async () => ({ data: { session: { user: { id: 'A' }, access_token: 'test-A' } } }) },
      functions: sdk.functions,
    }
    const result = invokeScopedFunction(client, 'document-jobs', { source: 'A-private' }, { userId: 'A', alive: () => true, signal: new AbortController().signal })
    await waiting
    releaseToken('test-B')
    expect((await result).error).toBeNull()
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  test('scope abort during pending session rejects promptly and fences the late result', async () => {
    let release!: (v: Awaited<ReturnType<ScopedFunctionClient['auth']['getSession']>>) => void
    const invoke = vi.fn()
    const controller = new AbortController()
    const call = invokeScopedFunction({ auth: { getSession: () => new Promise((r) => { release = r }) }, functions: { invoke } },
      'cli-chat', { source: 'A' }, { userId: 'A', alive: () => true, signal: controller.signal })
    controller.abort()
    await expect(call).rejects.toThrow('SESSION_SCOPE_LOST')
    release({ data: { session: { user: { id: 'A' }, access_token: 'test-A' } } })
    await Promise.resolve()
    expect(invoke).not.toHaveBeenCalled()
  })

  test('logout event cancels before React commit, even when session lookup returns the same user', async () => {
    let emit!: (event: string, session: { user: { id: string } } | null) => void
    let release!: (v: Awaited<ReturnType<ScopedFunctionClient['auth']['getSession']>>) => void
    const invoke = vi.fn()
    const unsubscribe = vi.fn()
    const call = invokeScopedFunction({ auth: {
      getSession: () => new Promise((r) => { release = r }),
      onAuthStateChange: (cb) => { emit = cb; return { data: { subscription: { unsubscribe } } } },
    }, functions: { invoke } }, 'cli-chat', { source: 'A' }, { userId: 'A', alive: () => true, signal: new AbortController().signal })
    emit('SIGNED_OUT', null)
    emit('SIGNED_IN', { user: { id: 'A' } })
    release({ data: { session: { user: { id: 'A' }, access_token: 'test-new-session-A' } } })
    await expect(call).rejects.toThrow('SESSION_SCOPE_LOST')
    expect(invoke).not.toHaveBeenCalled()
    expect(unsubscribe).toHaveBeenCalledOnce()
  })
})

const transportOf = (script: Array<{ status: number; body: Record<string, unknown> | null }>) => {
  const calls: Array<Record<string, unknown>> = []
  const transport: DocumentJobsTransport = async (body) => {
    calls.push(body)
    return script[Math.min(calls.length - 1, script.length - 1)]
  }
  return { transport, calls }
}
const JOB = 'cd55c5de-5555-4555-8555-5555555def55'
const okEnqueue = { status: 200, body: { ok: true, job_id: JOB, workflow_id: JOB, deduplicated: false } }

describe('enqueue — same request_id every time', () => {
  test('retry and reload send the IDENTICAL request_id; dedup passes through', async () => {
    const { transport, calls } = transportOf([
      okEnqueue,
      { status: 200, body: { ...okEnqueue.body, deduplicated: true } },
    ])
    const params = { userId: USER_A, requestKey: 'msg-42', kind: 'docx_document' as const, input: { kind: 'docx_document' } }
    const first = await enqueueDocumentJob(transport, params)
    const second = await enqueueDocumentJob(transport, params)
    expect(first.jobId).toBe(JOB)
    expect(second.deduplicated).toBe(true)
    expect(calls[0].request_id).toBe(calls[1].request_id)
    expect(calls[0].request_id).toBe(first.requestId)
  })

  test('typed errors: quota, conflict, malformed backend', async () => {
    const quota = transportOf([{ status: 429, body: { ok: false, error: 'quota_exceeded' } }])
    await expect(enqueueDocumentJob(quota.transport, { userId: USER_A, requestKey: 'q', kind: 'docx_document', input: {} }))
      .rejects.toMatchObject({ code: 'quota_exceeded' })
    const malformed = transportOf([{ status: 200, body: { ok: true, job_id: 'garbage' } }])
    await expect(enqueueDocumentJob(malformed.transport, { userId: USER_A, requestKey: 'm', kind: 'docx_document', input: {} }))
      .rejects.toMatchObject({ code: 'server_error' })
    expect(new DocumentJobsRequestError('not_ready').message).toBe('DOCUMENT_JOBS_NOT_READY')
  })
})

describe('poll — timeout is still-processing, scope loss stops requests', () => {
  const processing = { status: 200, body: { ok: true, status: 'processing', error_code: null, kind: 'docx_document', artifact: null } }
  const completed = {
    status: 200,
    body: {
      ok: true, status: 'completed', error_code: null, kind: 'docx_document',
      artifact: { name: 'report.docx', mime_type: 'x', size_bytes: 1, sha256: 'a'.repeat(64) },
    },
  }

  test('terminal resolves with the artifact', async () => {
    const { transport, calls } = transportOf([processing, processing, completed])
    const outcome = await pollDocumentJob(transport, JOB, { scopeAlive: () => true, intervalMs: 1, timeoutMs: 10_000 })
    expect(outcome.kind).toBe('terminal')
    if (outcome.kind === 'terminal') expect(outcome.result.artifact?.name).toBe('report.docx')
    expect(calls.length).toBe(3)
  })

  test('timeout → still_processing (no error), the NEXT poll resumes the SAME job', async () => {
    const { transport, calls } = transportOf([processing])
    const outcome = await pollDocumentJob(transport, JOB, { scopeAlive: () => true, intervalMs: 50, timeoutMs: 60, sleep: async () => {} })
    expect(outcome.kind).toBe('still_processing')
    const resumed = transportOf([completed])
    const second = await pollDocumentJob(resumed.transport, JOB, { scopeAlive: () => true, intervalMs: 1, timeoutMs: 10_000 })
    expect(second.kind).toBe('terminal')
    expect(resumed.calls[0].job_id).toBe(calls[0].job_id) // тот же job, никакой перегенерации
  })

  test('scope flipping DURING the status await → scope_lost, never terminal data', async () => {
    let alive = true
    const calls: Array<Record<string, unknown>> = []
    const transport: DocumentJobsTransport = async (body) => {
      calls.push(body)
      alive = false // identity switches while the response is in flight
      return completed
    }
    const outcome = await pollDocumentJob(transport, JOB, { scopeAlive: () => alive, intervalMs: 1, timeoutMs: 10_000 })
    expect(outcome).toEqual({ kind: 'scope_lost' })
    expect(calls.length).toBe(1)
  })

  test('a transport ERROR landing in a dead scope becomes scope_lost, not a UI error', async () => {
    let alive = true
    const transport: DocumentJobsTransport = async () => {
      alive = false
      throw new Error('network died mid-switch')
    }
    const outcome = await pollDocumentJob(transport, JOB, { scopeAlive: () => alive, intervalMs: 1, timeoutMs: 10_000 })
    expect(outcome).toEqual({ kind: 'scope_lost' })
    // with a LIVE scope the same error still surfaces
    await expect(pollDocumentJob(async () => { throw new Error('boom') }, JOB, { scopeAlive: () => true }))
      .rejects.toThrow(/boom/)
  })

  test('a dead scope stops BEFORE any further request', async () => {
    let alive = true
    const { transport, calls } = transportOf([processing])
    const outcome = pollDocumentJob(transport, JOB, {
      scopeAlive: () => alive,
      intervalMs: 5,
      timeoutMs: 10_000,
      sleep: async () => { alive = false }, // identity switch mid-wait
    })
    expect((await outcome).kind).toBe('scope_lost')
    expect(calls.length).toBe(1)
  })

  test('failed job surfaces its error code', async () => {
    const failed = { status: 200, body: { ok: true, status: 'failed', error_code: 'DOCUMENT_MANIFEST_INVALID', kind: 'docx_document', artifact: null } }
    const outcome = await pollDocumentJob(transportOf([failed]).transport, JOB, { scopeAlive: () => true })
    expect(outcome).toMatchObject({ kind: 'terminal', result: { status: 'failed', error_code: 'DOCUMENT_MANIFEST_INVALID' } })
  })
})

describe('status/download validation', () => {
  test('unknown backend status is a typed server_error', async () => {
    const { transport } = transportOf([{ status: 200, body: { ok: true, status: 'exploded' } }])
    await expect(getDocumentJobStatus(transport, JOB)).rejects.toMatchObject({ code: 'server_error' })
  })

  test('download maps not_ready/unregistered and validates the TTL contract', async () => {
    await expect(getDocumentJobDownload(transportOf([{ status: 409, body: { ok: false, error: 'not_ready' } }]).transport, JOB))
      .rejects.toMatchObject({ code: 'not_ready' })
    await expect(getDocumentJobDownload(transportOf([{ status: 409, body: { ok: false, error: 'artifact_unregistered' } }]).transport, JOB))
      .rejects.toMatchObject({ code: 'artifact_unregistered' })
    // a link with the wrong TTL contract is refused, not silently accepted
    await expect(getDocumentJobDownload(transportOf([
      { status: 200, body: { ok: true, url: 'https://x', expires_in: 3600 } },
    ]).transport, JOB)).rejects.toMatchObject({ code: 'server_error' })
    const good = await getDocumentJobDownload(transportOf([
      { status: 200, body: { ok: true, url: 'https://signed', expires_in: 300, name: 'r.docx', mime_type: 'x', size_bytes: 1, sha256: 'a'.repeat(64) } },
    ]).transport, JOB)
    expect(good.url).toBe('https://signed')
  })
})
