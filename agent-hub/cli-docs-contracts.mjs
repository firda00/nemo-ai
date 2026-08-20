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
  const installs = [...docs.matchAll(/command: '(?:npm i -g|npx) ([a-z0-9@/-]+)/g)].map((m) => m[1])
  const wrong = installs.filter((name) => name !== pkg.name)
  check('команды установки ставят наш пакет', wrong.length === 0,
    wrong.length ? `в документации: ${[...new Set(wrong)].join(', ')}, в package.json: ${pkg.name}` : pkg.name)
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

  const ps = commandOf('powershell', 'unix')
  check('в команде для PowerShell нет &&', ps.includes('&&') === false,
    ps.includes('&&') ? `скопированная строка там не выполнится: ${ps}` : ps)
  check('в команде для PowerShell есть ;', ps.includes(';'), ps)

  const unix = commandOf('unix', 'npx')
  check('в команде для macOS/Linux есть &&', unix.includes('&&'), unix)

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
