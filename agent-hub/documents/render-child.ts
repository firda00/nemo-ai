import { readFile, writeFile } from 'node:fs/promises'
import { renderMarpSlides } from './marp-renderer.ts'
import { assembleDocx } from './docx-assembler.ts'
import { assemblePptx } from './pptx-assembler.ts'

const [inputPath, outputPath] = process.argv.slice(2)
if (!inputPath || !outputPath) throw new Error('Document render paths are required')

const payload = JSON.parse(await readFile(inputPath, 'utf8')) as { kind?: string }
// The native Typst package probes Node's process report while selecting its Linux
// binary. The worker has no sys permission; the host release already enforces Linux
// x64 glibc, so provide only the one fact the selector needs before importing it.
if (payload.kind === 'typst_document' && process.report?.getReport) {
  process.report.getReport = () => ({ header: { glibcVersionRuntime: 'worker-host' } }) as ReturnType<typeof process.report.getReport>
}
const result = payload.kind === 'typst_document'
  ? (await import('./typst-renderer.ts')).renderTypstPdf(payload)
  : payload.kind === 'marp_presentation'
    ? renderMarpSlides(payload)
    : payload.kind === 'docx_document'
      ? assembleDocx(payload)
      : payload.kind === 'pptx_presentation'
        ? assemblePptx(payload)
        : (() => { throw new Error('Unsupported document job kind') })()

await writeFile(outputPath, result.bytes, { flag: 'wx', mode: 0o600 })
process.stdout.write(JSON.stringify({ outputName: result.outputName, seed: result.seed }))
