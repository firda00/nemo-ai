// Слова для человека. Два языка, потому что продавец на Uzum читает по-русски или по-узбекски.
//
// Здесь ровно один вид текста — тот, что владелец увидит в окне расширения. Системных фраз вроде
// «кнопка не найдена» тут нет намеренно: они называют нашу внутреннюю причину, а не его следующий
// шаг, и человек, прочитав такое, идёт искать поломку вместо того, чтобы нажать одну кнопку.

export const LANGS = ['ru', 'uz']

const DICT = {
  title: {
    ru: 'Загрузчик карточек Uzum',
    uz: 'Uzum kartochkalari yuklovchisi',
  },
  intro: {
    ru: 'Переносит готовую карточку из Nemo в форму создания товара. Проверяете и продолжаете сами.',
    uz: 'Nemo’dagi tayyor kartochkani tovar yaratish shakliga ko‘chiradi. Tekshirish va davom ettirish — sizdan.',
  },
  fill: { ru: 'Заполнить карточку', uz: 'Kartochkani to‘ldirish' },
  working: { ru: 'Заполняю…', uz: 'To‘ldirilmoqda…' },
  checking: { ru: 'Проверяю связь…', uz: 'Aloqa tekshirilmoqda…' },

  ready: {
    ru: 'Всё готово. Откройте страницу создания товара в кабинете Uzum и нажмите кнопку ниже.',
    uz: 'Hammasi tayyor. Uzum kabinetida tovar yaratish sahifasini oching va quyidagi tugmani bosing.',
  },

  // --- Почему нельзя работать ---------------------------------------------------------------
  not_linked: {
    ru: 'Нет связи с Nemo. Откройте Nemo, войдите как владелец и нажмите «Связать с Nemo».',
    uz: 'Nemo bilan aloqa yo‘q. Nemo’ni oching, egasi sifatida kiring va «Nemo bilan bog‘lash» tugmasini bosing.',
  },
  no_create_tab: {
    ru: 'Откройте в кабинете Uzum страницу создания товара — расширение работает на ней.',
    uz: 'Uzum kabinetida tovar yaratish sahifasini oching — kengaytma o‘sha yerda ishlaydi.',
  },
  idle: {
    ru: 'Готовых карточек нет. Одобрите черновик в Nemo — и он появится здесь.',
    uz: 'Tayyor kartochkalar yo‘q. Nemo’da qoralamani tasdiqlang — u shu yerda paydo bo‘ladi.',
  },
  network: {
    ru: 'Nemo сейчас не отвечает. Попробуйте через минуту.',
    uz: 'Nemo hozir javob bermayapti. Bir daqiqadan so‘ng urinib ko‘ring.',
  },

  // --- Что случилось на странице ------------------------------------------------------------
  //
  // Главная из этих строк — про категорию. В Uzum поля названий и описания оживают только после
  // того, как категория выбрана и подтверждена кнопкой «Принять». Пока этого не сделано, полей
  // на странице просто нет, и «поле не найдено» было бы правдой, от которой никакого толку.
  category_first: {
    ru: 'Сначала подтвердите категорию на странице — выберите её и нажмите «Принять». После этого нажмите «Заполнить карточку».',
    uz: 'Avval sahifada turkumni tasdiqlang — uni tanlang va «Принять» tugmasini bosing. Shundan so‘ng «Kartochkani to‘ldirish» tugmasini bosing.',
  },
  human_needed: {
    ru: 'На странице появилось окно, которое расширение не трогает. Закройте его и попробуйте снова.',
    uz: 'Sahifada kengaytma tegmaydigan oyna paydo bo‘ldi. Uni yoping va qayta urinib ko‘ring.',
  },
  form_changed: {
    ru: 'Форма Uzum выглядит не так, как мы её знаем. Заполните карточку вручную и напишите нам — поправим.',
    uz: 'Uzum shakli biz bilgan ko‘rinishda emas. Kartochkani qo‘lda to‘ldiring va bizga yozing — tuzatamiz.',
  },
  no_response: {
    ru: 'Страница кабинета не ответила. Обновите её и попробуйте снова.',
    uz: 'Kabinet sahifasi javob bermadi. Uni yangilang va qayta urinib ko‘ring.',
  },
  selectors_missing: {
    ru: 'Расширение ещё не знает эту форму. Заполните карточку вручную — мы допишем разметку.',
    uz: 'Kengaytma bu shaklni hali bilmaydi. Kartochkani qo‘lda to‘ldiring — biz belgilashni qo‘shamiz.',
  },

  // --- Чем всё кончилось --------------------------------------------------------------------
  done: {
    ru: 'Карточка заполнена. Проверьте её глазами и продолжайте на Uzum.',
    uz: 'Kartochka to‘ldirildi. Ko‘z bilan tekshiring va Uzum’da davom eting.',
  },
  doneSkipped: {
    ru: 'Заполнено, но не всё. Осталось дописать вручную:',
    uz: 'To‘ldirildi, lekin hammasi emas. Qo‘lda to‘ldirish kerak:',
  },
  tooLong: {
    ru: 'Текст длиннее, чем разрешает Uzum. Сократите в Nemo:',
    uz: 'Matn Uzum ruxsat etganidan uzun. Nemo’da qisqartiring:',
  },
}

/** Человеческие имена полей: в сообщении владельцу не должно быть наших ключей. */
const FIELD_NAMES = {
  titleRu: { ru: 'название на русском', uz: 'ruscha nomi' },
  titleUz: { ru: 'название на узбекском', uz: 'o‘zbekcha nomi' },
  descriptionRu: { ru: 'описание на русском', uz: 'ruscha tavsifi' },
  descriptionUz: { ru: 'описание на узбекском', uz: 'o‘zbekcha tavsifi' },
}

export function pickLang(preferred) {
  if (LANGS.includes(preferred)) return preferred
  const ui = (globalThis.chrome?.i18n?.getUILanguage?.() ?? 'ru').toLowerCase()
  return ui.startsWith('uz') ? 'uz' : 'ru'
}

export function say(key, lang) {
  const block = DICT[key]
  // Незнакомый ключ не должен печататься сырым: пустая строка честнее, чем «category_first» на
  // экране у продавца.
  return block ? block[lang] ?? block.ru : ''
}

export function fieldName(key, lang) {
  const block = FIELD_NAMES[key]
  return block ? block[lang] ?? block.ru : key
}

/** «название на русском, описание на русском» — список полей словами, а не ключами. */
export function fieldList(keys, lang) {
  return (keys ?? []).map((key) => fieldName(key, lang)).join(', ')
}
