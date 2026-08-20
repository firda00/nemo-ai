/*
 * Сборка автономного CLI: dist/cli.js, запускаемый обычным `node` без флагов.
 *
 * ЗАЧЕМ СБОРКА ВООБЩЕ. Точка входа импортирует .ts-модули и потому требует
 * --experimental-strip-types, а глобальная команда обязана запускаться сама: пользователь набирает
 * `nemo`, а не вспоминает флаги Node. esbuild снимает типы на этапе сборки, и на выходе — обычный
 * JavaScript.
 *
 * ЧТО ОСТАВЛЕНО СНАРУЖИ (external) и почему это не оплошность:
 *   — puppeteer и playwright тянут за собой браузер весом в сотни мегабайт. Они нужны лишь части
 *     команд (/qa, /browse), и вшивать их в каждый запуск — значит сделать установку неподъёмной.
 *     Отсутствие этих пакетов CLI переживает: сами инструменты просто не регистрируются.
 *   — @supabase/supabase-js и подобные тянутся как обычные зависимости пакета.
 *
 * Проверка ниже — часть сборки, а не отдельный шаг: собранный файл, в котором нет строки запуска
 * или есть секрет, не должен попасть в dist молча.
 */
import { build } from 'esbuild'
import fs from 'node:fs'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..')
const outfile = path.join(root, 'dist', 'cli.js')

const EXTERNAL = ['puppeteer', 'playwright', 'playwright-core', '@supabase/supabase-js', 'fluent-ffmpeg']

await build({
  entryPoints: [path.join(root, 'agent-hub', 'nemo.mjs')],
  outfile,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  external: EXTERNAL,
  // Строка запуска обязана быть ПЕРВОЙ в файле, иначе оболочка не поймёт, чем его исполнять.
  banner: { js: '#!/usr/bin/env node' },
  logLevel: 'warning',
  // Имена сохраняются: в трассировке стека у пользователя должны быть читаемые названия функций,
  // иначе сообщение об ошибке из чужой машины бесполезно.
  keepNames: true,
})

const bundled = fs.readFileSync(outfile, 'utf8')

const problems = []
if (!bundled.startsWith('#!/usr/bin/env node')) problems.push('нет строки запуска в первой строке')

/*
 * СЕКРЕТОВ В СОБРАННОМ ФАЙЛЕ БЫТЬ НЕ МОЖЕТ.
 *
 * Он уезжает на чужие машины целиком. Ключ, случайно затянутый импортом из .secrets.local или
 * оставленный в константе, окажется у каждого, кто установил пакет, — и узнаем мы об этом по
 * счёту за чужое потребление. Публикуемый ключ Supabase исключён намеренно: он публичен по замыслу
 * и ограничен политиками RLS.
 */
const SECRET_SHAPES = [
  [/sk-or-v1-[A-Za-z0-9]{16,}/, 'ключ OpenRouter'],
  [/sb_secret_[A-Za-z0-9_-]{16,}/, 'служебный ключ Supabase'],
  [/\bservice_role\b/, 'упоминание service_role'],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, 'приватный ключ'],
  [/\b\d{8,10}:[A-Za-z0-9_-]{35}\b/, 'токен Telegram-бота'],
]
for (const [shape, name] of SECRET_SHAPES) {
  if (shape.test(bundled)) problems.push(`в сборку попал ${name}`)
}

if (problems.length) {
  fs.rmSync(outfile, { force: true })
  console.error('Сборка отклонена:')
  for (const problem of problems) console.error(`  — ${problem}`)
  process.exit(1)
}

fs.chmodSync(outfile, 0o755)
const size = (fs.statSync(outfile).size / 1024).toFixed(0)
console.log(`dist/cli.js собран: ${size} КБ, вне сборки оставлены ${EXTERNAL.length} пакета(ов)`)
