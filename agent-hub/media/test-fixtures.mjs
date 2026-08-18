// Синтетические медиафайлы для проверки рендера — без внешних зависимостей и без самого ffmpeg.
//
// ЗАЧЕМ ПИСАТЬ PNG И WAV РУКАМИ. Обычный способ сделать тестовое видео — `ffmpeg -f lavfi -i color=...`.
// Он не сработал: сборка ffmpeg, доступная в этом дереве (внутри Remotion), собрана с белым списком
// демультиплексоров, и `lavfi` в него не входит. То есть инструмент, которым надо проверять рендер, не
// может создать материал для этой проверки.
//
// PNG и WAV — форматы, которые записываются десятком строк, а читаются любым ffmpeg: демультиплексоры
// `image2` и `wav` есть даже в урезанных сборках. Это делает проверку независимой и от внешних файлов,
// и от того, насколько богата сборка на конкретной машине.

import zlib from 'node:zlib'
import fs from 'node:fs/promises'

/** CRC32 для блоков PNG. Таблица считается один раз при загрузке модуля. */
const CRC_TABLE = new Uint32Array(256)
for (let n = 0; n < 256; n++) {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  CRC_TABLE[n] = c >>> 0
}
function crc32(buffer) {
  let crc = 0xffffffff
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

function pngChunk(type, data) {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([length, body, crc])
}

/**
 * Однотонный PNG заданного размера.
 *
 * Размеры разные у разных сцен НАМЕРЕННО в проверках: смысл масштабирования под 9:16 как раз в том,
 * чтобы привести разнородные исходники к одному кадру, и одинаковые картинки этого не проверяют.
 */
export function makeSolidPng(width, height, rgb) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8   // бит на канал
  ihdr[9] = 2   // тип цвета: truecolor RGB
  ihdr[10] = 0  // сжатие: deflate
  ihdr[11] = 0  // фильтрация: стандартная
  ihdr[12] = 0  // без чересстрочности

  // Каждая строка начинается с байта фильтра (0 — без фильтрации), дальше пиксели RGB.
  const row = Buffer.alloc(1 + width * 3)
  for (let x = 0; x < width; x++) {
    row[1 + x * 3] = rgb[0]
    row[2 + x * 3] = rgb[1]
    row[3 + x * 3] = rgb[2]
  }
  const raw = Buffer.concat(Array.from({ length: height }, () => row))

  return Buffer.concat([
    signature,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ])
}

/**
 * WAV с синусоидой: PCM 16 бит, моно.
 *
 * Именно тон, а не тишина: тишина проходит через микширование и нормализацию неотличимо от
 * отсутствующей дорожки, и проверка «звук на месте» на ней ничего не показывает.
 */
export function makeSineWav(seconds, frequency = 440, sampleRate = 48_000, amplitude = 0.5) {
  const frames = Math.round(seconds * sampleRate)
  const data = Buffer.alloc(frames * 2)
  for (let i = 0; i < frames; i++) {
    const value = Math.round(amplitude * 32_767 * Math.sin((2 * Math.PI * frequency * i) / sampleRate))
    data.writeInt16LE(value, i * 2)
  }

  const header = Buffer.alloc(44)
  header.write('RIFF', 0, 'latin1')
  header.writeUInt32LE(36 + data.length, 4)
  header.write('WAVE', 8, 'latin1')
  header.write('fmt ', 12, 'latin1')
  header.writeUInt32LE(16, 16)        // размер блока fmt
  header.writeUInt16LE(1, 20)         // PCM без сжатия
  header.writeUInt16LE(1, 22)         // моно
  header.writeUInt32LE(sampleRate, 24)
  header.writeUInt32LE(sampleRate * 2, 28) // байт в секунду
  header.writeUInt16LE(2, 32)         // выравнивание блока
  header.writeUInt16LE(16, 34)        // бит на отсчёт
  header.write('data', 36, 'latin1')
  header.writeUInt32LE(data.length, 40)

  return Buffer.concat([header, data])
}

export async function writePng(filePath, width, height, rgb) {
  await fs.writeFile(filePath, makeSolidPng(width, height, rgb))
  return filePath
}

export async function writeWav(filePath, seconds, frequency) {
  await fs.writeFile(filePath, makeSineWav(seconds, frequency))
  return filePath
}
