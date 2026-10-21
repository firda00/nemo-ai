// Web worker for XLSX parsing: keeps a pathological file off the main thread. The client
// enforces the hard deadline and terminates this worker — no cooperation needed from here.
import { parseXlsxWorkbook } from './xlsxIngest'

self.onmessage = (event: MessageEvent<ArrayBuffer>) => {
  const result = parseXlsxWorkbook(new Uint8Array(event.data))
  ;(self as unknown as { postMessage: (value: unknown) => void }).postMessage(result)
}
