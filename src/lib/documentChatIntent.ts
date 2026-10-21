// Классификатор документного намерения в чате (DOCX/PPTX/PDF) — консервативный по построению:
//   • срабатывает ТОЛЬКО на явное указание формата (word/docx, powerpoint/pptx, презентация,
//     слайды, taqdimot) ВМЕСТЕ с глаголом создания — разговорное упоминание «в ворде» без
//     просьбы ничего не перехватывает;
//   • явный PDF направляется в зарегистрированный документный путь; смешение форматов
//     («сделай word в pdf») не выдаёт генерацию за конвертацию исходного файла;
//   • отрицание («не нужно…») и вопросы «как создать…» — не перехватываются;
//   • результат — {kind, title, brief}: brief — это ВЕСЬ запрос пользователя как задание для
//     СУЩЕСТВУЮЩЕГО генерационного пути; хвост после двоеточия НЕ считается проверенным
//     материалом (это может быть инструкция) — что из brief станет содержимым, решает
//     генерационный шаг, которому явно велено использовать переданный текст дословно.
import type { DocumentJobKind } from './documentJobs'

export interface DocumentChatIntent {
  kind: DocumentJobKind
  title: string
  brief: string
}

const PPTX_TOKENS = /\b(pptx?|powerpoint)\b|презентаци|слайд|taqdimot|slayd/i
const DOCX_TOKENS = /\b(docx?|word)\b|ворд/i
const PDF_TOKENS = /\bpdf\b|пдф/i
const CREATION_CUE = /сдела|создай|подготов|состав|сформируй|оформ|напиш|собери|make|create|generate|prepare|write|build|yarat|tayyorla|\btuz\b|\byoz\b/i
// \b в JavaScript НЕ разделяет кириллические слова — границы через Unicode-классы
const NEGATION = /(^|[^\p{L}\p{N}_])(не|нет|don't|do\s+not|never|kerak\s+emas|emas)(?![\p{L}\p{N}_])/iu
const HOW_QUESTION = /(^|[^\p{L}\p{N}_])(как|how|qanday)(?![\p{L}\p{N}_])/iu
// слова, из которых заголовок не строится: сами глаголы/форматы и связки
const TITLE_NOISE = /^(файл|file|fayl|формат|о|об|обо|про|по|для|в|на|and|a|the|about|on|for|in|of|uchun|haqida)$/i

export function classifyDocumentChatIntent(message: string): DocumentChatIntent | null {
  const value = message.trim()
  if (!value) return null
  // классифицируется только «голова» просьбы (до первого разделителя): формат, упомянутый
  // ВНУТРИ переданного текста, не переключает вид файла
  const separator = value.search(/[:\n]/)
  const head = separator >= 0 ? value.slice(0, separator) : value
  const tail = separator >= 0 ? value.slice(separator + 1).trim() : ''

  if (!CREATION_CUE.test(head)) return null
  if (NEGATION.test(head)) return null
  if (HOW_QUESTION.test(head)) return null
  const pdfMatch = PDF_TOKENS.exec(head)
  const pptxMatch = PPTX_TOKENS.exec(head)
  const docxMatch = DOCX_TOKENS.exec(head)
  if (pdfMatch && (pptxMatch || docxMatch)) return null
  if (!pptxMatch && !docxMatch && !pdfMatch) return null
  const kind: DocumentJobKind = pdfMatch ? 'typst_document' : pptxMatch && (!docxMatch || pptxMatch.index < docxMatch.index)
    ? 'pptx_presentation'
    : 'docx_document'

  // заголовок — ЦЕЛЫМИ словами: слово выбрасывается, если содержит глагол/формат/связку;
  // частичная замена стема («сдела→й», «презентаци→ю») сюда не попадает по построению
  const strippedHead = head
    .split(/\s+/)
    .map((word) => word.replace(/^[«»"'.,!?()-]+|[«»"'.,!?()-]+$/g, ''))
    .filter((word) => word.length > 0
      && !CREATION_CUE.test(word) && !PPTX_TOKENS.test(word) && !DOCX_TOKENS.test(word) && !PDF_TOKENS.test(word)
      && !TITLE_NOISE.test(word))
    .join(' ')
    .trim()
  const firstTailLine = tail.split('\n')[0]?.trim().slice(0, 120) ?? ''
  const title = strippedHead.length >= 3 ? strippedHead.slice(0, 240) : firstTailLine

  return { kind, title, brief: value }
}
