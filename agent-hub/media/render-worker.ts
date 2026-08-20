// Медиа-воркер: разбирает очередь рендера, собирает ролик, отчитывается.
//
// ОЧЕРЕДЬ ЗДЕСЬ РАБОТАЕТ ИНАЧЕ, ЧЕМ У SDR, и это осознанное различие. У задач SDR источник правды —
// Postgres: там резервируются кредиты, и потеря записи означает списанные деньги без работы. Задача
// рендера кредитов не резервирует: она либо выполнится, либо будет поставлена заново тем, кто её
// поставил. Поэтому здесь Dragonfly ХРАНИТ саму задачу, а не сигнал о ней, — ровно как просит §4
// задания Фазы 4.
//
// Цена такого решения названа прямо: перезапуск Dragonfly без сохранённого снапшота теряет очередь
// рендеров. Это приемлемо для роликов и было бы неприемлемо для оплаченных прогонов SDR.
//
// ОДНА ЗАДАЧА ЗА РАЗ. Рендер занимает все ядра машины: два параллельных не ускоряют работу, а
// замедляют оба и удваивают пиковое потребление диска под временные файлы. Масштабируется это числом
// контейнеров, а не потоков внутри одного.

import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { VideoRenderTaskSchema, VideoRenderResultSchema } from '../contracts/media.ts'
import type { VideoRenderResult, VideoRenderTask } from '../contracts/media.ts'
import { parseContract } from '../contracts/v5.ts'
import { buildAssFile } from './subtitles.ts'
import {
  buildRenderArgs, cleanupWorkDir, probeCapabilities, runRender, type FfmpegCapabilities,
} from './ffmpeg-engine.ts'

/** Ключ очереди из задания. Отличается от очереди SDR: это разные потоки задач с разной ценой потери. */
export const RENDER_QUEUE_KEY = 'render:queue'
/** Сколько воркер висит на BLPOP за заход. Конечное ожидание переживает перезапуск Dragonfly. */
export const BLOCK_SECONDS = 30
/** Предел размера скачиваемого исходника: 512 МБ — это уже не сцена ролика, а чей-то архив. */
const MAX_ASSET_BYTES = 512 * 1024 * 1024

export interface RedisLike {
  blpop(key: string, timeoutSeconds: number): Promise<[string, string] | null>
  rpush(key: string, ...values: string[]): Promise<number>
  quit(): Promise<unknown>
}

export interface RenderWorkerDeps {
  redis: RedisLike
  ffmpegPath: string
  capabilities: FfmpegCapabilities
  /** Скачивание исходника. Отдельно — чтобы проверки не ходили в сеть. */
  fetchAsset?: (url: string, destination: string) => Promise<void>
  /** Обновление состояния в базе. Необязательно: воркер работает и без неё, но тише. */
  updateStatus?: (taskId: string, patch: Record<string, unknown>) => Promise<void>
  sendWebhook?: (url: string, result: VideoRenderResult) => Promise<{ ok: boolean; error?: string }>
  onLog?: (line: string) => void
  workRoot?: string
}

/**
 * Скачивание исходника на диск.
 *
 * Предел размера проверяется ПО ХОДУ, а не по заголовку Content-Length: заголовок необязателен и легко
 * врёт. Без проверки один исходник на десять гигабайт забивает диск воркера и останавливает очередь
 * целиком, а выглядит это как «рендер завис».
 */
export async function downloadAsset(url: string, destination: string, fetchImpl: typeof fetch = fetch): Promise<void> {
  const response = await fetchImpl(url, { signal: AbortSignal.timeout(120_000) })
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`)
  if (!response.body) throw new Error(`${url}: пустой ответ`)

  const chunks: Uint8Array[] = []
  let total = 0
  const reader = response.body.getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > MAX_ASSET_BYTES) {
      await reader.cancel().catch(() => {})
      throw new Error(`${url}: больше ${Math.round(MAX_ASSET_BYTES / 1024 / 1024)} МБ`)
    }
    chunks.push(value)
  }
  await fs.writeFile(destination, Buffer.concat(chunks))
}

/**
 * Имя локального файла для исходника.
 *
 * Расширение берётся из адреса и НУЖНО по существу: по нему решается, ставить ли `-loop 1` для
 * картинки. Всё остальное в имени — индекс, а не исходное название: имя из чужого URL может содержать
 * что угодно, включая `../`, и попадать в путь на диске ему незачем.
 */
export function localAssetName(url: string, index: number, prefix = 'scene'): string {
  const extension = (() => {
    try {
      const ext = path.extname(new URL(url).pathname).toLowerCase()
      return /^\.[a-z0-9]{2,5}$/.test(ext) ? ext : '.bin'
    } catch {
      return '.bin'
    }
  })()
  return `${prefix}${index}${extension}`
}

/**
 * Выполнить одну задачу.
 *
 * Рабочий каталог удаляется в finally ВСЕГДА. Один невычищенный каталог — это сотни мегабайт скачанных
 * сцен; воркер, работающий сутками, забивает диск за день и встаёт с «нет места», а причина выглядит
 * как проблема инфраструктуры, а не как забытая уборка.
 */
export async function renderTask(task: VideoRenderTask, deps: RenderWorkerDeps): Promise<VideoRenderResult> {
  const log = deps.onLog ?? (() => {})
  const startedAt = Date.now()
  const root = deps.workRoot ?? path.join(os.tmpdir(), 'renders')
  await fs.mkdir(root, { recursive: true })
  const workDir = await fs.mkdtemp(path.join(root, `${task.id}-`))
  const fetchAsset = deps.fetchAsset ?? ((url, destination) => downloadAsset(url, destination))

  try {
    await deps.updateStatus?.(task.id, { status: 'RENDERING', started_at: new Date().toISOString() })

    const localScenePaths: string[] = []
    for (const [index, scene] of task.scenes.entries()) {
      const destination = path.join(workDir, localAssetName(scene.mediaUrl, index))
      await fetchAsset(scene.mediaUrl, destination)
      localScenePaths.push(destination)
    }
    const voicePath = path.join(workDir, localAssetName(task.voiceoverUrl, 0, 'voice'))
    await fetchAsset(task.voiceoverUrl, voicePath)

    let bgmPath: string | null = null
    if (task.bgmUrl) {
      bgmPath = path.join(workDir, localAssetName(task.bgmUrl, 0, 'bgm'))
      await fetchAsset(task.bgmUrl, bgmPath)
    }

    let assPath: string | null = null
    if (task.subtitles?.length) {
      assPath = path.join(workDir, 'subtitles.ass')
      await fs.writeFile(assPath, buildAssFile(task.subtitles), 'utf8')
      if (!deps.capabilities.has('ass')) {
        // Молча выпустить ролик без субтитров нельзя: их заказали, за них заплатили, и обнаружится
        // пропажа уже после публикации.
        log(`${task.id}: фильтр ass недоступен — субтитры НЕ будут вжжены`)
      }
    }

    const outputPath = path.join(workDir, `${task.id}.mp4`)
    const plan = buildRenderArgs({
      task, localScenePaths, voicePath, bgmPath, assPath, outputPath, capabilities: deps.capabilities,
    })
    log(`${task.id}: рендер ${plan.totalDurationSec} с, приглушение=${plan.ducking}, субтитры=${plan.subtitlesBurned}`)

    const outcome = await runRender({
      ffmpegPath: deps.ffmpegPath,
      args: plan.args,
      totalDurationSec: plan.totalDurationSec,
      onProgress: (progress) => {
        void deps.updateStatus?.(task.id, { progress: Number(progress.fraction.toFixed(3)) })
      },
    })

    if (!outcome.ok) {
      const reason = outcome.timedOut
        ? `рендер не уложился в отведённое время (${plan.totalDurationSec} с материала)`
        : `ffmpeg завершился с кодом ${outcome.code}: ${outcome.stderrTail.split('\n').slice(-3).join(' | ')}`
      return finalize({ id: task.id, outputPath: '', durationSec: 0, renderTimeMs: Date.now() - startedAt,
        fileSizeBytes: 0, status: 'FAILED', error: reason })
    }

    const stat = await fs.stat(outputPath)
    // Готовый файл ПЕРЕНОСИТСЯ из рабочего каталога до его удаления. Оставить его внутри — значит
    // удалить вместе с каталогом в finally и отчитаться об успехе, которого нет.
    const finalPath = path.join(root, `${task.id}.mp4`)
    await fs.rename(outputPath, finalPath).catch(async () => {
      // rename между разными томами не работает; копирование медленнее, но надёжнее.
      await fs.copyFile(outputPath, finalPath)
    })

    return finalize({
      id: task.id, outputPath: finalPath, durationSec: plan.totalDurationSec,
      renderTimeMs: Date.now() - startedAt, fileSizeBytes: stat.size, status: 'COMPLETED', error: null,
    })
  } catch (error) {
    return finalize({
      id: task.id, outputPath: '', durationSec: 0, renderTimeMs: Date.now() - startedAt,
      fileSizeBytes: 0, status: 'FAILED',
      error: error instanceof Error ? error.message : String(error),
    })
  } finally {
    const cleanupError = await cleanupWorkDir(workDir)
    if (cleanupError) log(`${task.id}: каталог не удалён — ${cleanupError}`)
  }
}

/** Итог проходит через схему: она не даст записать FAILED без причины и отрицательные размеры. */
function finalize(candidate: Record<string, unknown>): VideoRenderResult {
  const checked = parseContract(VideoRenderResultSchema, candidate)
  if (checked.ok) return checked.data
  // Схема отвергла собственный итог — это ошибка в коде выше, и молчать о ней нельзя.
  return {
    id: String(candidate.id), outputPath: '', durationSec: 0,
    renderTimeMs: Number(candidate.renderTimeMs ?? 0), fileSizeBytes: 0,
    status: 'FAILED', error: `внутренняя ошибка сборки итога: ${checked.error}`,
  }
}

/** Разбор задачи из очереди. Негодная — в журнал и мимо: возвращать её в очередь значит зациклиться. */
export function parseQueuedTask(raw: string): { ok: true; task: VideoRenderTask } | { ok: false; error: string } {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    return { ok: false, error: `не разбирается как JSON: ${(error as Error).message}` }
  }
  const checked = parseContract(VideoRenderTaskSchema, parsed)
  return checked.ok ? { ok: true, task: checked.data } : { ok: false, error: checked.error }
}

/**
 * Один проход очереди: взять задачу, отрендерить, отчитаться.
 *
 * Возвращает идентификатор обработанной задачи либо null, если за отведённое время ничего не пришло.
 */
export async function processOnce(deps: RenderWorkerDeps): Promise<string | null> {
  const log = deps.onLog ?? (() => {})
  const popped = await deps.redis.blpop(RENDER_QUEUE_KEY, BLOCK_SECONDS).catch(() => null)
  if (!popped) return null

  const parsed = parseQueuedTask(popped[1])
  if (!parsed.ok) {
    log(`негодная задача в очереди отброшена: ${parsed.error}`)
    return null
  }

  const result = await renderTask(parsed.task, deps)
  await deps.updateStatus?.(result.id, {
    status: result.status,
    output_path: result.outputPath || null,
    duration_sec: result.durationSec,
    render_time_ms: result.renderTimeMs,
    file_size_bytes: result.fileSizeBytes,
    error: result.error,
    finished_at: new Date().toISOString(),
  }).catch((error) => log(`${result.id}: состояние не записано — ${error instanceof Error ? error.message : error}`))

  if (parsed.task.webhookUrl && deps.sendWebhook) {
    // Отказ вебхука НЕ отменяет готовый ролик: файл уже собран, и терять его из-за недоступного
    // приёмника было бы несоразмерно. Причина попадает в журнал.
    const sent = await deps.sendWebhook(parsed.task.webhookUrl, result).catch((error) => ({
      ok: false, error: error instanceof Error ? error.message : String(error),
    }))
    if (!sent.ok) log(`${result.id}: вебхук не доставлен — ${sent.error ?? 'причина не указана'}`)
  }

  log(`${result.id}: ${result.status}, ${result.fileSizeBytes} байт за ${result.renderTimeMs} мс`)
  return result.id
}

export { MAX_ASSET_BYTES, probeCapabilities }
