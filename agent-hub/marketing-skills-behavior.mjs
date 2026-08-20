// Маркетинговые навыки: разбор каталога, команда /skill и попадание методики в системный промпт.
//
// Источник — vendor/marketingskills (github.com/coreyhaines31/marketingskills, MIT), закреплённый
// коммитом. Здесь проверяется НАША обвязка вокруг него, а не содержание чужих файлов.
//
// Запуск: npm run test:marketing-skills
import assertStrict from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const { catalogLines, loadSkills, parseSkill, skillPromptBlock, skillsDir } = await import('./cli/skills.ts')
const { AGENT_ROLES, missionFor } = await import('./cli/roles.ts')
const { COMMANDS, parseSlash, runSlash } = await import('./cli/commands.ts')

let checks = 0
const assert = new Proxy(assertStrict, {
  get: (target, key) => {
    const value = target[key]
    if (typeof value !== 'function') return value
    return (...args) => { checks++; return value.apply(target, args) }
  },
})

// ── Каталог на месте ─────────────────────────────────────────────────────────────────────────
const dir = skillsDir()
assert.ok(dir, 'каталог vendor/marketingskills не найден — забрать: node scripts/vendor-marketing-skills.mjs')

const skills = loadSkills()
assert.ok(skills.length >= 40, `навыков всего ${skills.length}, ожидалось не меньше 40`)

/*
 * ЛИЦЕНЗИЯ И ПРОИСХОЖДЕНИЕ ЛЕЖАТ РЯДОМ С ФАЙЛАМИ.
 *
 * Условие MIT — сохранять текст лицензии. Ссылка в комментарии этого не заменяет: комментарий
 * теряется при копировании каталога, а файл — едет вместе с ним.
 *
 * Коммит записан не для порядка: содержимое становится ИНСТРУКЦИЯМИ агента. Без закреплённой
 * версии поведение нашего агента менялось бы тогда, когда посторонний человек вливает изменение в
 * чужой репозиторий, — и заметили бы мы это по изменившимся ответам, а не по своему коммиту.
 */
const vendorRoot = path.dirname(dir)
assert.ok(fs.existsSync(path.join(vendorRoot, 'LICENSE')), 'нет файла LICENSE рядом с забранными навыками')
const provenance = fs.readFileSync(path.join(vendorRoot, 'PROVENANCE.md'), 'utf8')
assert.match(provenance, /coreyhaines31\/marketingskills/, 'в происхождении не назван источник')
assert.match(provenance, /коммит: [0-9a-f]{40}/, 'версия не закреплена полным SHA коммита')
assert.match(fs.readFileSync(path.join(vendorRoot, 'LICENSE'), 'utf8'), /MIT License/i)

// ── Разбор файла навыка ──────────────────────────────────────────────────────────────────────
{
  const parsed = parseSkill('demo', [
    '---',
    'name: demo',
    'description: "Когда нужно проверить разбор."',
    'metadata:',
    '  version: 2.0.0',
    '---',
    '',
    '# Заголовок',
    '',
    'Тело навыка.',
  ].join('\n'))
  assert.equal(parsed.id, 'demo')
  assert.equal(parsed.when, 'Когда нужно проверить разбор.')
  // Frontmatter в промпт НЕ идёт: он адресован загрузчику, а место занимает.
  assert.equal(parsed.body.includes('version: 2.0.0'), false, 'frontmatter утёк в тело навыка')
  assert.ok(parsed.body.startsWith('# Заголовок'))

  // Файл без frontmatter — не ошибка: телом становится всё содержимое.
  const bare = parseSkill('bare', 'просто текст')
  assert.equal(bare.body, 'просто текст')
  assert.equal(bare.when, '')

  // CRLF: рабочее дерево здесь такое, и разбор обязан его переживать.
  const crlf = parseSkill('crlf', '---\r\nname: x\r\ndescription: "Опис."\r\n---\r\n\r\nТело.')
  assert.equal(crlf.when, 'Опис.', 'разбор frontmatter сломался на CRLF')
  assert.equal(crlf.body, 'Тело.')
}

// Все забранные навыки разобрались непусто: пустое тело означало бы методику без инструкций.
{
  const empty = skills.filter((skill) => skill.body.trim().length < 200).map((skill) => skill.id)
  assert.deepEqual(empty, [], `навыки без содержания: ${empty.join(', ')}`)
  const nameless = skills.filter((skill) => !skill.when.trim()).map((skill) => skill.id)
  assert.deepEqual(nameless, [], `навыки без описания «когда применять»: ${nameless.join(', ')}`)
}

// ── Блок для промпта ─────────────────────────────────────────────────────────────────────────
{
  assert.equal(skillPromptBlock(skills, []), '', 'пустой выбор обязан давать пустой блок, а не заголовок')
  assert.equal(skillPromptBlock(skills, ['нет-такого']), '', 'неизвестный навык не должен рождать пустой блок с заголовком')

  const block = skillPromptBlock(skills, ['cro'])
  assert.match(block, /## cro/)
  assert.match(block, /coreyhaines31\/marketingskills/, 'в блоке промпта нет ссылки на источник')
  assert.ok(block.length > 1000, 'методика в промпте подозрительно короткая')

  // Порядок сохраняется: человек подключал в определённой последовательности.
  const two = skillPromptBlock(skills, ['pricing', 'cro'])
  assert.ok(two.indexOf('## pricing') < two.indexOf('## cro'), 'порядок подключения не сохранён')
}

// Каталог для человека: строки в одну линию и без обрыва посреди слова на длинных описаниях.
{
  const lines = catalogLines(skills, 92)
  assert.equal(lines.length, skills.length)
  assert.equal(lines.some((line) => line.includes('\n')), false, 'строка каталога перенеслась')
  assert.ok(lines.every((line) => line.length <= 96), 'строка каталога длиннее окна')
}

// ── Роль маркетолога ─────────────────────────────────────────────────────────────────────────
{
  const role = AGENT_ROLES.marketing
  assert.ok(role, 'роли marketing нет')
  const mission = missionFor(role)
  assert.match(mission, /\/skill/, 'роль не знает про команду подключения методик')
  assert.match(mission, /НЕ ВЫДУМЫВАЙ ЦИФРЫ/, 'из роли пропал запрет выдумывать статистику')

  /*
   * У МАРКЕТОЛОГА НЕТ ПРАВА ПИСАТЬ КЛИЕНТАМ.
   *
   * Роль пишет тексты и планы; отправку карточек и запись в CRM делает sdr. Дать маркетологу
   * telegram_send_lead значит однажды разослать черновик оффера настоящим людям.
   */
  for (const forbidden of ['telegram_send_lead', 'crm_sync_lead', 'search_leads']) {
    assert.equal(role.tools.includes(forbidden), false, `маркетологу достался ${forbidden}`)
  }
  assert.ok(role.tools.includes('browser_navigate_and_extract'), 'маркетолог не может открыть страницу')
  assert.ok(role.tools.includes('fs_export'), 'маркетологу нечем отдать результат')
}

// ── Команда /skill ───────────────────────────────────────────────────────────────────────────
assert.ok(COMMANDS.some((one) => one.name === 'skill'), 'команды /skill нет в списке')

const baseDeps = (state) => ({
  session: { messages: [], turnCount: 0, setSystemPrompt: () => {}, recordToolCall: () => {}, reset: () => {} },
  registry: { has: () => false, names: () => [] },
  setRole: () => {},
  currentRole: () => AGENT_ROLES.marketing,
  setModel: () => null,
  currentModel: () => 'x',
  mcpStatus: () => [],
  health: async () => [],
  balance: async () => ({ ok: false, error: 'нет' }),
  summarize: async () => '',
  activeSkills: () => state.ids,
  setSkills: (ids) => { state.ids = ids },
})

// Список без аргументов не меняет состояние.
{
  const state = { ids: [] }
  const result = await runSlash(parseSlash('/skill'), baseDeps(state))
  assert.equal(result.kind, 'lines')
  assert.deepEqual(state.ids, [], 'просмотр списка подключил методику')
  assert.ok(result.lines.some((line) => /coreyhaines31/.test(line)), 'в списке не назван источник')
  assert.ok(result.lines.some((line) => /\bcro\b/.test(line)), 'в списке нет cro')
}

// Подключение и повторное подключение.
{
  const state = { ids: [] }
  const deps = baseDeps(state)
  await runSlash(parseSlash('/skill cro'), deps)
  assert.deepEqual(state.ids, ['cro'])

  const again = await runSlash(parseSlash('/skill cro'), deps)
  assert.deepEqual(state.ids, ['cro'], 'повторное подключение задвоило методику')
  assert.ok(again.lines.some((line) => /уже подключена/.test(line)))

  await runSlash(parseSlash('/skill pricing'), deps)
  assert.deepEqual(state.ids, ['cro', 'pricing'])

  await runSlash(parseSlash('/skill off'), deps)
  assert.deepEqual(state.ids, [])
}

// Промах в имени: подсказка вместо молчаливого отказа.
{
  const state = { ids: [] }
  const result = await runSlash(parseSlash('/skill copywritng'), baseDeps(state))
  assert.deepEqual(state.ids, [], 'опечатка подключила что-то наугад')
  assert.ok(result.lines.some((line) => /нет методики/.test(line)))
  assert.ok(result.lines.some((line) => /copywriting/.test(line)), 'близкое имя не подсказано')
}

// Регистр не должен мешать: человек набирает как привык.
{
  const state = { ids: [] }
  await runSlash(parseSlash('/skill CRO'), baseDeps(state))
  assert.deepEqual(state.ids, ['cro'], 'идентификатор в верхнем регистре не распознан')
}

// ── Отсутствующий каталог не роняет CLI ──────────────────────────────────────────────────────
{
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'nemo-noskills-'))
  assert.equal(skillsDir([path.join(empty, 'нет')]), null)
  assert.deepEqual(loadSkills(null), [], 'без каталога загрузка обязана вернуть пустой список, а не упасть')
  fs.rmSync(empty, { recursive: true, force: true })
}

console.log(`[OK] Marketing skills: ${checks} assertions, ${skills.length} методик`)
