import { describe, expect, test } from 'vitest'
import { zlibSync } from 'fflate'
import { inspectPdf } from '../supabase/functions/_shared/pdfInspect.ts'
import { buildDocumentModel } from '../agent-hub/documents/document-models.ts'
import { buildTypstSource, renderTypstPdf } from '../agent-hub/documents/typst-renderer.ts'

const encoder = new TextEncoder()
const body = 'Проверенный текст отчёта. To‘liq ma’lumot. This report preserves the supplied material.'

// Independently assembled classic-xref fixtures: offsets are calculated from bytes,
// so malformed structures cannot pass merely because the xref is already broken.
function fixture(options: { catalog?: string; tree?: string; page?: string; extra?: string; stream?: Uint8Array; filter?: string; trailer?: string } = {}): Uint8Array {
  const data = options.stream ?? encoder.encode('q Q')
  const objects = [
    `<< /Type /Catalog /Pages 2 0 R ${options.catalog ?? ''} >>`,
    options.tree ?? '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    options.page ?? '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R >>',
    `<< /Length ${data.length} ${options.filter ?? ''} >>\nstream\n${Buffer.from(data).toString('latin1')}\nendstream`,
    ...(options.extra ? [options.extra] : []),
  ]
  let out = '%PDF-1.7\n'
  const offsets = [0]
  for (let i = 0; i < objects.length; i++) { offsets.push(Buffer.byteLength(out, 'latin1')); out += `${i + 1} 0 obj\n${objects[i]}\nendobj\n` }
  const xref = Buffer.byteLength(out, 'latin1')
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f\r\n`
  for (const offset of offsets.slice(1)) out += `${String(offset).padStart(10, '0')} 00000 n\r\n`
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R ${options.trailer ?? ''} >>\nstartxref\n${xref}\n%%EOF`
  return new Uint8Array(Buffer.from(out, 'latin1'))
}

describe('registered typed PDF', () => {
  test('chat model preserves long source text and never accepts arbitrary Typst', () => {
    const source = `${body}\n\n${body.repeat(120)}`
    const built = buildDocumentModel('typst_document', 'Отчёт', source)
    expect(built.ok && built.kind === 'typst_document').toBe(true)
    if (!built.ok || built.kind !== 'typst_document') return
    expect(built.input.sections.map((section) => section.body).join('')).toBe(source)
    expect(built.input.line_items).toEqual([])
    expect(built.input.output_name).toBe('document.pdf')
    expect(() => buildTypstSource({ ...built.input, code: '#read("secret")' })).toThrow()
  })

  test('real Typst PDF with injection strings passes strict inspection', () => {
    const injection = '] #panic("EXECUTED") [ #read("secret") \\ "'
    const result = renderTypstPdf({ kind: 'typst_document', template: 'report', title: 'Отчёт / Hisobot',
      recipient: injection, sections: [{ heading: injection, body: `${body}\n${injection}` }],
      line_items: [{ description: injection, quantity: 2, unit_price: 3 }],
    })
    expect(inspectPdf(result.bytes)).toEqual({ ok: true, pages: 1 })
  })

  test('independent PDF.js reads RU/UZ text and literal Typst injection from actual PDF bytes', async () => {
    const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs')
    const literal = '] #panic("EXECUTED") [ #read("secret")'
    const result = renderTypstPdf({ kind: 'typst_document', template: 'report', title: 'Отчёт / Hisobot',
      sections: [{ heading: 'Итоги', body }], line_items: [{ description: literal, quantity: 2, unit_price: 3 }] })
    const loading = getDocument({ data: result.bytes, isEvalSupported: false })
    const document = await loading.promise
    try {
      const page = await document.getPage(1)
      const content = await page.getTextContent()
      const extracted = content.items.map((item) => 'str' in item ? item.str : '').join(' ').replace(/\s+/gu, ' ')
      expect(extracted).toContain('Отчёт / Hisobot')
      expect(extracted).toContain('Проверенный текст отчёта.')
      expect(extracted).toContain('To‘liq ma’lumot.')
      expect(extracted).toContain(literal)
    } finally { await loading.destroy() }
  })

  test('a real multipage report has a valid page tree and preserves the full source', () => {
    const built = buildDocumentModel('typst_document', 'Длинный отчёт', `${body}\n\n`.repeat(140))
    expect(built.ok).toBe(true)
    if (!built.ok) return
    const result = renderTypstPdf(built.input)
    const verdict = inspectPdf(result.bytes)
    expect(verdict.ok).toBe(true)
    expect(verdict.pages).toBeGreaterThan(1)
  })

  test('valid independent fixture and compressed stream are accepted', () => {
    expect(inspectPdf(fixture())).toEqual({ ok: true, pages: 1 })
    expect(inspectPdf(fixture({ stream: zlibSync(encoder.encode('q Q')), filter: '/Filter /FlateDecode' }))).toEqual({ ok: true, pages: 1 })
  })

  test('magic-only, truncated, appended, wrong-xref and dangling page data are refused', () => {
    const good = fixture()
    for (const invalid of [encoder.encode('%PDF-1.7\nfake'), good.subarray(0, good.length - 12),
      new Uint8Array([...good, ...encoder.encode('\nextra')]),
      encoder.encode(new TextDecoder().decode(good).replace(/startxref\n\d+/, 'startxref\n4')),
      fixture({ page: '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 999 0 R >>' }),
    ]) expect(inspectPdf(invalid).ok).toBe(false)
  })

  test('cyclic, wrong-count and missing-page trees are refused', () => {
    for (const tree of ['<< /Type /Pages /Kids [2 0 R] /Count 1 >>',
      '<< /Type /Pages /Kids [3 0 R] /Count 2 >>', '<< /Type /Pages /Kids [] /Count 0 >>']) {
      expect(inspectPdf(fixture({ tree })).ok).toBe(false)
    }
  })

  test('encoded forbidden PDF names are refused before stream inflation', () => {
    for (const extra of ['<< /S /J#61vaScript /JS (anything) >>',
      '<< /Type /Obj#53tm /Length 4 /Filter /FlateDecode >>\nstream\njunk\nendstream',
      '<< /Type /EmbeddedFile >>']) {
      expect(inspectPdf(fixture({ extra }))).toMatchObject({ ok: false, reason: 'pdf_unsupported_feature' })
    }
    for (const trailer of ['/En#63rypt 1 0 R', '/P#72ev 10', '/XRefStm 12']) {
      expect(inspectPdf(fixture({ trailer }))).toMatchObject({ ok: false, reason: 'pdf_unsupported_feature' })
    }
    expect(inspectPdf(fixture({ catalog: '/OpenAction 3 0 R' })).ok).toBe(false)
  })

  test('corrupt checksums and compressed expansion beyond the limit are refused', () => {
    const compressed = zlibSync(encoder.encode('q Q'))
    compressed[compressed.length - 1] ^= 1
    expect(inspectPdf(fixture({ stream: compressed, filter: '/Filter /FlateDecode' })).ok).toBe(false)
    const bomb = zlibSync(new Uint8Array(17 * 1024 * 1024))
    expect(inspectPdf(fixture({ stream: bomb, filter: '/Filter /FlateDecode' })))
      .toMatchObject({ ok: false, reason: 'pdf_stream_limit' })
  })

  test('parser limits apply before allocating huge arrays, deep structures or oversized tokens', () => {
    expect(inspectPdf(fixture({ extra: `[${'0 '.repeat(120_000)}]` })))
      .toMatchObject({ ok: false, reason: 'pdf_structure_limit' })
    expect(inspectPdf(fixture({ extra: `${'['.repeat(80)}0${']'.repeat(80)}` })))
      .toMatchObject({ ok: false, reason: 'pdf_structure_limit' })
    for (const extra of [`(${'x'.repeat(32_000)})`, `/${'A'.repeat(32_000)}`, `<${'aa'.repeat(32_000)}>`]) {
      expect(inspectPdf(fixture({ extra }))).toMatchObject({ ok: false, reason: 'pdf_token_limit' })
    }
  })
})
