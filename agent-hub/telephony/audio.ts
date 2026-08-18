// Аудио телефонии: кодек G.711 μ-law, кадры, пересчёт частоты.
//
// Здесь нет ни одной сетевой операции и ни одного побочного эффекта — только арифметика над числами.
// Это сделано намеренно: всё остальное в голосовом тракте зависит от реального времени и от чужих
// сервисов, а вот кодек либо верен, либо нет, и проверить это можно точно.
//
// ПОЧЕМУ μ-law. FreeSWITCH через mod_audio_fork отдаёт поток телефонного качества: 8 кГц, 8 бит,
// G.711. В Северной Америке и Японии это μ-law (PCMU), в Европе — A-law (PCMA). Список кодеков транка
// в SIPTrunkConfigSchema начинается с PCMU, поэтому реализован он; A-law добавляется тем же способом,
// когда появится транк, который его требует.
//
// ТОЧНОСТЬ ВАЖНЕЕ КРАСОТЫ. μ-law — сжатие с потерями по построению: 14 значащих бит укладываются в 8
// через сегментно-логарифмическую шкалу. Ошибка на единицу в таблице сегментов даёт не «чуть хуже
// звук», а треск и щелчки, которые распознавание речи принимает за согласные. Поэтому реализация
// следует ITU-T G.711 буквально, а тесты сверяются с эталонными значениями стандарта.

/** Частота телефонного потока. Всё, что приходит от FreeSWITCH по μ-law, идёт на этой частоте. */
export const TELEPHONY_SAMPLE_RATE = 8_000

/**
 * Длительность кадра. Двадцать миллисекунд — то, чем оперирует RTP и mod_audio_fork.
 *
 * Число не произвольное: при 8 кГц это ровно 160 отсчётов, то есть 160 байт μ-law. Кадр другой длины
 * означает рассинхронизацию с потоком — звук поедет, а причина будет выглядеть как «плохая связь».
 */
export const FRAME_MS = 20
export const SAMPLES_PER_FRAME = (TELEPHONY_SAMPLE_RATE * FRAME_MS) / 1000
export const BYTES_PER_FRAME = SAMPLES_PER_FRAME

// ── G.711 μ-law ───────────────────────────────────────────────────────────────────────────────────

/** Смещение из стандарта. Добавляется перед кодированием и снимается после декодирования. */
const BIAS = 0x84
/**
 * Предел амплитуды В 14-БИТНОЙ ОБЛАСТИ.
 *
 * Не 32635. Кодирование начинается со сдвига входного отсчёта на два бита вправо: μ-law описан для
 * 14-битного линейного сигнала, а на вход приходит 16-битный. Пропуск этого сдвига — ровно та ошибка,
 * которую сначала и допустила эта реализация: тишина кодировалась байтом 0xE7 вместо 0xFF, отношение
 * сигнал/шум на синусе 440 Гц вышло 5.9 дБ вместо примерно 38, и обратное преобразование перестало
 * быть монотонным. На слух это треск, а распознавание речи принимает его за согласные.
 */
const CLIP = 8_159

/**
 * Верхние границы восьми логарифмических сегментов, в 14-битной области.
 *
 * Развёрнуты таблицей, а не вычисляются логарифмом: на каждый отсчёт приходится короткий перебор
 * вместо вызова Math.log, а отсчётов восемь тысяч в секунду на каждый активный звонок.
 */
const SEGMENT_END = [0x3f, 0x7f, 0xff, 0x1ff, 0x3ff, 0x7ff, 0xfff, 0x1fff]

function segmentOf(value: number): number {
  for (let i = 0; i < SEGMENT_END.length; i++) if (value <= SEGMENT_END[i]) return i
  return SEGMENT_END.length
}

/**
 * Один отсчёт PCM16 → один байт μ-law.
 *
 * Порядок действий из G.711, и переставлять его нельзя: сдвиг к 14 битам, снятие знака, ограничение
 * амплитуды, смещение, поиск сегмента, мантисса. Инверсия в конце не украшение: она делает тишину
 * байтом 0xFF, и линия, оборвавшаяся в ноль, звучит громким треском, а не тишиной — по этому признаку
 * обрыв слышно сразу.
 */
export function muLawEncodeSample(sample: number): number {
  const clamped = Math.max(-32_768, Math.min(32_767, Math.round(sample)))
  // Сдвиг арифметический: для отрицательных >> сохраняет знак, а >>> превратил бы их в огромные
  // положительные и весь кодек — в шум.
  let pcm = clamped >> 2
  let mask: number
  if (pcm < 0) { pcm = -pcm; mask = 0x7f } else { mask = 0xff }
  if (pcm > CLIP) pcm = CLIP
  pcm += BIAS >> 2

  const segment = segmentOf(pcm)
  if (segment >= 8) return (0x7f ^ mask) & 0xff
  return (((segment << 4) | ((pcm >> (segment + 1)) & 0x0f)) ^ mask) & 0xff
}

/** Один байт μ-law → отсчёт PCM16. Обратная операция к предыдущей, тоже буквально по стандарту. */
export function muLawDecodeSample(byte: number): number {
  const value = (~byte) & 0xff
  const sign = value & 0x80
  const exponent = (value >> 4) & 0x07
  const mantissa = value & 0x0f
  let sample = ((mantissa << 3) + BIAS) << exponent
  sample -= BIAS
  return sign !== 0 ? -sample : sample
}

/**
 * Таблица декодирования на все 256 значений.
 *
 * Считается один раз при загрузке модуля. Декодирование идёт на каждый входящий кадр каждого звонка:
 * поиск по массиву дешевле цепочки сдвигов, а результат тот же по построению — таблица заполнена той
 * же функцией.
 */
const DECODE_LUT = new Int16Array(256)
for (let i = 0; i < 256; i++) DECODE_LUT[i] = muLawDecodeSample(i)

/** Кадр μ-law → отсчёты PCM16. */
export function muLawDecode(frame: Uint8Array): Int16Array {
  const out = new Int16Array(frame.length)
  for (let i = 0; i < frame.length; i++) out[i] = DECODE_LUT[frame[i]]
  return out
}

/** Отсчёты PCM16 → кадр μ-law. */
export function muLawEncode(samples: Int16Array): Uint8Array {
  const out = new Uint8Array(samples.length)
  for (let i = 0; i < samples.length; i++) out[i] = muLawEncodeSample(samples[i])
  return out
}

// ── Частота дискретизации ─────────────────────────────────────────────────────────────────────────

/**
 * 8 кГц → 16 кГц линейной интерполяцией.
 *
 * Нужно ровно одному потребителю — Silero VAD, который принимает 8 или 16 кГц. Интерполяция, а не
 * повтор отсчётов: повтор даёт ступенчатый сигнал с зеркальными частотами выше 4 кГц, и детектор
 * речи начинает видеть согласные там, где их нет.
 *
 * Правильный ресемплинг требует фильтра нижних частот, и для ВОСПРОИЗВЕДЕНИЯ этого было бы мало. Но
 * здесь результат идёт только в детектор, который смотрит на огибающую, а не слушает; ставить сюда
 * полноценный фильтр значило бы платить за качество, которое некому оценить.
 */
export function upsample8kTo16k(samples: Int16Array): Int16Array {
  const out = new Int16Array(samples.length * 2)
  for (let i = 0; i < samples.length; i++) {
    const current = samples[i]
    const next = i + 1 < samples.length ? samples[i + 1] : current
    out[i * 2] = current
    out[i * 2 + 1] = (current + next) >> 1
  }
  return out
}

/** 16 кГц → 8 кГц усреднением пар. Обратная задача: голос от TTS обычно приходит шире телефонного. */
export function downsample16kTo8k(samples: Int16Array): Int16Array {
  const out = new Int16Array(Math.floor(samples.length / 2))
  for (let i = 0; i < out.length; i++) out[i] = (samples[i * 2] + samples[i * 2 + 1]) >> 1
  return out
}

/** PCM16 в нормированные float для нейросетевого детектора: он ждёт диапазон [-1, 1]. */
export function toFloat32(samples: Int16Array): Float32Array {
  const out = new Float32Array(samples.length)
  for (let i = 0; i < samples.length; i++) out[i] = samples[i] / 32_768
  return out
}

// ── Нарезка потока на кадры ───────────────────────────────────────────────────────────────────────

/**
 * Накопитель кадров постоянной длины.
 *
 * WebSocket НЕ ГАРАНТИРУЕТ, что пакет придёт ровно кадром. FreeSWITCH шлёт по 20 мс, но между ним и
 * нами стоят TCP, прокси и планировщик: пакеты склеиваются и делятся. Детектор речи, получающий то
 * 90, то 230 байт, считает энергию по кускам разной длины — и порог в миллисекундах перестаёт что-либо
 * значить. Накопитель возвращает поток к кадрам одинакового размера.
 *
 * Остаток НЕ ВЫБРАСЫВАЕТСЯ, а ждёт следующего пакета: выброшенные полкадра — это щелчок в записи и
 * потерянный слог в распознавании.
 */
export class FrameAssembler {
  private buffer: Uint8Array
  private readonly frameBytes: number
  private length = 0

  constructor(frameBytes: number = BYTES_PER_FRAME) {
    if (frameBytes <= 0) throw new Error('размер кадра должен быть положительным')
    this.frameBytes = frameBytes
    this.buffer = new Uint8Array(frameBytes * 4)
  }

  /** Сколько байт лежит в остатке. Для наблюдения: постоянный ненулевой остаток означает рассинхрон. */
  get pending(): number { return this.length }

  push(chunk: Uint8Array): Uint8Array[] {
    if (this.length + chunk.length > this.buffer.length) {
      const grown = new Uint8Array(Math.max(this.buffer.length * 2, this.length + chunk.length))
      grown.set(this.buffer.subarray(0, this.length))
      this.buffer = grown
    }
    this.buffer.set(chunk, this.length)
    this.length += chunk.length

    const frames: Uint8Array[] = []
    let offset = 0
    while (this.length - offset >= this.frameBytes) {
      // slice, а не subarray: subarray отдал бы окно в буфер, который перезапишется следующим же
      // пакетом, и кадр молча изменился бы уже после выдачи.
      frames.push(this.buffer.slice(offset, offset + this.frameBytes))
      offset += this.frameBytes
    }
    if (offset > 0) {
      this.buffer.copyWithin(0, offset, this.length)
      this.length -= offset
    }
    return frames
  }

  /** Сбросить остаток. Вызывается на завершении звонка, чтобы хвост не уехал в следующий. */
  reset(): void { this.length = 0 }
}

/** Длительность потока μ-law в миллисекундах. Одно место на весь модуль, чтобы не делить руками. */
export function durationMs(byteLength: number, sampleRate = TELEPHONY_SAMPLE_RATE): number {
  return (byteLength / sampleRate) * 1000
}

/**
 * Среднеквадратичная громкость кадра, нормированная к единице.
 *
 * Именно RMS, а не пиковое значение: один щелчок в кадре даёт пик под потолок, но не означает речи.
 * RMS отражает энергию всего кадра, и порог по нему держится на реальных линиях.
 */
export function frameRms(samples: Int16Array): number {
  if (samples.length === 0) return 0
  let sum = 0
  for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i]
  return Math.sqrt(sum / samples.length) / 32_768
}

/**
 * Частота переходов через ноль, доля от числа отсчётов.
 *
 * Отличает речь от гула. Ровный низкочастотный шум (двигатель, кондиционер) даёт высокую энергию и
 * НИЗКУЮ частоту переходов; шипение и щелчки — наоборот, низкую энергию и очень высокую. Речь лежит
 * между, и по одной энергии эти случаи не разделить.
 */
export function zeroCrossingRate(samples: Int16Array): number {
  if (samples.length < 2) return 0
  let crossings = 0
  for (let i = 1; i < samples.length; i++) {
    if ((samples[i - 1] < 0) !== (samples[i] < 0)) crossings++
  }
  return crossings / (samples.length - 1)
}
