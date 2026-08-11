import assert from 'node:assert/strict'
import {
  CB_PRICE,
  acceptedText,
  ownPricePrompt,
  parseOwnPrice,
  parsePriceCallback,
  priceKeyboard,
  refusalText,
  replyTarget,
} from '../supabase/functions/_shared/commercePriceChat.ts'

const ID = 'b1f2c3d4-5566-4778-8999-aabbccddeeff'

// --- Кнопка помещается в лимит Telegram -----------------------------------------------------
// Лимит 64 БАЙТА, не символа. Кнопка, вышедшая за него, приходит обрезанной и не совпадает ни с
// чем — нажатие просто ничего не делает, молча.

const keyboard = priceKeyboard(ID, 5_875_000)
const encoder = new TextEncoder()
for (const row of keyboard) {
  for (const button of row) {
    assert.ok(
      encoder.encode(button.callback_data).length <= 64,
      `callback_data вышла за 64 байта: ${button.callback_data}`,
    )
  }
}
// В тексте кнопки неразрывный пробел безвреден: кнопку не копируют, её нажимают.
assert.ok(/58\s?750/.test(keyboard[0][0].text), 'на кнопке видно то самое число')
assert.equal(keyboard[0][0].callback_data, `${CB_PRICE}:${ID}:y:58750`)
assert.equal(keyboard[1].length, 2, 'своя цена и отклонить стоят вместе, под принятием')

// --- Разбор нажатия -------------------------------------------------------------------------

const accepted = parsePriceCallback(`${CB_PRICE}:${ID}:y:58750`)
assert.equal(accepted.action, 'y')
assert.equal(accepted.priceTiyin, 5_875_000, 'цена едет в кнопке — совет мог пересчитаться с тех пор')
assert.equal(parsePriceCallback(`${CB_PRICE}:${ID}:c`).priceTiyin, null, '«своя цена» числа не несёт')
assert.equal(parsePriceCallback(`${CB_PRICE}:${ID}:n`).action, 'n')

// Чужие кнопки не наши: обработчик обязан их пропустить, а не попытаться разобрать.
for (const alien of ['cld:' + ID + ':y', `${CB_PRICE}:не-uuid:y`, `${CB_PRICE}:${ID}:z`, '', null, 'cpp']) {
  assert.equal(parsePriceCallback(alien), null, `не наша кнопка: ${alien}`)
}

// --- «Своя цена» без хранения состояния -----------------------------------------------------
// Вебхук без памяти. Метка в тексте приглашения — то, что позволяет ответу найти свой товар:
// Telegram присылает исходное сообщение целиком, и метка читается оттуда.

const prompt = ownPricePrompt(ID, 'Женский бони Молочный', 4_700_000)
assert.ok(prompt.includes('#b1f2c3d4'), 'метка стоит в приглашении')
assert.equal(replyTarget(prompt), 'b1f2c3d4', 'и вычитывается обратно из ответа')
assert.equal(replyTarget('обычное сообщение без метки'), null)
assert.ok(/47\s?000/.test(prompt), 'пол назван до того, как владелец начал набирать число')

// --- Число, а не разговор -------------------------------------------------------------------

assert.equal(parseOwnPrice('58750'), 5_875_000)
assert.equal(parseOwnPrice('58 750'), 5_875_000, 'разделитель разрядов — то, как это набирают')
assert.equal(parseOwnPrice(' 58.750 '), 5_875_000)
// Фраза не содержит цены. Угаданная из неё цифра уехала бы в решение как согласие владельца.
for (const noise of ['поставлю дороже', 'цена 58750 будет к пятнице', 'да', '', '0', '-500', '1']) {
  assert.equal(parseOwnPrice(noise), null, `не цена: «${noise}»`)
}

// --- Ответы владельцу -----------------------------------------------------------------------

const ok = acceptedText('Женский бони Молочный', 5_875_000, '2026-08-17T06:00:00Z')
assert.ok(/<code>58750<\/code>/.test(ok), 'копируемое число — голые цифры')
assert.ok(ok.includes('2026-08-17'), 'срок проверки назван, иначе «проверю» — обещание без даты')
assert.ok(/Nemo не меняет цену на Uzum/.test(ok), 'read-only сказано вслух')

// Отказ называет число: без него он неотличим от поломки, и владелец шлёт то же самое ещё раз.
assert.ok(/47\s?000/.test(refusalText('below_floor', 4_700_000)))
assert.ok(refusalText('no_floor', null).includes('себестоимости'))
assert.ok(refusalText('already_accepted', null).includes('Уже'))

console.log('[OK] Price chat behaviour: 31 assertions')
