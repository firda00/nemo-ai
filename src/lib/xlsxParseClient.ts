// Hard-deadline client for the XLSX parse worker: whatever the file does, the UI gets an answer
// within the bound and the worker is terminated — a hostile archive cannot freeze the tab.
import { type XlsxParseResult } from './xlsxIngest'

export function parseXlsxInWorker(buffer: ArrayBuffer, timeoutMs = 20_000): Promise<XlsxParseResult> {
  return new Promise((resolve) => {
    let settled = false
    let worker: Worker
    const finish = (result: XlsxParseResult) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try { worker.terminate() } catch { /* already gone */ }
      resolve(result)
    }
    const timer = setTimeout(() => finish({ ok: false, reason: 'parse_timeout' }), timeoutMs)
    try {
      worker = new Worker(new URL('./xlsxParse.worker.ts', import.meta.url), { type: 'module' })
    } catch {
      clearTimeout(timer)
      resolve({ ok: false, reason: 'worker_failed' })
      return
    }
    worker.onmessage = (event: MessageEvent<XlsxParseResult>) => finish(event.data)
    worker.onerror = () => finish({ ok: false, reason: 'worker_failed' })
    worker.postMessage(buffer, [buffer])
  })
}
