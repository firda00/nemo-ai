/*
 * Сборка deploy/init-supabase.sql из миграций.
 *
 * ПОЧЕМУ ГЕНЕРАТОР, А НЕ ФАЙЛ, НАПИСАННЫЙ РУКАМИ.
 *
 * Схема живёт в supabase/migrations — там 144 файла и десять тысяч строк, и там же лежат политики
 * RLS, которые создаются, переопределяются и удаляются на протяжении всей истории. Итоговый набор
 * политик по одному файлу не прочитать: это результат ВОСПРОИЗВЕДЕНИЯ всех миграций по порядку —
 * именно так его и проверяет agent-hub/auth-rls-contracts.mjs.
 *
 * Схема, переписанная рядом руками, — это второй источник правды. Он совпадает с первым ровно до
 * следующей миграции, а потом расходится молча: обе версии выглядят рабочими, и на новом проекте
 * поднимется база, отличающаяся от боевой в мелочах вроде одной политики. Такое находят по утечке
 * чужих данных, а не по красной сборке.
 *
 * Поэтому файл СОБИРАЕТСЯ и помечен как собранный. Править надо миграцию, потом пересобрать.
 *
 * Запуск: node deploy/build-init-sql.mjs
 */
import fs from 'node:fs'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..')
const migrations = path.join(root, 'supabase/migrations')
const out = path.join(root, 'deploy/init-supabase.sql')

// Порядок — по имени файла: миграции Supabase именуются меткой времени, и лексикографический
// порядок совпадает с хронологическим. Сортировка обязательна: readdirSync порядок не гарантирует.
const files = fs.readdirSync(migrations).filter((name) => name.endsWith('.sql')).sort()
if (!files.length) throw new Error('миграций не найдено — нечего собирать')

const header = [
  '-- ЭТОТ ФАЙЛ СОБРАН. НЕ ПРАВЬТЕ ЕГО РУКАМИ.',
  '--',
  '-- Источник — supabase/migrations. Правка здесь потеряется при следующей сборке, а до тех пор',
  '-- будет расходиться с боевой базой молча: оба файла выглядят рабочими.',
  '--',
  '--   изменить схему:  создать миграцию в supabase/migrations',
  '--   пересобрать:     node deploy/build-init-sql.mjs',
  '--   применить:       supabase db push   (предпочтительно — умеет докатывать)',
  '--',
  '-- Этот файл нужен для ОДНОГО случая: поднять схему на чистом проекте вставкой в SQL-редактор,',
  '-- когда CLI недоступен. Для существующего проекта используйте db push: повторный прогон всего',
  '-- файла целиком безопаснее не стал — часть миграций не идемпотентна.',
  '--',
  `-- Собрано из ${files.length} миграций: ${files[0]} … ${files[files.length - 1]}`,
  '',
  'begin;',
  '',
].join('\n')

const body = files.map((name) => [
  `-- ─── ${name} ${'─'.repeat(Math.max(0, 88 - name.length))}`,
  fs.readFileSync(path.join(migrations, name), 'utf8').trimEnd(),
  '',
].join('\n')).join('\n')

fs.mkdirSync(path.dirname(out), { recursive: true })
fs.writeFileSync(out, `${header}${body}\ncommit;\n`)

const lines = fs.readFileSync(out, 'utf8').split('\n').length
console.log(`deploy/init-supabase.sql собран: ${files.length} миграций, ${lines} строк`)
