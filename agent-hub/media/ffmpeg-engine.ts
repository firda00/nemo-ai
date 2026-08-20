// Движок рендера: построение фильтр-графа и запуск ffmpeg.
//
// ПРЯМОЙ ЗАПУСК БИНАРНИКА, а не обёртка вроде fluent-ffmpeg. Причина не в идеологии: фильтр-граф здесь
// сложный (масштабирование под 9:16, склейка сцен, наложение субтитров, микширование двух дорожек), и
// обёртка на нём всё равно превращается в передачу сырых строк — только с лишним слоем, который
// незаметно меняет порядок аргументов. Спецификация V5 (§2) называет ту же причину экономической:
// нативный ffmpeg не требует лицензионных отчислений, в отличие от Remotion, на котором сейчас работает
// render-worker этого проекта.
//
// ── ПОЧЕМУ ЗДЕСЬ ЕСТЬ ПРОБА ВОЗМОЖНОСТЕЙ ────────────────────────────────────────────────────────
//
// Сборки ffmpeg РАЗИТЕЛЬНО отличаются друг от друга, и это не теория. Бинарник, лежащий в этом же
// репозитории внутри Remotion, собран с `--disable-filters` и белым списком: в нём есть scale, crop,
// concat, loudnorm, amix — и НЕТ ни ass, ни xfade, ни sidechaincompress, то есть ровно тех четырёх
// фильтров, которые нужны для субтитров, переходов и приглушения музыки.
//
// Граф, собранный в предположении «фильтр есть», падает не при сборке аргументов, а на середине
// рендера — после того, как минуты процессорного времени уже потрачены, и с сообщением вида
// «No such filter: 'ass'», по которому непонятно, что делать. Поэтому возможности проверяются ОДИН РАЗ
// при старте, а граф строится под то, что действительно доступно: без xfade сцены склеиваются встык,
// без sidechaincompress музыка приглушается постоянной громкостью. Отсутствие ass — единственный
// случай, который не деградирует молча: субтитры либо накладываются, либо о них честно сообщается.

import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import { OUTPUT_FPS, OUTPUT_HEIGHT, OUTPUT_WIDTH } from '../contracts/media.ts'
import type { Scene, VideoRenderTask } from '../contracts/media.ts'
import { escapeFilterPath } from './subtitles.ts'

/** Фильтры, от наличия которых зависит форма графа. */
export const REQUIRED_FILTERS = ['scale', 'crop', 'concat'] as const
/**
 * Фильтры, без которых граф работает хуже, но работает.
 *
 * `fps` и `setsar` попали сюда НЕ из осторожности, а по факту: первый настоящий прогон упал с
 * «No option name near '30'» именно на них. Проба возможностей уже существовала, но к цепочке
 * масштабирования не применялась — и это ровно тот случай, ради которого она заводилась. Ошибка при
 * этом выглядит как поломка разбора всего графа, а не как отсутствие одного фильтра.
 */
export const OPTIONAL_FILTERS = [
  'ass', 'xfade', 'sidechaincompress', 'loudnorm', 'amix', 'volume', 'fps', 'setsar', 'asplit', 'setpts',
] as const

export interface FfmpegCapabilities {
  filters: Set<string>
  has(name: string): boolean
  /** Чего не хватает из обязательного. Непустой список означает непригодный бинарник. */
  missingRequired: string[]
}

/**
 * Что умеет этот конкретный бинарник.
 *
 * Разбирается вывод `-filters`: первые восемь строк — заголовок, дальше по строке на фильтр, где имя
 * во втором столбце. Формат стабилен между версиями ffmpeg уже много лет; при изменении проба вернёт
 * пустой набор, и обязательные фильтры окажутся «отсутствующими» — то есть рендер откажется стартовать
 * с внятной причиной вместо того, чтобы упасть на середине.
 */
export async function probeCapabilities(ffmpegPath: string, runner = runCommand): Promise<FfmpegCapabilities> {
  const filters = new Set<string>()
  try {
    const { stdout } = await runner(ffmpegPath, ['-hide_banner', '-filters'], 15_000)
    for (const line of stdout.split('\n').slice(8)) {
      const name = line.trim().split(/\s+/)[1]
      if (name) filters.add(name)
    }
  } catch {
    // Проба не удалась — набор пуст, и обязательные окажутся недостающими. Это правильнее, чем
    // предположить, что всё на месте.
  }
  return {
    filters,
    has: (name: string) => filters.has(name),
    missingRequired: REQUIRED_FILTERS.filter((name) => !filters.has(name)),
  }
}

/**
 * Масштабирование сцены под 9:16 БЕЗ полей.
 *
 * `increase` вместо `decrease` и последующий crop — это «заполнить кадр», а не «вписать в кадр».
 * Разница видна сразу: вписывание оставляет чёрные полосы, а лента коротких видео их не прощает —
 * ролик с полосами выглядит как перезалив с другой платформы.
 *
 * setsar=1 в конце обязателен: исходники приходят с разным соотношением пикселей, и без выравнивания
 * склейка отказывается работать с сообщением про несовпадение параметров потоков.
 */
export function sceneScaleFilter(capabilities: FfmpegCapabilities): string {
  const parts = [
    `scale=${OUTPUT_WIDTH}:${OUTPUT_HEIGHT}:force_original_aspect_ratio=increase`,
    `crop=${OUTPUT_WIDTH}:${OUTPUT_HEIGHT}`,
  ]
  // Частота кадров и соотношение сторон пикселя выравниваются фильтрами ТОЛЬКО когда они есть. Иначе
  // частоту задаёт `-r` на выходе, а квадратный пиксель обеспечивает само масштабирование: сборка без
  // `fps` и `setsar` — не редкость, и падать на ней целиком незачем.
  if (capabilities.has('fps')) parts.push(`fps=${OUTPUT_FPS}`)
  parts.push('format=yuv420p')
  if (capabilities.has('setsar')) parts.push('setsar=1')
  return parts.join(',')
}

/**
 * Видеочасть графа.
 *
 * Каждая сцена приводится к одному разрешению, частоте кадров и формату пикселей — concat отказывается
 * склеивать потоки, отличающиеся хоть одним из этих параметров, и сообщение об этом описывает
 * несовпадение, а не его причину.
 */
export function buildVideoGraph(scenes: readonly Scene[], options: { assPath?: string | null; capabilities: FfmpegCapabilities }): { chain: string; outLabel: string } {
  const parts: string[] = []
  const labels: string[] = []

  scenes.forEach((scene, index) => {
    const label = `v${index}`
    // trim + setpts: длительность сцены задаём мы, а не исходник. Без обрезки видео длиной в минуту
    // проигрывается целиком, и ролик из пяти сцен по три секунды выходит пятиминутным.
    // setpts обнуляет отсчёт времени сцены после обрезки. Фильтра может не быть (в проверенной здесь
    // сборке его нет — есть только asetpts для звука); тогда временные метки выравнивает сам concat.
    const resetPts = options.capabilities.has('setpts') ? ',setpts=PTS-STARTPTS' : ''
    parts.push(`[${index}:v]${sceneScaleFilter(options.capabilities)},trim=duration=${scene.durationSec}${resetPts}[${label}]`)
    labels.push(`[${label}]`)
  })

  let current = 'vout'
  parts.push(`${labels.join('')}concat=n=${scenes.length}:v=1:a=0[${current}]`)

  if (options.assPath && options.capabilities.has('ass')) {
    parts.push(`[${current}]ass='${escapeFilterPath(options.assPath)}'[vsub]`)
    current = 'vsub'
  }

  return { chain: parts.join(';'), outLabel: current }
}

/**
 * Звуковая часть графа.
 *
 * ГОЛОС НОРМАЛИЗУЕТСЯ, музыка приглушается. Порядок именно такой: нормализовать смесь бессмысленно —
 * loudnorm подтянет громкость там, где говорит диктор, и опустит там, где играет музыка, то есть
 * сделает ровно обратное задуманному.
 *
 * ПРИГЛУШЕНИЕ. sidechaincompress — настоящий ducking: музыка проседает В МОМЕНТ речи и возвращается в
 * паузах. Когда фильтра нет, музыка играет постоянной пониженной громкостью. Второе хуже, но
 * работает; отказаться от музыки вовсе было бы хуже обоих вариантов.
 */
export function buildAudioGraph(options: {
  voiceIndex: number
  bgmIndex: number | null
  bgmVolume: number
  totalDurationSec: number
  capabilities: FfmpegCapabilities
}): { chain: string; outLabel: string; ducking: 'sidechain' | 'static' | 'none' } {
  const parts: string[] = []
  const { voiceIndex, bgmIndex, bgmVolume, capabilities } = options

  // Голос обрезается по длительности видео и дополняется тишиной, если он короче: без apad ffmpeg
  // закончит файл на конце самой короткой дорожки, и последняя сцена окажется обрезанной.
  const voiceChain = capabilities.has('loudnorm')
    ? `[${voiceIndex}:a]loudnorm=I=-16:TP=-1.5:LRA=11,aresample=48000[voice]`
    : `[${voiceIndex}:a]aresample=48000[voice]`
  parts.push(voiceChain)

  if (bgmIndex === null) {
    parts.push(`[voice]apad,atrim=duration=${options.totalDurationSec},asetpts=PTS-STARTPTS[aout]`)
    return { chain: parts.join(';'), outLabel: 'aout', ducking: 'none' }
  }

  parts.push(`[${bgmIndex}:a]volume=${bgmVolume},aresample=48000,apad,atrim=duration=${options.totalDurationSec}[bgm]`)

  if (capabilities.has('sidechaincompress') && capabilities.has('asplit')) {
    // Голос раздваивается: одна копия идёт в микс, вторая управляет компрессором. Без asplit поток
    // нельзя использовать дважды — ffmpeg откажет с сообщением про повторное подключение.
    parts.push('[voice]asplit=2[voice_mix][voice_key]')
    parts.push('[bgm][voice_key]sidechaincompress=threshold=0.05:ratio=8:attack=20:release=400[bgm_ducked]')
    parts.push(`[voice_mix][bgm_ducked]amix=inputs=2:duration=first:dropout_transition=0[amix]`)
    parts.push(`[amix]atrim=duration=${options.totalDurationSec},asetpts=PTS-STARTPTS[aout]`)
    return { chain: parts.join(';'), outLabel: 'aout', ducking: 'sidechain' }
  }

  parts.push('[voice][bgm]amix=inputs=2:duration=first:dropout_transition=0[amix]')
  parts.push(`[amix]atrim=duration=${options.totalDurationSec},asetpts=PTS-STARTPTS[aout]`)
  return { chain: parts.join(';'), outLabel: 'aout', ducking: 'static' }
}

export interface RenderPlan {
  args: string[]
  ducking: 'sidechain' | 'static' | 'none'
  subtitlesBurned: boolean
  totalDurationSec: number
}

/**
 * Полный набор аргументов командной строки.
 *
 * ЧИСТАЯ ФУНКЦИЯ — ни запуска процесса, ни обращения к диску. Это не стилистика: проверить фильтр-граф
 * иначе можно только настоящим рендером, то есть минутами на каждую проверку и зависимостью от того,
 * какие фильтры есть в системе. Здесь граф проверяется сравнением строк за миллисекунды.
 */
export function buildRenderArgs(options: {
  task: VideoRenderTask
  localScenePaths: string[]
  voicePath: string
  bgmPath: string | null
  assPath: string | null
  outputPath: string
  capabilities: FfmpegCapabilities
}): RenderPlan {
  const { task, localScenePaths, voicePath, bgmPath, assPath, outputPath, capabilities } = options
  const totalDurationSec = task.scenes.reduce((sum, scene) => sum + scene.durationSec, 0)

  const args: string[] = ['-hide_banner', '-nostdin', '-y']

  task.scenes.forEach((scene, index) => {
    // -loop 1 нужен КАРТИНКАМ: без него изображение даёт один кадр, и сцена длится 1/30 секунды.
    // Для видео этот флаг вреден, поэтому решает расширение файла.
    if (isStillImage(localScenePaths[index])) args.push('-loop', '1', '-t', String(scene.durationSec))
    args.push('-i', localScenePaths[index])
  })

  const voiceIndex = task.scenes.length
  args.push('-i', voicePath)
  const bgmIndex = bgmPath ? voiceIndex + 1 : null
  if (bgmPath) args.push('-i', bgmPath)

  const video = buildVideoGraph(task.scenes, { assPath, capabilities })
  const audio = buildAudioGraph({
    voiceIndex, bgmIndex, bgmVolume: task.bgmVolume, totalDurationSec, capabilities,
  })

  args.push('-filter_complex', `${video.chain};${audio.chain}`)
  args.push('-map', `[${video.outLabel}]`, '-map', `[${audio.outLabel}]`)

  args.push(
    '-c:v', 'libx264',
    // veryfast, а не medium: разница в размере файла на коротком вертикальном ролике единицы процентов,
    // а во времени рендера — разы. Медиа-воркер обрабатывает очередь, и время здесь дороже байтов.
    '-preset', 'veryfast',
    '-crf', '23',
    // yuv420p обязателен: без него часть плееров и загрузчиков соцсетей отказываются принимать файл,
    // а некоторые показывают зелёный экран.
    '-pix_fmt', 'yuv420p',
    '-r', String(OUTPUT_FPS),
    '-c:a', 'aac', '-b:a', '128k', '-ar', '48000',
    // faststart переносит индекс в начало файла: без него ролик в ленте начинает играть только после
    // полной загрузки, и на мобильной сети это выглядит как «видео не работает».
    '-movflags', '+faststart',
    '-t', String(totalDurationSec),
    // Прогресс в stdout машинным форматом. Разбирать вывод для человека из stderr — гадание: он
    // меняется между версиями и содержит перевод каретки вместо переводов строки.
    '-progress', 'pipe:1',
    '-nostats',
    outputPath,
  )

  return {
    args,
    ducking: audio.ducking,
    subtitlesBurned: Boolean(assPath && capabilities.has('ass')),
    totalDurationSec,
  }
}

const STILL_IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.bmp', '.gif'])
export function isStillImage(filePath: string): boolean {
  return STILL_IMAGE_EXT.has(path.extname(String(filePath ?? '')).toLowerCase())
}

// ── Прогресс ──────────────────────────────────────────────────────────────────────────────────────

export interface RenderProgress {
  /** Позиция в выходном файле, секунды. */
  outTimeSec: number
  /** Доля выполненного, 0..1. */
  fraction: number
  frame: number
  speed: number | null
}

/**
 * Разбор блока `-progress`.
 *
 * Формат простой: строки `ключ=значение`, блок завершается строкой `progress=continue` или
 * `progress=end`. Разбирается ИМЕННО он, а не человекочитаемый вывод в stderr: тот меняется между
 * версиями, использует возврат каретки вместо перевода строки и не поддаётся надёжному разбору.
 *
 * `out_time_ms` в ffmpeg на самом деле МИКРОСЕКУНДЫ, вопреки имени. Это давняя особенность, на которой
 * ошибаются регулярно: деление на 1000 вместо 1_000_000 даёт прогресс в тысячу раз больше и мгновенное
 * «готово» в интерфейсе.
 */
export function parseProgressBlock(block: string, totalDurationSec: number): RenderProgress | null {
  const values = new Map<string, string>()
  for (const line of block.split('\n')) {
    const index = line.indexOf('=')
    if (index > 0) values.set(line.slice(0, index).trim(), line.slice(index + 1).trim())
  }
  const microseconds = Number(values.get('out_time_us') ?? values.get('out_time_ms'))
  if (!Number.isFinite(microseconds)) return null

  const outTimeSec = microseconds / 1_000_000
  const speedRaw = values.get('speed')
  const speed = speedRaw && speedRaw.endsWith('x') ? Number(speedRaw.slice(0, -1)) : null
  return {
    outTimeSec,
    fraction: totalDurationSec > 0 ? Math.min(1, Math.max(0, outTimeSec / totalDurationSec)) : 0,
    frame: Number(values.get('frame') ?? 0) || 0,
    speed: Number.isFinite(speed) ? speed : null,
  }
}

// ── Запуск ────────────────────────────────────────────────────────────────────────────────────────

export interface RunResult { code: number | null; stdout: string; stderr: string; timedOut: boolean }

/** Простой запуск с таймаутом — для пробы возможностей. */
export async function runCommand(command: string, args: string[], timeoutMs: number): Promise<RunResult> {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true })
    let stdout = ''
    let stderr = ''
    let timedOut = false
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL') }, timeoutMs)
    child.stdout?.on('data', (chunk) => { stdout += chunk })
    child.stderr?.on('data', (chunk) => { stderr += chunk })
    child.on('error', (error) => { clearTimeout(timer); reject(error) })
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, stdout, stderr, timedOut }) })
  })
}

export interface RenderOutcome {
  ok: boolean
  code: number | null
  timedOut: boolean
  /** Последние строки stderr. Именно в них ffmpeg объясняет, ЧТО не так с графом. */
  stderrTail: string
  renderTimeMs: number
}

/**
 * Запуск рендера.
 *
 * ТРИ вещи, каждая из которых защищает от своей поломки:
 *
 *   ТАЙМАУТ. Рендер, наткнувшийся на битый исходник, может встать навсегда — ffmpeg будет ждать данных
 *   из потока, который никогда не придёт. Без предела такой процесс держит очередь до перезапуска.
 *
 *   УБИЙСТВО ДЕРЕВА. SIGTERM самому ffmpeg не всегда достаточно: на Windows он порождает дочерние
 *   процессы, и убийство родителя оставляет их держать файлы. Отсюда taskkill /T на Windows и SIGKILL
 *   по группе на остальных системах.
 *
 *   ХВОСТ stderr. Целиком stderr рендера — это мегабайты; полезны последние строки, где ffmpeg
 *   объясняет отказ. Хранить всё ради них значит держать в памяти по мегабайту на каждую задачу.
 */
export async function runRender(options: {
  ffmpegPath: string
  args: string[]
  totalDurationSec: number
  timeoutMs?: number
  onProgress?: (progress: RenderProgress) => void
}): Promise<RenderOutcome> {
  const startedAt = Date.now()
  // По умолчанию — двадцать реальных секунд на секунду ролика плюс минута про запас. Абсолютное число
  // здесь не годится: тридцатисекундный ролик и пятиминутный отличаются на порядок.
  const timeoutMs = options.timeoutMs ?? Math.round(options.totalDurationSec * 20_000) + 60_000

  return await new Promise((resolve) => {
    const child = spawn(options.ffmpegPath, options.args, { windowsHide: true })
    let stderrTail = ''
    let progressBuffer = ''
    let timedOut = false
    let settled = false

    const timer = setTimeout(() => {
      timedOut = true
      killTree(child.pid)
    }, timeoutMs)

    child.stdout?.on('data', (chunk) => {
      progressBuffer += chunk
      // Блок завершается строкой progress=... Держим хвост до следующего блока: разбирать половину
      // блока значит получать null на каждом втором вызове.
      let index = progressBuffer.indexOf('progress=')
      while (index !== -1) {
        const end = progressBuffer.indexOf('\n', index)
        if (end === -1) break
        const block = progressBuffer.slice(0, end)
        progressBuffer = progressBuffer.slice(end + 1)
        const progress = parseProgressBlock(block, options.totalDurationSec)
        if (progress && options.onProgress) options.onProgress(progress)
        index = progressBuffer.indexOf('progress=')
      }
    })

    child.stderr?.on('data', (chunk) => {
      stderrTail = (stderrTail + chunk).slice(-4_000)
    })

    const finish = (code: number | null) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({
        ok: code === 0 && !timedOut,
        code,
        timedOut,
        stderrTail: stderrTail.trim(),
        renderTimeMs: Date.now() - startedAt,
      })
    }

    child.on('error', (error) => {
      stderrTail = `${stderrTail}\n${error.message}`.slice(-4_000)
      finish(null)
    })
    child.on('close', finish)
  })
}

/**
 * Убить процесс вместе с потомками.
 *
 * На Windows ffmpeg порождает дочерние процессы, и kill родителя оставляет их жить, удерживая
 * временные файлы — очистка после этого падает с «файл занят другим процессом», а сами процессы
 * копятся до перезагрузки.
 */
export function killTree(pid: number | undefined): void {
  if (!pid) return
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true })
    } else {
      process.kill(-pid, 'SIGKILL')
    }
  } catch {
    // Процесс уже мёртв — это ожидаемо и не ошибка.
  }
}

/**
 * Удалить рабочий каталог задачи.
 *
 * Вызывается в finally ВСЕГДА. Один невычищенный каталог — это десятки мегабайт скачанных сцен и
 * промежуточных файлов; воркер, обрабатывающий очередь сутками, забивает диск за день и останавливается
 * с «нет места», а причина при этом выглядит как проблема инфраструктуры.
 *
 * Отказ удаления НЕ бросает: он сообщается, но не отменяет уже готовый ролик.
 */
export async function cleanupWorkDir(dir: string): Promise<string | null> {
  try {
    await fs.rm(dir, { recursive: true, force: true })
    return null
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

export { OUTPUT_WIDTH, OUTPUT_HEIGHT, OUTPUT_FPS }
