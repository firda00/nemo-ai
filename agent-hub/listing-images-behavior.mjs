import assert from 'node:assert/strict'
import {
  IMAGE_BUCKET,
  MAX_IMAGES,
  SIGNED_URL_TTL_SECONDS,
  imagePathFor,
  ownsImagePath,
  signImages,
} from '../supabase/functions/_shared/listingImages.ts'

const ACCOUNT = '319eac6f-72e0-4664-a45f-da7474efd999'
const OTHER = 'de33dbc0-6dea-40b3-aca8-f9c7f918743a'

// --- Первый сегмент пути — единственная граница между арендаторами -----------------------------
// RLS защищает загрузку из браузера. ЧТЕНИЕ идёт сервисным ключом, которому доступно всё, поэтому
// проверка владения обязана стоять здесь: путь приходит из тела запроса, и прислать можно любой.

assert.equal(ownsImagePath(`${ACCOUNT}/a1b2.jpg`, ACCOUNT), true)
assert.equal(ownsImagePath(`${OTHER}/a1b2.jpg`, ACCOUNT), false, 'чужая папка недоступна')

// Переходы вверх и абсолютные пути обошли бы проверку префикса.
for (const evil of [
  `${ACCOUNT}/../${OTHER}/a.jpg`,
  `/${ACCOUNT}/a.jpg`,
  `..\/${OTHER}/a.jpg`,
  ACCOUNT,
  `${ACCOUNT}/`,
  '',
  null,
  42,
]) {
  assert.equal(ownsImagePath(evil, ACCOUNT), false, `должно быть отвергнуто: ${JSON.stringify(evil)}`)
}

// --- Имя файла --------------------------------------------------------------------------------

assert.equal(imagePathFor(ACCOUNT, 'image/jpeg', 'abc'), `${ACCOUNT}/abc.jpg`)
assert.equal(imagePathFor(ACCOUNT, 'IMAGE/PNG', 'abc'), `${ACCOUNT}/abc.png`)
// Тип, которого нет в бакете, отвергается здесь, а не в Storage: отказ ближе к причине понятнее.
assert.equal(imagePathFor(ACCOUNT, 'application/pdf', 'abc'), null)
assert.equal(imagePathFor(ACCOUNT, 'video/mp4', 'abc'), null)

// --- Подпись ----------------------------------------------------------------------------------
// Модель ходит за картинкой сама, поэтому адрес доступен извне — и именно поэтому он короткий.

assert.equal(IMAGE_BUCKET, 'listing-temp-images')
assert.ok(SIGNED_URL_TTL_SECONDS <= 900, 'подпись живёт минуты, а не часы')

const calls = []
const admin = {
  storage: {
    from(bucket) {
      return {
        async createSignedUrl(path, ttl) {
          calls.push({ bucket, path, ttl })
          return { data: { signedUrl: `https://signed/${path}` } }
        },
      }
    },
  },
}

const signed = await signImages(admin, ACCOUNT, [
  `${ACCOUNT}/1.jpg`,
  `${OTHER}/2.jpg`,          // чужая — молча выбрасывается
  `${ACCOUNT}/3.jpg`,
  'мусор',
])
assert.deepEqual(signed, [`https://signed/${ACCOUNT}/1.jpg`, `https://signed/${ACCOUNT}/3.jpg`])
assert.equal(calls.length, 2, 'чужие пути даже не подписываются')
assert.equal(calls[0].bucket, IMAGE_BUCKET)
assert.equal(calls[0].ttl, SIGNED_URL_TTL_SECONDS)

// Одно не загрузившееся фото из четырёх не должно стоить владельцу всей карточки.
const partial = {
  storage: {
    from() {
      return { async createSignedUrl(path) { return path.endsWith('2.jpg') ? { data: null } : { data: { signedUrl: `https://signed/${path}` } } } }
    },
  },
}
assert.deepEqual(
  await signImages(partial, ACCOUNT, [`${ACCOUNT}/1.jpg`, `${ACCOUNT}/2.jpg`]),
  [`https://signed/${ACCOUNT}/1.jpg`],
  'битая подпись пропускается, остальные едут',
)

// Пятое фото добавляет счёт, а не факты.
const many = await signImages(admin, ACCOUNT, Array.from({ length: 9 }, (_, i) => `${ACCOUNT}/${i}.jpg`))
assert.equal(many.length, MAX_IMAGES)

assert.deepEqual(await signImages(admin, ACCOUNT, null), [])
assert.deepEqual(await signImages(admin, ACCOUNT, []), [])

console.log('[OK] Listing images behaviour: 26 assertions')
