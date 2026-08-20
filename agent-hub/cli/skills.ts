/*
 * Маркетинговые навыки для CLI.
 *
 * Читаются из vendor/marketingskills — забранных исходников
 * github.com/coreyhaines31/marketingskills (MIT), закреплённых коммитом. Условия лицензии и
 * происхождение лежат там же рядом с файлами.
 *
 * ПОЧЕМУ ФАЙЛАМИ, А НЕ ВНУТРИ СБОРКИ. Навыков сорок девять, суммарно три четверти мегабайта. Вшить
 * их в dist/cli.js значило бы утроить его размер ради содержимого, которое в одном сеансе нужно
 * штучно. Файлы едут рядом с пакетом и читаются по требованию.
 *
 * ЧТО ЭТО ЗА ТЕКСТ. Это ЧУЖИЕ ИНСТРУКЦИИ, которые становятся частью системного промпта. Источник
 * известный и лицензия позволяет, но доверие здесь осознанное, а не автоматическое: версия
 * закреплена коммитом, и обновление — отдельное действие с просмотром дифа.
 */
import fs from 'node:fs'
import path from 'node:path'

export interface Skill {
  id: string
  /** Первая строка описания из frontmatter — по ней понятно, когда навык уместен. */
  when: string
  /** Полный текст навыка без frontmatter: он и уходит в системный промпт. */
  body: string
}

/*
 * Где искать каталог.
 *
 * Путей два, и оба нужны. В репозитории модуль лежит в agent-hub/cli, и vendor — на два уровня
 * выше. В собранном пакете модуль превращается в dist/cli.js, и vendor оказывается на один уровень
 * выше. Проверять оба дешевле, чем угадывать, как именно запущен код, — а угадав неверно, мы
 * получаем CLI, который молча теряет все навыки на машине пользователя.
 */
const CANDIDATES = [
  path.resolve(import.meta.dirname, '..', '..', 'vendor', 'marketingskills', 'skills'),
  path.resolve(import.meta.dirname, '..', 'vendor', 'marketingskills', 'skills'),
]

export function skillsDir(candidates: string[] = CANDIDATES): string | null {
  for (const dir of candidates) {
    try { if (fs.statSync(dir).isDirectory()) return dir } catch { /* нет — пробуем следующий */ }
  }
  return null
}

/**
 * Разбор одного файла навыка.
 *
 * Frontmatter отрезается: он адресован загрузчику, а не модели, и место в промпте занимает зря.
 * Описание оттуда сохраняется отдельно — по нему человек выбирает навык в каталоге.
 */
export function parseSkill(id: string, text: string): Skill {
  const source = String(text ?? '')
  const match = source.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/)
  const front = match?.[1] ?? ''
  const body = match ? source.slice(match[0].length).trim() : source.trim()

  // description бывает в кавычках и на нескольких строках; берём до первого перевода строки,
  // который начинается с ключа верхнего уровня.
  const described = front.match(/^description:\s*(.*)$/m)?.[1] ?? ''
  const when = described.trim().replace(/^["']|["']$/g, '').trim()
  return { id, when, body }
}

/** Все навыки каталога. Пустой список — не ошибка: каталога может не быть при частичной установке. */
export function loadSkills(dir = skillsDir()): Skill[] {
  if (!dir) return []
  return fs.readdirSync(dir)
    .filter((name) => name.endsWith('.md'))
    .sort()
    .map((name) => parseSkill(name.replace(/\.md$/, ''), fs.readFileSync(path.join(dir, name), 'utf8')))
}

/** Ширина колонки идентификатора. Ровная колонка читается взглядом, рваная — нет. */
const ID_COLUMN = 24
/** Отступ слева плюс пробел между колонками. */
const GUTTER = 3

/**
 * Короткий каталог для человека: id и первая фраза описания.
 *
 * Место под описание считается от ВЫРОВНЕННОЙ колонки, а не от длины самого идентификатора. В
 * первой редакции было наоборот, и короткий id вроде `cro` получал место по своей длине — строка
 * выходила на двадцать знаков за край окна и переносилась, ломая колонку. Поймано проверкой.
 */
export function catalogLines(skills: Skill[], width = 92): string[] {
  const room = Math.max(20, width - ID_COLUMN - GUTTER)
  return skills.map((skill) => {
    const first = skill.when.split(/(?<=[.!?])\s/)[0] ?? ''
    const tail = first.length > room ? `${first.slice(0, room - 1)}…` : first
    return `  ${skill.id.padEnd(ID_COLUMN)} ${tail}`
  })
}

/**
 * Блок для системного промпта.
 *
 * Неизвестные идентификаторы молча пропускаются — вызывающий уже сказал человеку, что такого навыка
 * нет, и второе сообщение об этом ничего не добавит.
 */
export function skillPromptBlock(skills: Skill[], ids: readonly string[]): string {
  const chosen = ids
    .map((id) => skills.find((skill) => skill.id === id))
    .filter((skill): skill is Skill => Boolean(skill))
  if (!chosen.length) return ''
  return [
    '# МАРКЕТИНГОВЫЕ НАВЫКИ (применяй эти методы)',
    '',
    'Источник: github.com/coreyhaines31/marketingskills (MIT).',
    '',
    ...chosen.map((skill) => `## ${skill.id}\n\n${skill.body}`),
  ].join('\n')
}
