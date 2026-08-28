/**
 * Текст, написанный прямо в разметке, переключателем языка не переводится.
 *
 * Это не теория: страницы Forge и Настроек оставались русскими на EN и UZ, потому что все их
 * строки жили в JSX, а не в словаре. Заметил это владелец на своих же скриншотах, а не проверка —
 * контракта, который запрещал бы такое, в репозитории не было. Гейт при этом был зелёный.
 *
 * Проверка НЕ пытается вычистить весь репозиторий разом: список ниже — это то, что уже приведено
 * в порядок и обязано таким остаться. Остальное печатается справочно, чтобы объём долга был виден
 * и не забывался.
 */
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (file) => readFileSync(path.join(root, file), 'utf8')

/**
 * Экраны, переведённые полностью. Добавили сюда — обратной дороги нет.
 *
 * Хуки в списке не для полноты: экран может быть чист, а текст ему подавать хук. Forge ровно так и
 * протёк — `ForgePage.tsx` числился здесь и был честно чист, а восемь русских сообщений об ошибках
 * лежали в `useForgeExecution.ts` и всплывали поверх английского интерфейса. Проверять надо всё,
 * что доносит строку до экрана, а не только сам экран.
 */
const CLEAN = [
  'src/hooks/useForgeExecution.ts',
  'src/pages/app/ForgePage.tsx',
  'src/pages/app/SettingsPage.tsx',
  'src/pages/app/BillingPage.tsx',
  'src/pages/PricingPage.tsx',
]

/**
 * Названия языков пишутся на самих этих языках — это не забытый перевод, а единственная верная
 * форма: в списке выбора «Русский» обязан оставаться «Русским» и на английском интерфейсе.
 */
const ALLOWED = new Set(['Русский'])

/** Комментарии — не интерфейс. Русский комментарий в коде переводить незачем. */
function stripComments(source) {
  return source
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
}

function hardcodedStrings(file) {
  const body = stripComments(read(file))
  const found = []
  for (const match of body.matchAll(/["'>]([^"'<>]*[а-яА-ЯёЁ]{4,}[^"'<>]*)/g)) {
    const text = match[1].trim()
    if (text && !ALLOWED.has(text)) found.push(text)
  }
  return found
}

let failed = 0
for (const file of CLEAN) {
  const found = hardcodedStrings(file)
  if (found.length) {
    failed += found.length
    console.log(`[FAIL] ${file}: ${found.length} строк мимо словаря`)
    for (const text of found.slice(0, 5)) console.log(`       ${text.slice(0, 90)}`)
  } else {
    console.log(`[OK] ${file}`)
  }
}

// Справочно: сколько осталось на остальных экранах. Не роняет прогон — это долг, а не регресс.
const pagesDir = path.join(root, 'src/pages')
const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
  const full = path.join(dir, entry.name)
  return entry.isDirectory() ? walk(full) : entry.name.endsWith('.tsx') ? [path.relative(root, full).split(path.sep).join('/')] : []
})
// Часть экранов носит собственный словарь по языкам (`copy[lang]`) вместо общего t(). Их русские
// строки — это русский ВАРИАНТ, а не забытый перевод, и в долг их записывать неверно.
const hasOwnDictionary = (file) => {
  const body = read(file)
  return body.includes('copy' + String.fromCharCode(91) + 'lang' + String.fromCharCode(93)) || /lang === .(ru|uz|en)./.test(body)
}

const scanned = walk(pagesDir).filter((file) => !CLEAN.includes(file))
const ownDictionary = scanned.filter(hasOwnDictionary)
const backlog = scanned
  .filter((file) => !hasOwnDictionary(file))
  .map((file) => [file, hardcodedStrings(file).length])
  .filter(([, count]) => count > 0)
  .sort((a, b) => b[1] - a[1])

const total = backlog.reduce((sum, [, count]) => sum + count, 0)
console.log(`\nОсталось непереведённых строк на других экранах: ${total} в ${backlog.length} файлах`)
for (const [file, count] of backlog.slice(0, 5)) console.log(`  ${String(count).padStart(4)}  ${file}`)
console.log(`Экранов со своим словарём по языкам (в долг не идут): ${ownDictionary.length}`)

assert.equal(failed, 0, 'на переведённых экранах снова появился текст мимо словаря')
console.log('\nHardcoded UI text contracts passed.')
