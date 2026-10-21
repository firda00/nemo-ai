// Медиа-пайплайн: контракты, субтитры .ass, фильтр-граф ffmpeg, воркер рендера.
//
// ЧТО ЗДЕСЬ ЗАЩИЩАЕТСЯ В ПЕРВУЮ ОЧЕРЕДЬ:
//
//   1. ЭКРАНИРОВАНИЕ .ass. Фигурные скобки в ASS открывают блок переопределения стиля: `{\pos(0,0)}`
//      двигает текст, `{\alpha&HFF&}` делает невидимым, `{\p1}` переключает движок в режим векторных
//      фигур, и остаток строки перестаёт быть текстом. Текст субтитров приходит от модели, то есть
//      это чужая строка. Реплика «скидка {50%}» без экранирования — субтитр, молча исчезнувший с экрана.
//
//   2. ПОСТРОЕНИЕ ГРАФА ПОД ДОСТУПНЫЕ ФИЛЬТРЫ. Сборки ffmpeg разительно отличаются: та, что лежит в
//      этом дереве внутри Remotion, не содержит ни ass, ни xfade, ни sidechaincompress, ни даже fps,
//      setpts и setsar. Первый настоящий прогон упал именно на этом — с сообщением «No option name
//      near '30'», описывающим поломку разбора всего графа, а не отсутствие одного фильтра.
//
//   3. ОЧИСТКА И ПЕРЕНОС РЕЗУЛЬТАТА. Рабочий каталог удаляется всегда, а готовый файл переносится из
//      него ДО удаления: оставить ролик внутри — значит удалить его вместе с каталогом и отчитаться об
//      успехе, которого нет.
//
// Настоящий рендер живёт отдельно (media/real-render-probe.mjs) и в гейт не входит: он требует ffmpeg,
// наличие которого зависит от машины. Здесь граф проверяется сравнением строк — за миллисекунды и
// одинаково везде.

import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  OUTPUT_FPS, OUTPUT_HEIGHT, OUTPUT_WIDTH, SceneSchema, SubtitleCueSchema, VideoRenderResultSchema,
  VideoRenderTaskSchema,
} from './contracts/media.ts'
import {
  DEFAULT_STYLE, applyHighlight, buildAssFile, buildAssHeader, escapeAssText, escapeFilterPath,
  formatAssTime,
} from './media/subtitles.ts'
import {
  buildAudioGraph, buildRenderArgs, buildVideoGraph, cleanupWorkDir, isStillImage, parseProgressBlock,
  probeCapabilities, sceneScaleFilter,
} from './media/ffmpeg-engine.ts'
import { localAssetName, parseQueuedTask, processOnce, renderTask, RENDER_QUEUE_KEY } from './media/render-worker.ts'
import { makeSineWav, makeSolidPng } from './media/test-fixtures.mjs'

let checks = 0
const check = (fn) => { fn(); checks++ }
const checkAsync = async (fn) => { await fn(); checks++ }

/** Набор возможностей для проверок: полный, урезанный и пустой. */
const caps = (names) => ({
  filters: new Set(names),
  has: (name) => names.includes(name),
  missingRequired: ['scale', 'crop', 'concat'].filter((n) => !names.includes(n)),
})
const FULL = caps(['scale', 'crop', 'concat', 'ass', 'xfade', 'sidechaincompress', 'loudnorm', 'amix', 'volume', 'fps', 'setpts', 'setsar', 'asplit'])
// Ровно то, что есть в сборке внутри Remotion. Не выдуманный набор, а измеренный.
const LIMITED = caps(['scale', 'crop', 'concat', 'loudnorm', 'amix', 'volume', 'format', 'trim', 'asetpts', 'apad', 'atrim', 'aresample'])

// ─── Контракты ────────────────────────────────────────────────────────────────────────────────────

const TASK = {
  id: '11111111-2222-3333-4444-555555555555',
  tenantId: '22222222-3333-4444-5555-666666666666',
  scenes: [
    { id: 's1', mediaUrl: 'https://cdn.example.com/1.png', durationSec: 2 },
    { id: 's2', mediaUrl: 'https://cdn.example.com/2.mp4', durationSec: 3 },
  ],
  voiceoverUrl: 'https://cdn.example.com/voice.mp3',
}

check(() => {
  const parsed = VideoRenderTaskSchema.parse(TASK)
  assert.equal(parsed.bgmVolume, 0.15, 'значение из спецификации должно появляться само')
  assert.equal(parsed.outputFormat, 'mp4_9_16')
  assert.equal(parsed.scenes[0].transition, 'none')
})

check(() => assert.equal(VideoRenderTaskSchema.safeParse({ ...TASK, scenes: [] }).success, false, 'ролик без сцен собрать не из чего'))
// Путь на диске вместо адреса: воркер работает в контейнере, чья файловая система исчезнет вместе с
// ним, и /tmp/scene1.png из чужого процесса там не существует.
check(() => assert.equal(VideoRenderTaskSchema.safeParse({ ...TASK, scenes: [{ id: 'a', mediaUrl: '/tmp/1.png', durationSec: 2 }] }).success, false))
// Кадр короче трети секунды человек не успевает разглядеть — при склейке это мигание.
check(() => assert.equal(SceneSchema.safeParse({ id: 'a', mediaUrl: 'https://x.uz/1.png', durationSec: 0.1 }).success, false))
check(() => assert.equal(SceneSchema.safeParse({ id: 'a', mediaUrl: 'https://x.uz/1.png', durationSec: 0.3 }).success, true))
check(() => assert.equal(SceneSchema.safeParse({ id: 'a', mediaUrl: 'https://x.uz/1.png', durationSec: 0 }).success, false))

// Громкость музыки больше единицы означает музыку ГРОМЧЕ голоса — ролик непригоден, а заметят это уже
// после публикации.
check(() => assert.equal(VideoRenderTaskSchema.safeParse({ ...TASK, bgmVolume: 1.5 }).success, false))
check(() => assert.equal(VideoRenderTaskSchema.safeParse({ ...TASK, bgmVolume: 0 }).success, true, 'ноль — законное «выключить музыку»'))

// Одинаковые идентификаторы сцен ломают не рендер, а РАЗБОР: по ним ищут, какая сцена не отрисовалась.
check(() => assert.equal(VideoRenderTaskSchema.safeParse({
  ...TASK, scenes: [{ id: 'x', mediaUrl: 'https://x.uz/1.png', durationSec: 1 }, { id: 'x', mediaUrl: 'https://x.uz/2.png', durationSec: 1 }],
}).success, false))

check(() => assert.equal(VideoRenderTaskSchema.safeParse({
  ...TASK, scenes: Array.from({ length: 7 }, (_, i) => ({ id: `s${i}`, mediaUrl: 'https://x.uz/a.png', durationSec: 100 })),
}).success, false, 'суммарная длительность за пределом'))

check(() => assert.equal(SubtitleCueSchema.safeParse({ startMs: 1000, endMs: 500, text: 'а' }).success, false, 'конец раньше начала'))
check(() => assert.equal(SubtitleCueSchema.safeParse({ startMs: 0, endMs: 1, text: 'а' }).success, true))
check(() => assert.equal(SubtitleCueSchema.safeParse({ startMs: -1, endMs: 100, text: 'а' }).success, false))

// FAILED без причины — бесполезная запись: она сообщает, что не получилось, и не даёт ни одного
// способа узнать почему.
const RESULT = { id: TASK.id, outputPath: '/tmp/a.mp4', durationSec: 5, renderTimeMs: 1000, fileSizeBytes: 100 }
check(() => assert.equal(VideoRenderResultSchema.safeParse({ ...RESULT, status: 'FAILED', error: null }).success, false))
check(() => assert.equal(VideoRenderResultSchema.safeParse({ ...RESULT, status: 'FAILED', error: 'ffmpeg код 1' }).success, true))
check(() => assert.equal(VideoRenderResultSchema.safeParse({ ...RESULT, status: 'COMPLETED' }).success, true))
check(() => assert.equal(VideoRenderResultSchema.safeParse({ ...RESULT, status: 'COMPLETED', fileSizeBytes: -1 }).success, false))

// ─── Экранирование .ass ───────────────────────────────────────────────────────────────────────────

const BACKSLASH = String.fromCharCode(92)

// Блок переопределения стиля обезвреживается — иначе чужой текст управляет отрисовкой.
check(() => assert.equal(escapeAssText('скидка {50%}'), 'скидка \\{50%\\}'))
// Режим векторных фигур: после {\p1} остаток строки перестаёт быть текстом вовсе.
check(() => assert.ok(!escapeAssText('{\\p1}m 0 0').includes('{\\p1}')))
// Обратная косая удваивается: \N переносит строку, и путь «C:\new» иначе разорвёт реплику.
check(() => assert.equal(escapeAssText(BACKSLASH), BACKSLASH + BACKSLASH))
check(() => assert.equal(escapeAssText(`C:${BACKSLASH}new`), `C:${BACKSLASH}${BACKSLASH}new`))
// Сырой перевод строки обрывает событие: всё после него становится мусором в файле.
check(() => assert.equal(escapeAssText('первая\nвторая'), 'первая\\Nвторая'))
check(() => assert.equal(escapeAssText('первая\r\nвторая'), 'первая\\Nвторая'))
check(() => assert.equal(escapeAssText(null), ''))

/*
 * Порядок подмен: обратная косая ПЕРВОЙ.
 *
 * Иначе она удвоит косые, добавленные экранированием скобок, и `{` превратится в `\\{` — то есть в
 * экранированную косую плюс открывающую скобку, и блок переопределения снова окажется живым.
 */
check(() => {
  const escaped = escapeAssText('{a}')
  assert.equal(escaped, '\\{a\\}')
  assert.equal(escaped.includes(BACKSLASH + BACKSLASH), false, 'косая удвоена лишний раз — скобка снова активна')
})

// ─── Время .ass ───────────────────────────────────────────────────────────────────────────────────
//
// Формат H:MM:SS.CC: часы БЕЗ ведущего нуля, остальное с ним. Именно на этом чужие плееры спотыкаются.

check(() => assert.equal(formatAssTime(0), '0:00:00.00'))
check(() => assert.equal(formatAssTime(999), '0:00:00.99'))
check(() => assert.equal(formatAssTime(1_000), '0:00:01.00'))
check(() => assert.equal(formatAssTime(61_500), '0:01:01.50'))
check(() => assert.equal(formatAssTime(3_661_230), '1:01:01.23'))
check(() => assert.equal(formatAssTime(-100), '0:00:00.00', 'отрицательное время не должно давать мусор'))
// Сотые, а не тысячные: деление на 10 вместо 100 даёт время в десять раз больше.
check(() => assert.equal(formatAssTime(1_230), '0:00:01.23'))

// ─── Подсветка ────────────────────────────────────────────────────────────────────────────────────

check(() => {
  const highlighted = applyHighlight('Скидка только сегодня', 'скидка', DEFAULT_STYLE)
  assert.ok(highlighted.includes(DEFAULT_STYLE.highlightColour), 'цвет подсветки не применён')
  // Возврат цвета обязателен: без него подсветка «протекает» на весь остаток реплики.
  assert.ok(highlighted.includes(DEFAULT_STYLE.primaryColour), 'цвет не возвращён — подсветится вся строка')
})
// Регистр не важен: расшифровка отдаёт слово так, как его произнесли.
check(() => assert.ok(applyHighlight('СКИДКА сегодня', 'скидка', DEFAULT_STYLE).includes('\\c')))
// Границы по свойствам Unicode: \b на кириллице не работает, и «да» совпало бы внутри «свобода».
check(() => assert.equal(applyHighlight('свобода выбора', 'да', DEFAULT_STYLE), 'свобода выбора'))
// Слова нет — возвращается текст как есть: подсветка приём, а не обязанность.
check(() => assert.equal(applyHighlight('Привет', 'скидка', DEFAULT_STYLE), 'Привет'))
check(() => assert.equal(applyHighlight('Привет', undefined, DEFAULT_STYLE), 'Привет'))
// Знаки регулярных выражений внутри слова не должны ломать поиск.
check(() => assert.doesNotThrow(() => applyHighlight('цена (сегодня)', '(сегодня)', DEFAULT_STYLE)))

// ─── Файл .ass целиком ────────────────────────────────────────────────────────────────────────────

check(() => {
  const file = buildAssFile([{ startMs: 0, endMs: 1_000, text: 'Привет' }])
  // Разрешение обязано совпадать с рендером: иначе ffmpeg масштабирует разметку сам, и крупный шрифт
  // приезжает мелким — заметно только на готовом файле.
  assert.ok(file.includes(`PlayResX: ${OUTPUT_WIDTH}`))
  assert.ok(file.includes(`PlayResY: ${OUTPUT_HEIGHT}`))
  // Без этого обводка не масштабируется и на 1080p превращается в едва заметный контур.
  assert.ok(file.includes('ScaledBorderAndShadow: yes'))
  assert.ok(file.includes('[V4+ Styles]') && file.includes('[Events]'))
  assert.ok(file.includes('Dialogue: 0,0:00:00.00,0:00:01.00,Kinetic'))
})

// Реплики сортируются: список приходит из расшифровки, где порядок никто не гарантировал, а
// пересекающиеся реплики дают текст поверх текста.
check(() => {
  const lines = buildAssFile([
    { startMs: 2_000, endMs: 3_000, text: 'вторая' },
    { startMs: 0, endMs: 1_000, text: 'первая' },
  ]).split(/\r?\n/).filter((line) => line.startsWith('Dialogue'))
  assert.ok(lines[0].includes('первая'), 'реплики не отсортированы по времени')
})

// Отступ снизу уводит текст выше интерфейса TikTok и Reels: субтитр «как обычно снизу» окажется под
// подписью автора и кнопками.
check(() => {
  const marginV = Number(buildAssHeader(DEFAULT_STYLE).match(/Style: Kinetic,[^\n]*?,(\d+),1$/m)[1])
  assert.ok(marginV > OUTPUT_HEIGHT * 0.12, `отступ снизу ${marginV} — субтитр попадёт под интерфейс`)
})
check(() => assert.equal(buildAssFile([]).includes('Dialogue'), false, 'пустой список не должен давать событий'))

/*
 * Путь к файлу субтитров внутри фильтра экранируется ИНАЧЕ, чем текст.
 *
 * В описании фильтра двоеточие разделяет параметры, а `C:\renders\a.ass` содержит и его, и обратные
 * косые: ffmpeg разберёт «C» как имя файла, а остаток — как неизвестный параметр, и сообщение об
 * ошибке об этом не скажет ни слова.
 */
check(() => {
  const escaped = escapeFilterPath(`C:${BACKSLASH}renders${BACKSLASH}a.ass`)
  assert.equal(escaped, `C${BACKSLASH}:/renders/a.ass`, 'путь для кавычек графа: прямые косые, одна косая перед двоеточием')
})
// Двойная косая перед двоеточием — прежняя поломка Windows: значение стоит в кавычках, разборщик
// графа доносит обе косые до разборщика параметров дословно, там `\\` схлопывается в одну, живое
// двоеточие режет путь, и ffmpeg жалуется на original_size, ни словом не упоминая экранирование.
check(() => assert.equal(
  escapeFilterPath(`C:${BACKSLASH}a.ass`).includes(BACKSLASH + BACKSLASH), false,
  'двойное экранирование внутри кавычек снова режет путь по двоеточию',
))
// POSIX-путь проходит без изменений: экранировать в нём нечего.
check(() => assert.equal(escapeFilterPath('/tmp/subs.ass'), '/tmp/subs.ass'))
// Кавычка в пути не должна выпускать остаток строки из кавычек графа: она закрывает их, вставляется
// экранированной для обоих уровней разбора и открывает снова.
check(() => assert.equal(
  escapeFilterPath(`/tmp/o'brien.ass`),
  `/tmp/o'${BACKSLASH}${BACKSLASH}${BACKSLASH}''brien.ass`,
))

// ─── Фильтр-граф ──────────────────────────────────────────────────────────────────────────────────

// «Заполнить кадр», а не «вписать»: вписывание оставляет чёрные полосы, а лента коротких видео их не
// прощает — ролик выглядит перезаливом с другой платформы.
check(() => assert.ok(sceneScaleFilter(FULL).includes('force_original_aspect_ratio=increase')))
check(() => assert.ok(sceneScaleFilter(FULL).includes(`crop=${OUTPUT_WIDTH}:${OUTPUT_HEIGHT}`)))
check(() => assert.ok(sceneScaleFilter(FULL).includes(`fps=${OUTPUT_FPS}`)))
check(() => assert.ok(sceneScaleFilter(FULL).includes('setsar=1')))

/*
 * ГЛАВНАЯ ПРОВЕРКА ГРАФА: на урезанной сборке недоступные фильтры НЕ попадают в цепочку.
 *
 * Первый настоящий прогон упал именно здесь. Проба возможностей существовала, но к масштабированию не
 * применялась, и ffmpeg отверг ВЕСЬ граф с сообщением «No option name near '30'» — по нему невозможно
 * догадаться, что дело в отсутствии одного фильтра.
 */
check(() => {
  const chain = sceneScaleFilter(LIMITED)
  assert.equal(chain.includes('fps='), false, 'fps попал в граф на сборке, где его нет')
  assert.equal(chain.includes('setsar'), false, 'setsar попал в граф на сборке, где его нет')
  assert.ok(chain.includes('scale=') && chain.includes('crop='), 'обязательное должно остаться')
})

check(() => {
  const graph = buildVideoGraph(TASK.scenes, { assPath: '/tmp/s.ass', capabilities: FULL })
  assert.ok(graph.chain.includes('concat=n=2:v=1:a=0'))
  assert.ok(graph.chain.includes('ass='), 'субтитры не накладываются при доступном фильтре')
  assert.equal(graph.outLabel, 'vsub')
})

// Windows-путь попадает в граф в кавычках и с ОДНОЙ косой перед двоеточием — ровно та форма, которую
// понимают оба уровня разбора настоящего ffmpeg.
check(() => {
  const graph = buildVideoGraph(TASK.scenes, { assPath: `C:${BACKSLASH}w${BACKSLASH}s.ass`, capabilities: FULL })
  assert.ok(graph.chain.includes(`ass='C${BACKSLASH}:/w/s.ass'`), 'граф собрал путь не в той форме, которую разберёт ffmpeg')
  // Длительность сцены задаём мы, а не исходник: без обрезки видео длиной в минуту проигрывается
  // целиком, и ролик из пяти сцен по три секунды выходит пятиминутным.
  assert.ok(graph.chain.includes('trim=duration=2') && graph.chain.includes('trim=duration=3'))
})

check(() => {
  const graph = buildVideoGraph(TASK.scenes, { assPath: '/tmp/s.ass', capabilities: LIMITED })
  assert.equal(graph.chain.includes('ass='), false, 'граф ссылается на недоступный фильтр')
  assert.equal(graph.outLabel, 'vout')
})
check(() => assert.equal(buildVideoGraph(TASK.scenes, { assPath: null, capabilities: FULL }).outLabel, 'vout'))

// ─── Звук ─────────────────────────────────────────────────────────────────────────────────────────

check(() => {
  const audio = buildAudioGraph({ voiceIndex: 2, bgmIndex: 3, bgmVolume: 0.15, totalDurationSec: 5, capabilities: FULL })
  assert.equal(audio.ducking, 'sidechain', 'при доступном фильтре нужно настоящее приглушение')
  assert.ok(audio.chain.includes('sidechaincompress'))
  // Голос раздваивается: одна копия в микс, вторая управляет компрессором. Без asplit ffmpeg откажет.
  assert.ok(audio.chain.includes('asplit=2'))
  assert.ok(audio.chain.includes('loudnorm'), 'голос обязан нормализоваться')
})

// Нет sidechaincompress — музыка играет постоянной пониженной громкостью. Хуже, но работает; отказаться
// от музыки вовсе было бы хуже обоих вариантов.
check(() => {
  const audio = buildAudioGraph({ voiceIndex: 2, bgmIndex: 3, bgmVolume: 0.15, totalDurationSec: 5, capabilities: LIMITED })
  assert.equal(audio.ducking, 'static')
  assert.ok(audio.chain.includes('volume=0.15'))
  assert.equal(audio.chain.includes('sidechaincompress'), false)
  assert.ok(audio.chain.includes('amix=inputs=2'))
})

check(() => {
  const audio = buildAudioGraph({ voiceIndex: 2, bgmIndex: null, bgmVolume: 0.15, totalDurationSec: 5, capabilities: FULL })
  assert.equal(audio.ducking, 'none')
  assert.equal(audio.chain.includes('amix'), false, 'микшировать нечего — второй дорожки нет')
  // apad обязателен: без него файл закончится на конце короткого голоса, и последняя сцена обрежется.
  assert.ok(audio.chain.includes('apad'))
})

// Нормализуется ГОЛОС, а не смесь: loudnorm на миксе подтянет громкость там, где говорит диктор, и
// опустит там, где играет музыка, — то есть сделает ровно обратное задуманному.
check(() => {
  const audio = buildAudioGraph({ voiceIndex: 2, bgmIndex: 3, bgmVolume: 0.15, totalDurationSec: 5, capabilities: FULL })
  assert.ok(audio.chain.indexOf('loudnorm') < audio.chain.indexOf('amix'))
})

// ─── Аргументы командной строки ───────────────────────────────────────────────────────────────────

const argsFor = (capabilities, overrides = {}) => buildRenderArgs({
  task: VideoRenderTaskSchema.parse({ ...TASK, ...overrides }),
  localScenePaths: ['/w/scene0.png', '/w/scene1.mp4'],
  voicePath: '/w/voice.mp3',
  bgmPath: overrides.bgmUrl === null ? null : '/w/bgm.mp3',
  assPath: '/w/subs.ass',
  outputPath: '/w/out.mp4',
  capabilities,
})

check(() => {
  const plan = argsFor(FULL)
  const joined = plan.args.join(' ')
  assert.ok(joined.includes('-c:v libx264'))
  assert.ok(joined.includes('-c:a aac'))
  // Без yuv420p часть плееров и загрузчиков соцсетей отказываются принимать файл или показывают
  // зелёный экран.
  assert.ok(joined.includes('-pix_fmt yuv420p'))
  // faststart переносит индекс в начало: без него ролик в ленте начинает играть только после полной
  // загрузки, и на мобильной сети это выглядит как «видео не работает».
  assert.ok(joined.includes('-movflags +faststart'))
  // Прогресс машинным форматом в stdout: разбирать человекочитаемый вывод из stderr — гадание.
  assert.ok(joined.includes('-progress pipe:1'))
  assert.equal(plan.totalDurationSec, 5)
})

// -loop 1 нужен КАРТИНКАМ: без него изображение даёт один кадр, и сцена длится 1/30 секунды. Для видео
// этот флаг вреден, поэтому решает расширение файла.
check(() => {
  const args = argsFor(FULL).args
  const png = args.indexOf('/w/scene0.png')
  const mp4 = args.indexOf('/w/scene1.mp4')
  // Последовательность: -loop 1 -t <длительность> -i <путь>. Смотрим окно перед входом, а не одну
  // позицию: точное смещение зависит от того, задана ли длительность, и утверждение по индексу ломается
  // от любой правки порядка флагов.
  assert.ok(args.slice(Math.max(0, png - 5), png).includes('-loop'), 'картинка без -loop даст один кадр')
  assert.equal(args.slice(Math.max(0, mp4 - 5), mp4).includes('-loop'), false, '-loop на видео вреден')
})
// Все распространённые расширения картинок, а не только png: неопознанная картинка получает один кадр
// вместо сцены, и ролик выходит с миганием вместо изображения.
for (const ext of ['.png', '.PNG', '.jpg', '.jpeg', '.webp', '.bmp', '.gif']) {
  check(() => assert.equal(isStillImage('/w/a' + ext), true, ext + ' не опознан как картинка'))
}
for (const ext of ['.mp4', '.mov', '.webm', '.mkv']) {
  check(() => assert.equal(isStillImage('/w/a' + ext), false, ext + ' ошибочно принят за картинку'))
}
check(() => assert.equal(isStillImage(''), false))

check(() => {
  const plan = argsFor(LIMITED)
  assert.equal(plan.subtitlesBurned, false, 'обещаны субтитры, которых сборка не умеет')
  assert.equal(plan.ducking, 'static')
  assert.equal(plan.args.join(' ').includes('ass='), false)
})
check(() => assert.equal(argsFor(FULL).subtitlesBurned, true))

// Порядок входов задаёт индексы в графе: голос идёт сразу после сцен, музыка — после голоса.
// Перепутанный порядок даёт граф, ссылающийся на чужой поток, и ffmpeg сообщает о несовпадении типов.
check(() => {
  const args = argsFor(FULL).args
  const inputs = args.filter((_, i) => args[i - 1] === '-i')
  assert.deepEqual(inputs, ['/w/scene0.png', '/w/scene1.mp4', '/w/voice.mp3', '/w/bgm.mp3'])
})

// ─── Прогресс ─────────────────────────────────────────────────────────────────────────────────────

/*
 * out_time_us — МИКРОсекунды, вопреки имени out_time_ms в старых версиях.
 *
 * Деление на 1000 вместо 1_000_000 даёт прогресс в тысячу раз больше и мгновенное «готово» в
 * интерфейсе, при том что рендер идёт ещё минуту.
 */
check(() => {
  const progress = parseProgressBlock('frame=90\nfps=30\nout_time_us=3000000\nspeed=1.5x\nprogress=continue', 6)
  assert.equal(progress.outTimeSec, 3)
  assert.equal(progress.fraction, 0.5)
  assert.equal(progress.frame, 90)
  assert.equal(progress.speed, 1.5)
})
check(() => assert.equal(parseProgressBlock('out_time_us=12000000\nprogress=end', 6).fraction, 1, 'доля не должна превышать единицу'))
check(() => assert.equal(parseProgressBlock('frame=1\nprogress=continue', 6), null, 'блок без времени бесполезен'))
check(() => assert.equal(parseProgressBlock('out_time_us=1000000\nprogress=continue', 0).fraction, 0, 'нулевая длительность не должна давать деление на ноль'))
check(() => assert.equal(parseProgressBlock('out_time_us=1000000\nspeed=N/A\nprogress=continue', 4).speed, null))

// ─── Воркер ───────────────────────────────────────────────────────────────────────────────────────

check(() => assert.equal(RENDER_QUEUE_KEY, 'render:queue', 'ключ очереди задан спецификацией'))

// Имя берётся из индекса, а не из чужого URL: в имени файла может быть что угодно, включая «../», и
// попадать в путь на диске ему незачем. Расширение при этом нужно — по нему решается про -loop.
check(() => assert.equal(localAssetName('https://cdn.uz/a/b/photo.PNG', 3), 'scene3.png'))
check(() => assert.equal(localAssetName('https://cdn.uz/x', 0), 'scene0.bin'))
check(() => assert.equal(localAssetName('https://cdn.uz/../../etc/passwd', 1), 'scene1.bin'))
check(() => assert.equal(localAssetName('не-адрес', 2), 'scene2.bin'))
check(() => assert.equal(localAssetName('https://cdn.uz/v.mp4', 0, 'voice'), 'voice0.mp4'))

check(() => assert.equal(parseQueuedTask('{не json').ok, false))
check(() => assert.match(parseQueuedTask('{"id":"нет"}').error, /id/))
check(() => assert.equal(parseQueuedTask(JSON.stringify(TASK)).ok, true))

const makeDeps = (overrides = {}) => {
  const statuses = []
  const webhooks = []
  return {
    statuses, webhooks,
    deps: {
      redis: overrides.redis ?? { blpop: async () => null, rpush: async () => 1, quit: async () => 'OK' },
      ffmpegPath: 'ffmpeg',
      capabilities: overrides.capabilities ?? FULL,
      workRoot: overrides.workRoot,
      fetchAsset: overrides.fetchAsset ?? (async (url, destination) => {
        await fs.writeFile(destination, destination.endsWith('.mp3') || destination.endsWith('.wav')
          ? makeSineWav(1) : makeSolidPng(8, 8, [1, 2, 3]))
      }),
      updateStatus: async (id, patch) => { statuses.push({ id, patch }) },
      sendWebhook: overrides.sendWebhook ?? (async (url, result) => { webhooks.push({ url, result }); return { ok: true } }),
      onLog: () => {},
    },
  }
}

/*
 * РАБОЧИЙ КАТАЛОГ УДАЛЯЕТСЯ ДАЖЕ ПРИ ОТКАЗЕ.
 *
 * Один невычищенный каталог — сотни мегабайт скачанных сцен. Воркер, работающий сутками, забивает диск
 * за день и встаёт с «нет места», а причина выглядит как проблема инфраструктуры, а не как забытая
 * уборка.
 */
await checkAsync(async () => {
  const workRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'nemo-media-test-'))
  try {
    const harness = makeDeps({ workRoot, fetchAsset: async () => { throw new Error('исходник недоступен') } })
    const result = await renderTask(VideoRenderTaskSchema.parse(TASK), harness.deps)
    assert.equal(result.status, 'FAILED')
    assert.match(result.error, /исходник недоступен/)
    const left = await fs.readdir(workRoot)
    assert.deepEqual(left, [], `после отказа осталось: ${left.join(', ')}`)
  } finally {
    await fs.rm(workRoot, { recursive: true, force: true })
  }
})

// Отказ рендера сообщает ПРИЧИНУ и код: «не получилось» без причины разбирают повторным запуском на
// боевых данных.
await checkAsync(async () => {
  const workRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'nemo-media-test-'))
  try {
    const harness = makeDeps({ workRoot })
    harness.deps.ffmpegPath = 'ffmpeg-которого-нет'
    const result = await renderTask(VideoRenderTaskSchema.parse(TASK), harness.deps)
    assert.equal(result.status, 'FAILED')
    assert.ok(result.error && result.error.length > 0, 'у неудачи обязана быть причина')
    assert.equal(result.outputPath, '', 'путь к несуществующему файлу возвращать нельзя')
  } finally {
    await fs.rm(workRoot, { recursive: true, force: true })
  }
})

// Негодная задача из очереди отбрасывается, а не возвращается в неё: возврат зациклил бы воркер.
await checkAsync(async () => {
  const logs = []
  const harness = makeDeps()
  harness.deps.redis = { blpop: async () => [RENDER_QUEUE_KEY, '{битый'], rpush: async () => 1, quit: async () => 'OK' }
  harness.deps.onLog = (line) => logs.push(line)
  assert.equal(await processOnce(harness.deps), null)
  assert.ok(logs.some((line) => line.includes('негодная задача')))
})

await checkAsync(async () => {
  const harness = makeDeps()
  harness.deps.redis = { blpop: async () => null, rpush: async () => 1, quit: async () => 'OK' }
  assert.equal(await processOnce(harness.deps), null, 'пустая очередь — не ошибка')
})

// Обрыв соединения с очередью не должен ронять воркер: следующий заход попробует снова.
await checkAsync(async () => {
  const harness = makeDeps()
  harness.deps.redis = { blpop: async () => { throw new Error('соединение разорвано') }, rpush: async () => 1, quit: async () => 'OK' }
  assert.equal(await processOnce(harness.deps), null)
})

// ─── Проба возможностей ───────────────────────────────────────────────────────────────────────────

await checkAsync(async () => {
  const capabilities = await probeCapabilities('ffmpeg', async () => ({
    code: 0, timedOut: false, stderr: '',
    stdout: ['Filters:', '', '', '', '', '', '', '',
      ' ... scale             V->V       Scale',
      ' ... concat            N->N       Concat',
      ' ... crop              V->V       Crop',
    ].join('\n'),
  }))
  assert.equal(capabilities.has('scale'), true)
  assert.equal(capabilities.has('ass'), false)
  assert.deepEqual(capabilities.missingRequired, [])
})

// Проба не удалась — набор пуст, обязательные считаются недостающими. Это правильнее, чем
// предположить, что всё на месте, и упасть на середине рендера.
await checkAsync(async () => {
  const capabilities = await probeCapabilities('нет-такого', async () => { throw new Error('ENOENT') })
  assert.equal(capabilities.filters.size, 0)
  assert.deepEqual(capabilities.missingRequired, ['scale', 'crop', 'concat'])
})

await checkAsync(async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nemo-cleanup-'))
  await fs.writeFile(path.join(dir, 'a.tmp'), 'x')
  assert.equal(await cleanupWorkDir(dir), null)
  await assert.rejects(() => fs.stat(dir))
})
// Отказ удаления сообщается, но НЕ бросает: он не должен отменять уже готовый ролик.
await checkAsync(async () => assert.equal(await cleanupWorkDir(path.join(os.tmpdir(), 'нет-такого-каталога')), null))

// ─── Синтетические исходники ──────────────────────────────────────────────────────────────────────
//
// Пишутся руками, потому что ffmpeg в этом дереве собран без демультиплексора lavfi: инструмент,
// которым надо проверять рендер, не может создать материал для проверки.

check(() => {
  const png = makeSolidPng(4, 3, [255, 0, 0])
  assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 'сигнатура PNG')
  assert.equal(png.subarray(12, 16).toString('latin1'), 'IHDR')
  assert.equal(png.readUInt32BE(16), 4)
  assert.equal(png.readUInt32BE(20), 3)
  assert.ok(png.subarray(-8).toString('latin1').includes('IEND'))
})
check(() => {
  const wav = makeSineWav(0.5, 440, 8_000)
  assert.equal(wav.subarray(0, 4).toString('latin1'), 'RIFF')
  assert.equal(wav.subarray(8, 12).toString('latin1'), 'WAVE')
  assert.equal(wav.readUInt32LE(24), 8_000, 'частота дискретизации в заголовке')
  assert.equal(wav.length, 44 + 4_000 * 2, 'полсекунды по 8 кГц — 4000 отсчётов по два байта')
  // Тон, а не тишина: тишина проходит через микширование неотличимо от отсутствующей дорожки.
  assert.notEqual(wav.readInt16LE(44 + 100), 0)
})

console.log(`[OK] Media pipeline behaviour: ${checks} assertions`)
