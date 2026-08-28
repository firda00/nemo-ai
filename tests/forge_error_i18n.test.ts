/**
 * Русское сообщение на английском экране.
 *
 * Владелец прислал скриншот Forge с выбранным EN и строкой «Не удалось загрузить согласования.» в
 * панели подключений. Сам экран был переведён полностью — течь была в хуке: восемь сообщений об
 * ошибках он отдавал готовым русским текстом, минуя словарь.
 *
 * Тест держит два условия. Первое: каждый код ошибки превращается в НАСТОЯЩИЙ текст, а не в путь к
 * ключу (`t()` при промахе возвращает сам путь — на экране это выглядело бы как `forgePage.errX`).
 * Второе: на английском и узбекском в этом тексте нет кириллицы. Именно это владелец и увидел, и
 * именно это никакая проверка до сих пор не ловила.
 */
import { describe, expect, it } from 'vitest'
import { makeT } from '../src/i18n/translate'
import { FORGE_ERROR_CODES, compileErrorCodeFor, forgeErrorText } from '../src/hooks/useForgeExecution'
import { compileTask } from '../src/lib/forge-task-compiler'

const CYRILLIC = /[а-яё]/i

describe('сообщения об ошибках Forge переводятся', () => {
  for (const lang of ['uz', 'ru', 'en'] as const) {
    const t = makeT(lang)

    it(`${lang}: каждый код даёт текст, а не путь к ключу`, () => {
      for (const code of FORGE_ERROR_CODES) {
        const text = forgeErrorText(code, t)
        expect(text, `${lang}/${code}`).not.toBe(`forgePage.${code}`)
        expect(text.length, `${lang}/${code}`).toBeGreaterThan(10)
      }
    })

    if (lang !== 'ru') {
      it(`${lang}: в сообщениях нет русского текста`, () => {
        for (const code of FORGE_ERROR_CODES) {
          expect(forgeErrorText(code, t), `${lang}/${code}`).not.toMatch(CYRILLIC)
        }
      })
    }
  }

  it('русский остаётся русским — проверка выше не должна «чинить» его в английский', () => {
    const ru = makeT('ru')
    expect(forgeErrorText('errApprovals', ru)).toMatch(CYRILLIC)
  })
})

describe('сбой компилятора доезжает до пользователя переведённым', () => {
  /*
   * Код не выдуман под тест: он берётся из настоящего исключения компилятора. Если компилятор
   * переименует ошибку, тест заметит это здесь, а не на экране пользователя.
   */
  it('слишком короткая задача → errTooShort во всех трёх языках', () => {
    let thrown = ''
    try {
      compileTask('ab', { totalBudgetCapUsd: 5 })
    } catch (error) {
      thrown = error instanceof Error ? error.message : String(error)
    }
    expect(thrown).toBe('FORGE_PROMPT_TOO_SHORT')

    const code = compileErrorCodeFor(thrown)
    expect(code).toBe('errTooShort')
    for (const lang of ['uz', 'ru', 'en'] as const) {
      expect(forgeErrorText(code, makeT(lang)), lang).not.toBe('forgePage.errTooShort')
    }
  })

  it('незнакомая ошибка не молчит, а падает в общий текст', () => {
    expect(compileErrorCodeFor('SOMETHING_ELSE')).toBe('errNoPlan')
  })

  /*
   * Строку от сервера подменять нельзя: конкретная причина отказа полезнее общей заглушки, а
   * перевести её всё равно нечем — в словаре её нет.
   */
  it('текст сервера проходит насквозь', () => {
    expect(forgeErrorText('APPROVAL_QUEUE_LOCKED', makeT('en'))).toBe('APPROVAL_QUEUE_LOCKED')
    expect(forgeErrorText('', makeT('en'))).toBe('')
  })
})
