// Shared typed PDF input: browser, Deno and Node safe; no native compiler.
import { z } from 'zod'

const SafeOutputNameSchema = z.string().min(1).max(120).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*\.pdf$/i)

const DocumentSectionSchema = z.object({
  heading: z.string().max(160).default(''),
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
