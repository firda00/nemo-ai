import { Marp } from '@marp-team/marp-core'
import { z } from 'zod'

const SafeOutputNameSchema = z.string().min(1).max(120).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*\.html$/i)
const EXTERNAL_REFERENCE = /(?:https?|ftp|file):|(?:^|[\s('"=])\/\//i
const CSS_FETCH = /@import\b|url\s*\(/i
const RAW_HTML = /<\/?[a-z][^>]*>/i

export const MarpPresentationInputSchema = z.object({
  kind: z.literal('marp_presentation'),
  output_name: SafeOutputNameSchema.default('slides.html'),
  title: z.string().min(1).max(240),
  markdown: z.string().min(1).max(60 * 1024),
  seed: z.union([z.number().int(), z.string().max(128)]).default(0),
}).strict()

export type MarpPresentationInput = z.infer<typeof MarpPresentationInputSchema>

export function assertSelfContainedMarkdown(markdown: string): void {
  if (EXTERNAL_REFERENCE.test(markdown) || CSS_FETCH.test(markdown) || RAW_HTML.test(markdown)) {
    throw new Error('Presentation contains an external or executable resource')
  }
  const destinations = [...markdown.matchAll(/!?\[[^\]]*\]\(([^)]+)\)/g)].map((match) => match[1].trim())
  for (const destination of destinations) {
    if (destination.startsWith('#')) continue
    if (/^data:image\/(?:png|jpeg|webp|gif);base64,[a-z0-9+/=]+$/i.test(destination)) continue
    throw new Error('Presentation resource must be an inline data image or an internal anchor')
  }
}

export function renderMarpSlides(raw: unknown): { bytes: Uint8Array; outputName: string; seed: string | number } {
  const input = MarpPresentationInputSchema.parse(raw)
  assertSelfContainedMarkdown(input.markdown)
  const marp = new Marp({ html: false })
  const { html, css } = marp.render(input.markdown)
  const document = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${input.title.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')}</title>
<style>${css}</style>
</head>
<body>${html}</body>
</html>`
  if (EXTERNAL_REFERENCE.test(document.replaceAll('http://www.w3.org/2000/svg', ''))) {
    throw new Error('Rendered presentation is not self-contained')
  }
  return { bytes: new TextEncoder().encode(document), outputName: input.output_name, seed: input.seed }
}
