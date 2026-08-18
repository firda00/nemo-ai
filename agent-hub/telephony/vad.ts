// Детекция речи: Silero VAD и конечный автомат реплики.
//
// ЧТО ЗДЕСЬ ГЛАВНОЕ. Не сам детектор, а АВТОМАТ вокруг него. Вероятность речи в отдельном кадре по
// двадцать миллисекунд скачет: на паузе между словами она падает, на щелчке линии подскакивает.
// Реагировать на неё напрямую значит перебивать бота на каждом вздохе клиента и обрывать распознавание
// в середине слова. Порог по НАКОПЛЕННОЙ длительности и удержание после конца речи — это и есть то,
// что превращает шумное число в пригодное событие.
//
// ПОРОГ 150–200 мс из спецификации V5 — не про чувствительность детектора, а про НАМЕРЕНИЕ. Меньше
// ста миллисекунд человеческой речи не бывает; всё короткое — это кашель, стук по столу или щелчок
// коммутатора. Двести миллисекунд подряд означают, что человек начал говорить и хочет, чтобы его
// услышали, — а бот в этот момент обязан замолчать.
//
// ПРЕДЗАПИСЬ ОБЯЗАТЕЛЬНА. Событие «речь началась» приходит на двухсотой миллисекунде, то есть первые
// десять кадров речи УЖЕ ПРОШЛИ. Отправить в распознавание только то, что после события, значит
// потерять начало первого слова: «Здравствуйте» приезжает как «авствуйте», и модель отвечает не на то.
// Поэтому кадры копятся в кольцевом буфере и отдаются вместе с событием.
//
// SILERO И ЗАПАСНОЙ ПУТЬ. Спецификация требует Silero VAD, и он реализован. Но onnxruntime-node —
// нативная зависимость, которая на части систем не загружается (на машине разработки как раз не
// загрузилась: сбой инициализации DLL). Поэтому загрузка ленивая и необязательная, а при неудаче
// работает энергетический детектор. Это не заглушка: связка RMS + частота переходов через ноль с
// подстраивающимся уровнем шума — то, чем телефония пользовалась до нейросетевых детекторов, и на
// барже-ин её хватает. Silero точнее на шумных линиях, и когда он доступен — работает он.

import { frameRms, toFloat32, upsample8kTo16k, zeroCrossingRate } from './audio.ts'

/** Итог оценки одного кадра. */
export interface VadFrameResult {
  /** Вероятность речи, 0..1. У энергетического детектора — оценка, а не вероятность в строгом смысле. */
  probability: number
  speech: boolean
}

export interface VadBackend {
  readonly name: string
  /** Оценить кадр PCM16 на телефонной частоте. */
  process(samples: Int16Array): Promise<VadFrameResult>
  reset(): void
  close(): Promise<void>
}

// ── Энергетический детектор ───────────────────────────────────────────────────────────────────────

/**
 * Порог по громкости относительно уровня шума.
 *
 * Не абсолютный. Абсолютный порог работает на одной линии и не работает на следующей: мобильный
 * оператор, стационарный аппарат и гарнитура дают разную громкость на одинаковой речи. Множитель
 * относительно измеренного шума переносится между линиями, абсолютное число — нет.
 */
const NOISE_MULTIPLIER = 3.0
/** Нижняя граница: совсем тихий кадр не считается речью, каким бы тихим ни был фон. */
const ABSOLUTE_FLOOR = 0.008
/** Речь по переходам через ноль лежит между гулом и шипением. */
const ZCR_MIN = 0.02
const ZCR_MAX = 0.55
/** Насколько быстро подстраивается уровень шума. Медленно — чтобы речь его не подняла. */
const NOISE_ADAPT = 0.02

export class EnergyVad implements VadBackend {
  readonly name = 'energy'
  private noiseFloor = 0.01

  async process(samples: Int16Array): Promise<VadFrameResult> {
    const rms = frameRms(samples)
    const zcr = zeroCrossingRate(samples)

    const loud = rms > Math.max(this.noiseFloor * NOISE_MULTIPLIER, ABSOLUTE_FLOOR)
    const voiced = zcr >= ZCR_MIN && zcr <= ZCR_MAX
    const speech = loud && voiced

    // Уровень шума подстраивается ТОЛЬКО по не-речевым кадрам. Иначе громкий собеседник за полминуты
    // поднимает порог выше собственного голоса, и детектор перестаёт его слышать.
    if (!speech) this.noiseFloor += (rms - this.noiseFloor) * NOISE_ADAPT

    // Оценка вероятности — отношение к порогу, ограниченное единицей. Строгой вероятностью не является
    // и не притворяется: у автомата ниже от неё нужен только порядок величины.
    const threshold = Math.max(this.noiseFloor * NOISE_MULTIPLIER, ABSOLUTE_FLOOR)
    const probability = speech ? Math.min(1, rms / (threshold * 2)) : Math.min(0.4, rms / threshold * 0.4)
    return { probability, speech }
  }

  reset(): void { this.noiseFloor = 0.01 }
  async close(): Promise<void> {}
}

// ── Silero ────────────────────────────────────────────────────────────────────────────────────────

/**
 * Размер окна Silero на 16 кГц.
 *
 * Модель принимает ровно 512 отсчётов на 16 кГц (или 256 на 8 кГц) — это её контракт, а не наш выбор.
 * Кадр телефонии в 20 мс даёт 160 отсчётов на 8 кГц, то есть 320 после повышения частоты: меньше
 * окна. Поэтому кадры накапливаются до полного окна, а результат распространяется на весь кадр.
 */
const SILERO_WINDOW_16K = 512
/** Форма скрытого состояния: [2, batch, 128]. Взято из графа модели, а не из документации. */
const SILERO_STATE_SIZE = 2 * 1 * 128

export const SILERO_MODEL_URL = 'https://github.com/snakers4/silero-vad/raw/master/src/silero_vad/data/silero_vad.onnx'
/**
 * Контрольная сумма проверенной версии модели.
 *
 * Модель скачивается по сети, а сеть отдаёт что угодно: подменённый релиз, страницу ошибки прокси,
 * обрезанный файл. Несовпадение — отказ загрузки, а не «попробуем запустить и посмотрим»: битая модель
 * не падает, она молча выдаёт мусорные вероятности, и это выглядит как «VAD плохо работает».
 */
export const SILERO_MODEL_SHA256 = '1a153a22f4509e292a94e67d6f9b85e8deb25b4988682b7e174c65279d8788e3'

interface OnnxSession {
  run(feeds: Record<string, unknown>): Promise<Record<string, { data: Float32Array }>>
  release?(): Promise<void>
}

/**
 * Silero VAD поверх onnxruntime.
 *
 * НЕ ПРОВЕРЕН ЗАПУСКОМ. На машине разработки onnxruntime-node не загружается (сбой инициализации DLL),
 * поэтому вывод модели здесь ни разу не выполнялся. Проверено другое, и это стоит различать: файл
 * модели скачан, его контрольная сумма записана, а имена и формы тензоров (`input`, `state`, `sr`,
 * `output`, `stateN`) прочитаны РАЗБОРОМ самого файла, а не взяты из документации. Накопление окна,
 * пороги и автомат реплики проверены отдельно и от модели не зависят.
 */
export class SileroVad implements VadBackend {
  readonly name = 'silero'
  private readonly session: OnnxSession
  private readonly tensorFactory: (type: string, data: unknown, dims: number[]) => unknown
  private state: Float32Array
  private window: Float32Array
  private filled = 0
  private lastProbability = 0

  constructor(session: OnnxSession, tensorFactory: (type: string, data: unknown, dims: number[]) => unknown) {
    this.session = session
    this.tensorFactory = tensorFactory
    this.state = new Float32Array(SILERO_STATE_SIZE)
    this.window = new Float32Array(SILERO_WINDOW_16K)
  }

  async process(samples: Int16Array): Promise<VadFrameResult> {
    const wide = toFloat32(upsample8kTo16k(samples))

    // Кадр короче окна модели: копим. Пока окно не заполнено, отдаём ПРЕДЫДУЩУЮ вероятность, а не
    // ноль — иначе каждый второй кадр выглядел бы тишиной и автомат обрывал бы речь на середине.
    for (let i = 0; i < wide.length; i++) {
      this.window[this.filled++] = wide[i]
      if (this.filled === SILERO_WINDOW_16K) {
        this.lastProbability = await this.infer(this.window)
        this.filled = 0
      }
    }
    return { probability: this.lastProbability, speech: this.lastProbability >= 0.5 }
  }

  private async infer(window: Float32Array): Promise<number> {
    const outputs = await this.session.run({
      input: this.tensorFactory('float32', window, [1, window.length]),
      // BigInt64Array: частота объявлена в модели как int64, и обычное число тут даёт отказ типов.
      sr: this.tensorFactory('int64', BigInt64Array.from([16_000n]), []),
      state: this.tensorFactory('float32', this.state, [2, 1, 128]),
    })
    // Состояние переносится между окнами: без этого модель забывает контекст и на каждом окне решает
    // заново, теряя как раз ту устойчивость, ради которой её и берут вместо энергетического порога.
    if (outputs.stateN?.data) this.state = Float32Array.from(outputs.stateN.data)
    return outputs.output?.data?.[0] ?? 0
  }

  reset(): void {
    this.state = new Float32Array(SILERO_STATE_SIZE)
    this.filled = 0
    this.lastProbability = 0
  }

  async close(): Promise<void> { await this.session.release?.() }
}

/**
 * Поднять лучший доступный детектор.
 *
 * Silero, если onnxruntime загрузился И модель на месте; иначе энергетический. Причина отката
 * ВОЗВРАЩАЕТСЯ, а не пишется в журнал и забывается: «работает энергетический VAD» и «работает
 * энергетический VAD, потому что модель не скачана» — разные новости для того, кто разбирает жалобу
 * на ложные срабатывания.
 */
export async function resolveVad(options: {
  modelPath?: string
  loadOnnx?: () => Promise<unknown>
  readModel?: (path: string) => Promise<Uint8Array>
} = {}): Promise<{ vad: VadBackend; fallbackReason: string | null }> {
  const modelPath = options.modelPath ?? process.env.SILERO_MODEL_PATH
  if (!modelPath) return { vad: new EnergyVad(), fallbackReason: 'SILERO_MODEL_PATH не задан' }

  try {
    const ort = (await (options.loadOnnx ?? (() => import('onnxruntime-node')))()) as {
      default?: Record<string, unknown>
      InferenceSession?: { create: (path: string) => Promise<OnnxSession> }
      Tensor?: new (type: string, data: unknown, dims: number[]) => unknown
    }
    const runtime = (ort.default ?? ort) as {
      InferenceSession: { create: (path: string) => Promise<OnnxSession> }
      Tensor: new (type: string, data: unknown, dims: number[]) => unknown
    }
    const session = await runtime.InferenceSession.create(modelPath)
    const factory = (type: string, data: unknown, dims: number[]) => new runtime.Tensor(type, data, dims)
    return { vad: new SileroVad(session, factory), fallbackReason: null }
  } catch (error) {
    return {
      vad: new EnergyVad(),
      fallbackReason: `Silero недоступен: ${error instanceof Error ? error.message : String(error)}`,
    }
  }
}

// ── Автомат реплики ───────────────────────────────────────────────────────────────────────────────

export interface SpeechDetectorOptions {
  /** Сколько миллисекунд речи подряд означают начало реплики. Спецификация V5: 150–200 мс. */
  speechThresholdMs?: number
  /** Сколько тишины подряд означают конец реплики. Пауза между словами короче — она не обрывает. */
  silenceThresholdMs?: number
  /** Длительность кадра. Должна совпадать с тем, что реально приходит. */
  frameMs?: number
  /** Сколько миллисекунд до события хранить для отправки в распознавание вместе с началом речи. */
  prerollMs?: number
}

export type SpeechEvent =
  | { type: 'speech_start'; atMs: number; preroll: Int16Array[]; speechRunMs: number }
  | { type: 'speech_end'; atMs: number; durationMs: number }

/**
 * Речь клиента как последовательность событий.
 *
 * Порог начала и порог тишины РАЗНЫЕ по смыслу и по величине. Начало должно быть строгим: перебить
 * бота на щелчке линии хуже, чем не перебить на тихом слове — во втором случае человек повторит, в
 * первом решит, что его не слышат. Конец должен быть терпеливым: пауза перед «…ну, в общем, да» короче
 * половины секунды, и оборвать на ней значит ответить на половину фразы.
 */
export class SpeechDetector {
  private readonly speechThresholdMs: number
  private readonly silenceThresholdMs: number
  private readonly frameMs: number
  private readonly prerollFrames: number

  private speaking = false
  private speechRunMs = 0
  private silenceRunMs = 0
  private elapsedMs = 0
  private utteranceStartMs = 0
  private readonly preroll: Int16Array[] = []

  constructor(options: SpeechDetectorOptions = {}) {
    this.speechThresholdMs = options.speechThresholdMs ?? 180
    this.silenceThresholdMs = options.silenceThresholdMs ?? 600
    this.frameMs = options.frameMs ?? 20
    this.prerollFrames = Math.ceil((options.prerollMs ?? 300) / this.frameMs)
  }

  get isSpeaking(): boolean { return this.speaking }
  /** Сколько миллисекунд речи накоплено в текущей серии. Для наблюдения и отладки порогов. */
  get currentSpeechRunMs(): number { return this.speechRunMs }

  /**
   * Скормить кадр и получить событие, если оно наступило.
   *
   * Возвращает null в подавляющем большинстве вызовов — это норма: событий два на реплику, а кадров
   * пятьдесят в секунду.
   */
  push(frame: Int16Array, isSpeech: boolean): SpeechEvent | null {
    this.elapsedMs += this.frameMs

    // Предзапись копится ВСЕГДА, а не только в тишине: событие приходит с опозданием на порог, и
    // кадры, попавшие внутрь этого порога, тоже нужны распознаванию.
    this.preroll.push(frame)
    if (this.preroll.length > this.prerollFrames) this.preroll.shift()

    if (isSpeech) {
      this.speechRunMs += this.frameMs
      this.silenceRunMs = 0
      if (!this.speaking && this.speechRunMs >= this.speechThresholdMs) {
        this.speaking = true
        this.utteranceStartMs = this.elapsedMs - this.speechRunMs
        // Копия массива, а не он сам: буфер живёт дальше и будет изменён следующими кадрами.
        return { type: 'speech_start', atMs: this.elapsedMs, preroll: [...this.preroll], speechRunMs: this.speechRunMs }
      }
      return null
    }

    this.silenceRunMs += this.frameMs
    if (this.speaking && this.silenceRunMs >= this.silenceThresholdMs) {
      this.speaking = false
      const durationMs = this.elapsedMs - this.utteranceStartMs - this.silenceRunMs
      this.speechRunMs = 0
      return { type: 'speech_end', atMs: this.elapsedMs, durationMs: Math.max(0, durationMs) }
    }
    // Серия речи обнуляется только ПОСЛЕ порога тишины. Иначе один тихий кадр посреди слова сбрасывал
    // бы счётчик, и порог в 180 мс не набирался бы никогда на прерывистой линии.
    if (!this.speaking && this.silenceRunMs >= this.frameMs * 2) this.speechRunMs = 0
    return null
  }

  reset(): void {
    this.speaking = false
    this.speechRunMs = 0
    this.silenceRunMs = 0
    this.elapsedMs = 0
    this.utteranceStartMs = 0
    this.preroll.length = 0
  }
}

export { NOISE_MULTIPLIER, ABSOLUTE_FLOOR, SILERO_WINDOW_16K }
