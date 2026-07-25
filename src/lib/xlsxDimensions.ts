import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate'

const SHEET_XML = /^xl\/worksheets\/sheet\d+\.xml$/
const MAX_UNCOMPRESSED_BYTES = 80 * 1024 * 1024

function columnNumber(letters: string): number {
  let value = 0
  for (const char of letters) value = value * 26 + char.charCodeAt(0) - 64
  return value
}

/**
 * Uzum exports currently declare worksheet dimension A1 even though their XML
 * contains many rows. Some safe XLSX readers honor that declaration and expose
 * only the first cell. Repair only the dimension metadata; cell data is not
 * interpreted or changed here.
 */
export function repairXlsxDimensions(input: ArrayBuffer): Uint8Array {
  const archive = unzipSync(new Uint8Array(input))
  const uncompressedBytes = Object.values(archive).reduce((sum, file) => sum + file.byteLength, 0)
  if (uncompressedBytes > MAX_UNCOMPRESSED_BYTES) throw new Error('FILE_TOO_LARGE')

  let changed = false
  for (const [name, file] of Object.entries(archive)) {
    if (!SHEET_XML.test(name)) continue
    const xml = strFromU8(file)
    let maxRow = 1
    let maxColumn = 1
    let maxColumnName = 'A'
    for (const match of xml.matchAll(/\br="([A-Z]+)(\d+)"/g)) {
      const column = columnNumber(match[1])
      const row = Number(match[2])
      if (column > maxColumn) {
        maxColumn = column
        maxColumnName = match[1]
      }
      if (row > maxRow) maxRow = row
    }
    const expected = `A1:${maxColumnName}${maxRow}`
    const repaired = xml.replace(
      /<dimension\b[^>]*\bref="[^"]*"[^>]*\/>/,
      `<dimension ref="${expected}"/>`,
    )
    if (repaired !== xml) {
      archive[name] = strToU8(repaired)
      changed = true
    }
  }
  return changed ? zipSync(archive, { level: 6 }) : new Uint8Array(input)
}
