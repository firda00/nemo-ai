// Real, editable Word documents (OOXML .docx) from a TYPED model — no HTML behind a magic
// header, no LLM, no keys, no network. The model accepts ONLY plain strings: every character
// is XML-escaped, control bytes are stripped, and there is deliberately NO way to smuggle raw
// OOXML, macros (this package has no vbaProject part and never will) or external
// relationships — the only relationships are the internal styles/numbering/core parts this
// module itself writes. Sizes are strictly bounded before any assembly work happens.
//
// Honest scope: structural validity and text fidelity are provable offline (our own unzip and
// independent python-docx reads); full VISUAL layout certification needs a renderer this
// environment does not bundle (no soffice) and remains an explicit open gap.
import { strToU8, zipSync } from 'fflate'
import {
  DocxDocumentInputSchema, MAX_TOTAL_TEXT_BYTES,
  type DocxDocumentInput,
} from './document-models.ts'

// the schemas and budgets live in the Deno/browser-safe document-models module (the frontend
// must never import THIS file — it pulls fflate); re-exported for existing importers
export {
  DocxDocumentInputSchema, MAX_TOTAL_TEXT_BYTES, QUEUE_INPUT_LIMIT_BYTES, serializedPayloadBytes,
  type DocxDocumentInput,
} from './document-models.ts'

/**
 * Plain text only: escape XML metacharacters, DROP control bytes (tab/newline become spaces)
 * and REPLACE every scalar XML 1.0 forbids — U+FFFE/U+FFFF and isolated surrogates — so no
 * input can produce a malformed document part.
 */
export function escapeDocText(value: string): string {
  let out = ''
  for (const ch of value) {
    const code = ch.codePointAt(0) ?? 0
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) { out += ' '; continue }
    // for-of yields an ISOLATED surrogate as its own "character"; paired ones come through as
    // one supplementary code point (> 0xFFFF) and are fine
    if ((code >= 0xd800 && code <= 0xdfff) || code === 0xfffe || code === 0xffff) { out += '�'; continue }
    if (ch === '&') out += '&amp;'
    else if (ch === '<') out += '&lt;'
    else if (ch === '>') out += '&gt;'
    else if (ch === '"') out += '&quot;'
    else out += ch
  }
  return out
}

/** ZIP entries carry a FIXED mtime: identical input yields identical bytes on any clock. */
export const DETERMINISTIC_MTIME = new Date('2020-01-01T00:00:00Z')
export function deterministicZip(files: Record<string, Uint8Array>): Uint8Array {
  const stamped: Record<string, [Uint8Array, { level: 6; mtime: Date }]> = {}
  for (const [name, data] of Object.entries(files)) stamped[name] = [data, { level: 6, mtime: DETERMINISTIC_MTIME }]
  return zipSync(stamped)
}

const run = (text: string, bold = false) =>
  `<w:r><w:rPr>${bold ? '<w:b/>' : ''}</w:rPr><w:t xml:space="preserve">${escapeDocText(text)}</w:t></w:r>`

const paragraph = (text: string, props = '') => `<w:p>${props ? `<w:pPr>${props}</w:pPr>` : ''}${run(text)}</w:p>`

function tableXml(header: string[], rows: string[][]): string {
  const cell = (text: string, bold: boolean) =>
    `<w:tc><w:tcPr><w:tcW w:w="0" w:type="auto"/></w:tcPr><w:p><w:pPr/>${run(text, bold)}</w:p></w:tc>`
  const row = (cells: string[], bold: boolean) => `<w:tr>${cells.map((text) => cell(text, bold)).join('')}</w:tr>`
  const border = '<w:top w:val="single" w:sz="4" w:color="808080"/><w:left w:val="single" w:sz="4" w:color="808080"/><w:bottom w:val="single" w:sz="4" w:color="808080"/><w:right w:val="single" w:sz="4" w:color="808080"/><w:insideH w:val="single" w:sz="4" w:color="808080"/><w:insideV w:val="single" w:sz="4" w:color="808080"/>'
  return `<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/><w:tblBorders>${border}</w:tblBorders></w:tblPr>`
    + `<w:tblGrid>${header.map(() => '<w:gridCol/>').join('')}</w:tblGrid>`
    + row(header, true)
    + rows.map((cells) => row(cells, false)).join('')
    + '</w:tbl>'
}

const W_NS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"'

function documentXml(input: DocxDocumentInput): string {
  const body = input.blocks.map((block) => {
    if (block.type === 'heading') return paragraph(block.text, `<w:pStyle w:val="Heading${block.level}"/>`)
    if (block.type === 'paragraph') return paragraph(block.text)
    if (block.type === 'bullets') {
      return block.items.map((item) =>
        paragraph(item, '<w:pStyle w:val="ListParagraph"/><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr>')).join('')
    }
    // table rows are normalized to the header width: SHORT rows pad, LONG rows were refused
    return tableXml(block.header, block.rows.map((cells) => {
      const padded = [...cells]
      while (padded.length < block.header.length) padded.push('')
      return padded
    }))
  }).join('')
  const sectPr = '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1418" w:header="709" w:footer="709"/></w:sectPr>'
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document ${W_NS}><w:body>${body}${sectPr}</w:body></w:document>`
}

const STYLES_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles ${W_NS}>`
  + '<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:cs="Calibri"/><w:sz w:val="22"/><w:szCs w:val="22"/><w:lang w:val="ru-RU"/></w:rPr></w:rPrDefault></w:docDefaults>'
  + '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>'
  + '<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:before="240" w:after="120"/></w:pPr><w:rPr><w:b/><w:sz w:val="32"/></w:rPr></w:style>'
  + '<w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:before="200" w:after="100"/></w:pPr><w:rPr><w:b/><w:sz w:val="28"/></w:rPr></w:style>'
  + '<w:style w:type="paragraph" w:styleId="Heading3"><w:name w:val="heading 3"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:before="160" w:after="80"/></w:pPr><w:rPr><w:b/><w:sz w:val="24"/></w:rPr></w:style>'
  + '<w:style w:type="paragraph" w:styleId="ListParagraph"><w:name w:val="List Paragraph"/><w:basedOn w:val="Normal"/><w:pPr><w:ind w:left="720"/></w:pPr></w:style>'
  + '</w:styles>'

const NUMBERING_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:numbering ${W_NS}>`
  + '<w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="bullet"/><w:lvlText w:val="&#8226;"/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="720" w:hanging="360"/></w:pPr></w:lvl></w:abstractNum>'
  + '<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>'
  + '</w:numbering>'

const CONTENT_TYPES = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
  + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
  + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
  + '<Default Extension="xml" ContentType="application/xml"/>'
  + '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
  + '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>'
  + '<Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/>'
  + '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>'
  + '</Types>'

const ROOT_RELS = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
  + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
  + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>'
  + '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>'
  + '</Relationships>'

const DOCUMENT_RELS = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
  + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
  + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>'
  + '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/>'
  + '</Relationships>'

const coreXml = (title: string, language: string) => '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
  + '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/">'
  + `<dc:title>${escapeDocText(title)}</dc:title><dc:language>${language}</dc:language>`
  + '</cp:coreProperties>'

function totalTextBytes(input: DocxDocumentInput): number {
  const encoder = new TextEncoder()
  let total = encoder.encode(input.title).byteLength
  for (const block of input.blocks) {
    if (block.type === 'heading' || block.type === 'paragraph') total += encoder.encode(block.text).byteLength
    else if (block.type === 'bullets') for (const item of block.items) total += encoder.encode(item).byteLength
    else {
      for (const cell of block.header) total += encoder.encode(cell).byteLength
      for (const row of block.rows) for (const cell of row) total += encoder.encode(cell).byteLength
    }
  }
  return total
}

export function assembleDocx(raw: unknown): { bytes: Uint8Array; outputName: string; seed: string | number } {
  const input = DocxDocumentInputSchema.parse(raw)
  if (totalTextBytes(input) > MAX_TOTAL_TEXT_BYTES) throw new Error('Document text exceeds the 48 KiB budget')
  for (const block of input.blocks) {
    if (block.type === 'table' && block.rows.some((row) => row.length > block.header.length)) {
      throw new Error('Table rows must not be wider than the header')
    }
  }
  const bytes = deterministicZip({
    '[Content_Types].xml': strToU8(CONTENT_TYPES),
    '_rels/.rels': strToU8(ROOT_RELS),
    'docProps/core.xml': strToU8(coreXml(input.title, input.language)),
    'word/document.xml': strToU8(documentXml(input)),
    'word/styles.xml': strToU8(STYLES_XML),
    'word/numbering.xml': strToU8(NUMBERING_XML),
    'word/_rels/document.xml.rels': strToU8(DOCUMENT_RELS),
  })
  return { bytes, outputName: input.output_name, seed: input.seed }
}
