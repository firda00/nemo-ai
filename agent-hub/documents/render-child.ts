import { readFile, writeFile } from 'node:fs/promises'
import { renderMarpSlides } from './marp-renderer.ts'
import { renderTypstPdf } from './typst-renderer.ts'

const [inputPath, outputPath] = process.argv.slice(2)
if (!inputPath || !outputPath) throw new Error('Document render paths are required')

const payload = JSON.parse(await readFile(inputPath, 'utf8')) as { kind?: string }
const result = payload.kind === 'typst_document'
  ? renderTypstPdf(payload)
  : payload.kind === 'marp_presentation'
    ? renderMarpSlides(payload)
    : (() => { throw new Error('Unsupported document job kind') })()

await writeFile(outputPath, result.bytes, { flag: 'wx', mode: 0o600 })
process.stdout.write(JSON.stringify({ outputName: result.outputName, seed: result.seed }))
