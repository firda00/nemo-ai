// Слова для человека. Два языка, потому что продавец на Uzum читает по-русски или по-узбекски.
//
// Здесь ровно один вид текста — тот, что владелец увидит в окне расширения. Системных фраз вроде
// «кнопка не найдена» тут нет намеренно: они называют нашу внутреннюю причину, а не его следующий
// шаг, и человек, прочитав такое, идёт искать поломку вместо того, чтобы нажать одну кнопку.

export const LANGS = ['ru', 'uz']

const DICT = {
  title: {
    ru: 'Nemo — помощник на странице',
    uz: 'Nemo — sahifadagi yordamchi',
  },
  intro: {
    ru: 'Напишите, что сделать на открытой странице. Nemo посмотрит её и предложит действия.',
    uz: 'Ochiq sahifada nima qilishni yozing. Nemo uni ko‘rib, amallarni taklif qiladi.',
  },
  working: { ru: 'Смотрю страницу…', uz: 'Sahifani ko‘ryapman…' },
  enableUniversal: { ru: 'Разрешить Nemo работать на сайтах', uz: 'Nemo’ga saytlarda ishlashga ruxsat berish' },
  universalEnabled: { ru: '✓ Управление сайтами включено', uz: '✓ Saytlarni boshqarish yoqilgan' },
  universalGranted: { ru: 'Готово. Теперь Nemo может сам открывать сайты и переходить между вкладками.', uz: 'Tayyor. Endi Nemo saytlarni o‘zi ochib, varaqlar orasida o‘ta oladi.' },
  universalDenied: { ru: 'Разрешение не выдано. Nemo продолжит работать только в Uzum.', uz: 'Ruxsat berilmadi. Nemo faqat Uzum’da ishlashda davom etadi.' },
  host_permission_required: { ru: 'Откройте расширение Nemo и один раз разрешите ему работать на сайтах.', uz: 'Nemo kengaytmasini oching va saytlarda ishlashga bir marta ruxsat bering.' },

  run: {
    ru: "Выполнить",
    uz: "Bajarish",
  },
  placeholder: {
    ru: "Например: обнови цену, остаток и фото карточки",
    uz: "Masalan: kartochka narxi, qoldig‘i va rasmlarini yangila",
  },
  mediaLabel: { ru: 'Фото и инфографика', uz: 'Rasm va infografika' },
  mediaEmpty: { ru: 'не выбраны', uz: 'tanlanmagan' },
  mediaCount: { ru: 'выбрано: {count}', uz: 'tanlandi: {count}' },
  too_many_media: { ru: 'Можно выбрать не больше 8 изображений.', uz: '8 tadan ortiq rasm tanlab bo‘lmaydi.' },
  unsupported_media: { ru: 'Поддерживаются JPG, PNG и WebP.', uz: 'JPG, PNG va WebP qo‘llanadi.' },
  media_too_large: { ru: 'Каждое изображение должно быть не больше 8 МБ.', uz: 'Har bir rasm 8 MB dan oshmasligi kerak.' },
  media_total_too_large: { ru: 'Общий размер изображений должен быть не больше 32 МБ.', uz: 'Rasmlarning umumiy hajmi 32 MB dan oshmasligi kerak.' },
  no_file_field: { ru: 'На странице не найдено поле загрузки изображений. Откройте шаг «Фото» и повторите.', uz: 'Sahifada rasm yuklash maydoni topilmadi. «Rasmlar» bosqichini ochib, qayta urinib ko‘ring.' },
  media_not_uploaded: { ru: 'Nemo прошёл страницы, но не нашёл поле загрузки изображений. Проверьте, что в карточке доступен шаг «Фото».', uz: 'Nemo sahifalardan o‘tdi, ammo rasm yuklash maydonini topmadi. Kartochkada «Rasmlar» bosqichi borligini tekshiring.' },
  no_progress: { ru: 'Страница не изменилась после двух попыток. Nemo остановился, чтобы не повторять одно действие бесконечно.', uz: 'Ikki urinishdan keyin sahifa o‘zgarmadi. Bir amalni cheksiz takrorlamaslik uchun Nemo to‘xtadi.' },
  step_limit: { ru: 'Nemo дошёл до лимита из 12 шагов и остановился. Проверьте текущий экран перед продолжением.', uz: 'Nemo 12 qadamlik chegaraga yetib to‘xtadi. Davom etishdan oldin joriy sahifani tekshiring.' },
  left_allowed_site: { ru: 'Кабинет открыл страницу вне seller.uzum.uz. Nemo остановился и не передал туда данные.', uz: 'Kabinet seller.uzum.uz dan tashqaridagi sahifani ochdi. Nemo to‘xtadi va u yerga ma’lumot yubormadi.' },
  no_tab: {
    ru: "Откройте страницу, с которой нужно работать, и повторите.",
    uz: "Ishlamoqchi bo‘lgan sahifani oching va qayta urinib ko‘ring.",
  },
  no_plan: {
    ru: "Nemo не нашёл на этой странице, что заполнить. Уточните поручение.",
    uz: "Nemo bu sahifada nimani to‘ldirishni topmadi. Topshiriqni aniqlashtiring.",
  },
  needs_confirmation: {
    ru: "В плане есть необратимое действие — нажатие кнопки отправки или удаления. Разрешите его галочкой и повторите.",
    uz: "Rejada qaytarib bo‘lmaydiganamal bor — yuborish yoki o‘chirish tugmasi. Belgilab, qayta urinib ko‘ring.",
  },
  allowRisky: {
    ru: "Разрешить нажимать кнопки отправки и удаления",
    uz: "Yuborish va o‘chirish tugmalarini bosishga ruxsat",
  },
  filledCount: {
    ru: "Готово. Заполнено полей:",
    uz: "Tayyor. To‘ldirilgan maydonlar:",
  },
  submitted: {
    ru: 'Карточка отправлена по вашему подтверждению. Nemo проверит результат при следующей синхронизации.',
    uz: 'Kartochka sizning tasdig‘ingiz bilan yuborildi. Nemo natijani keyingi sinxronlashda tekshiradi.',
  },
  failedCount: {
    ru: "Не удалось:",
    uz: "Bajarilmadi:",
  },
  rejected: {
    ru: "Часть предложенных действий не прошла проверку безопасности. Отброшено:",
    uz: "Taklif qilingan amallarning bir qismi xavfsizlik tekshiruvidan o‘tmadi. Rad etildi:",
  },
  notAddressed: {
    ru: "Часть полей план не тронул — проверьте карточку глазами. Не тронуто:",
    uz: "Reja ba'zi maydonlarga tegmadi — kartochkani ko‘z bilan tekshiring. Tegilmagan:",
  },
  categoryMismatch: {
    ru: "Категория страницы не совпадает с карточкой — заполнять её сюда рискованно, модерация отклонит товар.",
    uz: "Sahifa turkumi kartochka bilan mos kelmayapti — bu yerga to‘ldirish xavfli, moderatsiya tovarni rad etadi.",
  },
  onPage: { ru: "На странице", uz: "Sahifada" },
  inDraft: { ru: "В карточке", uz: "Kartochkada" },
  categoryMismatchConfirm: {
    ru: "Если категория верна для этого товара — нажмите «Выполнить» ещё раз.",
    uz: "Agar bu tovar uchun turkum to‘g‘ri bo‘lsa — «Bajarish» tugmasini yana bosing.",
  },
  expired: {
    ru: "Срок связи истёк — ключ доступа живёт около часа. Откройте Nemo и нажмите «Связать с Nemo» ещё раз.",
    uz: "Aloqa muddati tugadi — kirish kaliti taxminan bir soat yashaydi. Nemo’ni oching va «Nemo bilan bog‘lash» tugmasini yana bosing.",
  },
  diagnose: {
    ru: "Собрать отчёт о проблеме",
    uz: "Muammo haqida hisobot yig‘ish",
  },
  diagnoseDone: {
    ru: "Отчёт скопирован в буфер обмена — пришлите его целиком.",
    uz: "Hisobot buferga nusxalandi — uni to‘liq yuboring.",
  },
  diagnoseFail: {
    ru: "Не удалось скопировать. Выделите текст ниже и скопируйте вручную.",
    uz: "Nusxalab bo‘lmadi. Quyidagi matnni belgilab, qo‘lda nusxalang.",
  },
  ready: {
    ru: 'Связь с Nemo есть. Откройте нужную страницу и напишите поручение.',
    uz: 'Nemo bilan aloqa bor. Kerakli sahifani oching va topshiriqni yozing.',
  },
  autonomousRunning: {
    ru: 'Nemo самостоятельно выполняет маршрут в браузере. Текущий шаг: {step}.',
    uz: 'Nemo brauzerdagi yo‘lni mustaqil bajaryapti. Joriy qadam: {step}.',
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
