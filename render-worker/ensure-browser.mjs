import { ensureBrowser } from '@remotion/renderer'

process.chdir(import.meta.dirname)
await ensureBrowser()
