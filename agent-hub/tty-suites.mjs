// Прогон наборов проверок так, будто под процессом ЖИВОЙ ТЕРМИНАЛ.
//
// ЗАЧЕМ ОТДЕЛЬНЫЙ ПРОГОН. Утверждение вида `menu.includes('[1] CSV')` на раскрашенной строке ищет
// подстроку, которой там нет: между «[1]» и «CSV» стоит ESC[0m. В конвейере — а гейт качества и CI
// это конвейер — цвет выключен, проверка проходит. В терминале разработчика цвет включается, и та же
// проверка на том же коде падает.
//
// Это худший вид отказа из возможных: он не воспроизводится там, где его ищут, и по стектрейсу
// причину не увидеть. Дважды такие проверки уходили в основную ветку зелёными и падали у человека —
// в tui-behavior и в query-parse-behavior. Оба раза находились они не разбором, а чужим отчётом.
//
// Прогон запускает те же наборы во втором окружении. Стоит секунды, ловит целый класс.

import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { readdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))

/**
 * Наборы, чьи проверки смотрят на отрисованные строки.
 *
 * Списком, а не поиском по каталогу: набор, проверяющий разбор JSON, от цвета не зависит, и гонять
 * его дважды — тратить время гейта без пользы. Здесь только те, где есть отрисовка.
 */
const SUITES = [
  'tui-behavior.mjs',
  'query-parse-behavior.mjs',
  'cli-commands-behavior.mjs',
  'agent-behavior.mjs',
  'lead-report-behavior.mjs',
]

/**
 * Ребёнок, которому подменён stdout.isTTY.
 *
 * Отдельный процесс обязателен: подменить isTTY в этом же нельзя — наборы уже загружены, а палитра
 * по умолчанию строится при импорте tui.mjs.
 *
 * Путь передаётся ПЕРЕМЕННОЙ ОКРУЖЕНИЯ, а не аргументом: при запуске через --eval нумерация argv
 * сдвигается, и argv[2] оказывается не тем, чем кажется. Ошибка была ровно такой и выглядела как
 * «Cannot find package 'undefined'».
 */
const CHILD = `
Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true })
Object.defineProperty(process.stderr, 'isTTY', { value: true, configurable: true })
delete process.env.NO_COLOR
await import(process.env.NEMO_TTY_SUITE)
`

async function runSuite(file) {
  const url = pathToFileURL(path.join(here, file)).href
  return await new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      ['--experimental-strip-types', '--input-type=module', '--eval', CHILD],
      { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, NEMO_TTY_SUITE: url, NO_COLOR: '' } },
    )
    let output = ''
    child.stdout.on('data', (chunk) => { output += chunk.toString() })
    child.stderr.on('data', (chunk) => { output += chunk.toString() })
    child.on('error', (error) => resolve({ file, ok: false, output: error.message }))
    child.on('close', (code) => resolve({ file, ok: code === 0, output }))
  })
}

/*
 * СПИСОК НЕ ДОЛЖЕН ОТСТАВАТЬ ОТ КАТАЛОГА.
 *
 * Набор, который завели позже и забыли сюда вписать, остаётся непроверенным во втором окружении —
 * молча, и обнаружится это опять чужим отчётом. Признак объективный: файл проверок, импортирующий
 * отрисовку, обязан быть в списке.
 */
const RENDER_IMPORTS = /from '\.\/(tui|lead-report|nemo-ui)\.mjs'/
const missing = (await readdir(here))
  .filter((file) => file.endsWith('-behavior.mjs'))
  .filter((file) => !SUITES.includes(file))
  .filter((file) => RENDER_IMPORTS.test(readFileSync(path.join(here, file), 'utf8')))

if (missing.length) {
  console.error(`[FAIL] Suites under a TTY: наборы с отрисовкой не в списке: ${missing.join(', ')}`)
  console.error('       Впишите их в SUITES — иначе они проверяются только там, где цвет выключен.')
  process.exit(1)
}

const results = []
for (const file of SUITES) results.push(await runSuite(file))

const failed = results.filter((one) => !one.ok)
for (const one of results) {
  console.log(`  ${one.ok ? '✓' : '×'} ${one.file}`)
  if (!one.ok) {
    // Показываем ХВОСТ вывода, а не первую строку: assert печатает причину и место после заголовка,
    // и без них отчёт «набор упал» не помогает.
    for (const line of one.output.split(/\r?\n/).filter((line) => line.trim()).slice(0, 12)) {
      console.log(`      ${line}`)
    }
  }
}

if (failed.length) {
  console.error(`[FAIL] Suites under a TTY: упало ${failed.length} из ${results.length}`)
  console.error('       Проверка смотрит на раскрашенную строку. Оберните её в stripAnsi() из tui.mjs.')
  process.exit(1)
}
console.log(`[OK] Suites under a TTY: ${results.length} наборов`)
