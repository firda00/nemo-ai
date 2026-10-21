// Chat document-intent classifier — conservative routing contract (post-review):
//   • explicit format token + creation verb, RU/UZ/EN;
//   • explicit PDF generation is captured; mixed-format conversion requests and bare
//     «документ» are not classified as generation;
//   • negations and «how to create…» explanation questions are NOT captured;
//   • the result carries a BRIEF (the full user request) for the generation step — the tail
//     after a colon is NOT treated as verified source material (it may be an instruction);
//   • whole-word title extraction: no partial stem residue («й ю о солнечной энергии»);
//   • a format token inside the tail never reclassifies the kind.
import { describe, expect, test } from 'vitest'
import { classifyDocumentChatIntent } from '../src/lib/documentChatIntent.ts'

describe('classifyDocumentChatIntent', () => {
  test('RU/UZ/EN word requests route to docx', () => {
    expect(classifyDocumentChatIntent('Сделай Word: Итоги квартала по продажам')).toMatchObject({ kind: 'docx_document' })
    expect(classifyDocumentChatIntent('Создай DOCX: текст отчёта')).toMatchObject({ kind: 'docx_document' })
    expect(classifyDocumentChatIntent('Word fayl yarat: hisobot matni')).toMatchObject({ kind: 'docx_document' })
    expect(classifyDocumentChatIntent('make a word document: quarterly notes')).toMatchObject({ kind: 'docx_document' })
  })

  test('presentation requests route to pptx', () => {
    expect(classifyDocumentChatIntent('Сделай презентацию: план запуска')).toMatchObject({ kind: 'pptx_presentation' })
    expect(classifyDocumentChatIntent('Создай PPTX: тезисы')).toMatchObject({ kind: 'pptx_presentation' })
    expect(classifyDocumentChatIntent('Taqdimot tayyorla: reja')).toMatchObject({ kind: 'pptx_presentation' })
    expect(classifyDocumentChatIntent('Подготовь слайды: три пункта')).toMatchObject({ kind: 'pptx_presentation' })
  })

  test('PDF creation in RU/UZ/EN routes to registered typst; conversion stays separate', () => {
    expect(classifyDocumentChatIntent('Сделай PDF: отчёт')).toMatchObject({ kind: 'typst_document', title: 'отчёт' })
    expect(classifyDocumentChatIntent('Сделай пдф отчёт')).toMatchObject({ kind: 'typst_document', title: 'отчёт' })
    expect(classifyDocumentChatIntent('PDF fayl yarat: hisobot')).toMatchObject({ kind: 'typst_document' })
    expect(classifyDocumentChatIntent('Create a PDF: quarterly report')).toMatchObject({ kind: 'typst_document' })
    expect(classifyDocumentChatIntent('Сделай Word в PDF: готовый текст документа')).toBeNull()
    expect(classifyDocumentChatIntent('Сделай документ: отчёт')).toBeNull()
    expect(classifyDocumentChatIntent('Сделай PDF и Word: отчёт')).toBeNull()
    expect(classifyDocumentChatIntent('Как сделать PDF?')).toBeNull()
    expect(classifyDocumentChatIntent('Не создавай PDF')).toBeNull()
  })

  test('negation and explanation questions are NOT captured (Codex probes)', () => {
    expect(classifyDocumentChatIntent('Не нужно готовить файл, напиши как создать презентацию')).toBeNull()
    expect(classifyDocumentChatIntent('How to create a pptx?')).toBeNull()
    expect(classifyDocumentChatIntent('как сделать word-файл красивым')).toBeNull()
  })

  test('a format mention WITHOUT a creation verb is not captured', () => {
    expect(classifyDocumentChatIntent('вчера открывал файл в ворде и всё сломалось')).toBeNull()
    expect(classifyDocumentChatIntent('what is a docx file?')).toBeNull()
  })

  test('whole-word title extraction — no partial stem residue (Codex probe)', () => {
    const intent = classifyDocumentChatIntent('Сделай презентацию о солнечной энергии')
    expect(intent?.kind).toBe('pptx_presentation')
    expect(intent?.title).toBe('солнечной энергии')
    expect(classifyDocumentChatIntent('Сделай Word отчёт по маркетингу: текст')?.title).toContain('отчёт')
  })

  test('the BRIEF is the full request; the colon tail is never split off as verified material', () => {
    const message = 'Сделай презентацию: сравни выручку за этот месяц'
    const intent = classifyDocumentChatIntent(message)
    expect(intent?.kind).toBe('pptx_presentation')
    expect(intent?.brief).toBe(message) // the instruction stays part of the brief for GENERATION
  })

  test('a format token inside the tail does not reclassify the kind', () => {
    const intent = classifyDocumentChatIntent('Сделай Word: подготовили презентацию и слайды для клиента')
    expect(intent?.kind).toBe('docx_document')
    const multiline = classifyDocumentChatIntent('Создай DOCX\nПервый абзац.\nВторой абзац.')
    expect(multiline?.kind).toBe('docx_document')
    expect(multiline?.brief).toContain('Второй абзац.')
  })

  test('title falls back to the first tail line when the head has no subject', () => {
    expect(classifyDocumentChatIntent('Сделай Word: Итоги квартала\nостальной текст')?.title).toBe('Итоги квартала')
  })
})
