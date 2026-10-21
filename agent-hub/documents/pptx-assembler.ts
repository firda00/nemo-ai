// Real, office-editable presentations (OOXML .pptx) from a TYPED model — same contract as the
// docx assembler: plain strings only, escaped and control-stripped; no raw OOXML, no macros,
// no external relationships (every relationship in the package points at parts written here);
// strict sizes checked before assembly.
//
// OVERFLOW POLICY: content never silently clips. Each slide's body has a fixed line budget
// derived from the box geometry below; bullets that exceed it CONTINUE onto follow-up slides
// (titled «… (2)», «… (3)»), and a single bullet longer than a whole slide is split at the
// line budget so progress is always made. The character model here is deliberately
// conservative and is CALIBRATED by an actual-rendering check (the overflow smoke measures
// real text wrapping at this exact geometry in a browser engine) — character counts alone are
// not the evidence. Full slide visual certification (fonts/kerning in office renderers)
// remains an explicit open gap until a bundled renderer exists.
import { strToU8 } from 'fflate'
import { deterministicZip, escapeDocText } from './docx-assembler.ts'
import { PptxPresentationInputSchema, type PptxPresentationInput } from './document-models.ts'

// schema lives in the Deno/browser-safe document-models module; re-exported for importers
export { PptxPresentationInputSchema, type PptxPresentationInput } from './document-models.ts'

// slide geometry (EMU) — the overflow smoke renders at EXACTLY these numbers
export const SLIDE_W = 12192000
export const SLIDE_H = 6858000
export const BODY_X = 685800
export const BODY_Y = 1600200
export const BODY_W = 10820400
export const BODY_H = 4800600
export const BODY_FONT_PT = 18
export const BODY_LINE_HEIGHT = 1.2
// text-box insets are ENCODED explicitly (not left to Office defaults) so the rendering
// calibration measures exactly the geometry the file declares
export const INSET_LR = 91440
export const INSET_TB = 45720
/** conservative wrap model, calibrated by the rendering smoke — not trusted on its own */
export const CHARS_PER_LINE = 80
export const LINES_PER_SLIDE = 14
const MAX_EMITTED_SLIDES = 200
export const TITLE_H = 990600

/**
 * The title box cannot continue onto another slide — long titles step the EXPLICIT font size
 * down instead (encoded in the run, verified by the rendering smoke), never a silent clip.
 */
export function titleFontSize(title: string): number {
  // thresholds sized for WIDE glyphs (Ш/W ≈ one em) inside the inset content box — the
  // rendering smoke measures each boundary, boundary+1 and 200-wide-glyph worst cases
  const length = [...title].length
  if (length <= 26) return 3200
  if (length <= 72) return 2400
  if (length <= 160) return 1600
  return 1400
}

const bulletLines = (text: string) => Math.max(1, Math.ceil([...text].length / CHARS_PER_LINE))

interface FlatSlide { title: string; bullets: string[] }

/** Deterministic continuation: pack bullets into line-budgeted slides; split oversized bullets. */
export function planSlides(input: PptxPresentationInput): FlatSlide[] {
  const emitted: FlatSlide[] = []
  for (const slide of input.slides) {
    // a single bullet longer than a whole slide is split at the line budget — always progress
    const atoms: string[] = []
    for (const bullet of slide.bullets) {
      const chars = [...bullet]
      const maxChars = LINES_PER_SLIDE * CHARS_PER_LINE
      for (let index = 0; index < chars.length; index += maxChars) {
        atoms.push(chars.slice(index, index + maxChars).join(''))
      }
      if (!chars.length) atoms.push(bullet)
    }
    let part: string[] = []
    let partLines = 0
    let partNumber = 0
    const flush = () => {
      partNumber += 1
      emitted.push({ title: partNumber === 1 ? slide.title : `${slide.title} (${partNumber})`, bullets: part })
      part = []
      partLines = 0
    }
    if (!atoms.length) { flush(); continue }
    for (const atom of atoms) {
      const lines = bulletLines(atom)
      if (partLines + lines > LINES_PER_SLIDE && part.length) flush()
      part.push(atom)
      partLines += lines
    }
    if (part.length) flush()
  }
  return emitted
}

const A_NS = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"'
const P_NS = 'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"'
const R_NS = 'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"'

function textBox(id: number, name: string, x: number, y: number, w: number, h: number, paragraphs: string, autofit = false): string {
  return `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${name}"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr/></p:nvSpPr>`
    + `<p:spPr><a:xfrm><a:off x="${x}" y="${y}"/><a:ext cx="${w}" cy="${h}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr>`
    + `<p:txBody>${autofit
      ? `<a:bodyPr wrap="square" lIns="${INSET_LR}" rIns="${INSET_LR}" tIns="${INSET_TB}" bIns="${INSET_TB}"><a:normAutofit/></a:bodyPr>`
      : `<a:bodyPr wrap="square" lIns="${INSET_LR}" rIns="${INSET_LR}" tIns="${INSET_TB}" bIns="${INSET_TB}"/>`}<a:lstStyle/>${paragraphs}</p:txBody></p:sp>`
}

function slideXml(slide: FlatSlide): string {
  // the 1.2 line spacing is ENCODED in the OOXML, so the rendering calibration measures the
  // same geometry office renderers will lay out — not a browser-only assumption
  const lineSpacing = `<a:lnSpc><a:spcPct val="${Math.round(BODY_LINE_HEIGHT * 100000)}"/></a:lnSpc>`
  const titleParagraph = `<a:p><a:pPr>${lineSpacing}</a:pPr><a:r><a:rPr lang="ru-RU" sz="${titleFontSize(slide.title)}" b="1"/><a:t>${escapeDocText(slide.title)}</a:t></a:r></a:p>`
  const bulletParagraphs = slide.bullets.length
    ? slide.bullets.map((bullet) =>
      `<a:p><a:pPr>${lineSpacing}<a:buChar char="&#8226;"/></a:pPr><a:r><a:rPr lang="ru-RU" sz="${BODY_FONT_PT * 100}"/><a:t>${escapeDocText(bullet)}</a:t></a:r></a:p>`).join('')
    : '<a:p><a:endParaRPr lang="ru-RU"/></a:p>'
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:sld ${P_NS} ${A_NS} ${R_NS}><p:cSld><p:spTree>`
    + '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>'
    + textBox(2, 'Title', BODY_X, 365760, BODY_W, TITLE_H, titleParagraph, true)
    + textBox(3, 'Body', BODY_X, BODY_Y, BODY_W, BODY_H, bulletParagraphs)
    + '</p:spTree></p:cSld><p:clrMapOvr><a:overrideClrMapping bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/></p:clrMapOvr></p:sld>'
}

const THEME_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><a:theme ${A_NS} name="Nemo"><a:themeElements>`
  + '<a:clrScheme name="Nemo"><a:dk1><a:srgbClr val="111111"/></a:dk1><a:lt1><a:srgbClr val="FFFFFF"/></a:lt1><a:dk2><a:srgbClr val="333333"/></a:dk2><a:lt2><a:srgbClr val="F2F2F2"/></a:lt2>'
  + '<a:accent1><a:srgbClr val="8B7CF8"/></a:accent1><a:accent2><a:srgbClr val="22D3EE"/></a:accent2><a:accent3><a:srgbClr val="2DD4BF"/></a:accent3><a:accent4><a:srgbClr val="F59E0B"/></a:accent4>'
  + '<a:accent5><a:srgbClr val="EF4444"/></a:accent5><a:accent6><a:srgbClr val="10B981"/></a:accent6><a:hlink><a:srgbClr val="2563EB"/></a:hlink><a:folHlink><a:srgbClr val="7C3AED"/></a:folHlink></a:clrScheme>'
  + '<a:fontScheme name="Nemo"><a:majorFont><a:latin typeface="Calibri"/><a:ea typeface=""/><a:cs typeface="Calibri"/></a:majorFont><a:minorFont><a:latin typeface="Calibri"/><a:ea typeface=""/><a:cs typeface="Calibri"/></a:minorFont></a:fontScheme>'
  + '<a:fmtScheme name="Nemo"><a:fillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:fillStyleLst>'
  + '<a:lnStyleLst><a:ln w="6350"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln w="12700"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln w="19050"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln></a:lnStyleLst>'
  + '<a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst>'
  + '<a:bgFillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:bgFillStyleLst></a:fmtScheme>'
  + '</a:themeElements></a:theme>'

const SLIDE_MASTER_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:sldMaster ${P_NS} ${A_NS} ${R_NS}>`
  + '<p:cSld><p:bg><p:bgPr><a:solidFill><a:schemeClr val="lt1"/></a:solidFill><a:effectLst/></p:bgPr></p:bg><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/></p:spTree></p:cSld>'
  + '<p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/>'
  + '<p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst>'
  + '</p:sldMaster>'

const SLIDE_LAYOUT_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:sldLayout ${P_NS} ${A_NS} ${R_NS} type="blank">`
  + '<p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/></p:spTree></p:cSld>'
  + '<p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>'

const RELS_XMLNS = 'xmlns="http://schemas.openxmlformats.org/package/2006/relationships"'
const REL_TYPE = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'

export function assemblePptx(raw: unknown): { bytes: Uint8Array; outputName: string; seed: string | number; slideCount: number } {
  const input = PptxPresentationInputSchema.parse(raw)
  // same independent renderer budget as the docx model (NOT a queue-fit guarantee — the
  // enqueue boundary must measure the SERIALIZED payload, see serializedPayloadBytes)
  const encoder = new TextEncoder()
  let totalText = encoder.encode(input.title).byteLength
  for (const slide of input.slides) {
    totalText += encoder.encode(slide.title).byteLength
    for (const bullet of slide.bullets) totalText += encoder.encode(bullet).byteLength
  }
  if (totalText > 48 * 1024) throw new Error('Presentation text exceeds the 48 KiB budget')
  const slides = planSlides(input)
  if (slides.length > MAX_EMITTED_SLIDES) throw new Error('Presentation exceeds the 200-slide budget after continuation')

  const files: Record<string, Uint8Array> = {}
  const contentTypes = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
    + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
    + '<Default Extension="xml" ContentType="application/xml"/>'
    + '<Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>'
    + '<Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/>'
    + '<Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/>'
    + '<Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>'
    + slides.map((_slide, index) => `<Override PartName="/ppt/slides/slide${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`).join('')
    + '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>'
    + '</Types>'
  files['[Content_Types].xml'] = strToU8(contentTypes)
  files['_rels/.rels'] = strToU8('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + `<Relationships ${RELS_XMLNS}>`
    + `<Relationship Id="rId1" Type="${REL_TYPE}/officeDocument" Target="ppt/presentation.xml"/>`
    + '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>'
    + '</Relationships>')
  files['docProps/core.xml'] = strToU8('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/">'
    + `<dc:title>${escapeDocText(input.title)}</dc:title></cp:coreProperties>`)

  const presentation = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:presentation ${P_NS} ${A_NS} ${R_NS}>`
    + '<p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst>'
    + `<p:sldIdLst>${slides.map((_slide, index) => `<p:sldId id="${256 + index}" r:id="rId${index + 2}"/>`).join('')}</p:sldIdLst>`
    + `<p:sldSz cx="${SLIDE_W}" cy="${SLIDE_H}"/><p:notesSz cx="${SLIDE_H}" cy="${SLIDE_W}"/></p:presentation>`
  files['ppt/presentation.xml'] = strToU8(presentation)
  files['ppt/_rels/presentation.xml.rels'] = strToU8('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + `<Relationships ${RELS_XMLNS}>`
    + `<Relationship Id="rId1" Type="${REL_TYPE}/slideMaster" Target="slideMasters/slideMaster1.xml"/>`
    + slides.map((_slide, index) => `<Relationship Id="rId${index + 2}" Type="${REL_TYPE}/slide" Target="slides/slide${index + 1}.xml"/>`).join('')
    + '</Relationships>')

  files['ppt/slideMasters/slideMaster1.xml'] = strToU8(SLIDE_MASTER_XML)
  files['ppt/slideMasters/_rels/slideMaster1.xml.rels'] = strToU8('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + `<Relationships ${RELS_XMLNS}>`
    + `<Relationship Id="rId1" Type="${REL_TYPE}/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>`
    + `<Relationship Id="rId2" Type="${REL_TYPE}/theme" Target="../theme/theme1.xml"/>`
    + '</Relationships>')
  files['ppt/slideLayouts/slideLayout1.xml'] = strToU8(SLIDE_LAYOUT_XML)
  files['ppt/slideLayouts/_rels/slideLayout1.xml.rels'] = strToU8('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + `<Relationships ${RELS_XMLNS}>`
    + `<Relationship Id="rId1" Type="${REL_TYPE}/slideMaster" Target="../slideMasters/slideMaster1.xml"/>`
    + '</Relationships>')
  files['ppt/theme/theme1.xml'] = strToU8(THEME_XML)

  slides.forEach((slide, index) => {
    files[`ppt/slides/slide${index + 1}.xml`] = strToU8(slideXml(slide))
    files[`ppt/slides/_rels/slide${index + 1}.xml.rels`] = strToU8('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
      + `<Relationships ${RELS_XMLNS}>`
      + `<Relationship Id="rId1" Type="${REL_TYPE}/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>`
      + '</Relationships>')
  })

  return { bytes: deterministicZip(files), outputName: input.output_name, seed: input.seed, slideCount: slides.length }
}
