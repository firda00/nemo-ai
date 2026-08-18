// Голосовой воркер: WebSocket-сервер для аудиопотока FreeSWITCH.
//
// ЧТО НА ТОМ КОНЦЕ. Модуль mod_audio_fork (или mod_audio_stream) откалывает аудио звонка и шлёт его
// сюда двоичными кадрами по WebSocket; управляющие события — ANSWER, HANGUP, метаданные звонка —
// приходят текстовыми сообщениями в JSON. Ответное аудио уходит двоичными кадрами обратно.
//
// ЧТО НЕ ПРОВЕРЕНО. FreeSWITCH в среде разработки не поднимался: это отдельный сервер с SIP-стеком,
// которому нужен транк у оператора. Проверено то, что можно проверить без него, — и проверено
// НАСТОЯЩИМ WebSocket-клиентом, а не вызовом обработчиков: рукопожатие, разбор управляющих событий,
// разбор аудиокадров, прерывание, завершение звонка и разбор после HANGUP. Формат управляющих
// сообщений взят по документации mod_audio_fork и на живом коммутаторе НЕ сверялся; если он отличается,
// правится одно место — parseControl ниже.
//
// ОДИН ПРОЦЕСС — МНОГО ЗВОНКОВ. Сессии независимы и хранятся по идентификатору соединения. Падение
// одной не должно ронять остальные, поэтому каждый обработчик обёрнут: необработанное отклонение
// промиса в Node убивает процесс целиком, то есть один сбойный звонок оборвал бы все идущие.

import { WebSocketServer, type WebSocket } from 'ws'
import { BYTES_PER_FRAME, FRAME_MS } from './audio.ts'
import { CallSession } from './session.ts'
import { DialogueState, buildGreeting, buildSystemPrompt } from './dialogue.ts'
import { SpeechChunker, type VoiceProviders } from './providers.ts'
import { SpeechDetector, resolveVad } from './vad.ts'
import { analyzeCall, persistCall, type CompletedCall, type PersistDeps } from './analytics.ts'

/** Управляющее сообщение от коммутатора. */
export type ControlMessage =
  | { type: 'answer'; callId: string; tenantId: string; trunkId: string; customerPhone: string; callerId: string; direction: 'INBOUND' | 'OUTBOUND'; companyName?: string; niche?: string; icp?: string; icebreaker?: string }
  | { type: 'hangup'; callId: string; cause: string | null; recordingUrl: string | null }
  | { type: 'unknown'; raw: string }

/**
 * Разбор управляющего сообщения.
 *
 * Терпим к форме и НЕ бросает. Коммутатор — чужая система, её сообщения меняются с версией модуля, и
 * необработанное исключение здесь оборвало бы звонок вместо того, чтобы пропустить непонятную строку.
 * Неизвестное возвращается как 'unknown' и попадает в журнал: так видно, что формат разошёлся, но
 * звонок при этом продолжается.
 */
export function parseControl(raw: string): ControlMessage {
  let data: Record<string, unknown>
  try {
    data = JSON.parse(raw) as Record<string, unknown>
  } catch {
    return { type: 'unknown', raw: raw.slice(0, 200) }
  }

  // mod_audio_fork называет событие по-разному в зависимости от версии и настройки: принимаем оба
  // написания, потому что цена ошибки — не поднятая трубка.
  const event = String(data.event ?? data.type ?? '').toLowerCase()

  if (event === 'answer' || event === 'start' || event === 'session_start') {
    const callId = String(data.callId ?? data.call_id ?? data.uuid ?? '')
    if (!callId) return { type: 'unknown', raw: raw.slice(0, 200) }
    return {
      type: 'answer',
      callId,
      tenantId: String(data.tenantId ?? data.tenant_id ?? ''),
      trunkId: String(data.trunkId ?? data.trunk_id ?? ''),
      customerPhone: String(data.customerPhone ?? data.customer_phone ?? data.caller ?? ''),
      callerId: String(data.callerId ?? data.caller_id ?? ''),
      direction: (data.direction === 'INBOUND' ? 'INBOUND' : 'OUTBOUND'),
      companyName: data.companyName ? String(data.companyName) : undefined,
      niche: data.niche ? String(data.niche) : undefined,
      icp: data.icp ? String(data.icp) : undefined,
      icebreaker: data.icebreaker ? String(data.icebreaker) : undefined,
    }
  }

  if (event === 'hangup' || event === 'stop' || event === 'session_end') {
    return {
      type: 'hangup',
      callId: String(data.callId ?? data.call_id ?? data.uuid ?? ''),
      cause: data.cause ? String(data.cause) : null,
      recordingUrl: data.recordingUrl ? String(data.recordingUrl) : null,
    }
  }

  return { type: 'unknown', raw: raw.slice(0, 200) }
}

interface LiveCall {
  session: CallSession
  dialogue: DialogueState
  meta: Extract<ControlMessage, { type: 'answer' }>
  startedAt: number
  timer: ReturnType<typeof setInterval>
}

export interface VoiceWorkerOptions {
  port: number
  providers: VoiceProviders
  persist: PersistDeps
  /** Заменяемо в проверках: настоящий детектор поднимается лениво. */
  createVad?: () => Promise<{ vad: Awaited<ReturnType<typeof resolveVad>>['vad']; fallbackReason: string | null }>
  onLog?: (line: string) => void
}

/**
 * Сервер голосовых звонков.
 *
 * Возвращает управление сразу после начала прослушивания: адрес и остановка доступны вызывающему.
 */
export async function startVoiceWorker(options: VoiceWorkerOptions): Promise<{
  port: number
  close: () => Promise<void>
  activeCalls: () => number
}> {
  const log = options.onLog ?? ((line: string) => console.log(`[voice] ${line}`))
  const { vad, fallbackReason } = await (options.createVad ?? resolveVad)()
  if (fallbackReason) log(`детектор речи: ${vad.name} (${fallbackReason})`)
  else log(`детектор речи: ${vad.name}`)

  if (options.providers.missing.length) {
    // Воркер поднимается, но ЧЕСТНО говорит, чего у него нет. Снимать трубку без синтеза нельзя:
    // человек услышит тишину и решит, что ему звонят мошенники.
    log(`НЕ ХВАТАЕТ: ${options.providers.missing.join('; ')}`)
  }

  const server = new WebSocketServer({ port: options.port })
  const calls = new Map<WebSocket, LiveCall>()

  server.on('connection', (socket: WebSocket) => {
    socket.on('message', (data: Buffer, isBinary: boolean) => {
      // Каждый обработчик обёрнут: необработанное отклонение промиса в Node убивает процесс, то есть
      // один сбойный звонок оборвал бы все идущие.
      void handleMessage(socket, data, isBinary).catch((error) => {
        log(`ошибка обработки: ${error instanceof Error ? error.message : String(error)}`)
      })
    })
    socket.on('close', () => { void finishCall(socket, null, null).catch(() => {}) })
    socket.on('error', () => { void finishCall(socket, 'socket_error', null).catch(() => {}) })
  })

  async function handleMessage(socket: WebSocket, data: Buffer, isBinary: boolean): Promise<void> {
    const live = calls.get(socket)
    if (isBinary) {
      // Аудио. До ANSWER его быть не должно, но если пришло — молча пропускаем: спорить с чужим
      // коммутатором о порядке сообщений бесполезно.
      if (live) await live.session.onAudio(new Uint8Array(data))
      return
    }

    const message = parseControl(data.toString('utf8'))
    if (message.type === 'unknown') { log(`неизвестное сообщение: ${message.raw}`); return }
    if (message.type === 'answer') { await beginCall(socket, message); return }
    await finishCall(socket, message.cause, message.recordingUrl)
  }

  async function beginCall(socket: WebSocket, meta: Extract<ControlMessage, { type: 'answer' }>): Promise<void> {
    if (calls.has(socket)) return

    const dialogue = new DialogueState({
      companyName: meta.companyName ?? null,
      niche: meta.niche ?? null,
      icp: meta.icp ?? null,
      icebreaker: meta.icebreaker ?? null,
    })
    const systemPrompt = buildSystemPrompt(dialogue.context)

    const session = new CallSession({
      callId: meta.callId,
      vad,
      detector: new SpeechDetector({ speechThresholdMs: 180, silenceThresholdMs: 600 }),
      callbacks: {
        sendAudio: (frame) => { if (socket.readyState === socket.OPEN) socket.send(frame) },

        respond: async (utterance, _turn, signal) => {
          const stt = options.providers.stt
          if (!stt) return ''
          const heard = await stt.transcribe(utterance, signal)
          if (!heard.text.trim()) return ''
          dialogue.addCustomer(heard.text, Date.now())
          if (dialogue.shouldHangUp()) return ''
          return heard.text
        },

        speak: async function* (text, _turn, signal) {
          const { llm, tts } = options.providers
          if (!tts) return
          // Приветствие и завершающая фраза уже готовы текстом — их не надо просить у модели.
          const isScripted = dialogue.turns.length === 0 || dialogue.shouldHangUp()
          if (isScripted || !llm) {
            dialogue.addBot(text, Date.now())
            yield* tts.synthesize(text, signal)
            return
          }
          const chunker = new SpeechChunker()
          let full = ''
          for await (const delta of llm.respond(systemPrompt, dialogue, signal)) {
            full += delta
            for (const sentence of chunker.push(delta)) {
              // Синтез идёт ПО КУСКАМ, а не после всего ответа: иначе первый звук прозвучит через
              // секунды, и бюджет задержки будет израсходован на ожидание точки.
              yield* tts.synthesize(sentence, signal)
            }
          }
          const tail = chunker.flush()
          if (tail) yield* tts.synthesize(tail, signal)
          if (full.trim()) dialogue.addBot(full.trim(), Date.now())
        },

        onEvent: (event) => {
          if (event.type === 'barge_in') log(`${meta.callId}: перебивание после ${event.afterMs} мс речи`)
          if (event.type === 'turn_latency') log(`${meta.callId}: ответ за ${event.ms} мс`)
        },
      },
    })

    // Таймер темпа: один кадр за FRAME_MS. Без него исходящее аудио ушло бы одним куском, и прерывание
    // стало бы невозможным — см. пояснение в session.ts.
    const timer = setInterval(() => {
      session.tick()
      session.onFramePlayed()
    }, FRAME_MS)

    calls.set(socket, { session, dialogue, meta, startedAt: Date.now(), timer })
    log(`${meta.callId}: звонок начат (${meta.customerPhone})`)
    session.onAnswer(buildGreeting(dialogue.context))
  }

  async function finishCall(socket: WebSocket, cause: string | null, recordingUrl: string | null): Promise<void> {
    const live = calls.get(socket)
    if (!live) return
    calls.delete(socket)
    clearInterval(live.timer)
    live.session.end()

    const durationSeconds = Math.max(0, Math.round((Date.now() - live.startedAt) / 1000))
    const completed: CompletedCall = {
      callId: live.meta.callId,
      tenantId: live.meta.tenantId,
      trunkId: live.meta.trunkId,
      direction: live.meta.direction,
      customerPhone: live.meta.customerPhone,
      callerId: live.meta.callerId,
      durationSeconds,
      sipHangupCause: cause,
      recordingUrl,
      transcript: live.dialogue.transcript(),
      detectedOutcome: live.dialogue.detectedOutcome,
      talkToListenRatio: live.dialogue.talkToListenRatio(),
      companyName: live.meta.companyName ?? null,
    }

    // Разбор ПОСЛЕ завершения: во время разговора на него нет времени, здесь спешить некуда.
    const { analytics, source, error } = await analyzeCall(completed, options.providers.llm)
    if (error) log(`${completed.callId}: разбор — ${source} (${error})`)
    const report = await persistCall(completed, analytics, options.persist)
    log(`${completed.callId}: завершён за ${durationSeconds} с, итог ${analytics.call_outcome}, `
      + `сохранён=${report.saved}, карточка=${report.cardSent}, CRM=${report.crmPushed}`)
    for (const one of report.errors) log(`${completed.callId}: ${one}`)
  }

  await new Promise<void>((resolve) => server.once('listening', resolve))
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : options.port
  log(`слушаю ws://0.0.0.0:${port}`)

  return {
    port,
    activeCalls: () => calls.size,
    close: async () => {
      for (const [socket, live] of calls) {
        clearInterval(live.timer)
        live.session.end()
        socket.close()
      }
      calls.clear()
      await new Promise<void>((resolve) => server.close(() => resolve()))
      await vad.close()
    },
  }
}

export { BYTES_PER_FRAME }
