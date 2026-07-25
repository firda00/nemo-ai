// Document → plain text extraction for the knowledge base (RAG).
// Heavy parsers (pdf.js, mammoth, read-excel-file) are dynamically imported so they only
// load when a user actually uploads a file — the main bundle stays small.
import { repairXlsxDimensions } from './xlsxDimensions'

const MAX_CHARS = 200_000 // bound what we store per document
export const MAX_KNOWLEDGE_FILE_BYTES = 20 * 1024 * 1024
export const MAX_SKILL_FILE_BYTES = 5 * 1024 * 1024
export const MAX_SKILL_CHARS = 12_000

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any

/** Extensions we accept in the file picker. */
export const KNOWLEDGE_ACCEPT = '.pdf,.docx,.xlsx,.txt,.md,.csv,.tsv,.json,.html,.htm'

export async function extractText(file: File): Promise<string> {
  if (file.size <= 0) throw new Error('EMPTY_FILE')
  if (file.size > MAX_KNOWLEDGE_FILE_BYTES) throw new Error('FILE_TOO_LARGE')
  const name = file.name.toLowerCase()
  const type = file.type || ''

  if (!/\.(pdf|docx|xlsx|txt|md|markdown|csv|tsv|json|log|html?|xml)$/.test(name)) {
    throw new Error('UNSUPPORTED_FILE_TYPE')
  }

  // plain-text family
  if (type.startsWith('text/') || /\.(txt|md|markdown|csv|tsv|json|log|html?|xml)$/.test(name)) {
    return (await file.text()).slice(0, MAX_CHARS)
  }

  // PDF (pdf.js)
  if (type === 'application/pdf' || name.endsWith('.pdf')) {
    const pdfjs = (await import('pdfjs-dist')) as Any
    const workerUrl = (await import('pdfjs-dist/build/pdf.worker.min.mjs?url')).default
    pdfjs.GlobalWorkerOptions.workerSrc = workerUrl
    const buf = await file.arrayBuffer()
    const doc = await pdfjs.getDocument({ data: buf }).promise
    let out = ''
    for (let i = 1; i <= doc.numPages && out.length < MAX_CHARS; i++) {
      const page = await doc.getPage(i)
      const content = await page.getTextContent()
      out += content.items.map((it: Any) => (typeof it?.str === 'string' ? it.str : '')).join(' ') + '\n'
    }
    return out.slice(0, MAX_CHARS)
  }

  // Word .docx (mammoth)
  if (name.endsWith('.docx') || type.includes('officedocument.wordprocessingml')) {
    const mammoth = (await import('mammoth/mammoth.browser')) as Any
    const arrayBuffer = await file.arrayBuffer()
    const { value } = await mammoth.extractRawText({ arrayBuffer })
    return String(value ?? '').slice(0, MAX_CHARS)
  }

  // Excel .xlsx (read-excel-file). The older SheetJS dependency had known
  // prototype-pollution/ReDoS advisories and no patched release in npm.
  // Legacy .xls is intentionally not parsed in-browser until a safe parser is
  // available; users can export it as .xlsx or .csv.
  if (name.endsWith('.xlsx') || type.includes('spreadsheetml')) {
    // read-excel-file >= 8 changed its default export to return sheet objects.
    // Use the named single-sheet reader so uploads remain a row matrix instead
    // of being flattened to "[object Object]".
    const readSheet = ((await import('read-excel-file/browser')) as Any).readSheet as (
      input: File | Blob | ArrayBuffer
    ) => Promise<unknown[][]>
    if (typeof readSheet !== 'function') throw new Error('UNSUPPORTED_FILE_TYPE')
    const repaired = repairXlsxDimensions(await file.arrayBuffer())
    const rows = await readSheet(repaired.buffer as ArrayBuffer)
    return rows
      .map((row) => row
        .map((cell) => String(cell ?? '').replace(/[\t\r\n]+/g, ' ').trim())
        .join('\t'))
      .join('\n')
      .slice(0, MAX_CHARS)
  }

  throw new Error('UNSUPPORTED_FILE_TYPE')
}

/**
 * Import a user-authored skill as prompt instructions. Known document formats use the
 * regular extractors above; source/config formats fall back to bounded plain text.
 * Binary packages, executables and media are deliberately rejected and never executed.
 */
export async function extractSkillText(file: File): Promise<string> {
  if (file.size <= 0) throw new Error('EMPTY_FILE')
  if (file.size > MAX_SKILL_FILE_BYTES) throw new Error('FILE_TOO_LARGE')

  try {
    return (await extractText(file)).slice(0, MAX_SKILL_CHARS)
  } catch (error) {
    if (!(error instanceof Error) || error.message !== 'UNSUPPORTED_FILE_TYPE') throw error
  }

  const text = await file.text()
  if (!text.trim() || text.includes('\u0000')) throw new Error('UNSUPPORTED_FILE_TYPE')
  const controlCount = [...text.slice(0, 20_000)].filter((char) => {
    const code = char.charCodeAt(0)
    return code < 32 && char !== '\n' && char !== '\r' && char !== '\t'
  }).length
  if (controlCount > Math.max(4, text.length * 0.01)) throw new Error('UNSUPPORTED_FILE_TYPE')

  return [...text]
    .filter((char) => {
      const code = char.charCodeAt(0)
      return code >= 32 || char === '\n' || char === '\r' || char === '\t'
    })
    .join('')
    .slice(0, MAX_SKILL_CHARS)
}
