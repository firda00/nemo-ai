import { NodeCompiler } from '@myriaddreamin/typst-ts-node-compiler'
import { TypstDocumentInputSchema, type TypstDocumentInput } from './typst-model.ts'
export { TypstDocumentInputSchema, type TypstDocumentInput } from './typst-model.ts'

function typstString(value: string): string {
  return JSON.stringify(value.replaceAll('\u0000', ''))
}

function renderLineItems(input: TypstDocumentInput): string {
  if (!input.line_items.length) return ''
  const rows = input.line_items.map((item) => {
    const total = item.quantity * item.unit_price
    return `text(${typstString(item.description)}), [${item.quantity}], [${item.unit_price.toFixed(2)}], [${total.toFixed(2)}]`
  })
  const grandTotal = input.line_items.reduce((sum, item) => sum + item.quantity * item.unit_price, 0)
  return `
#table(
  columns: (1fr, auto, auto, auto),
  inset: 6pt,
  stroke: 0.5pt + rgb("d8dce8"),
  table.header([*Description*], [*Qty*], [*Unit price*], [*Total*]),
  ${rows.join(',\n  ')},
)

#align(right)[*Total: ${grandTotal.toFixed(2)} ${input.currency}*]
`
}

export function buildTypstSource(raw: unknown): { input: TypstDocumentInput; source: string } {
  const input = TypstDocumentInputSchema.parse(raw)
  const sections = input.sections.map((section) => {
    // Keep short paragraphs together at a page boundary. Long prose remains
    // breakable, so a large supplied paragraph can never overflow a single page.
    const paragraphs = section.body.split(/\n{2,}/).map((paragraph) => {
      const breakable = paragraph.length > 1000 || paragraph.split('\n').length > 8
      return `#block(breakable: ${breakable})[#text(${typstString(paragraph)})]`
    }).join('\n\n')
    return `
${section.heading ? `= #text(${typstString(section.heading)})` : ''}

${paragraphs}
`
  }).join('\n')
  const recipient = input.recipient ? `#text(${typstString(`Prepared for: ${input.recipient}`)})` : ''
  const source = `
#set page(paper: "a4", margin: (x: 22mm, y: 20mm), numbering: "1")
#set text(size: 10.5pt)
#set par(justify: true, leading: 0.72em)
#set heading(numbering: "1.")

#align(center)[
  #text(size: 20pt, weight: "bold", ${typstString(input.title)})
  #v(6pt)
  ${recipient}
]

#v(12pt)
${sections}
${renderLineItems(input)}
`
  return { input, source }
}

export function renderTypstPdf(raw: unknown): { bytes: Uint8Array; outputName: string; seed: string | number } {
  const { input, source } = buildTypstSource(raw)
  const compiler = NodeCompiler.create()
  const pdf = compiler.pdf({ mainFileContent: source })
  if (pdf.length < 5 || pdf.subarray(0, 5).toString() !== '%PDF-') {
    throw new Error('Typst compiler did not produce a PDF')
  }
  return { bytes: new Uint8Array(pdf), outputName: input.output_name, seed: input.seed }
}
