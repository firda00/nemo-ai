// Юридические документы: публичная оферта и политика конфиденциальности.
//
// ⚠ ЭТО ЧЕРНОВИК, А НЕ ЮРИДИЧЕСКАЯ КОНСУЛЬТАЦИЯ. Публичная оферта в Узбекистане имеет требования
// закона к содержанию (существенные условия, порядок акцепта, реквизиты оферента). До того как
// документ начнёт регулировать реальные договоры и списания денег, его обязан проверить юрист.
// Текст ниже описывает, как продукт РАБОТАЕТ на самом деле, — это лучшая заготовка для юриста, но
// заготовкой она и остаётся.
//
// ПОЧЕМУ ОТДЕЛЬНЫМ МОДУЛЕМ, а не строками в компоненте. Юрист правит текст, а не разметку. Здесь
// один файл, который можно отдать на вычитку целиком, и три языка рядом — расхождение между ними
// видно глазом, а не только при переключении языка в браузере.

import type { Lang } from '../types'

export interface LegalSection {
  heading: string
  paragraphs: string[]
}

export interface LegalDocument {
  title: string
  updated: string
  intro: string
  sections: LegalSection[]
}

/** Дата вступления в силу. Одна на оба документа: расхождение дат — первый вопрос проверяющего. */
export const LEGAL_EFFECTIVE_DATE = '2026-08-19'

/**
 * Пять блоков, обязательных для этого продукта.
 *
 * Не украшение и не перестраховка — каждый закрывает конкретный способ поссориться с клиентом:
 *
 *   ai_disclaimer  — модель ошибается вероятностно, и ошибка выглядит так же уверенно, как правда;
 *   human_loop     — отправку клиенту и публикацию подтверждает человек, а не агент;
 *   billing        — токены списываются за фактическое вычисление и не возвращаются;
 *   rag            — данные компании не уходят в обучение публичных моделей;
 *   liability      — предел ответственности деньгами, а не «в размере причинённого ущерба».
 *
 * Список экспортируется, потому что на него ссылается проверка: документ без любого из блоков
 * выкатывать нельзя, и заметить пропажу глазами на трёх языках невозможно.
 */
export const REQUIRED_LEGAL_BLOCKS = ['ai_disclaimer', 'human_loop', 'billing', 'rag', 'liability'] as const
export type RequiredLegalBlock = (typeof REQUIRED_LEGAL_BLOCKS)[number]

/** Ключи блоков в порядке появления в документе. Нужны проверке и оглавлению. */
export const TERMS_BLOCK_ORDER: RequiredLegalBlock[] = ['ai_disclaimer', 'human_loop', 'billing', 'liability']
export const PRIVACY_BLOCK_ORDER: RequiredLegalBlock[] = ['rag']

const RU_TERMS: LegalDocument = {
  title: 'Условия использования (публичная оферта)',
  updated: LEGAL_EFFECTIVE_DATE,
  intro: 'Nemo AI — платформа автономных AI-агентов и команд для бизнеса. Создавая аккаунт, вы принимаете эти условия. Если вы не согласны хотя бы с одним пунктом, не пользуйтесь сервисом.',
  sections: [
    {
      heading: 'Точность ответов и природа языковых моделей',
      paragraphs: [
        'Агенты Nemo AI построены на больших языковых моделях. Такие модели работают вероятностно: они предсказывают продолжение текста, а не извлекают факты из проверенной базы. Поэтому ответ может быть неверным, устаревшим или выдуманным — и при этом выглядеть таким же уверенным, как правильный.',
        'Мы не гарантируем точность, полноту и пригодность сгенерированного содержимого для конкретной цели. Любой результат работы агента — черновик, требующий проверки человеком, а не готовое решение.',
        'Особенно это касается чисел, контактов, юридических формулировок, медицинских и финансовых сведений. Проверяйте их по первоисточнику до того, как использовать.',
      ],
    },
    {
      heading: 'Действия во внешнем мире подтверждает человек',
      paragraphs: [
        'Агенты делятся на читающих и действующих. Читающие смотрят открытые данные и ничего не меняют. Действующие отправляют сообщения, публикуют карточки на маркетплейсах, пишут в CRM и совершают другие необратимые операции.',
        'Каждое действующее обращение требует подтверждения владельца аккаунта. Подтверждая, вы принимаете ответственность за содержание отправленного и за последствия: за текст сообщения клиенту, за корректность опубликованной карточки, за запись в чужой системе.',
        'Ответственность за соблюдение законов о рекламе, о персональных данных и о защите прав потребителей при таких отправках лежит на владельце аккаунта. Nemo AI предоставляет инструмент, но не проверяет содержание за вас.',
        'Настройка автоматического подтверждения, если она включена вами, не переносит ответственность на Nemo AI.',
      ],
    },
    {
      heading: 'Кредиты, списания и возврат',
      paragraphs: [
        'Работа агентов оплачивается кредитами. Кредиты списываются за фактически израсходованные вычислительные ресурсы: токены языковой модели, запуск браузера и разбор страниц, распознавание и синтез речи, обработку и сборку медиа, обращения к внешним сервисам.',
        'Списание происходит по факту выполнения работы, независимо от того, устроил ли вас результат. Неудачный или бесполезный для вас ответ модели — это тоже израсходованные вычисления, и он оплачивается.',
        'Израсходованные кредиты не возвращаются и не обмениваются на деньги. Неизрасходованный остаток может быть возвращён по правилам действующего тарифа.',
        'Актуальные тарифы, остаток и история списаний доступны в веб-панели управления Nemo AI.',
      ],
    },
    {
      heading: 'Предел ответственности',
      paragraphs: [
        'Совокупная ответственность Nemo AI по любым требованиям, связанным с использованием сервиса, ограничена суммой, фактически уплаченной вами за последний месяц подписки, предшествующий событию.',
        'Nemo AI не отвечает за упущенную выгоду, потерю данных, репутационный вред и иные косвенные убытки.',
        'Это ограничение не применяется там, где закон не допускает его применения.',
      ],
    },
    {
      heading: 'Допустимое использование',
      paragraphs: [
        'Запрещено использовать сервис для несанкционированного доступа к чужим системам, обхода средств защиты и капчи, массовых нежелательных рассылок, слежки, а также для действий против систем, которыми вы не владеете и на которые не имеете разрешения.',
        'Nemo AI вправе приостановить аккаунт при нарушении этих правил или при неоплате.',
      ],
    },
    {
      heading: 'Изменения и связь',
      paragraphs: [
        'Условия могут меняться. Существенные изменения публикуются на этой странице с новой датой вступления в силу; продолжение использования сервиса означает согласие с ними.',
        'Вопросы по условиям и подписке — через поддержку в веб-панели управления Nemo AI или к основателю платформы.',
      ],
    },
  ],
}

const RU_PRIVACY: LegalDocument = {
  title: 'Политика конфиденциальности',
  updated: LEGAL_EFFECTIVE_DATE,
  intro: 'Здесь описано, какие данные Nemo AI получает, зачем и что с ними не делает.',
  sections: [
    {
      heading: 'Ваши данные не обучают публичные модели',
      paragraphs: [
        'Документы, базы знаний, переписки, файлы и результаты работы агентов принадлежат вам. Nemo AI не передаёт их для обучения общедоступных языковых моделей и не использует для обучения собственных моделей, доступных другим клиентам.',
        'Ваша база знаний используется только для ответов вашим же агентам: содержимое подставляется в запрос в момент обращения и не остаётся в весах модели.',
        'При обращении к внешним поставщикам моделей мы передаём только то, что необходимо для выполнения запрошенной вами работы, и выбираем режимы, в которых поставщик не использует переданные данные для обучения. Если такой режим у поставщика недоступен, мы указываем это в настройках интеграции.',
      ],
    },
    {
      heading: 'Какие данные обрабатываются',
      paragraphs: [
        'Учётные данные и сведения о компании, содержимое запросов к агентам, загруженные файлы, журналы прогонов и подтверждений, метаданные интеграций, снимки страниц, сделанные браузером по вашему запросу.',
        'Данные используются для входа в аккаунт, выполнения запрошенной работы, обеспечения безопасности, поддержки и подсчёта израсходованных ресурсов.',
        'Маркетинговые сообщения отправляются только при отдельном согласии, которое можно отозвать.',
      ],
    },
    {
      heading: 'Доступ, хранение и удаление',
      paragraphs: [
        'Данные разделены по аккаунтам: агенты одного клиента не видят данные другого.',
        'Владелец аккаунта может запросить доступ к своим данным, их исправление, выгрузку или удаление.',
        'Секреты интеграций (ключи API, токены) хранятся только для записи: после сохранения они не показываются обратно и не выдаются по запросу.',
      ],
    },
    {
      heading: 'Где обрабатываются данные',
      paragraphs: [
        'Сервис работает из Узбекистана. Отдельные операции выполняются у поставщиков инфраструктуры и моделей за пределами страны — в объёме, необходимом для выполнения вашего запроса.',
        'Мы не заявляем о соответствии GDPR, HIPAA или SOC 2 до завершения соответствующих проверок. Утверждать обратное было бы обещанием, которое нечем подтвердить.',
      ],
    },
    {
      heading: 'Связь',
      paragraphs: [
        'Запросы по обработке данных принимаются через поддержку в веб-панели управления Nemo AI.',
      ],
    },
  ],
}

const UZ_TERMS: LegalDocument = {
  title: 'Foydalanish shartlari (ommaviy oferta)',
  updated: LEGAL_EFFECTIVE_DATE,
  intro: 'Nemo AI — biznes uchun avtonom AI-agentlar va jamoalar platformasi. Hisob yaratish orqali siz ushbu shartlarni qabul qilasiz. Agar biror band bilan rozi boʻlmasangiz, xizmatdan foydalanmang.',
  sections: [
    {
      heading: 'Javoblar aniqligi va til modellarining tabiati',
      paragraphs: [
        'Nemo AI agentlari katta til modellariga asoslangan. Bunday modellar ehtimollik asosida ishlaydi: ular tekshirilgan bazadan fakt olmaydi, balki matnning davomini bashorat qiladi. Shu sababli javob notoʻgʻri, eskirgan yoki toʻqib chiqarilgan boʻlishi mumkin — va toʻgʻri javob kabi ishonchli koʻrinishi mumkin.',
        'Biz yaratilgan kontentning aniqligi, toʻliqligi va muayyan maqsadga yaroqliligini kafolatlamaymiz. Agent ishining har qanday natijasi — inson tekshiruvini talab qiladigan qoralama, tayyor yechim emas.',
        'Bu ayniqsa raqamlar, kontaktlar, huquqiy iboralar, tibbiy va moliyaviy maʼlumotlarga tegishli. Foydalanishdan oldin ularni birlamchi manbadan tekshiring.',
      ],
    },
    {
      heading: 'Tashqi harakatlarni inson tasdiqlaydi',
      paragraphs: [
        'Agentlar oʻqiydigan va harakat qiladiganlarga boʻlinadi. Oʻqiydiganlar ochiq maʼlumotlarni koʻradi va hech narsani oʻzgartirmaydi. Harakat qiladiganlar xabar yuboradi, marketpleyslarda kartochka joylaydi, CRM ga yozadi va boshqa qaytarib boʻlmaydigan amallarni bajaradi.',
        'Har bir harakat hisob egasining tasdiqini talab qiladi. Tasdiqlash orqali siz yuborilgan mazmun va oqibatlar uchun javobgarlikni olasiz: mijozga yuborilgan matn, joylangan kartochka toʻgʻriligi, boshqa tizimdagi yozuv uchun.',
        'Bunday yuborishlarda reklama, shaxsiy maʼlumotlar va isteʼmolchilar huquqlari toʻgʻrisidagi qonunlarga rioya qilish javobgarligi hisob egasiga yuklanadi.',
        'Siz yoqqan avtomatik tasdiqlash sozlamasi javobgarlikni Nemo AI ga oʻtkazmaydi.',
      ],
    },
    {
      heading: 'Kreditlar, yechib olish va qaytarish',
      paragraphs: [
        'Agentlar ishi kreditlar bilan toʻlanadi. Kreditlar haqiqatda sarflangan hisoblash resurslari uchun yechiladi: til modeli tokenlari, brauzer ishga tushirilishi va sahifalarni tahlil qilish, nutqni tanish va sintez qilish, media qayta ishlash, tashqi xizmatlarga murojaatlar.',
        'Yechib olish ish bajarilgani boʻyicha amalga oshiriladi — natija sizni qanoatlantirdimi yoki yoʻqmi, bundan qatʼi nazar. Foydasiz javob ham sarflangan hisoblashdir va u toʻlanadi.',
        'Sarflangan kreditlar qaytarilmaydi va pulga almashtirilmaydi. Sarflanmagan qoldiq amaldagi tarif qoidalari boʻyicha qaytarilishi mumkin.',
        'Amaldagi tariflar, qoldiq va yechib olish tarixi Nemo AI boshqaruv veb-panelida mavjud.',
      ],
    },
    {
      heading: 'Javobgarlik chegarasi',
      paragraphs: [
        'Nemo AI ning xizmatdan foydalanish bilan bogʻliq har qanday talablar boʻyicha umumiy javobgarligi voqeadan oldingi oxirgi obuna oyi uchun siz haqiqatda toʻlagan summa bilan cheklanadi.',
        'Nemo AI boy berilgan foyda, maʼlumotlar yoʻqolishi, obroʻga zarar va boshqa bilvosita zararlar uchun javob bermaydi.',
        'Ushbu cheklov qonun uni qoʻllashga yoʻl qoʻymaydigan holatlarda amal qilmaydi.',
      ],
    },
    {
      heading: 'Ruxsat etilgan foydalanish',
      paragraphs: [
        'Xizmatdan begona tizimlarga ruxsatsiz kirish, himoya vositalari va capcha ni chetlab oʻtish, ommaviy keraksiz xabarlar tarqatish, kuzatuv, shuningdek siz egalik qilmaydigan tizimlarga qarshi harakatlar uchun foydalanish taqiqlanadi.',
        'Nemo AI ushbu qoidalar buzilganda yoki toʻlov amalga oshirilmaganda hisobni toʻxtatib turishga haqli.',
      ],
    },
    {
      heading: 'Oʻzgarishlar va aloqa',
      paragraphs: [
        'Shartlar oʻzgarishi mumkin. Muhim oʻzgarishlar ushbu sahifada yangi kuchga kirish sanasi bilan eʼlon qilinadi.',
        'Shartlar va obuna boʻyicha savollar — Nemo AI boshqaruv veb-panelidagi qoʻllab-quvvatlash orqali yoki platforma asoschisiga.',
      ],
    },
  ],
}

const UZ_PRIVACY: LegalDocument = {
  title: 'Maxfiylik siyosati',
  updated: LEGAL_EFFECTIVE_DATE,
  intro: 'Bu yerda Nemo AI qanday maʼlumotlarni oladi, nima uchun va ular bilan nima qilmasligi tasvirlangan.',
  sections: [
    {
      heading: 'Sizning maʼlumotlaringiz ommaviy modellarni oʻqitmaydi',
      paragraphs: [
        'Hujjatlar, bilimlar bazasi, yozishmalar, fayllar va agentlar ish natijalari sizga tegishli. Nemo AI ularni ommaviy til modellarini oʻqitish uchun uzatmaydi va boshqa mijozlarga ochiq boʻlgan oʻz modellarini oʻqitishda ishlatmaydi.',
        'Bilimlar bazangiz faqat sizning agentlaringiz javoblari uchun ishlatiladi: mazmun murojaat paytida soʻrovga qoʻyiladi va model ogʻirliklarida qolmaydi.',
        'Tashqi model taʼminotchilariga murojaat qilganda faqat soʻralgan ishni bajarish uchun zarur boʻlgan maʼlumot uzatiladi va taʼminotchi uzatilgan maʼlumotni oʻqitish uchun ishlatmaydigan rejimlar tanlanadi.',
      ],
    },
    {
      heading: 'Qanday maʼlumotlar qayta ishlanadi',
      paragraphs: [
        'Hisob maʼlumotlari va kompaniya haqidagi maʼlumotlar, agentlarga soʻrovlar mazmuni, yuklangan fayllar, ishga tushirish va tasdiqlash jurnallari, integratsiya metamaʼlumotlari, sizning soʻrovingiz boʻyicha brauzer olgan sahifa suratlari.',
        'Maʼlumotlar hisobga kirish, soʻralgan ishni bajarish, xavfsizlikni taʼminlash, qoʻllab-quvvatlash va sarflangan resurslarni hisoblash uchun ishlatiladi.',
        'Marketing xabarlari faqat alohida rozilik bilan yuboriladi va uni qaytarib olish mumkin.',
      ],
    },
    {
      heading: 'Kirish, saqlash va oʻchirish',
      paragraphs: [
        'Maʼlumotlar hisoblar boʻyicha ajratilgan: bir mijozning agentlari boshqasining maʼlumotlarini koʻrmaydi.',
        'Hisob egasi oʻz maʼlumotlariga kirish, ularni tuzatish, yuklab olish yoki oʻchirishni soʻrashi mumkin.',
        'Integratsiya sirlari (API kalitlari, tokenlar) faqat yozish uchun saqlanadi: saqlangandan keyin ular qaytarib koʻrsatilmaydi.',
      ],
    },
    {
      heading: 'Maʼlumotlar qayerda qayta ishlanadi',
      paragraphs: [
        'Xizmat Oʻzbekistondan ishlaydi. Ayrim amallar mamlakat tashqarisidagi infratuzilma va model taʼminotchilarida bajariladi — soʻrovingizni bajarish uchun zarur hajmda.',
        'Tegishli tekshiruvlar yakunlanmaguncha biz GDPR, HIPAA yoki SOC 2 ga muvofiqlik haqida daʼvo qilmaymiz.',
      ],
    },
    {
      heading: 'Aloqa',
      paragraphs: [
        'Maʼlumotlarni qayta ishlash boʻyicha soʻrovlar Nemo AI boshqaruv veb-panelidagi qoʻllab-quvvatlash orqali qabul qilinadi.',
      ],
    },
  ],
}

const EN_TERMS: LegalDocument = {
  title: 'Terms of Service (public offer)',
  updated: LEGAL_EFFECTIVE_DATE,
  intro: 'Nemo AI is a platform of autonomous AI agents and teams for business. By creating an account you accept these terms. If you disagree with any clause, do not use the service.',
  sections: [
    {
      heading: 'Accuracy and the nature of language models',
      paragraphs: [
        'Nemo AI agents are built on large language models. Such models are probabilistic: they predict the continuation of text rather than retrieve facts from a verified database. An answer may therefore be wrong, outdated or invented — and look exactly as confident as a correct one.',
        'We do not guarantee the accuracy, completeness or fitness of generated content for any particular purpose. Any agent output is a draft that requires human review, not a finished decision.',
        'This applies especially to numbers, contacts, legal wording, medical and financial information. Verify them against the primary source before acting.',
      ],
    },
    {
      heading: 'A human confirms actions in the outside world',
      paragraphs: [
        'Agents are either read-only or action-capable. Read-only agents inspect public data and change nothing. Action-capable agents send messages, publish marketplace listings, write to CRM and perform other irreversible operations.',
        'Every action-capable call requires the account owner’s confirmation. By confirming, you accept responsibility for what is sent and for the consequences: the text delivered to a customer, the correctness of a published listing, the record created in a third-party system.',
        'Compliance with advertising, personal data and consumer protection law for such sends rests with the account owner. Nemo AI supplies the tool; it does not review your content for you.',
        'An auto-confirmation setting, if you enable it, does not transfer responsibility to Nemo AI.',
      ],
    },
    {
      heading: 'Credits, charges and refunds',
      paragraphs: [
        'Agent work is paid for in credits. Credits are charged for compute actually consumed: language model tokens, browser launches and page parsing, speech recognition and synthesis, media processing, and calls to external services.',
        'Charges are made on completion of the work, regardless of whether the result satisfied you. An unhelpful answer is still consumed compute and is billed.',
        'Consumed credits are non-refundable and cannot be exchanged for money. An unused balance may be refunded under the rules of the active plan.',
        'Current pricing, balance and charge history are available in the Nemo AI web control panel.',
      ],
    },
    {
      heading: 'Limitation of liability',
      paragraphs: [
        'Nemo AI’s aggregate liability for any claim arising from use of the service is limited to the amount you actually paid for the last monthly subscription period preceding the event.',
        'Nemo AI is not liable for lost profit, data loss, reputational harm or other indirect damages.',
        'This limitation does not apply where the law does not permit it.',
      ],
    },
    {
      heading: 'Acceptable use',
      paragraphs: [
        'You may not use the service for unauthorized access to systems, bypassing security controls or CAPTCHAs, bulk unsolicited messaging, surveillance, or actions against systems you neither own nor have permission to operate.',
        'Nemo AI may suspend an account that violates these rules or is unpaid.',
      ],
    },
    {
      heading: 'Changes and contact',
      paragraphs: [
        'These terms may change. Material changes are published on this page with a new effective date.',
        'Questions about terms and subscription: through support in the Nemo AI web control panel or to the platform founder.',
      ],
    },
  ],
}

const EN_PRIVACY: LegalDocument = {
  title: 'Privacy Policy',
  updated: LEGAL_EFFECTIVE_DATE,
  intro: 'This describes what data Nemo AI receives, why, and what it does not do with it.',
  sections: [
    {
      heading: 'Your data does not train public models',
      paragraphs: [
        'Documents, knowledge bases, conversations, files and agent outputs belong to you. Nemo AI does not submit them for training publicly available language models, and does not use them to train its own models that are exposed to other customers.',
        'Your knowledge base is used only to answer your own agents: content is placed into the request at the moment of the call and does not remain in model weights.',
        'When calling external model providers we transmit only what is required to perform the work you requested, and select modes in which the provider does not use transmitted data for training. Where a provider offers no such mode, we state this in the integration settings.',
      ],
    },
    {
      heading: 'What data is processed',
      paragraphs: [
        'Account and company details, the content of requests to agents, uploaded files, run and approval logs, integration metadata, and page snapshots taken by the browser at your request.',
        'Data is used to sign you in, perform requested work, secure the service, provide support and meter consumed resources.',
        'Marketing messages are sent only with separate consent, which can be withdrawn.',
      ],
    },
    {
      heading: 'Access, retention and deletion',
      paragraphs: [
        'Data is separated by account: one customer’s agents cannot see another customer’s data.',
        'The account owner may request access to their data, its correction, export or deletion.',
        'Integration secrets (API keys, tokens) are stored write-only: once saved they are never displayed back.',
      ],
    },
    {
      heading: 'Where data is processed',
      paragraphs: [
        'The service is operated from Uzbekistan. Certain operations run at infrastructure and model providers outside the country, to the extent required to fulfil your request.',
        'We make no claim of GDPR, HIPAA or SOC 2 compliance until the corresponding verification is complete.',
      ],
    },
    {
      heading: 'Contact',
      paragraphs: [
        'Data requests are accepted through support in the Nemo AI web control panel.',
      ],
    },
  ],
}

const TERMS: Record<Lang, LegalDocument> = { ru: RU_TERMS, uz: UZ_TERMS, en: EN_TERMS }
const PRIVACY: Record<Lang, LegalDocument> = { ru: RU_PRIVACY, uz: UZ_PRIVACY, en: EN_PRIVACY }

export function termsFor(lang: Lang): LegalDocument {
  return TERMS[lang] ?? TERMS.ru
}

export function privacyFor(lang: Lang): LegalDocument {
  return PRIVACY[lang] ?? PRIVACY.ru
}

export { TERMS, PRIVACY }
