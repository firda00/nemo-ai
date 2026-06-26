// Document → plain text extraction for the knowledge base (RAG).
// Heavy parsers (pdf.js, mammoth, SheetJS) are dynamically imported so they only
// load when a user actually uploads a file — the main bundle stays small.

const MAX_CHARS = 200_000 // bound what we store per document

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any

/** Extensions we accept in the file picker. */
export const KNOWLEDGE_ACCEPT = '.pdf,.docx,.xlsx,.xls,.txt,.md,.csv,.tsv,.json,.html,.htm'

export async function extractText(file: File): Promise<string> {
  const name = file.name.toLowerCase()
  const type = file.type || ''

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

  // Excel .xlsx/.xls (SheetJS)
  if (/\.(xlsx|xls)$/.test(name) || type.includes('spreadsheetml') || type.includes('ms-excel')) {
    const XLSX = (await import('xlsx')) as Any
    const buf = await file.arrayBuffer()
    const wb = XLSX.read(buf, { type: 'array' })
    return (wb.SheetNames as string[])
      .map((n) => `# ${n}\n${XLSX.utils.sheet_to_csv(wb.Sheets[n])}`)
      .join('\n\n')
      .slice(0, MAX_CHARS)
  }

  // last resort: treat as text
  return (await file.text()).slice(0, MAX_CHARS)
}
