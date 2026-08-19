// Разбор переменных окружения шлюза.
//
// ОТДЕЛЬНЫМ МОДУЛЕМ, потому что main.ts при импорте ПОДНИМАЕТ СЕРВЕР: там верхнеуровневый await на
// listen. Функция, живущая рядом с ним, не проверяется иначе как запуском шлюза, а проверить надо
// ровно две вещи — запасной перец в разработке и отказ в бою.

import { randomBytes } from 'node:crypto'

/**
 * Обязательные переменные.
 *
 * Проверяются ВСЕ сразу и называются ВСЕ отсутствующие. Падать на первой значит запускать контейнер
 * трижды, чтобы узнать три недостающих имени.
 */
export function resolveGatewayEnv(
  env: Record<string, string | undefined>,
  makePepper: () => string = () => randomBytes(32).toString('hex'),
): { ok: true; url: string; serviceKey: string; pepper: string; generatedPepper: boolean }
  | { ok: false; missing: string[] } {
  const url = env.SUPABASE_URL
    ?? (env.SUPABASE_PROJECT_REF ? `https://${env.SUPABASE_PROJECT_REF}.supabase.co` : '')
  const serviceKey = env.SUPABASE_SERVICE_ROLE_KEY ?? env.SUPABASE_SECRET_KEY ?? ''
  let pepper = env.NEMO_TOKEN_PEPPER ?? ''

  const missing: string[] = []
  if (!url) missing.push('SUPABASE_URL (или SUPABASE_PROJECT_REF)')
  if (!serviceKey) missing.push('SUPABASE_SERVICE_ROLE_KEY (или SUPABASE_SECRET_KEY)')

  /*
   * ПЕРЕЦ: ЗАПАСНОЙ ВАРИАНТ ТОЛЬКО ДЛЯ РАЗРАБОТКИ, И ОН СЛУЧАЙНЫЙ.
   *
   * Перец подмешивается в отпечаток токена. Постоянное значение по умолчанию, зашитое в репозиторий,
   * было бы одинаковым у всех и однажды уехало бы в боевую среду — а там оно означает, что отпечатки
   * токенов может посчитать любой, кто читал этот файл. Поэтому запасной перец СЛУЧАЙНЫЙ на запуск:
   * шлюз поднимается, локальная разработка идёт, но токены не переживают перезапуск.
   *
   * В боевом режиме запасного варианта нет: там отсутствие перца — ошибка развёртывания, и молча
   * подставить случайное значение значит обесценить все ранее выданные токены без единого слова.
   */
  const production = (env.NODE_ENV ?? env.NEMO_ENV ?? '').toLowerCase() === 'production'
  if (!pepper && production) missing.push('NEMO_TOKEN_PEPPER')
  if (missing.length) return { ok: false, missing }

  const generatedPepper = !pepper
  if (!pepper) pepper = makePepper()
  return { ok: true, url, serviceKey, pepper, generatedPepper }
}
