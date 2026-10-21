import { strToU8, zipSync } from 'fflate'
export const spreadsheetNs = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
export function sourceXlsx(options: { prefix?: boolean; singleQuotes?: boolean; currency?: string | null; missingCost?: boolean; formula?: boolean; duplicateRef?: boolean } = {}): Uint8Array {
  const esc = (v: string) => v.replace(/&/g, '&amp;').replace(/</g, '&lt;')
  const row = (index: number, values: string[]) => `<row r="${index}">${values.map((v, c) => `<c r="${String.fromCharCode(65 + c)}${index}" t="inlineStr"><is><t>${esc(v)}</t></is></c>`).join('')}</row>`
  const header = ['Товар', 'Количество', 'Выручка', 'Сумма себестоимости', 'Валюта']
  const data = (name: string, cost: string) => row(1, header) + row(2, [name, '2', '200.00', cost, options.currency === undefined ? 'USD' : options.currency ?? ''])
  let sheet1 = `<worksheet xmlns="${spreadsheetNs}"><sheetData>${data('Товар Первый', options.missingCost ? '' : '80.00')}${options.formula ? '<row r="3"><c r="A3"><f>1+2</f></c></row>' : ''}${options.duplicateRef ? '<row r="2"><c r="A2"><v>1</v></c></row>' : ''}</sheetData></worksheet>`
  let sheet2 = `<worksheet xmlns="${spreadsheetNs}"><sheetData>${data('Товар Второй', '50.00')}</sheetData></worksheet>`
  let workbook = `<workbook xmlns="${spreadsheetNs}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Продажи" sheetId="1" r:id="rId1"/><sheet name="Второй лист" sheetId="2" r:id="rId2"/></sheets></workbook>`
  let rels = '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Target="worksheets/sheet2.xml"/></Relationships>'
  if (options.prefix) {
    const prefix = (xml: string) => xml.replace(/<(\/?)([A-Za-z][\w]*)/g, '<$1x:$2').replace('xmlns=', 'xmlns:x=')
    sheet1 = prefix(sheet1); sheet2 = prefix(sheet2); workbook = prefix(workbook)
  }
  if (options.singleQuotes) { sheet1 = sheet1.replace(/"/g, "'"); sheet2 = sheet2.replace(/"/g, "'"); workbook = workbook.replace(/"/g, "'"); rels = rels.replace(/"/g, "'") }
  return zipSync({ 'xl/workbook.xml': strToU8(workbook), 'xl/_rels/workbook.xml.rels': strToU8(rels), 'xl/worksheets/sheet1.xml': strToU8(sheet1), 'xl/worksheets/sheet2.xml': strToU8(sheet2) })
}
export function sourceDocx(text = 'Текст документа, который полностью переносится в готовый файл.', extra: Record<string, Uint8Array> = {}): Uint8Array {
  const ns = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
  return zipSync({ 'word/document.xml': strToU8(`<w:document xmlns:w="${ns}"><w:body><w:p><w:r><w:t>${text.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>Таблица: сохранённая ячейка</w:t></w:r></w:p></w:tc></w:tr></w:tbl></w:body></w:document>`),
    'word/header1.xml': strToU8(`<w:hdr xmlns:w="${ns}"><w:p><w:r><w:t>Важный колонтитул</w:t></w:r></w:p></w:hdr>`), ...extra })
}

/** Boundary rows on two sheets, a summary without a date and another currency OUTSIDE July. */
export function periodXlsx(options: { invalidDate?: boolean; currency?: string | null; date1904?: string } = {}): Uint8Array {
  const currency = options.currency === undefined ? 'USD' : options.currency ?? ''
  const row = (index: number, values: string[]) => `<row r="${index}">${values.map((v, c) => `<c r="${String.fromCharCode(65 + c)}${index}" t="inlineStr"><is><t>${v}</t></is></c>`).join('')}</row>`
  const header = row(4, ['Товар', 'Количество', 'Выручка', 'Сумма себестоимости', 'Валюта', 'Дата'])
  const sheet = (content: string) => strToU8(`<worksheet xmlns="${spreadsheetNs}"><sheetData>${row(1, ['Продажи по датам'])}${header}${content}</sheetData></worksheet>`)
  return zipSync({
    'xl/workbook.xml': strToU8(`<workbook xmlns="${spreadsheetNs}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">${options.date1904 === undefined ? '' : `<workbookPr date1904="${options.date1904}"/>`}<sheets><sheet name="Продажи" sheetId="1" r:id="rId1"/><sheet name="Возвраты" sheetId="2" r:id="rId2"/></sheets></workbook>`),
    'xl/_rels/workbook.xml.rels': strToU8('<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Target="worksheets/sheet2.xml"/></Relationships>'),
    'xl/worksheets/sheet1.xml': sheet(row(5, ['Июнь', '2', '900', '400', currency, '2026-06-30']) + row(6, ['Первое июля', '2', '200', '80', currency, '2026-07-01']) + row(7, ['Последнее июля', '3', '300', '90', currency, '31.07.2026']) + row(8, ['Август', '1', '9999999999999999999999', '1', 'EUR', '2026-08-01']) + row(9, ['Итого', '8', '1400', '570', currency, ''])),
    'xl/worksheets/sheet2.xml': sheet(row(5, ['Возврат', '-1', '-100', '-60', currency, options.invalidDate ? '31.02.2026' : '2026-07-15'])),
  })
}
