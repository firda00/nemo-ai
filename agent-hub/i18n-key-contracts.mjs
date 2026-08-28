/**
 * Ключ, которого нет в словаре, выглядит на экране как ключ.
 *
 * `t()` при промахе возвращает сам путь — сделано нарочно, чтобы пропажа была заметна. Но заметна
 * она только тому, кто откроет этот экран на этом языке. Перевод, добавленный в русский словарь и
 * забытый в узбекском, доезжает до продакшена молча: гейт зелёный, а пользователь видит
 * `forgePage.errApprovals` вместо текста.
 *
 * Проверка берёт все литеральные `t('…')` с переведённых экранов и требует, чтобы путь
 * разрешался в строку ВО ВСЕХ ТРЁХ словарях. Одного языка недостаточно: именно неполнота, а не
 * полное отсутствие, ломается тише всего.
 *
 * Отдельно ловится случай, ради которого это и написано: экран может быть переведён целиком, а
 * текст ему подаёт хук. `ForgePage.tsx` числился чистым и был чистым — русские строки лежали в
 * `useForgeExecution.ts` и всплывали поверх английского интерфейса.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** Файлы, чьи ключи обязаны существовать. Экраны и хуки, которые их кормят. */
const SOURCES = [
  'src/pages/app/ForgePage.tsx',
  'src/hooks/useForgeExecution.ts',
  'src/pages/app/SettingsPage.tsx',
  'src/pages/app/BillingPage.tsx',
  'src/pages/PricingPage.tsx',
]

// Словари живут в TypeScript и собраны из двух файлов через deepMerge. Регулярка тут не годится:
// проверять надо то, что реально попадёт в браузер, а не то, что написано в исходнике.
const bundled = await build({
  entryPoints: [path.join(root, 'src/i18n/translations.ts')],
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  write: false,
  logLevel: 'silent',
})
const source = bundled.outputFiles[0].text
const { translations } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`)

const LANGS = ['uz', 'ru', 'en']
for (const lang of LANGS) assert.ok(translations[lang], `словарь ${lang} не собрался`)

function resolve(dict, dotted) {
  return dotted.split('.').reduce((acc, key) => (acc && typeof acc === 'object' ? acc[key] : undefined), dict)
}

/*
 * Берутся только литералы: `t('a.b')`. Вычисляемый путь — `t(\`plans.${code}\`)` — статически не
 * проверить, и притворяться, что проверили, хуже, чем пропустить.
 */
function literalKeys(file) {
  const body = readFileSync(path.join(root, file), 'utf8')
  return [...body.matchAll(/\bt\(\s*'([A-Za-z0-9_.]+)'/g)].map((match) => match[1])
}

let missing = 0
let checked = 0
for (const file of SOURCES) {
  const keys = [...new Set(literalKeys(file))]
  const broken = []
  for (const key of keys) {
    checked += 1
    const gaps = LANGS.filter((lang) => typeof resolve(translations[lang], key) !== 'string')
    if (gaps.length) broken.push(`${key} → нет в ${gaps.join(', ')}`)
  }
  if (broken.length) {
    missing += broken.length
    console.log(`[FAIL] ${file}: ${broken.length} из ${keys.length} ключей неполны`)
    for (const line of broken.slice(0, 8)) console.log(`       ${line}`)
  } else {
    console.log(`[OK] ${file}: ${keys.length} ключей во всех трёх языках`)
  }
}

/*
 * Коды ошибок Forge задаются строкой и уходят в `t()` шаблоном, поэтому в выборку литералов не
 * попадают. Проверяются по своему списку — иначе самый первый повод для этой проверки остался бы
 * непроверенным.
 */
const hook = readFileSync(path.join(root, 'src/hooks/useForgeExecution.ts'), 'utf8')
const codes = [...hook.matchAll(/'(err[A-Za-z]+)'/g)].map((match) => match[1])
assert.ok(codes.length >= 8, `коды ошибок Forge не найдены в хуке (нашлось ${codes.length})`)
for (const code of [...new Set(codes)]) {
  checked += 1
  const gaps = LANGS.filter((lang) => typeof resolve(translations[lang], `forgePage.${code}`) !== 'string')
  if (gaps.length) {
    missing += 1
    console.log(`[FAIL] forgePage.${code} → нет в ${gaps.join(', ')}`)
  }
}
console.log(`[OK] коды ошибок Forge: ${new Set(codes).size} шт.`)

assert.equal(missing, 0, 'на переведённом экране используется ключ, которого нет в словаре')
console.log(`\nI18n key contracts passed (${checked} проверок).`)
