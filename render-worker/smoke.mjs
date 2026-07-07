// Offline render smoke test — validates Remotion + Chromium work on this box before wiring
// HTTP/Supabase. Renders the default Reel to /tmp and prints the path + size. No upload.
import { bundle } from '@remotion/bundler'
import { selectComposition, renderMedia, ensureBrowser } from '@remotion/renderer'
import { fileURLToPath } from 'node:url'
import { statSync } from 'node:fs'
import path from 'node:path'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const out = '/tmp/nemo-smoke.mp4'

const props = {
  title: 'Nemo AI',
  brand: 'Nemo AI',
  accent: '#8B7CF8',
  scenes: [
    { caption: 'Тест кириллицы — рендер работает', durationSec: 2 },
    { caption: 'Второй кадр с переходом', durationSec: 2 },
  ],
}

console.log('ensureBrowser...')
await ensureBrowser()
console.log('bundling...')
const serveUrl = await bundle({ entryPoint: path.join(__dirname, 'src', 'index.ts'), onProgress: () => {} })
console.log('selecting composition...')
const composition = await selectComposition({ serveUrl, id: 'Reel', inputProps: props })
console.log(`rendering ${composition.durationInFrames} frames @ ${composition.width}x${composition.height} ...`)
await renderMedia({ serveUrl, composition, codec: 'h264', outputLocation: out, inputProps: props, concurrency: 1, timeoutInMilliseconds: 120000, logLevel: 'error' })
console.log('DONE ->', out, statSync(out).size, 'bytes')
process.exit(0)
