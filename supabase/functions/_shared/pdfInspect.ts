// Strict profile for PDFs emitted by our typed Typst renderer, not a general PDF
// importer or renderer. Verify the complete classic xref, parse each object without
// PDFDocument.load's recovery/object-stream inflation, then validate references,
// page tree and bounded streams. Visual/text fidelity is tested with real readers.
import { PDFArray, PDFContext, PDFDict, PDFName, PDFNumber, PDFObjectParser, PDFRawStream, PDFRef, type PDFObject } from 'pdf-lib'
import { Unzlib } from 'fflate'

const MAX_BYTES = 16 * 1024 * 1024
const MAX_OBJECTS = 4096
const MAX_PAGES = 128
const MAX_STREAM_BYTES = 16 * 1024 * 1024
const MAX_INFLATED_BYTES = 64 * 1024 * 1024
const decoder = new TextDecoder('latin1') // one character per byte: xref offsets stay exact
const forbiddenNames = new Set([
  'ObjStm', 'XRef', 'XRefStm', 'Prev', 'Encrypt', 'JavaScript', 'JS', 'OpenAction',
  'AA', 'Launch', 'SubmitForm', 'ImportData', 'GoToR', 'GoToE', 'RichMedia',
  'EmbeddedFile', 'EmbeddedFiles', 'Filespec', 'AcroForm', 'XFA', 'F', 'FFilter',
])

export interface PdfVerdict { ok: boolean; reason?: string; pages?: number }

// Access the pinned parser's consumed-byte position so its permissive prefix parse
// cannot hide extra objects, revisions, or garbage after a valid dictionary.
class ExactObjectParser extends PDFObjectParser {
  static read(bytes: Uint8Array, context: PDFContext, budget: { nodes: number }): { value: PDFObject; offset: number } {
    const parser = PDFObjectParser.forBytes(bytes, context) as ExactObjectParser
    let depth = 0
    const parseObject = parser.parseObject.bind(parser)
    parser.parseObject = () => {
      if (++budget.nodes > 100_000 || ++depth > 32) throw new Error('pdf_structure_limit')
      try { return parseObject() } finally { depth-- }
    }
    // Bound strings, hex strings, names and numbers WHILE reading each byte, before
    // pdf-lib allocates their complete arrays/strings. Raw stream payloads are skipped
    // by the parser and separately size/expansion-checked below.
    let tokenStart: number | null = null
    const next = parser.bytes.next.bind(parser.bytes)
    parser.bytes.next = () => {
      if (tokenStart !== null && parser.bytes.offset() - tokenStart >= 16_384) throw new Error('pdf_token_limit')
      return next()
    }
    const token = <T>(read: () => T) => () => {
      const previous = tokenStart
      tokenStart = parser.bytes.offset()
      try { return read() } finally { tokenStart = previous }
    }
    parser.parseString = token(parser.parseString.bind(parser))
    parser.parseHexString = token(parser.parseHexString.bind(parser))
    parser.parseName = token(parser.parseName.bind(parser))
    parser.parseRawNumber = token(parser.parseRawNumber.bind(parser))
    parser.parseRawInt = token(parser.parseRawInt.bind(parser))
    const value = parser.parseObject()
    return { value, offset: parser.bytes.offset() }
  }
}

export function inspectPdf(bytes: Uint8Array, options: { textImport?: boolean } = {}): PdfVerdict {
  function fail(reason: string): never { throw new Error(reason) }
  try {
    if (bytes.length < 100 || bytes.length > MAX_BYTES) fail('pdf_size')
    const text = decoder.decode(bytes)
    if (!/^%PDF-1\.[4-7]\r?\n/.test(text)) fail('pdf_header')
    const ending = /\nstartxref\s+(\d{1,10})\s+%%EOF\s*$/.exec(text)
    if (!ending) fail('pdf_trailer')
    const xrefOffset = Number(ending![1])
    const xrefText = text.slice(xrefOffset, ending!.index)
    const header = /^xref\r?\n0 (\d+)\r?\n/.exec(xrefText)
    if (!header) fail('pdf_xref')
    const count = Number(header![1])
    if (count < 2 || count > MAX_OBJECTS) fail('pdf_object_limit')
    let cursor = header![0].length
    const objects: Array<{ id: number; offset: number }> = []
    for (let id = 0; id < count; id++) {
      const row = /^(\d{10}) (\d{5}) ([nf])(?:\r\n| \n)/.exec(xrefText.slice(cursor))
      if (!row) fail('pdf_xref_entry')
      cursor += row![0].length
      if (id === 0) {
        if (row![1] !== '0000000000' || row![2] !== '65535' || row![3] !== 'f') fail('pdf_xref_free')
        continue
      }
      const offset = Number(row![1])
      if (row![2] !== '00000' || row![3] !== 'n' || offset < 9 || offset >= xrefOffset) fail('pdf_xref_offset')
      objects.push({ id, offset })
    }
    objects.sort((a, b) => a.offset - b.offset)
    if (!/^%PDF-1\.[4-7]\r?\n(?:%[^\r\n]*\r?\n)?\s*$/.test(text.slice(0, objects[0].offset))) fail('pdf_prefix')
    const context = PDFContext.create()
    const parseBudget = { nodes: 0 }
    function parseExact(part: Uint8Array, suffix: RegExp): PDFObject {
      const { value, offset } = ExactObjectParser.read(part, context, parseBudget)
      if (!suffix.test(decoder.decode(part.subarray(offset)))) fail('pdf_object_trailing')
      return value
    }
    // PDFObjectParser returns raw streams; it does not decode /ObjStm or /XRef.
    // Those names are rejected from parsed objects before ANY decompression below.
    for (let i = 0; i < objects.length; i++) {
      const { id, offset } = objects[i]
      const end = objects[i + 1]?.offset ?? xrefOffset
      const prefix = new RegExp(`^${id} 0 obj\\s+`).exec(text.slice(offset, end))
      if (!prefix || end <= offset) fail('pdf_object_id')
      const object = parseExact(bytes.subarray(offset + prefix![0].length, end), /^\s*endobj\s*$/)
      context.assign(PDFRef.of(id), object)
    }
    if (options.textImport) cursor += /^\s*/.exec(xrefText.slice(cursor))![0].length
    if (!/^trailer\s+/.test(xrefText.slice(cursor))) fail('pdf_trailer')
    const trailerStart = xrefOffset + cursor + /^trailer\s+/.exec(xrefText.slice(cursor))![0].length
    const trailer = parseExact(bytes.subarray(trailerStart, ending!.index), /^\s*$/)
    if (!(trailer instanceof PDFDict) || trailer.lookup(PDFName.of('Size'))?.toString() !== String(count)) fail('pdf_trailer_size')

    let nodes = 0
    const streams: PDFRawStream[] = []
    const contentStreams = new Set<PDFRawStream>()
    function checkObject(value: PDFObject, depth = 0): void {
      if (++nodes > 100_000 || depth > 32) fail('pdf_structure_limit')
      if (value instanceof PDFRef) {
        if (!context.lookup(value)) fail('pdf_dangling_reference')
      } else if (value instanceof PDFName) {
        if (forbiddenNames.has(value.decodeText())) fail('pdf_unsupported_feature')
        if (options.textImport && ['Image', 'Pattern', 'Shading', 'Type3'].includes(value.decodeText())) fail('pdf_nontext_content')
      } else if (value instanceof PDFRawStream) {
        checkObject(value.dict, depth + 1)
        const length = value.dict.lookup(PDFName.of('Length'))
        if (!(length instanceof PDFNumber) || length.asNumber() !== value.getContentsSize()) fail('pdf_stream_length')
        const filter = value.dict.lookup(PDFName.of('Filter'))
        if (filter && (!(filter instanceof PDFName) || filter.decodeText() !== 'FlateDecode')) fail('pdf_stream_filter')
        if (value.dict.has(PDFName.of('DecodeParms'))) fail('pdf_stream_parameters')
        streams.push(value)
      } else if (value instanceof PDFDict) {
        if (options.textImport) {
          const xobjects = value.lookup(PDFName.of('XObject'))
          if (xobjects instanceof PDFDict && xobjects.entries().length > 0) fail('pdf_nontext_content')
          const annotations = value.lookup(PDFName.of('Annots'))
          if (annotations && (!(annotations instanceof PDFArray) || annotations.size() > 0)) fail('pdf_nontext_content')
          const contents = value.lookup(PDFName.of('Contents'))
          // Content arrays form one logical token stream. This strict import profile accepts
          // one stream per page, preventing inline-image tokens split across stream boundaries.
          if (contents instanceof PDFArray && contents.size() > 1) fail('pdf_nontext_content')
          const parts = contents instanceof PDFArray ? contents.asArray().map((item) => context.lookup(item)) : [contents]
          for (const part of parts) if (part instanceof PDFRawStream) contentStreams.add(part)
        }
        for (const [key, item] of value.entries()) { checkObject(key, depth + 1); checkObject(item, depth + 1) }
      } else if (value instanceof PDFArray) {
        for (const item of value.asArray()) checkObject(item, depth + 1)
      }
    }
    checkObject(trailer)
    for (const [, object] of context.enumerateIndirectObjects()) checkObject(object)

    let inflatedTotal = 0
    let importedContentBytes = 0
    let importedContentTokens = 0
    for (const stream of streams) {
      const data = stream.getContents()
      let size = 0
      let a = 1, b = 0
      // Conservative inline-image preflight over bounded page content. An isolated BI token
      // is refused even inside a literal string; this strict profile prefers false refusal
      // to decoding an unbounded inline image. Font/program streams are not scanned.
      let tail = ''
      let previousDelimiter = true
      let contentTokens = 0
      function consume(chunk: Uint8Array): void {
        size += chunk.length
        inflatedTotal += chunk.length
        if (size > MAX_STREAM_BYTES || inflatedTotal > MAX_INFLATED_BYTES) fail('pdf_stream_limit')
        if (options.textImport && contentStreams.has(stream)) {
          importedContentBytes += chunk.length
          if (size > 256 * 1024 || importedContentBytes > 1024 * 1024) fail('pdf_content_limit')
          for (const byte of chunk) {
            const delimiter = byte === 0 || byte === 9 || byte === 10 || byte === 12 || byte === 13 || byte === 32
              || byte === 40 || byte === 41 || byte === 60 || byte === 62 || byte === 91 || byte === 93 || byte === 123 || byte === 125 || byte === 47 || byte === 37
            if (!delimiter && previousDelimiter) { contentTokens++; importedContentTokens++ }
            previousDelimiter = delimiter
          }
          if (contentTokens > 50_000 || importedContentTokens > 100_000) fail('pdf_content_limit')
          const piece = tail + decoder.decode(chunk)
          // eslint-disable-next-line no-control-regex -- NUL is a PDF token delimiter
          if (/(?:^|[\s\x00()[\]<>{}/%])BI(?=[\s\x00()[\]<>{}/%]|$)/.test(piece)) fail('pdf_nontext_content')
          tail = piece.slice(-4)
        }
        for (const value of chunk) { a = (a + value) % 65521; b = (b + a) % 65521 }
      }
      if (stream.dict.has(PDFName.of('Filter'))) {
        if (data.length < 6) fail('pdf_stream_corrupt')
        const unzip = new Unzlib((chunk) => consume(chunk))
        // Small compressed chunks bound transient expansion before the output cap.
        for (let offset = 0; offset < data.length; offset += 512) unzip.push(data.subarray(offset, offset + 512), offset + 512 >= data.length)
        const checksum = new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(data.length - 4)
        if ((((b << 16) | a) >>> 0) !== checksum) fail('pdf_stream_checksum')
      } else consume(data)
    }

    const catalog = trailer.lookup(PDFName.of('Root'))
    if (!(catalog instanceof PDFDict) || catalog.lookup(PDFName.of('Type')) !== PDFName.of('Catalog')) fail('pdf_catalog')
    const seen = new Set<PDFObject>()
    function walkPages(reference: PDFObject | undefined, depth: number): number {
      const node = context.lookup(reference)
      if (!(node instanceof PDFDict) || depth > 32 || seen.has(node)) fail('pdf_page_tree')
      seen.add(node)
      const type = node.lookup(PDFName.of('Type'))
      if (type === PDFName.of('Page')) {
        if (seen.size > MAX_OBJECTS) fail('pdf_page_limit')
        const contents = node.lookup(PDFName.of('Contents'))
        const items = contents instanceof PDFArray ? contents.asArray().map((item) => context.lookup(item)) : [contents]
        if (!items.length || items.some((item) => !(item instanceof PDFRawStream) || !item.getContentsSize())) fail('pdf_page_content')
        const box = node.lookup(PDFName.of('MediaBox'))
        if (!(box instanceof PDFArray) || box.size() !== 4
          || box.asArray().some((item) => !(item instanceof PDFNumber) || !Number.isFinite(item.asNumber()))) fail('pdf_page_box')
        const [x1, y1, x2, y2] = box.asArray().map((item) => (item as PDFNumber).asNumber())
        if (x2 <= x1 || y2 <= y1 || x2 - x1 > 14_400 || y2 - y1 > 14_400) fail('pdf_page_box')
        return 1
      }
      if (type !== PDFName.of('Pages')) fail('pdf_page_type')
      const kids = node.lookup(PDFName.of('Kids'))
      if (!(kids instanceof PDFArray) || !kids.size() || kids.size() > MAX_PAGES) fail('pdf_page_kids')
      let pages = 0
      for (const child of kids.asArray()) { pages += walkPages(child, depth + 1); if (pages > MAX_PAGES) fail('pdf_page_limit') }
      const declared = node.lookup(PDFName.of('Count'))
      if (!(declared instanceof PDFNumber) || declared.asNumber() !== pages) fail('pdf_page_count')
      return pages
    }
    const pages = walkPages(catalog.get(PDFName.of('Pages')), 0)
    return { ok: true, pages }
  } catch (error) {
    const reason = error instanceof Error && /^pdf_[a-z_]+$/.test(error.message) ? error.message : 'pdf_parse_failed'
    return { ok: false, reason }
  }
}
