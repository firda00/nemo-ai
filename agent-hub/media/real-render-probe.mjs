// Настоящий рендер на синтетических файлах.
//
// Запускается вручную и НЕ входит в гейт качества: он требует ffmpeg с нужными фильтрами, а его наличие
// зависит от машины. Гейт проверяет построение аргументов сравнением строк — это быстро и не зависит
// от системы; этот файл отвечает на другой вопрос: собирается ли граф в НАСТОЯЩЕМ ffmpeg или он верен
// только на бумаге.
//
//   node --experimental-strip-types agent-hub/media/real-render-probe.mjs [путь-к-ffmpeg]
//
// Без аргумента ищется ffmpeg в PATH, затем бинарник внутри Remotion, который лежит в этом же дереве.

import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { buildRenderArgs, probeCapabilities, runCommand, runRender } from './ffmpeg-engine.ts'
import { buildAssFile } from './subtitles.ts'
import { VideoRenderTaskSchema } from '../contracts/media.ts'
import { writePng, writeWav } from './test-fixtures.mjs'

const REMOTION_FFMPEG = 'render-worker/node_modules/@remotion/compositor-win32-x64-msvc/ffmpeg.exe'

async function resolveFfmpeg(explicit) {
  if (explicit) return explicit
  try {
    await runCommand('ffmpeg', ['-version'], 5_000)
    return 'ffmpeg'
  } catch {
    return REMOTION_FFMPEG
  }
}

const ffmpegPath = await resolveFfmpeg(process.argv[2])
console.log(`бинарник: ${ffmpegPath}`)

const capabilities = await probeCapabilities(ffmpegPath)
console.log(`фильтров доступно: ${capabilities.filters.size}`)
if (capabilities.missingRequired.length) {
  console.error(`НЕПРИГОДНЫЙ бинарник, нет обязательного: ${capabilities.missingRequired.join(', ')}`)
  process.exit(1)
}
for (const name of ['ass', 'xfade', 'sidechaincompress', 'loudnorm', 'amix', 'asplit']) {
  console.log(`  ${name.padEnd(18)} ${capabilities.has(name) ? 'есть' : 'НЕТ — граф деградирует'}`)
}

const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'nemo-render-'))
console.log(`рабочий каталог: ${workDir}`)

try {
  // Исходники пишутся НАПРЯМУЮ, а не через ffmpeg: демультиплексора lavfi в доступной сборке нет,
  // то есть инструмент, которым надо проверять рендер, не может создать материал для проверки.
  // Размеры сцен РАЗНЫЕ — в этом и смысл масштабирования под 9:16.
  const scene1 = await writePng(path.join(workDir, 'scene1.png'), 640, 480, [20, 30, 90])
  const scene2 = await writePng(path.join(workDir, 'scene2.png'), 1280, 720, [120, 20, 30])
  const voice = await writeWav(path.join(workDir, 'voice.wav'), 5, 440)
  const bgm = await writeWav(path.join(workDir, 'bgm.wav'), 8, 220)
  console.log('исходники записаны: PNG 640x480 и 1280x720, WAV 5 с и 8 с')
  const assPath = path.join(workDir, 'subs.ass')
  await fs.writeFile(assPath, buildAssFile([
    { startMs: 0, endMs: 1500, text: 'Скидка {50%}!', highlightWord: 'Скидка' },
    { startMs: 1600, endMs: 3800, text: 'Только сегодня', highlightWord: 'сегодня' },
  ]), 'utf8')

  const task = VideoRenderTaskSchema.parse({
    id: '11111111-2222-3333-4444-555555555555',
    tenantId: '22222222-3333-4444-5555-666666666666',
    scenes: [
      { id: 's1', mediaUrl: 'https://example.com/1.png', durationSec: 2 },
      { id: 's2', mediaUrl: 'https://example.com/2.png', durationSec: 2 },
    ],
    voiceoverUrl: 'https://example.com/voice.wav',
    bgmUrl: 'https://example.com/bgm.wav',
    bgmVolume: 0.15,
  })

  const outputPath = path.join(workDir, 'out.mp4')
  const plan = buildRenderArgs({
    task,
    localScenePaths: [scene1, scene2],
    voicePath: voice,
    bgmPath: bgm,
    assPath: capabilities.has('ass') ? assPath : null,
    outputPath,
    capabilities,
  })
  console.log(`план: приглушение=${plan.ducking}, субтитры вжигаются=${plan.subtitlesBurned}, длительность=${plan.totalDurationSec} с`)

  const seen = []
  const outcome = await runRender({
    ffmpegPath, args: plan.args, totalDurationSec: plan.totalDurationSec,
    onProgress: (p) => seen.push(p.fraction),
  })

  console.log(`рендер: ok=${outcome.ok} код=${outcome.code} за ${outcome.renderTimeMs} мс`)
  console.log(`событий прогресса: ${seen.length}, последняя доля: ${seen.at(-1)?.toFixed(2) ?? '—'}`)
  if (!outcome.ok) {
    console.error('--- хвост stderr ---')
    console.error(outcome.stderrTail.split('\n').slice(-12).join('\n'))
    process.exit(1)
  }

  const stat = await fs.stat(outputPath)
  console.log(`файл: ${stat.size} байт`)

  // Проверяем ГЛАЗАМИ ffprobe, а не доверием: разрешение, кодеки и длительность обязаны совпасть с
  // заказанными. Успешный код возврата ffmpeg этого не гарантирует.
  const probeBinary = ffmpegPath.replace(/ffmpeg(\.exe)?$/i, (m) => m.replace('ffmpeg', 'ffprobe'))
  const probe = await runCommand(probeBinary, [
    '-v', 'error', '-show_entries', 'stream=codec_name,width,height,r_frame_rate:format=duration',
    '-of', 'default=noprint_wrappers=1', outputPath,
  ], 30_000).catch(() => null)
  if (probe?.stdout) {
    console.log('--- что получилось на самом деле ---')
    console.log(probe.stdout.trim())
  } else {
    console.log('ffprobe недоступен — содержимое файла не сверено')
  }
} finally {
  await fs.rm(workDir, { recursive: true, force: true })
  console.log('рабочий каталог удалён')
}
