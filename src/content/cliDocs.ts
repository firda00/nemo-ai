/*
 * Содержание страницы документации CLI.
 *
 * ТЕКСТ ОТДЕЛЁН ОТ РАЗМЕТКИ по той же причине, что и юридические документы: команды правят
 * отдельно от вёрстки, и сверять их с настоящим поведением CLI проще в одном файле, чем выискивая
 * по JSX.
 *
 * ГЛАВНОЕ ПРО ЭТИ КОМАНДЫ: они обязаны совпадать с тем, что CLI действительно умеет. Документация,
 * обещающая несуществующий флаг, хуже её отсутствия — человек тратит время и уходит с ощущением,
 * что продукт сломан. За совпадением следит контракт в agent-hub/cli-docs-contracts.mjs.
 */

export type Lang = 'uz' | 'ru' | 'en'

export interface InstallTab {
  id: string
  label: Record<Lang, string>
  /** Команда целиком, как её надо вставить в терминал. */
  command: string
  /** Одна строка пояснения под командой. Пусто — пояснение не нужно. */
  note: Record<Lang, string>
}

/*
 * СПОСОБЫ УСТАНОВКИ.
 *
 * Разделитель команд в PowerShell — это не придирка. `&&` там не работает как в bash: до PowerShell
 * 7 он вызывает ошибку разбора, а в 7+ ведёт себя иначе, чем ожидает человек, скопировавший строку
 * из документации для macOS. Отдельная вкладка честнее сноски мелким шрифтом.
 */
export const INSTALL_TABS: InstallTab[] = [
  {
    id: 'powershell',
    label: { ru: 'Windows PowerShell', uz: 'Windows PowerShell', en: 'Windows PowerShell' },
    command: 'npm i -g nemo-ai; nemo',
    note: {
      ru: 'В PowerShell команды разделяются точкой с запятой — «&&» там работает не так, как в bash.',
      uz: 'PowerShell’da buyruqlar nuqtali vergul bilan ajratiladi — «&&» u yerda bash’dagidek ishlamaydi.',
      en: 'PowerShell separates commands with a semicolon — “&&” does not behave like it does in bash.',
    },
  },
  {
    id: 'unix',
    label: { ru: 'macOS · Linux · WSL', uz: 'macOS · Linux · WSL', en: 'macOS · Linux · WSL' },
    command: 'npm i -g nemo-ai && nemo',
    note: {
      ru: 'Обычная установка. Команда nemo станет доступна в любой папке.',
      uz: 'Oddiy oʻrnatish. nemo buyrugʻi istalgan papkada ishlaydi.',
      en: 'The usual install. The nemo command works from any folder.',
    },
  },
  {
    id: 'npx',
    label: { ru: 'Без установки', uz: 'Oʻrnatishsiz', en: 'No install' },
    command: 'npx nemo-ai',
    note: {
      ru: 'Разовый запуск: ничего не ставится глобально, но каждый раз скачивается заново.',
      uz: 'Bir martalik ishga tushirish: hech narsa global oʻrnatilmaydi, lekin har safar qayta yuklanadi.',
      en: 'One-off run: nothing is installed globally, but it downloads each time.',
    },
  },
  {
    id: 'source',
    label: { ru: 'Из исходников', uz: 'Manbadan', en: 'From source' },
    command: 'git clone https://github.com/firda00/nemo-ai.git\ncd nemo-ai\nnpm i\nnpm link',
    note: {
      ru: 'Для разработки и когда реестр npm недоступен. npm link делает команду nemo глобальной.',
      uz: 'Ishlab chiqish uchun va npm reestri mavjud boʻlmaganda. npm link nemo buyrugʻini global qiladi.',
      en: 'For development, or when the npm registry is unreachable. npm link makes nemo global.',
    },
  },
]

export interface CommandRow {
  command: string
  what: Record<Lang, string>
}

export interface CommandGroup {
  title: Record<Lang, string>
  rows: CommandRow[]
}

export const COMMAND_GROUPS: CommandGroup[] = [
  {
    title: { ru: 'Вход', uz: 'Kirish', en: 'Signing in' },
    rows: [
      {
        command: 'nemo',
        what: {
          ru: 'Первый запуск спросит почту и пароль. Сессия ляжет в ~/.nemo/auth.json — больше не спросит.',
          uz: 'Birinchi ishga tushirishda pochta va parol soʻraladi. Sessiya ~/.nemo/auth.json ga saqlanadi.',
          en: 'The first run asks for email and password. The session goes to ~/.nemo/auth.json — it will not ask again.',
        },
      },
      {
        command: 'nemo logout',
        what: {
          ru: 'Удалить сохранённую сессию с этой машины.',
          uz: 'Ushbu qurilmadagi saqlangan sessiyani oʻchirish.',
          en: 'Remove the saved session from this machine.',
        },
      },
    ],
  },
  {
    title: { ru: 'Роли', uz: 'Rollar', en: 'Roles' },
    rows: [
      {
        command: '/agent general',
        what: {
          ru: 'Универсальный: видит все инструменты.',
          uz: 'Universal: barcha vositalarni koʻradi.',
          en: 'Universal: sees every tool.',
        },
      },
      {
        command: '/agent sdr',
        what: {
          ru: 'Поиск клиентов, карточки в Telegram, выгрузка в CRM.',
          uz: 'Mijoz qidirish, Telegram kartochkalari, CRM ga yuklash.',
          en: 'Finding clients, Telegram cards, CRM export.',
        },
      },
      {
        command: '/agent qa',
        what: {
          ru: 'Планы проверок, тесты, аудит сайтов.',
          uz: 'Tekshiruv rejalari, testlar, sayt auditi.',
          en: 'Test plans, tests, site audits.',
        },
      },
      {
        command: '/agent marketing',
        what: {
          ru: 'Позиционирование, тексты, конверсия, цены. Методики подключаются командой /skill.',
          uz: 'Pozitsiyalash, matnlar, konversiya, narxlar. Metodikalar /skill bilan ulanadi.',
          en: 'Positioning, copy, conversion, pricing. Methods load with /skill.',
        },
      },
    ],
  },
  {
    title: { ru: 'Модель', uz: 'Model', en: 'Model' },
    rows: [
      {
        command: 'OPENROUTER_API_KEY=... nemo',
        what: {
          ru: 'Свой ключ с openrouter.ai. Расход идёт по нему, а не по балансу аккаунта Nemo.',
          uz: 'openrouter.ai dan oʻz kalitingiz. Sarf shu kalit boʻyicha, Nemo balansi boʻyicha emas.',
          en: 'Your own key from openrouter.ai. Usage bills to it, not to your Nemo balance.',
        },
      },
      {
        command: '/model local',
        what: {
          ru: 'Своя модель через Ollama на 127.0.0.1:11434. Ключ не нужен.',
          uz: 'Ollama orqali oʻz modelingiz (127.0.0.1:11434). Kalit kerak emas.',
          en: 'Your own model via Ollama on 127.0.0.1:11434. No key needed.',
        },
      },
    ],
  },
  {
    title: { ru: 'В работе', uz: 'Ishda', en: 'While working' },
    rows: [
      {
        command: '/skill',
        what: {
          ru: '49 маркетинговых методик: CRO, копирайтинг, SEO, цены, запуск. /skill <id> — подключить.',
          uz: '49 ta marketing metodikasi: CRO, kopirayting, SEO, narxlar, ishga tushirish.',
          en: '49 marketing methods: CRO, copywriting, SEO, pricing, launch. /skill <id> loads one.',
        },
      },
      {
        command: '/browse <url>',
        what: {
          ru: 'Открыть страницу и положить её текст в контекст разговора.',
          uz: 'Sahifani ochib, matnini suhbat kontekstiga qoʻyish.',
          en: 'Open a page and put its text into the conversation context.',
        },
      },
      {
        command: '/qa <url>',
        what: {
          ru: 'Аудит сайта: скорость, ошибки консоли, битые ссылки, мобильная вёрстка.',
          uz: 'Sayt auditi: tezlik, konsol xatolari, buzilgan havolalar, mobil koʻrinish.',
          en: 'Site audit: speed, console errors, broken links, mobile layout.',
        },
      },
      {
        command: '/compact',
        what: {
          ru: 'Сжать историю пересказом, когда контекст подходит к пределу.',
          uz: 'Kontekst chegaraga yaqinlashganda tarixni qisqartirish.',
          en: 'Compress the history when the context nears its limit.',
        },
      },
      {
        command: '/help',
        what: { ru: 'Все команды.', uz: 'Barcha buyruqlar.', en: 'Every command.' },
      },
    ],
  },
]

/** Требование к среде. Названо явно: без этого установка падает с невнятной ошибкой Node. */
export const NODE_REQUIREMENT = 'Node.js 20.6+'

/*
 * ПОДПИСИ САМОЙ СТРАНИЦЫ — ТОЖЕ НА ТРИ ЯЗЫКА.
 *
 * Первая редакция оставила заголовки и предупреждение по-русски, а описания команд брала по языку
 * интерфейса. На английской версии вышло вперемешку: «Агент в терминале» над английским текстом.
 * Продукт продаётся в Узбекистане на трёх языках, и половина страницы на чужом — это не мелочь,
 * а сообщение «мы вас не имели в виду».
 */
export const UI: Record<string, Record<Lang, string>> = {
  badge: { ru: 'Nemo CLI', uz: 'Nemo CLI', en: 'Nemo CLI' },
  title: { ru: 'Агент в терминале', uz: 'Terminaldagi agent', en: 'The agent in your terminal' },
  lede: {
    ru: 'Одна команда — и агент Nemo работает в любой папке: ищет клиентов, проверяет сайты, пишет тексты и код.',
    uz: 'Bitta buyruq — va Nemo agenti istalgan papkada ishlaydi: mijoz qidiradi, saytlarni tekshiradi, matn va kod yozadi.',
    en: 'One command and the Nemo agent works in any folder: finds clients, audits sites, writes copy and code.',
  },
  needs: { ru: 'Нужен', uz: 'Kerak', en: 'Requires' },
  install: { ru: 'Установка', uz: 'Oʻrnatish', en: 'Install' },
  commands: { ru: 'Справочник команд', uz: 'Buyruqlar qoʻllanmasi', en: 'Command reference' },
  copy: { ru: 'копировать', uz: 'nusxalash', en: 'copy' },
  copied: { ru: 'скопировано', uz: 'nusxalandi', en: 'copied' },
  copyFailed: {
    ru: 'не вышло — скопируйте вручную',
    uz: 'boʻlmadi — qoʻlda nusxalang',
    en: 'failed — copy it by hand',
  },
  warnTitle: { ru: 'Windows PowerShell:', uz: 'Windows PowerShell:', en: 'Windows PowerShell:' },
  warnBody: {
    ru: 'разделяйте команды точкой с запятой, а не двойным амперсандом. Строка, скопированная из инструкции для macOS, там не выполнится.',
    uz: 'buyruqlarni nuqtali vergul bilan ajrating, qoʻsh ampersand bilan emas. macOS uchun yoʻriqnomadan nusxalangan satr u yerda ishlamaydi.',
    en: 'separate commands with a semicolon, not a double ampersand. A line copied from the macOS instructions will not run there.',
  },
  billingTitle: { ru: 'О расходе на модель', uz: 'Model xarajati haqida', en: 'About model spend' },
  billingBody: {
    ru: 'Вход в аккаунт Nemo и оплата модели — разные вещи. CLI обращается к модели по вашему ключу OpenRouter, а не по балансу аккаунта. Если ключа нет, поднимите локальную модель через Ollama и переключитесь командой /model local — она бесплатна и работает без интернета.',
    uz: 'Nemo hisobiga kirish va model uchun toʻlov — har xil narsalar. CLI modelga sizning OpenRouter kalitingiz orqali murojaat qiladi, hisob balansi orqali emas. Kalit boʻlmasa, Ollama orqali lokal modelni koʻtaring va /model local bilan almashing — u bepul va internetsiz ishlaydi.',
    en: 'Signing in to Nemo and paying for the model are separate things. The CLI calls the model with your own OpenRouter key, not your account balance. With no key, run a local model through Ollama and switch with /model local — it is free and works offline.',
  },
}
