// Документация CLI обязана совпадать с самим CLI.
//
// ЗАЧЕМ ЭТО ОТДЕЛЬНОЙ ПРОВЕРКОЙ. Страница /docs/cli — первое, что видит человек, решивший
// попробовать продукт. Команда, которой на самом деле нет, отправляет его в тупик: он набирает,
// получает «нет такой команды» и уходит с выводом, что сломан продукт, а не документация.
//
// Расхождение возникает не злым умыслом, а обычным порядком вещей: команду переименовали в
// commands.ts, страницу править забыли. Автоматически это не всплывает нигде — страница
// продолжает собираться и выглядеть исправной.
//
// Запуск: npm run test:cli-docs
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'

const root = path.resolve(import.meta.dirname, '..')
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8').replace(/\r\n/g, '\n')

let failed = 0
const check = (name, ok, detail = '') => {
  if (ok) console.log(`[OK]   ${name}${detail ? ` — ${detail}` : ''}`)
  else { failed += 1; console.error(`[FAIL] ${name}${detail ? ` — ${detail}` : ''}`) }
}

const docs = read('src/content/cliDocs.ts')
const page = read('src/pages/CliDocsPage.tsx')
const app = read('src/App.tsx')
const header = read('src/components/layout/MarketingHeader.tsx')
const commands = read('agent-hub/cli/commands.ts')
const roles = read('agent-hub/cli/roles.ts')
const pkg = JSON.parse(read('package.json'))

// ── Страница доступна ────────────────────────────────────────────────────────────────────────
check('маршрут /docs/cli объявлен', /path="\/docs\/cli"/.test(app))
// Короткий адрес тоже: его набирают руками чаще, чем длинный.
check('маршрут /docs объявлен', /path="\/docs"/.test(app))
check('ссылка в шапке лендинга', /\/docs\/cli/.test(header))

// ── Слеш-команды из документации существуют в CLI ────────────────────────────────────────────
{
  const declared = new Set([...commands.matchAll(/\{ name: '([a-z-]+)'/g)].map((m) => m[1]))
  const mentioned = [...new Set([...docs.matchAll(/command: '\/([a-z-]+)/g)].map((m) => m[1]))]
  const missing = mentioned.filter((name) => !declared.has(name))
  check('все слеш-команды документации существуют', missing.length === 0,
    missing.length ? `нет в CLI: ${missing.join(', ')}` : `${mentioned.length} команд сверено`)
}

// ── Роли из документации существуют ──────────────────────────────────────────────────────────
{
  const declared = new Set([...roles.matchAll(/^  ([a-z]+): \{$/gm)].map((m) => m[1]))
  const mentioned = [...new Set([...docs.matchAll(/\/agent ([a-z]+)/g)].map((m) => m[1]))]
  const missing = mentioned.filter((name) => !declared.has(name))
  check('все роли документации существуют', missing.length === 0,
    missing.length ? `нет в roles.ts: ${missing.join(', ')}` : `${mentioned.length} ролей сверено`)
}

/*
 * ── Имя пакета в командах установки совпадает с package.json ────────────────────────────────
 *
 * `npm i -g nemo-ai` установит ЧУЖОЙ пакет, если наш называется иначе. Это не опечатка в тексте,
 * а отправка пользователя к постороннему коду с правами глобальной установки.
 */
{
  /*
   * ИСТОЧНИК УСТАНОВКИ ОБЯЗАН БЫТЬ НАШИМ, И ПРОВЕРЯТЬ ЭТО НАДО НЕ ПО ИМЕНИ В package.json.
   *
   * Первая редакция сверяла имя пакета из команды с polem name в package.json — они совпадали, и
   * проверка проходила. Но имя `nemo-ai` В РЕЕСТРЕ NPM ПРИНАДЛЕЖИТ ПОСТОРОННЕМУ (автор emadjumaah).
   * То есть документация честно совпадала сама с собой и при этом велела людям ставить чужой код
   * глобально. Совпадение с package.json ничего не говорит о том, кому принадлежит имя снаружи.
   *
   * Пока своё имя в реестре не занято, единственный безопасный источник — репозиторий проекта.
   * Проверяется явно: спецификация обязана быть github:firda00/... либо областью, которой мы
   * владеем. Голое имя пакета запрещено.
   */
  const specs = [...docs.matchAll(/command: '(?:npm i -g|npm install -g|npx) ([^ ']+)/g)].map((m) => m[1])
  const OWN = /^(?:github:firda00\/|@nemoai\/|@firda00\/)/
  const bare = specs.filter((spec) => !OWN.test(spec))
  check('установка ведёт в наш источник, а не в чужой пакет реестра', bare.length === 0,
    bare.length ? `голые имена: ${[...new Set(bare)].join(', ')} — в npm они могут принадлежать кому угодно` : `${specs.length} команд`)

  // Скрипты установки не должны обходить это правило своим путём.
  for (const [name, text] of [['install.sh', read('public/install.sh')], ['install.ps1', read('public/install.ps1')]]) {
    const inScript = [...text.matchAll(/npm install -g ["'$]?([^ "'$\n]+)/g)].map((m) => m[1])
    const suspicious = inScript.filter((spec) => !OWN.test(spec) && !spec.includes('Repo') && !spec.includes('REPO'))
    check(`${name} ставит из нашего источника`, suspicious.length === 0,
      suspicious.length ? suspicious.join(', ') : 'из переменной с github: спецификацией')
    check(`${name} называет наш репозиторий`, /github:firda00\/nemo-ai/.test(text))
  }
}

/*
 * ── Установка из git требует prepare, а не prepack ──────────────────────────────────────────
 *
 * npm запускает prepare при установке из git И ставит для него devDependencies. prepack при такой
 * установке не вызывается вовсе — значит dist/cli.js не соберётся, команда nemo не появится, и
 * человек получит «успешную» установку без самой программы. Проверено вживую: ровно так и вышло.
 */
check('сборка CLI привязана к prepare', pkg.scripts?.prepare?.includes('build:cli') === true,
  pkg.scripts?.prepare ?? 'prepare отсутствует')
check('prepack не подменяет prepare', !pkg.scripts?.prepack,
  pkg.scripts?.prepack ? 'prepack при установке из git не вызывается' : 'нет')

// ── Нативные установщики опубликованы и доступны по адресу из документации ──────────────────
{
  const shPath = path.join(root, 'public/install.sh')
  const psPath = path.join(root, 'public/install.ps1')
  check('install.sh лежит в public', fs.existsSync(shPath))
  check('install.ps1 лежит в public', fs.existsSync(psPath))

  const urls = [...docs.matchAll(/(https:\/\/[^ '|]+\/install\.(?:sh|ps1))/g)].map((m) => m[1])
  check('в документации есть обе однострочные команды', urls.length >= 2, urls.join(', '))

  /*
   * Адрес в документации обязан вести на файл, который мы кладём в public. Опечатка в имени даёт
   * страницу приложения вместо скрипта — а `curl … | bash` выполнит её как оболочку, и человек
   * увидит поток синтаксических ошибок вместо установки.
   */
  const wrongName = urls.filter((url) => !/\/install\.(?:sh|ps1)$/.test(url))
  check('адреса установщиков совпадают с именами файлов', wrongName.length === 0, wrongName.join(', '))

  const sh = read('public/install.sh')
  check('install.sh проверяет наличие Node.js', /command -v node/.test(sh))
  check('install.sh проверяет версию Node.js', /NODE_MIN_MAJOR|20/.test(sh) && /NODE_MIN_MINOR|6/.test(sh))
  check('install.sh сообщает об успехе', /Nemo CLI успешно установлен/.test(sh))
  check('install.sh проверяет, что команда нашлась', /command -v nemo/.test(sh))
  // Без set -e скрипт молча продолжает после отказа установки и рапортует об успехе.
  check('install.sh останавливается на первой ошибке', /set -euo pipefail/.test(sh))

  const ps = read('public/install.ps1')
  check('install.ps1 проверяет наличие Node.js', /Get-Command node/.test(ps))
  check('install.ps1 проверяет команду nemo', /Get-Command nemo/.test(ps))
  check('install.ps1 обновляет PATH текущей сессии', /GetEnvironmentVariable\('Path'/.test(ps))
  // 2>&1 к native-команде в PowerShell 5.1 ломает $? — результат обязан читаться по $LASTEXITCODE.
  check('install.ps1 читает код возврата npm', /\$LASTEXITCODE/.test(ps))
}

// Команда, объявленная в bin, — та же, что человек набирает по документации.
{
  const binName = Object.keys(pkg.bin ?? {})[0] ?? ''
  check('команда из bin названа в документации', Boolean(binName) && docs.includes(`command: '${binName}'`),
    binName || 'bin не объявлен')
}

/*
 * ── Разделитель команд по разным оболочкам ──────────────────────────────────────────────────
 *
 * `&&` в PowerShell до версии 7 — ошибка разбора, а не разделитель. Человек копирует строку из
 * инструкции для macOS, получает красный текст и решает, что продукт сломан. Поэтому вкладка
 * PowerShell обязана давать точку с запятой, а страница — предупреждать об этом ВИДИМО, а не
 * сноской.
 */
{
  /*
   * Смотрим ТОЛЬКО на строку command, а не на весь блок вкладки.
   *
   * Первая редакция брала блок целиком и падала на исправном файле: в пояснении под командой «&&»
   * упомянут как раз затем, чтобы объяснить, почему его там нельзя. Проверка ловила собственную
   * документацию — четвёртый случай этого класса в репозитории.
   */
  const commandOf = (id, next) => {
    const block = docs.slice(docs.indexOf(`id: '${id}'`), docs.indexOf(`id: '${next}'`))
    return block.match(/command: '([^']*)'/)?.[1] ?? ''
  }

  const psNative = commandOf('native-windows', 'npm-unix')
  check('однострочник для Windows идёт через irm | iex', /irm .*\| iex/.test(psNative), psNative)

  const psNpm = commandOf('npm-windows', 'source')
  check('в команде npm для PowerShell нет &&', psNpm.includes('&&') === false,
    psNpm.includes('&&') ? `скопированная строка там не выполнится: ${psNpm}` : psNpm)
  check('в команде npm для PowerShell есть ;', psNpm.includes(';'), psNpm)

  const unixNative = commandOf('native-unix', 'native-windows')
  check('однострочник для macOS/Linux идёт через curl | bash', /curl -fsSL .*\| bash/.test(unixNative), unixNative)

  const unixNpm = commandOf('npm-unix', 'npm-windows')
  check('в команде npm для macOS/Linux есть &&', unixNpm.includes('&&'), unixNpm)

  /*
   * НАТИВНАЯ УСТАНОВКА — ПЕРВАЯ. Её и рекомендуем: она проверяет Node, ставит и честно говорит,
   * если команда не попала в PATH. Порядок вкладок — это и есть рекомендация: первую пробуют.
   */
  const firstTab = docs.slice(docs.indexOf('INSTALL_TABS')).match(/id: '([a-z-]+)'/)?.[1]
  check('нативная установка стоит первой', firstTab?.startsWith('native') === true, firstTab ?? '?')

  check('предупреждение о PowerShell видно на странице', /PowerShell/.test(page) && /TriangleAlert|Alert/.test(page))
}

/*
 * ── Оговорка про расход на модель ───────────────────────────────────────────────────────────
 *
 * Вход в аккаунт не оплачивает обращения к модели: они идут по личному ключу OpenRouter. Умолчать
 * значит, что человек установит, войдёт и упрётся в отказ, не понимая, чего от него хотят. Пока
 * прокси с оплатой по балансу не построен, эта оговорка обязана быть на странице.
 */
/*
 * Текст ищется в docs И в page: по правилу проекта содержание живёт в src/content, а разметка — в
 * странице. Первая редакция смотрела только в JSX и упала, когда текст переехал в content, — то
 * есть наказала за соблюдение договорённости.
 *
 * Оговорка обязана быть НА ВСЕХ ТРЁХ ЯЗЫКАХ: продукт продаётся в Узбекистане, и предупреждение о
 * расходах, понятное только русскоязычному, — это предупреждение не для всех.
 */
{
  const both = `${docs}\n${page}`
  check('сказано, что модель оплачивается своим ключом',
    /OpenRouter/.test(both) && /баланс/i.test(both))
  check('оговорка о расходах на трёх языках',
    /OpenRouter/.test(docs) && /balance/i.test(docs) && /hisob balansi/i.test(docs))
  check('назван путь без ключа (локальная модель)', /\/model local/.test(both))
}

// Требование к среде названо: без него установка падает с невнятной ошибкой Node.
check('названа версия Node', /NODE_REQUIREMENT/.test(page) && /20\.6/.test(docs))

// Копирование команды — кнопкой, а не выделением мышью по многострочной команде.
check('есть кнопка копирования', /navigator\.clipboard/.test(page))

console.log()
if (failed) { console.error(`Документация CLI: ${failed} проверок упало.`); process.exit(1) }
console.log('Документация CLI: всё сходится с самим CLI.')
