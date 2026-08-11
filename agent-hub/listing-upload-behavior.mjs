import assert from 'node:assert/strict'
import {
  ALLOWED_TYPES,
  MAX_BYTES,
  MAX_IMAGES,
  imagePath,
  pickImages,
} from '../src/lib/listingImageUpload.ts'

const ACCOUNT = '319eac6f-72e0-4664-a45f-da7474efd999'
const file = (name, type, size) => ({ name, type, size })

// --- Отбор с причиной на каждый отклонённый файл -----------------------------------------------
// Владелец перетащил пять фотографий, увидел четыре — и должен знать, какая пропала и почему.
// Молчаливое отбрасывание здесь худший из вариантов.

const mixed = pickImages([
  file('1.jpg', 'image/jpeg', 1_000),
  file('спека.pdf', 'application/pdf', 1_000),
  file('огромное.png', 'image/png', MAX_BYTES + 1),
  file('2.webp', 'image/webp', 2_000),
], 0)
assert.deepEqual(mixed.accepted.map((f) => f.name), ['1.jpg', '2.webp'])
assert.deepEqual(mixed.rejected, [
  { name: 'спека.pdf', reason: 'type' },
  { name: 'огромное.png', reason: 'size' },
])

// Ровно на границе — берём: «до 8 МБ» значит 8 МБ включительно.
assert.equal(pickImages([file('край.jpg', 'image/jpeg', MAX_BYTES)], 0).accepted.length, 1)
assert.equal(pickImages([file('край.jpg', 'image/jpeg', MAX_BYTES + 1)], 0).accepted.length, 0)

// Лимит считается вместе с уже загруженными, иначе четыре плюс четыре дали бы восемь.
const overflow = pickImages(Array.from({ length: 5 }, (_, i) => file(`${i}.jpg`, 'image/jpeg', 10)), 2)
assert.equal(overflow.accepted.length, MAX_IMAGES - 2, 'добираем только до предела')
assert.equal(overflow.rejected.length, 3)
assert.ok(overflow.rejected.every((r) => r.reason === 'limit'))
assert.equal(pickImages([file('1.jpg', 'image/jpeg', 10)], MAX_IMAGES).accepted.length, 0, 'полный список ничего не берёт')

// Ограничения дублируют серверные намеренно; разойтись они могут только в сторону, где отказ виден.
assert.deepEqual([...ALLOWED_TYPES], ['image/jpeg', 'image/png', 'image/webp'])
assert.equal(MAX_BYTES, 8 * 1024 * 1024)
assert.equal(MAX_IMAGES, 4)

// --- Путь: первый сегмент — граница между арендаторами -----------------------------------------

assert.equal(imagePath(ACCOUNT, 'image/jpeg', 'abc'), `${ACCOUNT}/abc.jpg`)
assert.equal(imagePath(ACCOUNT, 'image/webp', 'abc'), `${ACCOUNT}/abc.webp`)
assert.equal(imagePath(ACCOUNT, 'IMAGE/PNG', 'abc'), `${ACCOUNT}/abc.png`, 'регистр типа не должен решать судьбу файла')
assert.equal(imagePath(ACCOUNT, 'application/pdf', 'abc'), null)
// Без аккаунта пути нет: файл в корне бакета не принадлежал бы никому и был бы виден всем.
assert.equal(imagePath('', 'image/jpeg', 'abc'), null)

console.log('[OK] Listing upload behaviour: 17 assertions')
