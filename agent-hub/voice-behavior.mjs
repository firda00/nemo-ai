// Голосовой тракт: кодек, детекция речи, barge-in, диалог, пост-звонковый разбор.
//
// ЧТО ЗДЕСЬ ЗАЩИЩАЕТСЯ В ПЕРВУЮ ОЧЕРЕДЬ — ТРИ ВЕЩИ, каждую из которых нельзя увидеть иначе как
// симуляцией реального времени, и каждая из которых уже была сломана в этом коде:
//
//   1. Кодек G.711. Ошибка в сегментной шкале даёт не «чуть хуже звук», а треск, который распознавание
//      принимает за согласные. Первая реализация пропустила сдвиг к 14 битам: тишина кодировалась как
//      0xE7 вместо 0xFF, отношение сигнал/шум вышло 5.9 дБ вместо 40, монотонность сломалась.
//
//   2. Barge-in. Он ломается ДВУМЯ независимыми способами, и оба были в коде. Первый: синтез
//      ожидался целиком, поэтому входящее аудио не разбиралось, пока бот говорил, — перебить его было
//      физически нечем. Второй: мгновенный провал очереди читался как конец реплики, состояние
//      уходило в «слушаю», и прерывать становилось нечего, хотя бот на слух ещё звучал.
//
//   3. Границы слов в правилах итога. \b в JavaScript определён на ASCII, и с кириллицей не работает:
//      из одиннадцати разговорных фраз срабатывали ровно две — обе узбекские, латиницей. Весь русский
//      набор молча возвращал «итог не определён» на любом отказе.
//
// ВРЕМЯ УПРАВЛЯЕМОЕ. Сессия принимает часы параметром, и проверки порогов не зависят от загрузки
// машины: иначе набор занимал бы минуты и плавал бы на чужом компьютере.

import assert from 'node:assert/strict'
import {
  BYTES_PER_FRAME, FrameAssembler, SAMPLES_PER_FRAME, downsample16kTo8k, durationMs, frameRms,
  muLawDecode, muLawDecodeSample, muLawEncode, muLawEncodeSample, toFloat32, upsample8kTo16k,
  zeroCrossingRate,
} from './telephony/audio.ts'
import { EnergyVad, SpeechDetector, SILERO_MODEL_SHA256, resolveVad } from './telephony/vad.ts'
import { CallSession, MAX_LOOKAHEAD_FRAMES } from './telephony/session.ts'
import {
  DialogueState, buildClosing, buildGreeting, buildSystemPrompt, detectOutcome, outcomeToCardOutcome,
  shouldHangUp,
} from './telephony/dialogue.ts'
import { SpeechChunker } from './telephony/providers.ts'
import {
  analyticsToLeadCard, analyzeCall, fallbackAnalytics, formatTranscript, persistCall, stripCodeFence,
} from './telephony/analytics.ts'
import { parseControl } from './telephony/voice-worker.ts'
import { CallAnalyticsSchema, LeadCardNotificationSchema } from './contracts/v5.ts'

let checks = 0
const check = (fn) => { fn(); checks++ }
const checkAsync = async (fn) => { await fn(); checks++ }

// ─── Кодек G.711 ──────────────────────────────────────────────────────────────────────────────────

// Эталонные значения стандарта. Тишина ОБЯЗАНА кодироваться в 0xFF: это делает оборванную в ноль линию
// слышимой как треск, а не как тишина, и обрыв замечают сразу.
check(() => assert.equal(muLawEncodeSample(0), 0xff))
check(() => assert.equal(muLawEncodeSample(32_767), 0x80))
check(() => assert.equal(muLawEncodeSample(-32_768), 0x00))
check(() => assert.equal(muLawDecodeSample(0xff), 0))
check(() => assert.equal(muLawDecodeSample(0x00), -32_124))
check(() => assert.equal(muLawDecodeSample(0x80), 32_124))

/*
 * Устойчивость: декодированное и снова закодированное значение обязано совпасть с исходным байтом.
 *
 * 255 из 256, а не все: 0x7F и 0xFF декодируются в один и тот же ноль — у μ-law два представления
 * нуля, и стандарт схлопывает их в положительное. Это не дефект, а свойство шкалы.
 */
check(() => {
  let stable = 0
  for (let byte = 0; byte < 256; byte++) if (muLawEncodeSample(muLawDecodeSample(byte)) === byte) stable++
  assert.equal(stable, 255, 'нестабильных значений должно быть ровно одно — второе представление нуля')
})
check(() => assert.equal(muLawEncodeSample(muLawDecodeSample(0x7f)), 0xff, 'отрицательный ноль схлопывается в положительный'))

// Отношение сигнал/шум на настоящем сигнале. У G.711 около 38 дБ; всё, что заметно ниже, означает
// ошибку в шкале, а не «допустимую потерю качества».
check(() => {
  let sumSq = 0
  const amplitude = 20_000
  for (let i = 0; i < 8_000; i++) {
    const sample = Math.round(amplitude * Math.sin((2 * Math.PI * 440 * i) / 8_000))
    const back = muLawDecodeSample(muLawEncodeSample(sample))
    sumSq += (back - sample) ** 2
  }
  const snr = 20 * Math.log10(amplitude / Math.sqrt(sumSq / 8_000))
  assert.ok(snr > 35, `отношение сигнал/шум ${snr.toFixed(1)} дБ — ниже, чем даёт исправный G.711`)
})

// Монотонность: больший вход не может дать меньший выход. Её нарушение слышно как хрип.
check(() => {
  let previous = muLawDecodeSample(muLawEncodeSample(-32_000))
  for (let sample = -32_000; sample < 32_000; sample += 37) {
    const value = muLawDecodeSample(muLawEncodeSample(sample))
    assert.ok(value >= previous - 1, `монотонность нарушена на ${sample}`)
    previous = value
  }
})

check(() => {
  const samples = Int16Array.from([0, 1000, -1000, 30_000, -30_000])
  const roundTrip = muLawDecode(muLawEncode(samples))
  assert.equal(roundTrip.length, samples.length)
  for (let i = 0; i < samples.length; i++) {
    assert.ok(Math.abs(roundTrip[i] - samples[i]) < Math.max(200, Math.abs(samples[i]) * 0.1))
  }
})

// Кадр 20 мс на 8 кГц — ровно 160 байт. Другая длина означает рассинхронизацию с RTP.
check(() => assert.equal(SAMPLES_PER_FRAME, 160))
check(() => assert.equal(BYTES_PER_FRAME, 160))
check(() => assert.equal(durationMs(160), 20))
check(() => assert.equal(durationMs(8_000), 1_000))

// ─── Сборка кадров ────────────────────────────────────────────────────────────────────────────────
//
// WebSocket не обязан доставлять пакет ровно кадром: TCP и прокси склеивают и делят. Детектор,
// получающий то 90, то 230 байт, считает энергию по кускам разной длины — и порог в миллисекундах
// перестаёт что-либо значить.

check(() => {
  const assembler = new FrameAssembler(160)
  assert.deepEqual(assembler.push(new Uint8Array(90)), [], 'меньше кадра — ничего не отдаём')
  assert.equal(assembler.pending, 90)
  const frames = assembler.push(new Uint8Array(230))
  assert.equal(frames.length, 2, '90 + 230 = 320 = ровно два кадра')
  assert.equal(assembler.pending, 0)
})

// Остаток НЕ выбрасывается: выброшенные полкадра — это щелчок в записи и потерянный слог.
check(() => {
  const assembler = new FrameAssembler(160)
  assembler.push(new Uint8Array(250))
  assert.equal(assembler.pending, 90)
  assert.equal(assembler.push(new Uint8Array(70)).length, 1)
})

// Выданный кадр не должен меняться от следующего пакета: копия, а не окно в общий буфер.
check(() => {
  const assembler = new FrameAssembler(4)
  const first = assembler.push(Uint8Array.from([1, 2, 3, 4]))[0]
  assembler.push(Uint8Array.from([9, 9, 9, 9]))
  assert.deepEqual([...first], [1, 2, 3, 4], 'ранее выданный кадр изменился — это окно, а не копия')
})

check(() => assert.throws(() => new FrameAssembler(0), /положительным/))

// ─── Признаки речи ────────────────────────────────────────────────────────────────────────────────

check(() => assert.equal(frameRms(new Int16Array(160)), 0))
check(() => assert.ok(frameRms(Int16Array.from({ length: 160 }, () => 16_000)) > 0.4))
// Пиковое значение обмануло бы: один щелчок в кадре даёт пик под потолок, но не речь.
check(() => {
  const oneClick = new Int16Array(160)
  oneClick[80] = 32_000
  assert.ok(frameRms(oneClick) < 0.09, 'одиночный щелчок не должен читаться как громкий кадр')
})
check(() => assert.equal(zeroCrossingRate(Int16Array.from([1, 1, 1, 1])), 0))
check(() => assert.equal(zeroCrossingRate(Int16Array.from([1, -1, 1, -1])), 1))

check(() => {
  const wide = upsample8kTo16k(Int16Array.from([0, 1000]))
  assert.equal(wide.length, 4)
  assert.equal(wide[0], 0)
  assert.equal(wide[1], 500, 'интерполяция, а не повтор: повтор даёт зеркальные частоты выше 4 кГц')
})
check(() => assert.deepEqual([...downsample16kTo8k(Int16Array.from([0, 1000, 2000, 3000]))], [500, 2500]))
check(() => assert.equal(toFloat32(Int16Array.from([-32_768, 0, 16_384]))[2], 0.5))

// ─── Автомат реплики ──────────────────────────────────────────────────────────────────────────────

const speechFrames = (count) => Array.from({ length: count }, () => true)
const feed = (detector, flags) => {
  const events = []
  for (const isSpeech of flags) {
    const event = detector.push(new Int16Array(SAMPLES_PER_FRAME), isSpeech)
    if (event) events.push(event)
  }
  return events
}

// Порог 180 мс = 9 кадров по 20 мс. Восемь не должны давать события, девять — должны.
check(() => {
  const events = feed(new SpeechDetector({ speechThresholdMs: 180 }), speechFrames(8))
  assert.equal(events.length, 0, 'кашель короче порога не должен перебивать бота')
})
check(() => {
  const events = feed(new SpeechDetector({ speechThresholdMs: 180 }), speechFrames(9))
  assert.equal(events.length, 1)
  assert.equal(events[0].type, 'speech_start')
})
check(() => assert.equal(feed(new SpeechDetector({ speechThresholdMs: 200 }), speechFrames(9)).length, 0))
check(() => assert.equal(feed(new SpeechDetector({ speechThresholdMs: 200 }), speechFrames(10)).length, 1))

/*
 * Предзапись обязательна.
 *
 * Событие приходит на 180-й миллисекунде — то есть девять кадров речи УЖЕ прошли. Отправить в
 * распознавание только то, что после события, значит потерять начало первого слова: «Здравствуйте»
 * приезжает как «авствуйте», и модель отвечает не на то.
 */
check(() => {
  const events = feed(new SpeechDetector({ speechThresholdMs: 180, prerollMs: 300 }), speechFrames(9))
  assert.ok(events[0].preroll.length >= 9, `в предзаписи ${events[0].preroll.length} кадров — начало реплики потеряно`)
})
check(() => {
  const detector = new SpeechDetector({ speechThresholdMs: 180, prerollMs: 300 })
  const events = feed(detector, speechFrames(9))
  const capturedLength = events[0].preroll.length
  // Копия, а не ссылка: кольцевой буфер живёт дальше и будет перезаписан следующими кадрами, а
  // распознавание получит уже не ту реплику, которую услышал детектор.
  feed(detector, speechFrames(30))
  assert.equal(events[0].preroll.length, capturedLength, 'предзапись изменилась задним числом')
})

check(() => {
  const detector = new SpeechDetector({ prerollMs: 100 })
  const events = feed(detector, [...Array(50).fill(false), ...speechFrames(9)])
  assert.ok(events[0].preroll.length <= 5, 'предзапись ограничена: иначе она растёт весь звонок')
})

// Событие несёт накопленную длительность речи — по ней измеряется наложение голосов. Первая версия
// сессии считала его вычитанием now() из now() и получала ноль при любом пороге.
check(() => {
  const events = feed(new SpeechDetector({ speechThresholdMs: 180 }), speechFrames(9))
  assert.equal(events[0].speechRunMs, 180)
})

// Пауза между словами НЕ обрывает реплику: «…ну, в общем, да» короче полусекунды.
check(() => {
  const detector = new SpeechDetector({ speechThresholdMs: 180, silenceThresholdMs: 600 })
  const events = feed(detector, [
    ...speechFrames(12), ...Array(10).fill(false), ...speechFrames(12), ...Array(35).fill(false),
  ])
  assert.equal(events.length, 2, 'пауза 200 мс внутри фразы не должна давать вторую реплику')
  assert.equal(events[0].type, 'speech_start')
  assert.equal(events[1].type, 'speech_end')
})

check(() => {
  const detector = new SpeechDetector({ speechThresholdMs: 180, silenceThresholdMs: 400 })
  const events = feed(detector, [...speechFrames(50), ...Array(25).fill(false)])
  const end = events.find((one) => one.type === 'speech_end')
  assert.equal(end.durationMs, 1_000, 'длительность реплики считается без хвоста тишины')
})

check(() => {
  const detector = new SpeechDetector()
  feed(detector, speechFrames(20))
  assert.equal(detector.isSpeaking, true)
  detector.reset()
  assert.equal(detector.isSpeaking, false)
  assert.equal(detector.currentSpeechRunMs, 0)
})

// ─── Энергетический детектор ──────────────────────────────────────────────────────────────────────

const pcmFrame = (fn) => Int16Array.from({ length: SAMPLES_PER_FRAME }, (_, i) => fn(i))
const noiseFrame = () => pcmFrame(() => Math.round((Math.random() - 0.5) * 60))
const voiceFrame = (t) => pcmFrame((i) => Math.round(
  9_000 * Math.sin((2 * Math.PI * 220 * (t * 160 + i)) / 8_000) * (0.6 + 0.4 * Math.sin((2 * Math.PI * 4 * (t * 160 + i)) / 8_000)),
))
const rumbleFrame = () => pcmFrame((i) => Math.round(7_000 * Math.sin((2 * Math.PI * 50 * i) / 8_000)))

const warmUp = async (vad, frames = 30) => { for (let i = 0; i < frames; i++) await vad.process(noiseFrame()) }

await checkAsync(async () => {
  const vad = new EnergyVad()
  await warmUp(vad)
  assert.equal((await vad.process(voiceFrame(0))).speech, true)
})
await checkAsync(async () => {
  const vad = new EnergyVad()
  await warmUp(vad)
  assert.equal((await vad.process(noiseFrame())).speech, false)
})

// Гул двигателя ГРОМКИЙ, но не речь: у него низкая частота переходов через ноль. По одной энергии эти
// случаи не разделить, и машина на трассе перебивала бы бота непрерывно.
await checkAsync(async () => {
  const vad = new EnergyVad()
  await warmUp(vad)
  assert.equal((await vad.process(rumbleFrame())).speech, false, 'низкочастотный гул не должен читаться как речь')
})

// Уровень шума подстраивается ТОЛЬКО по не-речевым кадрам: иначе громкий собеседник за полминуты
// поднимает порог выше собственного голоса.
await checkAsync(async () => {
  const vad = new EnergyVad()
  await warmUp(vad)
  for (let t = 0; t < 60; t++) await vad.process(voiceFrame(t))
  assert.equal((await vad.process(voiceFrame(61))).speech, true, 'детектор оглох на длинной речи')
})

check(() => assert.match(SILERO_MODEL_SHA256, /^[0-9a-f]{64}$/))

// Silero недоступен — работает энергетический, и ПРИЧИНА называется. «Работает энергетический» и
// «работает энергетический, потому что модель не скачана» — разные новости для того, кто разбирает
// жалобу на ложные срабатывания.
await checkAsync(async () => {
  const { vad, fallbackReason } = await resolveVad({ modelPath: undefined })
  assert.equal(vad.name, 'energy')
  assert.match(fallbackReason, /SILERO_MODEL_PATH/)
})
await checkAsync(async () => {
  const { vad, fallbackReason } = await resolveVad({
    modelPath: '/models/silero.onnx',
    loadOnnx: async () => { throw new Error('DLL initialization routine failed') },
  })
  assert.equal(vad.name, 'energy')
  assert.match(fallbackReason, /DLL/)
})

// ─── Сессия и barge-in ────────────────────────────────────────────────────────────────────────────

function makeSession(options = {}) {
  let clock = 0
  const sent = []
  const events = []
  const spoken = []
  let chunksAfterAbort = 0

  const session = new CallSession({
    callId: 'call-1',
    vad: new EnergyVad(),
    detector: new SpeechDetector({ speechThresholdMs: 180, silenceThresholdMs: 400 }),
    now: () => clock,
    callbacks: {
      sendAudio: (frame) => sent.push(frame),
      onEvent: (event) => events.push(event),
      respond: options.respond ?? (async () => 'Понял вас.'),
      speak: options.speak ?? (async function* (text, turn, signal) {
        spoken.push(text)
        for (let i = 0; i < 40; i++) {
          if (signal.aborted) chunksAfterAbort++
          yield new Uint8Array(BYTES_PER_FRAME).fill(0x7f)
          await new Promise((resolve) => setTimeout(resolve, 2))
        }
      }),
    },
  })

  return {
    session, sent, events, spoken,
    chunksAfterAbort: () => chunksAfterAbort,
    advance: (ms) => { clock += ms },
    async pump(frameFactory, count) {
      for (let t = 0; t < count; t++) {
        clock += 20
        session.tick()
        session.onFramePlayed()
        await session.onAudio(muLawEncode(frameFactory(t)))
      }
    },
  }
}

// Инициативный старт: бот здоровается сразу после ANSWER. Тишина в начале звонка читается как обрыв.
await checkAsync(async () => {
  const harness = makeSession()
  harness.session.onAnswer('Здравствуйте, это Nemo.')
  await new Promise((resolve) => setTimeout(resolve, 30))
  assert.equal(harness.session.currentState, 'speaking')
  assert.deepEqual(harness.spoken, ['Здравствуйте, это Nemo.'])
})

// onAnswer НЕ возвращает обещание. Если бы возвращал, вызывающий естественно написал бы await — и
// входящее аудио не разбиралось бы, пока идёт синтез приветствия, то есть перебить бота было бы нечем.
await checkAsync(async () => {
  const harness = makeSession()
  const returned = harness.session.onAnswer('Здравствуйте.')
  assert.equal(returned, undefined, 'onAnswer стал ожидаемым — приветствие заблокирует приём аудио')
  await new Promise((resolve) => setTimeout(resolve, 20))
})

/*
 * ГЛАВНАЯ ПРОВЕРКА ФАЙЛА: перебивание во время речи бота.
 *
 * Ломается двумя независимыми способами, и оба были в коде. Первый: приветствие ожидалось целиком, и
 * входящее аудио не разбиралось, пока бот говорил. Второй: провал очереди читался как конец реплики,
 * состояние уходило в «слушаю», и прерывать было нечего.
 */
await checkAsync(async () => {
  const harness = makeSession()
  harness.session.onAnswer('Длинное приветствие, которое клиент перебьёт.')
  await new Promise((resolve) => setTimeout(resolve, 30))

  await harness.pump(noiseFrame, 10)
  assert.equal(harness.session.currentState, 'speaking', 'провал очереди не должен считаться концом реплики')

  await harness.pump(voiceFrame, 12)
  const barge = harness.events.find((one) => one.type === 'barge_in')
  assert.ok(barge, 'перебивание не сработало')
  assert.equal(barge.afterMs, 180, 'наложение голосов равно порогу детекции')
  assert.equal(harness.session.queuedFrames, 0, 'очередь обязана быть выброшена целиком')
  assert.equal(harness.session.currentState, 'listening')
})

/*
 * Порции синтеза, пришедшие ПОСЛЕ прерывания, выбрасываются по номеру реплики.
 *
 * Флага «бот не говорит» недостаточно: синтез уже работал и остановиться мгновенно не может, поэтому
 * его порции продолжают приходить секунду-другую. Без номера реплики они начали бы новую речь поверх
 * нового ответа.
 */
await checkAsync(async () => {
  const harness = makeSession()
  harness.session.onAnswer('Реплика, которую прервут на середине.')
  await new Promise((resolve) => setTimeout(resolve, 20))
  await harness.pump(noiseFrame, 5)
  await harness.pump(voiceFrame, 12)
  await new Promise((resolve) => setTimeout(resolve, 200))

  assert.ok(harness.chunksAfterAbort() > 0, 'симуляция не воспроизвела гонку — проверка ничего не проверяет')
  const dropped = harness.events.filter((one) => one.type === 'dropped_stale_chunk')
  assert.ok(dropped.length > 0, 'устаревшие порции синтеза не выбрасываются')
  assert.equal(harness.session.queuedFrames, 0, 'устаревшие порции попали в очередь')
})

// Опережение ограничено. Отправленное уже НЕ наше: оно в буфере коммутатора и будет проиграно, что бы
// мы дальше ни решили. Без предела прерывание становится невозможным.
await checkAsync(async () => {
  const harness = makeSession()
  harness.session.onAnswer('Реплика.')
  await new Promise((resolve) => setTimeout(resolve, 30))
  await new Promise((resolve) => setTimeout(resolve, 120))
  assert.ok(harness.session.queuedFrames > 10, 'очередь не заполнилась — проверять опережение не на чем')
  let sentInRow = 0
  for (let i = 0; i < 20; i++) if (harness.session.tick()) sentInRow++
  assert.equal(sentInRow, MAX_LOOKAHEAD_FRAMES, `отправлено ${sentInRow} кадров подряд без подтверждения`)
})

check(() => assert.ok(MAX_LOOKAHEAD_FRAMES >= 2 && MAX_LOOKAHEAD_FRAMES <= 10))

// Завершение звонка отменяет всё незавершённое.
await checkAsync(async () => {
  const harness = makeSession()
  harness.session.onAnswer('Реплика.')
  await new Promise((resolve) => setTimeout(resolve, 20))
  harness.session.end()
  assert.equal(harness.session.currentState, 'ended')
  assert.equal(harness.session.queuedFrames, 0)
  assert.equal(harness.session.tick(), false, 'завершённая сессия не должна ничего отправлять')
})

/*
 * Распознавание обязано получить ПРЕДЗАПИСЬ, а не только кадры после события.
 *
 * Порог 28 подобран ИЗМЕРЕНИЕМ, а не рассуждением: при 12 кадрах речи и 25 кадрах тишины путь с
 * предзаписью даёт 31 кадр, путь без неё — 22. Прикидка «должно быть хотя бы девять» здесь не
 * работает вовсе: кадры продолжают копиться весь хвост удержания, и оба пути дают заметно больше
 * девяти. Без этой проверки теряется начало первого слова — «Здравствуйте» приезжает как «авствуйте».
 */
await checkAsync(async () => {
  let received = null
  const harness = makeSession({ respond: async (utterance) => { received = utterance; return '' } })
  harness.session.onAnswer('Здравствуйте.')
  await new Promise((resolve) => setTimeout(resolve, 20))
  await harness.pump(voiceFrame, 12)
  await harness.pump(noiseFrame, 25)
  await new Promise((resolve) => setTimeout(resolve, 40))
  assert.ok(received, 'распознавание не вызвано вовсе')
  assert.ok(received.length >= 28, 'в реплику попало ' + received.length + ' кадров вместо 31 — предзапись потеряна')
})
// Отказ распознавания или модели НЕ роняет звонок и НЕ оставляет его в тупике: человек на линии, и
// молчание для него выглядит обрывом. Возвращаемся к слушанию — следующая реплика может пройти.
await checkAsync(async () => {
  const harness = makeSession({ respond: async () => { throw new Error('распознавание недоступно') } })
  harness.session.onAnswer('Здравствуйте.')
  await new Promise((resolve) => setTimeout(resolve, 20))
  await harness.pump(voiceFrame, 12)
  await harness.pump(noiseFrame, 25)
  await new Promise((resolve) => setTimeout(resolve, 60))
  assert.equal(harness.session.currentState, 'listening', 'звонок застрял в состоянии обдумывания')
})
// ─── Диалог ───────────────────────────────────────────────────────────────────────────────────────
//
// \b в JavaScript определён на ASCII: из одиннадцати фраз срабатывали ровно две — обе узбекские,
// латиницей. Весь русский набор был мёртв.

const OUTCOMES = [
  ['Ой, вы не туда попали', 'WRONG_NUMBER'],
  ['Вы ошиблись номером', 'WRONG_NUMBER'],
  ['Да, интересно, покажите демо', 'INTERESTED_DEMO'],
  ['Пришлите презентацию на почту', 'INTERESTED_DEMO'],
  ['Отправьте коммерческое предложение', 'INTERESTED_DEMO'],
  ['Хорошо, назначим встречу', 'INTERESTED_DEMO'],
  ['Перезвоните завтра после обеда', 'CALL_LATER'],
  ['Сейчас неудобно, я занят', 'CALL_LATER'],
  ['Нам это не нужно, спасибо', 'REJECTED'],
  ['Больше не звоните нам', 'REJECTED'],
  ['Мы отказываемся', 'REJECTED'],
  ['Kerak emas', 'REJECTED'],
  ["Keyinroq qo'ng'iroq qiling", 'CALL_LATER'],
  ['Adashdingiz', 'WRONG_NUMBER'],
]
for (const [phrase, expected] of OUTCOMES) {
  check(() => assert.equal(detectOutcome(phrase)?.outcome, expected, `«${phrase}» → ожидался ${expected}`))
}

// Ничего не значащие реплики НЕ классифицируются: закрывать звонок на первом «ну не знаю» нельзя.
for (const phrase of ['Ну не знаю', 'Здравствуйте', 'Расскажите подробнее', 'А сколько это стоит?', '']) {
  check(() => assert.equal(detectOutcome(phrase), null, `«${phrase}» не должно давать итог`))
}
// Юникодная граница не даёт «да» совпасть внутри слова.
check(() => assert.equal(detectOutcome('Свобода выбора'), null))

// Итог НЕ перезаписывается более поздней вежливостью: человек, сказавший «не интересно», а потом «ну
// ладно, присылайте», — это отказ, и отправлять к нему менеджера нельзя.
check(() => {
  const dialogue = new DialogueState()
  dialogue.addCustomer('Нам не интересно', 1_000)
  dialogue.addCustomer('Ну ладно, пришлите презентацию', 5_000)
  assert.equal(dialogue.detectedOutcome, 'REJECTED')
})

// Отказ и не тот номер завершают СРАЗУ; согласие и «перезвоните» дают боту одну реплику на прощание,
// иначе звонок обрывается на полуслове.
check(() => assert.equal(shouldHangUp('REJECTED', 0), true))
check(() => assert.equal(shouldHangUp('WRONG_NUMBER', 0), true))
check(() => assert.equal(shouldHangUp('INTERESTED_DEMO', 0), false))
check(() => assert.equal(shouldHangUp('INTERESTED_DEMO', 1), true))
check(() => assert.equal(shouldHangUp(null, 10), false))

check(() => assert.match(buildGreeting({ companyName: 'Дента Люкс' }), /Дента Люкс/))
// Признание, что это ИИ, в приветствии обязательно: отрицание было бы обманом, а в ряде стран и
// нарушением.
check(() => assert.match(buildGreeting({}), /ИИ-ассистент/))
check(() => assert.match(buildGreeting({ icebreaker: 'Заметил, что нет онлайн-записи.' }), /онлайн-записи/))
check(() => assert.match(buildClosing('REJECTED'), /не побеспокоим/))
check(() => assert.match(buildClosing('INTERESTED_DEMO'), /[Мм]енеджер/))

// Системный промпт запрещает выдумывать цены и требует коротких реплик: длинная реплика в разговоре —
// дефект, а выдуманная цена становится обещанием компании.
check(() => {
  const prompt = buildSystemPrompt({ companyName: 'Дента Люкс', niche: 'стоматология' })
  assert.match(prompt, /коротких предложения/)
  assert.match(prompt, /Не называй цен/)
  assert.match(prompt, /робот ли ты/)
  assert.match(prompt, /Дента Люкс/)
})

check(() => assert.equal(outcomeToCardOutcome('WRONG_NUMBER'), null))
check(() => assert.equal(outcomeToCardOutcome('CALL_LATER'), 'CALL_LATER'))

check(() => {
  const dialogue = new DialogueState()
  dialogue.addBot('Здравствуйте, это Nemo.', 0)
  dialogue.addCustomer('Да, слушаю', 2_000)
  assert.equal(dialogue.transcript().length, 2)
  assert.deepEqual(dialogue.toMessages()[0], { role: 'assistant', content: 'Здравствуйте, это Nemo.' })
  assert.ok(dialogue.talkToListenRatio() > 1)
})
check(() => assert.equal(new DialogueState().talkToListenRatio(), 0))

// ─── Разрезание ответа модели ─────────────────────────────────────────────────────────────────────

check(() => {
  const chunker = new SpeechChunker()
  assert.deepEqual(chunker.push('Здравствуйте! Это '), ['Здравствуйте!'])
  assert.deepEqual(chunker.push('Nemo.'), ['Это Nemo.'])
})
// Хвост без завершающего знака ОБЯЗАН прозвучать: без flush последняя фраза ответа теряется.
check(() => {
  const chunker = new SpeechChunker()
  chunker.push('Скажите, вам это интересно')
  assert.equal(chunker.flush(), 'Скажите, вам это интересно')
})
check(() => assert.equal(new SpeechChunker().flush(), null))
// Длинная фраза без точки не должна застревать целиком.
check(() => {
  const chunker = new SpeechChunker()
  const emitted = chunker.push('слово '.repeat(60))
  assert.ok(emitted.length > 0, 'фраза без знаков препинания застряла бы до конца ответа')
  assert.ok(emitted[0].length <= 180)
})

// ─── Пост-звонковый разбор ────────────────────────────────────────────────────────────────────────

const CALL = {
  callId: '33333333-4444-5555-6666-777777777777',
  tenantId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
  trunkId: 'bbbbbbbb-cccc-dddd-eeee-ffffffffffff',
  direction: 'OUTBOUND',
  customerPhone: '+998901112233',
  callerId: '+998712000000',
  durationSeconds: 95,
  sipHangupCause: 'NORMAL_CLEARING',
  recordingUrl: 'https://rec.nemo.ai/a.mp3',
  transcript: [
    { role: 'bot', text: 'Здравствуйте, это Nemo.', atMs: 0 },
    { role: 'customer', text: 'Да, слушаю', atMs: 2_000 },
  ],
  detectedOutcome: null,
  talkToListenRatio: 1.4,
  companyName: 'Дента Люкс',
}

check(() => assert.equal(CallAnalyticsSchema.safeParse(fallbackAnalytics(CALL)).success, true))
// Запасная аналитика ставит НЕЙТРАЛЬНЫЕ оценки, а не выдуманные: 50 означает «не оценивали», и это
// честнее, чем 80, создающее впечатление тёплого контакта.
check(() => assert.equal(fallbackAnalytics(CALL).relationship_health_score, 50))
check(() => assert.deepEqual(fallbackAnalytics(CALL).lead_pain_points, []))
check(() => assert.equal(fallbackAnalytics({ ...CALL, detectedOutcome: 'REJECTED' }).next_step.action, 'DO_NOT_DISTURB'))

check(() => assert.match(formatTranscript(CALL.transcript), /АССИСТЕНТ: Здравствуйте/))
check(() => assert.match(formatTranscript(CALL.transcript), /КЛИЕНТ: Да, слушаю/))

// Модель регулярно оборачивает JSON в ```json вопреки прямой просьбе этого не делать.
check(() => assert.equal(stripCodeFence('```json\n{"a":1}\n```'), '{"a":1}'))
check(() => assert.equal(stripCodeFence('```\n{"a":1}\n```'), '{"a":1}'))
check(() => assert.equal(stripCodeFence('{"a":1}'), '{"a":1}'))

const GOOD_ANALYTICS = {
  call_outcome: 'INTERESTED_DEMO',
  overall_sentiment: 'VERY_POSITIVE',
  relationship_health_score: 82,
  lead_pain_points: ['теряют заявки вечером'],
  manager_coaching_feedback: { talk_to_listen_ratio: 1.4, objection_handling_score: 7, actionable_advice: 'Меньше говорить' },
  next_step: { action: 'SEND_TELEGRAM_NOTIFICATION', scheduled_at: null, notification_payload: 'карточка' },
}

await checkAsync(async () => {
  const llm = { name: 'fake', respond: async function* () {}, complete: async () => JSON.stringify(GOOD_ANALYTICS) }
  const { analytics, source } = await analyzeCall(CALL, llm)
  assert.equal(source, 'llm')
  assert.equal(analytics.relationship_health_score, 82)
  // Идентификатор, номер и длительность подставляются НАШИ: модель может переписать их «похожими», и
  // запись перестанет сходиться с базой.
  assert.equal(analytics.call_id, CALL.callId)
  assert.equal(analytics.duration_seconds, 95)
})

// Негодный ответ модели не роняет разбор: звонок уже состоялся и его надо сохранить.
await checkAsync(async () => {
  const llm = { name: 'fake', respond: async function* () {}, complete: async () => 'не json' }
  const { source, error } = await analyzeCall(CALL, llm)
  assert.equal(source, 'fallback')
  assert.ok(error)
})
await checkAsync(async () => {
  const llm = { name: 'fake', respond: async function* () {}, complete: async () => JSON.stringify({ ...GOOD_ANALYTICS, relationship_health_score: 240 }) }
  const { source } = await analyzeCall(CALL, llm)
  assert.equal(source, 'fallback', '240 из 100 не должно доехать до карточки менеджера')
})
await checkAsync(async () => {
  const { source } = await analyzeCall(CALL, null)
  assert.equal(source, 'fallback')
})

/*
 * Итог по ПРАВИЛАМ имеет приоритет над мнением модели для отказа и не того номера.
 *
 * Модель, увидев вежливое «спасибо, до свидания» после «нам не нужно», охотно ставит
 * FRIENDLY_CHAT_FOLLOWUP — и человек, сказавший нет, попадает в список для повторного звонка.
 */
await checkAsync(async () => {
  const llm = { name: 'fake', respond: async function* () {}, complete: async () => JSON.stringify({ ...GOOD_ANALYTICS, call_outcome: 'FRIENDLY_CHAT_FOLLOWUP' }) }
  const { analytics } = await analyzeCall({ ...CALL, detectedOutcome: 'REJECTED' }, llm)
  assert.equal(analytics.call_outcome, 'REJECTED')
  assert.equal(analytics.next_step.action, 'DO_NOT_DISTURB')
})

// ─── Карточка и запись ────────────────────────────────────────────────────────────────────────────

check(() => {
  const card = analyticsToLeadCard(CALL, { ...GOOD_ANALYTICS, call_id: CALL.callId, caller_phone: CALL.customerPhone, duration_seconds: 95 })
  assert.equal(LeadCardNotificationSchema.safeParse(card).success, true)
  assert.equal(card.callId, CALL.callId)
  assert.equal(card.recordingUrl, CALL.recordingUrl)
  assert.deepEqual(card.keyPains, ['теряют заявки вечером'])
})
check(() => assert.equal(
  analyticsToLeadCard(CALL, { ...GOOD_ANALYTICS, call_outcome: 'WRONG_NUMBER', call_id: CALL.callId, caller_phone: CALL.customerPhone, duration_seconds: 95 }),
  null,
  'карточка по ошибочному номеру приучит менеджера пролистывать все',
))

const makePersist = (options = {}) => {
  const inserted = []
  const cards = []
  const crm = []
  return {
    inserted, cards, crm,
    deps: {
      admin: { from: () => ({ insert: async (values) => { if (options.insertError) return { error: options.insertError }; inserted.push(values); return { error: null } } }) },
      sendCard: options.noCard ? undefined : async (card) => { cards.push(card); return options.cardFails ? { ok: false, error: 'chat not found' } : { ok: true } },
      pushToCrm: options.noCrm ? undefined : async (call, analytics) => { crm.push(analytics.call_outcome); return options.crmFails ? { ok: false, error: 'HTTP 500' } : { ok: true } },
    },
  }
}

const ANALYTICS = { ...GOOD_ANALYTICS, call_id: CALL.callId, caller_phone: CALL.customerPhone, duration_seconds: 95 }

await checkAsync(async () => {
  const harness = makePersist()
  const report = await persistCall(CALL, ANALYTICS, harness.deps)
  assert.deepEqual(report, { saved: true, cardSent: true, crmPushed: true, errors: [] })
  assert.equal(harness.inserted[0].id, CALL.callId)
  assert.equal(harness.inserted[0].sip_hangup_cause, 'NORMAL_CLEARING')
  assert.equal(harness.inserted[0].full_transcript.length, 2)
  assert.equal(harness.inserted[0].analytics.call_outcome, 'INTERESTED_DEMO')
})

/*
 * Отказ записи в базу ОТМЕНЯЕТ рассылку.
 *
 * Карточка содержит идентификатор звонка, и менеджер, нажавший в ней кнопку, пойдёт искать звонок в
 * базе. Отправить её при незаписанном звонке значит гарантированно получить «звонок не найден» на
 * первое же нажатие.
 */
await checkAsync(async () => {
  const harness = makePersist({ insertError: { message: 'permission denied' } })
  const report = await persistCall(CALL, ANALYTICS, harness.deps)
  assert.equal(report.saved, false)
  assert.equal(harness.cards.length, 0, 'карточка ушла раньше записи звонка')
  assert.equal(harness.crm.length, 0)
  assert.match(report.errors[0], /permission denied/)
})

// Отказ карточки НЕ отменяет CRM: это независимые получатели.
await checkAsync(async () => {
  const harness = makePersist({ cardFails: true })
  const report = await persistCall(CALL, ANALYTICS, harness.deps)
  assert.equal(report.saved, true)
  assert.equal(report.cardSent, false)
  assert.equal(report.crmPushed, true, 'потеря карточки не повод терять CRM')
  assert.match(report.errors[0], /chat not found/)
})
await checkAsync(async () => {
  const harness = makePersist({ crmFails: true })
  const report = await persistCall(CALL, ANALYTICS, harness.deps)
  assert.equal(report.cardSent, true)
  assert.equal(report.crmPushed, false)
})
// Исключение получателя не должно ронять разбор целиком.
await checkAsync(async () => {
  const harness = makePersist()
  harness.deps.sendCard = async () => { throw new Error('сеть недоступна') }
  const report = await persistCall(CALL, ANALYTICS, harness.deps)
  assert.equal(report.saved, true)
  assert.match(report.errors[0], /сеть недоступна/)
})

// ─── Управляющие сообщения коммутатора ────────────────────────────────────────────────────────────
//
// Формат чужой и меняется с версией модуля. Непонятное сообщение НЕ должно ронять звонок.

check(() => {
  const parsed = parseControl(JSON.stringify({ event: 'answer', callId: 'c1', tenantId: 't1', trunkId: 'tr1', customerPhone: '+998901112233', callerId: '+998712000000', direction: 'OUTBOUND' }))
  assert.equal(parsed.type, 'answer')
  assert.equal(parsed.callId, 'c1')
  assert.equal(parsed.direction, 'OUTBOUND')
})
// Разные версии модуля называют событие по-разному; цена ошибки — не поднятая трубка.
check(() => assert.equal(parseControl(JSON.stringify({ event: 'start', call_id: 'c1' })).type, 'answer'))
check(() => assert.equal(parseControl(JSON.stringify({ type: 'session_start', uuid: 'c1' })).type, 'answer'))
check(() => assert.equal(parseControl(JSON.stringify({ event: 'hangup', callId: 'c1', cause: 'NORMAL_CLEARING' })).type, 'hangup'))
check(() => assert.equal(parseControl(JSON.stringify({ event: 'stop', call_id: 'c1' })).type, 'hangup'))
// Битый JSON и незнакомое событие не бросают: исключение здесь оборвало бы звонок.
check(() => assert.equal(parseControl('{не json').type, 'unknown'))
check(() => assert.equal(parseControl(JSON.stringify({ event: 'dtmf', digit: '1' })).type, 'unknown'))
check(() => assert.equal(parseControl(JSON.stringify({ event: 'answer' })).type, 'unknown', 'ANSWER без идентификатора бесполезен'))
check(() => assert.ok(parseControl('x'.repeat(5_000)).raw.length <= 200, 'мусор не должен целиком уезжать в журнал'))

console.log(`[OK] Voice pipeline behaviour: ${checks} assertions`)
