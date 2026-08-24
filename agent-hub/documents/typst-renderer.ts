import { NodeCompiler } from '@myriaddreamin/typst-ts-node-compiler'
import { z } from 'zod'

const SafeOutputNameSchema = z.string().min(1).max(120).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*\.pdf$/i)

const DocumentSectionSchema = z.object({
  heading: z.string().min(1).max(160),
  body: z.string().min(1).max(12_000),
}).strict()

const LineItemSchema = z.object({
  description: z.string().min(1).max(240),
  quantity: z.number().finite().nonnegative().max(1_000_000),
  unit_price: z.number().finite().nonnegative().max(1_000_000_000),
}).strict()

export const TypstDocumentInputSchema = z.object({
  kind: z.literal('typst_document'),
  template: z.enum(['commercial_proposal', 'estimate', 'report']),
  output_name: SafeOutputNameSchema.default('document.pdf'),
  title: z.string().min(1).max(240),
  recipient: z.string().max(240).optional(),
  currency: z.string().min(1).max(12).regex(/^[A-Z0-9._-]+$/).default('USD'),
  sections: z.array(DocumentSectionSchema).min(1).max(32),
  line_items: z.array(LineItemSchema).max(100).default([]),
  seed: z.union([z.number().int(), z.string().max(128)]).default(0),
}).strict()

export type TypstDocumentInput = z.infer<typeof TypstDocumentInputSchema>

function typstString(value: string): string {
  return JSON.stringify(value.replaceAll('\u0000', ''))
}

function renderLineItems(input: TypstDocumentInput): string {
  if (!input.line_items.length) return ''
  const rows = input.line_items.map((item) => {
    const total = item.quantity * item.unit_price
    return `[${typstString(item.description)}], [${item.quantity}], [${item.unit_price.toFixed(2)}], [${total.toFixed(2)}]`
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
  const sections = input.sections.map((section) => `
== #text(${typstString(section.heading)})

#text(${typstString(section.body)})
`).join('\n')
  const recipient = input.recipient ? `#text(${typstString(`Prepared for: ${input.recipient}`)})` : ''
  const source = `
#set page(paper: "a4", margin: (x: 22mm, y: 20mm))
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
