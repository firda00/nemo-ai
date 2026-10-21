// SHARED document models — Deno/browser/node safe by construction: zod only, no fflate, no
// node:crypto, no worker imports. The frontend imports THIS module (never the assemblers), the
// assemblers and the enqueue boundary import it too, so one schema serves every layer.
import { z } from 'zod'
import { TypstDocumentInputSchema, type TypstDocumentInput } from './typst-model.ts'
export { TypstDocumentInputSchema, type TypstDocumentInput } from './typst-model.ts'

const SafeDocxNameSchema = z.string().min(1).max(120).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*\.docx$/i)
const SafePptxNameSchema = z.string().min(1).max(120).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*\.pptx$/i)
const TEXT_LINE = z.string().max(500)

// the RENDERER'S independent text budget. It does NOT guarantee the queue contract fits:
// JSON escaping can nearly double byte counts (48 KiB of backslashes serializes to ~96 KiB),
// so the enqueue boundary must measure the SERIALIZED payload — see serializedPayloadBytes.
export const MAX_TOTAL_TEXT_BYTES = 48 * 1024

/** runtime_enqueue_compute_job caps input jsonb at this many bytes (SQL is authoritative). */
export const QUEUE_INPUT_LIMIT_BYTES = 65_536
/**
 * Client-side pre-check margin: Postgres serializes jsonb with ": "/", " separators, so its
 * octet count EXCEEDS compact JSON.stringify. The enqueue layer refuses above this and lets
 * the SQL cap stand as the authoritative backstop, mapped to the same typed refusal.
 */
export const ENQUEUE_SAFE_PAYLOAD_BYTES = 52 * 1024

/**
 * The only honest pre-submit queue check: the SERIALIZED payload size, not the raw text sum.
 */
export function serializedPayloadBytes(payload: unknown): number {
  return new TextEncoder().encode(JSON.stringify(payload)).byteLength
}

const HeadingBlockSchema = z.object({ type: z.literal('heading'), level: z.number().int().min(1).max(3), text: z.string().min(1).max(500) }).strict()
const ParagraphBlockSchema = z.object({ type: z.literal('paragraph'), text: z.string().max(4000) }).strict()
const BulletsBlockSchema = z.object({ type: z.literal('bullets'), items: z.array(z.string().min(1).max(500)).min(1).max(50) }).strict()
const TableBlockSchema = z.object({
  type: z.literal('table'),
  header: z.array(TEXT_LINE.min(1)).min(1).max(8),
  rows: z.array(z.array(TEXT_LINE)).max(100),
}).strict()

export const DocxDocumentInputSchema = z.object({
  kind: z.literal('docx_document'),
  output_name: SafeDocxNameSchema.default('document.docx'),
  title: z.string().min(1).max(240),
  language: z.enum(['ru', 'uz', 'en']).default('ru'),
  blocks: z.array(z.discriminatedUnion('type', [HeadingBlockSchema, ParagraphBlockSchema, BulletsBlockSchema, TableBlockSchema])).min(1).max(400),
  seed: z.union([z.number().int(), z.string().max(128)]).default(0),
}).strict()

export type DocxDocumentInput = z.infer<typeof DocxDocumentInputSchema>

export const PptxPresentationInputSchema = z.object({
  kind: z.literal('pptx_presentation'),
  output_name: SafePptxNameSchema.default('slides.pptx'),
  title: z.string().min(1).max(240),
  slides: z.array(z.object({
    title: z.string().min(1).max(200),
    // a bullet may be real prose (up to 2000 chars ≈ 25 wrapped lines) — LONGER than one
    // slide's budget, so the continuation split is reachable through the PUBLIC contract
    bullets: z.array(z.string().min(1).max(2000)).max(12).default([]),
  }).strict()).min(1).max(60),
  seed: z.union([z.number().int(), z.string().max(128)]).default(0),
}).strict()

export type PptxPresentationInput = z.infer<typeof PptxPresentationInputSchema>

export const DocumentInputSchemas = {
  docx_document: DocxDocumentInputSchema,
  pptx_presentation: PptxPresentationInputSchema,
  typst_document: TypstDocumentInputSchema,
} as const

export type DocumentJobKind = keyof typeof DocumentInputSchemas

// ── chat → model normalization ──────────────────────────────────────────────────────────────────
// PROVENANCE IS THE CALLER'S CONTRACT: `content` must be real supplied/generated material
// (user-provided text, a previous step's output) — NEVER the task prompt. Formatting a literal
// request into a file is not content generation; the character floor below only guards against
// empty-ish input and is NOT a substance classifier — a short real note can be legitimate and
// a long bare imperative is still not content. The chat layer decides what qualifies.
//
// FORMATTING NORMALIZATION IS EXPLICITLY SCOPED: blank lines collapse into paragraph breaks
// and leading/trailing whitespace per line is dropped — the NON-WHITESPACE character content
// is preserved exactly (that is what the tests assert), the whitespace shape is not.

const MIN_SUBSTANTIVE_CHARS = 40

export type BuildDocumentModelResult =
  | { ok: true; kind: 'docx_document'; input: DocxDocumentInput }
  | { ok: true; kind: 'pptx_presentation'; input: PptxPresentationInput }
  | { ok: true; kind: 'typst_document'; input: TypstDocumentInput }
  | { ok: false; reason: 'needs_content' | 'content_too_large' }

/**
 * Split text at sentence/space boundaries into chunks of at most maxUnits UTF-16 units — the
 * SAME measure zod .max() enforces, so a chunk always passes the schema. A cut never lands
 * inside a surrogate pair (supplementary-plane text stays intact).
 */
export function splitText(text: string, maxUnits: number): string[] {
  const out: string[] = []
  let rest = text
  while (rest.length > maxUnits) {
    let limit = maxUnits
    if (/[\uD800-\uDBFF]/.test(rest[limit - 1])) limit -= 1 // never orphan a high surrogate
    const window = rest.slice(0, limit)
    const sentence = Math.max(window.lastIndexOf('. '), window.lastIndexOf('! '), window.lastIndexOf('? '))
    const space = window.lastIndexOf(' ')
    const cut = sentence >= limit / 4 ? sentence + 2 : space >= limit / 4 ? space + 1 : limit
    out.push(rest.slice(0, cut))
    rest = rest.slice(cut)
  }
  if (rest) out.push(rest)
  return out
}

export function buildDocumentModel(
  kind: DocumentJobKind,
  title: string,
  content: string,
): BuildDocumentModelResult {
  const trimmedTitle = title.trim().slice(0, 240) || 'Документ'
  const body = content.trim()
  if ([...body].length < MIN_SUBSTANTIVE_CHARS) return { ok: false, reason: 'needs_content' }
  if (new TextEncoder().encode(body).byteLength > MAX_TOTAL_TEXT_BYTES) return { ok: false, reason: 'content_too_large' }

  const paragraphs = body.split(/\n{2,}/).flatMap((block) => block.split(/\n/)).map((p) => p.trim()).filter(Boolean)

  if (kind === 'typst_document') {
    const sections = splitText(body, 12_000).map((text) => ({ heading: '', body: text }))
    const parsed = TypstDocumentInputSchema.safeParse({ kind, template: 'report', title: trimmedTitle, sections, line_items: [] })
    return parsed.success ? { ok: true, kind, input: parsed.data } : { ok: false, reason: 'content_too_large' }
  }

  if (kind === 'docx_document') {
    const blocks: DocxDocumentInput['blocks'] = [{ type: 'heading', level: 1, text: trimmedTitle.slice(0, 500) }]
    for (const paragraph of paragraphs) {
      for (const chunk of splitText(paragraph, 4000)) blocks.push({ type: 'paragraph', text: chunk })
      if (blocks.length > 400) return { ok: false, reason: 'content_too_large' }
    }
    const parsed = DocxDocumentInputSchema.safeParse({ kind, title: trimmedTitle, blocks })
    return parsed.success ? { ok: true, kind, input: parsed.data } : { ok: false, reason: 'content_too_large' }
  }

  const slides: Array<{ title: string; bullets: string[] }> = []
  let current: string[] = []
  for (const paragraph of paragraphs) {
    for (const chunk of splitText(paragraph, 2000)) {
      if (current.length >= 12) { slides.push({ title: trimmedTitle.slice(0, 200), bullets: current }); current = [] }
      current.push(chunk)
    }
  }
  if (current.length) slides.push({ title: trimmedTitle.slice(0, 200), bullets: current })
  if (!slides.length || slides.length > 60) return { ok: false, reason: slides.length ? 'content_too_large' : 'needs_content' }
  const parsed = PptxPresentationInputSchema.safeParse({ kind, title: trimmedTitle, slides })
  return parsed.success ? { ok: true, kind, input: parsed.data } : { ok: false, reason: 'content_too_large' }
}
