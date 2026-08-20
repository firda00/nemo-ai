/*
 * Забор маркетинговых навыков из github.com/coreyhaines31/marketingskills (MIT).
 *
 * ВЕРСИЯ ЗАКРЕПЛЕНА КОММИТОМ, А НЕ ВЕТКОЙ.
 *
 * Эти файлы становятся ИНСТРУКЦИЯМИ агента. Тянуть их с main значит согласиться, что поведение
 * нашего агента меняется в тот момент, когда посторонний человек вливает изменение в чужой
 * репозиторий, — и узнаем мы об этом по изменившимся ответам, а не по своему коммиту. Закреплённый
 * коммит делает обновление ОСОЗНАННЫМ действием: поменял SHA, перезабрал, посмотрел диф.
 *
 * Берутся только SKILL.md: evals и references весят почти три мегабайта и в промпт не идут.
 *
 * Запуск:  node scripts/vendor-marketing-skills.mjs
 *          node scripts/vendor-marketing-skills.mjs --sha <новый коммит>
 */
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'

const REPO = 'coreyhaines31/marketingskills'
/** Закреплённая версия. Меняется руками, вместе с проверкой дифа. */
const PINNED_SHA = 'c6ea12834be62bdc4180a1385f6455cde84ae60c'

const shaArg = process.argv.indexOf('--sha')
const sha = shaArg > -1 ? process.argv[shaArg + 1] : PINNED_SHA
if (!/^[0-9a-f]{40}$/.test(sha)) {
  console.error(`Нужен полный SHA коммита (40 знаков), получено: ${sha}`)
  process.exit(1)
}

const root = path.resolve(import.meta.dirname, '..')
const out = path.join(root, 'vendor', 'marketingskills')

const api = async (route) => {
  const headers = { Accept: 'application/vnd.github+json', 'User-Agent': 'nemo-ai-vendor' }
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`
  const response = await fetch(`https://api.github.com/repos/${REPO}/${route}`, { headers })
  if (!response.ok) throw new Error(`GitHub ответил ${response.status} на ${route}`)
  return response.json()
}
const raw = async (filePath) => {
  const response = await fetch(`https://raw.githubusercontent.com/${REPO}/${sha}/${filePath}`)
  if (!response.ok) throw new Error(`не удалось скачать ${filePath}: ${response.status}`)
  return response.text()
}

console.log(`Забор из ${REPO}@${sha.slice(0, 10)}`)

const entries = await api(`contents/skills?ref=${sha}`)
const names = entries.filter((e) => e.type === 'dir').map((e) => e.name).sort()
if (!names.length) throw new Error('навыков не найдено — проверьте SHA')

fs.rmSync(out, { recursive: true, force: true })
fs.mkdirSync(path.join(out, 'skills'), { recursive: true })

let written = 0
let skipped = 0
for (const name of names) {
  let text
  try { text = await raw(`skills/${name}/SKILL.md`) } catch { skipped += 1; continue }
  fs.writeFileSync(path.join(out, 'skills', `${name}.md`), text)
  written += 1
}

fs.writeFileSync(path.join(out, 'LICENSE'), await raw('LICENSE'))

fs.writeFileSync(path.join(out, 'PROVENANCE.md'), [
  '# Происхождение',
  '',
  'Каталог собран скриптом `scripts/vendor-marketing-skills.mjs`. РУКАМИ НЕ ПРАВИТЬ:',
  'правка потеряется при следующем заборе, а до тех пор будет расходиться с источником молча.',
  '',
  `- источник: https://github.com/${REPO}`,
  `- коммит: ${sha}`,
  `- лицензия: MIT (файл LICENSE рядом)`,
  `- взято файлов: ${written}${skipped ? ` (пропущено без SKILL.md: ${skipped})` : ''}`,
  '',
  '## Что здесь лежит',
  '',
  'Только SKILL.md каждого навыка. Каталоги evals и references источника не берутся: они весят',
  'почти три мегабайта и в промпт агента не попадают.',
  '',
  '## Обновление',
  '',
  '```',
  'node scripts/vendor-marketing-skills.mjs --sha <новый коммит>',
  '```',
  '',
  'Обновление — ОСОЗНАННОЕ действие, и это не формальность: содержимое становится инструкциями',
  'агента. Тянуть с ветки значит согласиться, что поведение нашего агента меняется тогда, когда',
  'посторонний человек вливает изменение в чужой репозиторий. Посмотрите диф перед коммитом.',
  '',
].join('\n'))

console.log(`  навыков: ${written}${skipped ? `, пропущено: ${skipped}` : ''}`)
console.log(`  каталог: vendor/marketingskills/`)
