import assert from 'node:assert/strict'
import { buildPrintableDocument, buildWordDocument, markdownToDocumentHtml, safeDocumentName } from '../src/lib/docExport.ts'

const markdown = '# Sales handoff\n\n- **Amina** — Hot\n- Follow-up: `Ready to start?`\n\n<script>alert("xss")</script>'
const hostileTitle = 'Sales </title><script>alert("title")</script>'

const html = markdownToDocumentHtml(markdown)
assert.match(html, /<h1>Sales handoff<\/h1>/)
assert.match(html, /<b>Amina<\/b>/)
assert.match(html, /<code>Ready to start\?<\/code>/)
assert.ok(!html.includes('<script>alert("xss")</script>'), 'document content must be escaped')
assert.ok(html.includes('&lt;script&gt;'), 'escaped content remains readable')

const word = buildWordDocument(markdown, hostileTitle)
assert.ok(word.startsWith('<!DOCTYPE html>'))
assert.ok(word.includes('xmlns:w="urn:schemas-microsoft-com:office:word"'))
assert.ok(!word.includes('<title>Sales </title><script>'), 'Word title must not inject markup')
assert.ok(word.includes('&lt;/title&gt;'), 'Word title remains visible after escaping')

const printable = buildPrintableDocument(markdown, hostileTitle)
assert.ok(printable.includes('@media print'))
assert.ok(printable.includes('window.print()'))
assert.ok(!printable.includes('<title>Sales </title><script>'), 'print title must not inject script')

assert.equal(safeDocumentName(' Продажи / июль 2026 '), 'Продажи-июль-2026')
assert.equal(safeDocumentName('<>'), 'nemo')

console.log('Export contracts passed: Markdown, Word, and print-to-PDF are formatted and injection-safe.')
