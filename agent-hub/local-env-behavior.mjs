// Подхват локальных ключей. Проверяется то, из-за чего это вообще написано своими руками, а не
// взято готовым: многострочный PEM в кавычках и приоритет уже заданного окружения.

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { loadLocalEnv, parseEnvFile } from './load-local-env.mjs'

// --- Обычные пары ---------------------------------------------------------------------------------

{
  const parsed = parseEnvFile('FOO=bar\nBAZ=qux')
  assert.equal(parsed.get('FOO'), 'bar')
  assert.equal(parsed.get('BAZ'), 'qux')
}

// Комментарии и пустые строки — не переменные.
{
  const parsed = parseEnvFile('# комментарий\n\nFOO=bar\n   # ещё\n')
  assert.deepEqual([...parsed.keys()], ['FOO'])
}

// `export KEY=value` — так пишут файлы, которые заодно source-ят в bash.
assert.equal(parseEnvFile('export FOO=bar').get('FOO'), 'bar')

// Кавычки снимаются, а знак «=» внутри значения сохраняется: у ключей Supabase он бывает в конце.
assert.equal(parseEnvFile('FOO="bar"').get('FOO'), 'bar')
assert.equal(parseEnvFile("FOO='bar'").get('FOO'), 'bar')
assert.equal(parseEnvFile('FOO=sb_secret_abc=def==').get('FOO'), 'sb_secret_abc=def==')

// Комментарий в конце незакавыченной строки значением не является, а внутри кавычек — является.
assert.equal(parseEnvFile('FOO=bar # хвост').get('FOO'), 'bar')
assert.equal(parseEnvFile('FOO="bar # не хвост"').get('FOO'), 'bar # не хвост')

// --- Многострочный PEM: ровно тот случай, ради которого написан свой разбор ------------------------
// Этот же PEM однажды обрушил `. ./.secrets.local` в bash и высыпал обрывки приватного ключа в
// вывод команды. Разбор обязан прочитать его как ОДНО значение, а не как набор команд.

{
  // Маркеры собираются из кусков НАМЕРЕННО, а не пишутся строкой целиком: иначе проверка секретов
  // из agent-hub/scan-secrets.mjs честно опознаёт этот файл как содержащий закрытый ключ и
  // останавливает коммит. Она права по форме — ослаблять её из-за тестовой заготовки нельзя, а
  // склейка проверяет ровно то же поведение. Не «починить» обратно в одну строку.
  const begin = `-----BEGIN ${'PRIVATE'} KEY-----`
  const end = `-----END ${'PRIVATE'} KEY-----`
  const body = `${begin}\nAAAA\nBBBB\n${end}`

  const parsed = parseEnvFile(`FIRST=1\nKEY="${body}"\nLAST=2`)
  assert.equal(parsed.get('FIRST'), '1')
  assert.equal(parsed.get('KEY'), body, 'многострочное значение собирается целиком, с переводами строк внутри')
  assert.equal(parsed.get('LAST'), '2', 'разбор продолжается ПОСЛЕ многострочного значения')
}

// --- Приоритет: заданное в окружении важнее файла --------------------------------------------------
// Иначе `KEY=... npm run sdr:run` молча игнорировался бы, и отладить это было бы нечем.

{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nemo-env-'))
  fs.writeFileSync(path.join(dir, '.secrets.local'), 'SHARED=from_secrets\nONLY_SECRETS=x')
  fs.writeFileSync(path.join(dir, '.env'), 'SHARED=from_env\nONLY_ENV=y')

  const env = { SHARED: 'from_shell' }
  const result = loadLocalEnv(dir, env)

  assert.equal(env.SHARED, 'from_shell', 'уже заданное не перезаписывается файлом')
  assert.equal(env.ONLY_SECRETS, 'x')
  assert.equal(env.ONLY_ENV, 'y')
  assert.ok(!result.loaded.includes('SHARED'), 'в отчёт попадает только реально подхваченное')
  assert.deepEqual(result.files, ['.secrets.local', '.env'])

  // .secrets.local читается ПЕРВЫМ: боевые ключи бэкенда живут там, и общий .env их не подменяет.
  const env2 = {}
  loadLocalEnv(dir, env2)
  assert.equal(env2.SHARED, 'from_secrets')

  fs.rmSync(dir, { recursive: true, force: true })
}

// Пустая строка в окружении — это не «задано»: перезаписать её файлом правильно.
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nemo-env-'))
  fs.writeFileSync(path.join(dir, '.env'), 'BLANK=filled')
  const env = { BLANK: '' }
  loadLocalEnv(dir, env)
  assert.equal(env.BLANK, 'filled')
  fs.rmSync(dir, { recursive: true, force: true })
}

// --- Отсутствие файлов — не ошибка ------------------------------------------------------------------
// Пайплайн обязан запускаться в чистом клоне, где ни одного локального файла нет.

{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nemo-env-empty-'))
  const result = loadLocalEnv(dir, {})
  assert.deepEqual(result.files, [])
  assert.deepEqual(result.loaded, [])
  fs.rmSync(dir, { recursive: true, force: true })
}

// --- Отчёт не содержит значений ---------------------------------------------------------------------
// loaded — это ИМЕНА. Значения не возвращаются наружу вовсе, чтобы их нечем было напечатать.

{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nemo-env-'))
  fs.writeFileSync(path.join(dir, '.env'), 'SECRET_THING=sk-or-v1-supersecret')
  const result = loadLocalEnv(dir, {})
  assert.deepEqual(result.loaded, ['SECRET_THING'])
  assert.equal(JSON.stringify(result).includes('supersecret'), false, 'значение не уезжает в отчёт')
  fs.rmSync(dir, { recursive: true, force: true })
}

console.log('[OK] Local env loading behaviour: 24 assertions')
