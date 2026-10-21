// Runs in a disposable worker. Bounded text extraction, not visual conversion/OCR.
import { DOMParser } from '@xmldom/xmldom'
import { boundedOfficeParts, decode } from '../../supabase/functions/_shared/officeSourceZip'
import { parseSourceXlsx } from '../../supabase/functions/_shared/xlsxSource'
import { DocumentSourceError, MAX_SOURCE_BYTES, type SourceData } from './documentSources'
import { inspectPdf } from '../../supabase/functions/_shared/pdfInspect'

function docxData(bytes: Uint8Array): SourceData {
  const parts = boundedOfficeParts(bytes, 'docx')
  const fragments: Array<{ locator: string; text: string }> = []
  let textBytes = 0
  for (const name of Object.keys(parts).sort((a, b) => a === 'word/document.xml' ? -1 : b === 'word/document.xml' ? 1 : a.localeCompare(b))) {
    const xml = decode(parts[name])
    if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new DocumentSourceError('unreadable')
    if ((xml.match(/</g)?.length ?? 0) > 100000) throw new DocumentSourceError('too_large')
    const doc = new DOMParser({ onError: () => { throw new DocumentSourceError('unreadable') } }).parseFromString(xml, 'application/xml')
    if (!/wordprocessingml\/(2006\/main|main)$/.test(doc.documentElement?.namespaceURI ?? '')) throw new DocumentSourceError('unreadable')
    const paragraphs = doc.getElementsByTagNameNS('*', 'p')
    // Bound depth without recursive traversal and reject content requiring another extractor.
    const walk = [{ node: doc.documentElement!, depth: 0 }]
    while (walk.length) {
      const { node, depth } = walk.pop()!
      if (depth > 64) throw new DocumentSourceError('too_large')
      if (['drawing', 'pict', 'object', 'altChunk', 'oMath', 'oMathPara', 'AlternateContent', 'del', 'ins', 'instrText', 'fldSimple', 'fldChar', 'sym', 'txbxContent'].includes(node.localName ?? '')
        || /^(moveFrom|moveTo)|PrChange$/.test(node.localName ?? '')) throw new DocumentSourceError('incomplete')
      for (let child = node.firstChild; child; child = child.nextSibling) if (child.nodeType === 1) walk.push({ node: child as typeof node, depth: depth + 1 })
    }
    for (let index = 0; index < paragraphs.length; index++) {
      const p = paragraphs.item(index)!
      const nodes = p.getElementsByTagNameNS('*', '*')
      let text = ''
      for (let i = 0; i < nodes.length; i++) {
        const node = nodes.item(i)!
        if (node.localName === 't') text += node.textContent ?? ''
        if (node.localName === 'tab') text += '\t'
        if (node.localName === 'br' || node.localName === 'cr') text += '\n'
        if (node.localName === 'noBreakHyphen') text += '\u2011'
        if (node.localName === 'softHyphen') text += '\u00ad'
      }
      if (!text.trim()) continue
      textBytes += new TextEncoder().encode(text).length
      if (textBytes > MAX_SOURCE_BYTES || fragments.length >= 2000) throw new DocumentSourceError('too_large')
      fragments.push({ locator: `${name}:p:${index + 1}`, text })
    }
  }
  if (!fragments.length) throw new DocumentSourceError('unreadable')
  return { format: 'docx', fragments }
}

export function preflightDocumentPdf(bytes: Uint8Array): void {
  const verdict = inspectPdf(bytes, { textImport: true })
  if (!verdict.ok) throw new DocumentSourceError(verdict.reason === 'pdf_size' || verdict.reason?.includes('limit') ? 'too_large' : 'incomplete')
}

export function parseDocumentSourceBytes(format: 'text' | 'docx' | 'xlsx', bytes: Uint8Array): SourceData {
  if (format === 'docx') return docxData(bytes)
  if (format === 'xlsx') {
    return parseSourceXlsx(bytes)
  }
  if (bytes.length > MAX_SOURCE_BYTES) throw new DocumentSourceError('too_large')
  const text = decode(bytes)
  // No replacement decoding, disguised binaries or NULs inside a supposed text source.
  // eslint-disable-next-line no-control-regex
  if (!text.trim() || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(text)) throw new DocumentSourceError('unreadable')
  return { format: 'text', fragments: [{ locator: 'text:1', text }] }
}
