// Document → plain text extraction for the knowledge base (RAG).
// Heavy parsers (pdf.js, mammoth, read-excel-file) are dynamically imported so they only
// load when a user actually uploads a file — the main bundle stays small.

const MAX_CHARS = 200_000 // bound what we store per document
export const MAX_KNOWLEDGE_FILE_BYTES = 20 * 1024 * 1024

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
    const readXlsxFile = ((await import('read-excel-file/browser')) as Any).default as (input: File) => Promise<unknown[][]>
    const rows = await readXlsxFile(file)
    return rows
      .map((row) => row.map((cell) => String(cell ?? '')).join(', '))
      .join('\n')
      .slice(0, MAX_CHARS)
  }

  throw new Error('UNSUPPORTED_FILE_TYPE')
}
