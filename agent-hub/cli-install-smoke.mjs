// Установка CLI: команда `nemo` обязана работать из ЛЮБОЙ папки, обычным node, без флагов.
//
// ЧТО ИМЕННО ПРОВЕРЯЕТСЯ И ПОЧЕМУ ИМЕННО ТАК.
//
// Сборка, запущенная из корня репозитория, работает всегда: рядом лежат node_modules, .env.local и
// .secrets.local. Ровно поэтому она ничего не доказывает. Отказ «работает у меня» проявляется на
// чужой машине, где нет ни того, ни другого, — а обнаруживает его клиент, а не мы.
//
// Поэтому пакет собирается через `npm pack`, ставится в ПУСТОЙ каталог вне репозитория и
// запускается оттуда. Только так видно: попали ли нужные файлы в пакет, объявлена ли команда,
// не нужен ли флаг Node, не тянется ли что-то из соседних папок.
//
// Запуск: npm run test:cli-install
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { spawnSync } from 'node:child_process'

const root = path.resolve(import.meta.dirname, '..')
let failed = 0
const ok = (name, detail = '') => console.log(`[OK]   ${name}${detail ? ` — ${detail}` : ''}`)
const bad = (name, detail = '') => { failed += 1; console.error(`[FAIL] ${name}${detail ? ` — ${detail}` : ''}`) }

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
const run = (cmd, args, opts = {}) => spawnSync(cmd, args, { encoding: 'utf8', windowsHide: true, shell: process.platform === 'win32', ...opts })

// ── 1. Пакет собирается и содержит то, что объявлено ─────────────────────────────────────────
const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'nemo-cli-'))
const packed = run(npm, ['pack', '--pack-destination', stage], { cwd: root })
if (packed.status !== 0) {
  bad('npm pack', (packed.stderr || packed.stdout || '').trim().slice(0, 200))
} else {
  const tarball = fs.readdirSync(stage).find((f) => f.endsWith('.tgz'))
  ok('пакет собран', tarball)

  /*
   * Состав смотрится в САМОМ АРХИВЕ, а не в предсказании `npm pack --dry-run --json`.
   *
   * Первая редакция читала dry-run и объявила, что dist/cli.js в пакет не попал, — при том что
   * установка тут же проходила и команда работала. Врал не пакет, а проверка: у dry-run своя форма
   * ответа, и разбирать её на глаз значит проверять не то, что уедет пользователю.
   */
  // tar запускается ИЗ каталога архива и получает только имя файла: путь вида C:/… часть сборок
  // tar принимает за «хост:путь» и пытается идти по сети — отказ при этом выглядит как пустой архив.
  const listed = run('tar', ['-tzf', tarball], { cwd: stage })
  const files = (listed.stdout ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim().replace(/\\/g, '/').replace(/^package\//, ''))
    .filter(Boolean)
  const hasCli = files.includes('dist/cli.js')
  // Файл, объявленный в bin, но не попавший в пакет, ломает установку МОЛЧА: npm создаёт ссылку
  // на несуществующий путь, и `nemo` отвечает «команда не найдена» уже у пользователя.
  hasCli ? ok('dist/cli.js попал в пакет', `${files.length} файлов`) : bad('dist/cli.js НЕ попал в пакет', files.slice(0, 6).join(', '))

  // ── 2. Установка в пустой каталог ВНЕ репозитория ─────────────────────────────────────────
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'nemo-home-'))
  const install = run(npm, ['install', '--no-audit', '--no-fund', path.join(stage, tarball)], { cwd: home })
  if (install.status !== 0) {
    bad('установка в пустой каталог', (install.stderr || '').trim().slice(0, 300))
  } else {
    ok('установлен в пустой каталог')

    const binName = process.platform === 'win32' ? 'nemo.cmd' : 'nemo'
    const bin = path.join(home, 'node_modules', '.bin', binName)
    fs.existsSync(bin) ? ok('команда nemo объявлена', bin.replace(home, '<пусто>')) : bad('команды nemo нет', bin)

    if (fs.existsSync(bin)) {
      /*
       * Запуск БЕЗ терминала: точка входа обязана отказать понятной строкой, а не рухнуть
       * трассировкой стека. Это же доказывает главное — что файл ИСПОЛНЯЕТСЯ обычным node без
       * --experimental-strip-types. Синтаксическая ошибка или несобранный TypeScript дали бы
       * SyntaxError, а не наше сообщение.
       *
       * Каталог запуска — пустой и чужой: ни node_modules репозитория, ни .secrets.local рядом.
       */
      const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'nemo-empty-'))
      const started = run(bin, [], { cwd: empty, env: { ...process.env, OPENROUTER_API_KEY: '', NEMO_SKIP_LOGIN: '1' } })
      const output = `${started.stdout ?? ''}${started.stderr ?? ''}`
      const crashed = /SyntaxError|Cannot find module|ERR_MODULE_NOT_FOUND|ERR_UNKNOWN_FILE_EXTENSION/.test(output)
      crashed
        ? bad('запуск из пустой папки', output.trim().split('\n').slice(0, 3).join(' | ').slice(0, 260))
        : ok('запускается обычным node', output.trim().split('\n')[0]?.slice(0, 90) || '(без вывода)')

      const asksForTerminal = /терминал/i.test(output)
      asksForTerminal
        ? ok('отказ понятной строкой, а не падением')
        : bad('нет внятного отказа без терминала', output.trim().slice(0, 160))

      fs.rmSync(empty, { recursive: true, force: true })
    }
  }
  fs.rmSync(home, { recursive: true, force: true })
}
fs.rmSync(stage, { recursive: true, force: true })

// ── 3. Строка запуска и отсутствие секретов в собранном файле ────────────────────────────────
const distPath = path.join(root, 'dist', 'cli.js')
if (!fs.existsSync(distPath)) {
  bad('dist/cli.js отсутствует', 'соберите: npm run build:cli')
} else {
  const bundle = fs.readFileSync(distPath, 'utf8')
  bundle.startsWith('#!/usr/bin/env node')
    ? ok('строка запуска на месте')
    : bad('нет строки запуска', bundle.slice(0, 40))

  // То же, что проверяет сборка, — но и здесь: собранный файл могли положить руками.
  const secrets = [
    [/sk-or-v1-[A-Za-z0-9]{16,}/, 'ключ OpenRouter'],
    [/sb_secret_[A-Za-z0-9_-]{16,}/, 'служебный ключ Supabase'],
    [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, 'приватный ключ'],
    [/\b\d{8,10}:[A-Za-z0-9_-]{35}\b/, 'токен Telegram-бота'],
  ]
  const found = secrets.filter(([shape]) => shape.test(bundle)).map(([, name]) => name)
  found.length === 0
    ? ok('секретов в сборке нет')
    : bad('в сборке найдены секреты', found.join(', '))
}

console.log()
if (failed) { console.error(`Установка CLI: ${failed} проверок упало.`); process.exit(1) }
console.log('Установка CLI: всё пройдено.')
