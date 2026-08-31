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
 * СПОСОБЫ УСТАНОВКИ, ПЕРВЫЙ — РЕКОМЕНДОВАННЫЙ.
 *
 * Репозиторий проекта приватный. Поэтому пользователь получает только две публичные команды:
 * curl для macOS/Linux и PowerShell для Windows. Оба установщика скачивают готовый архив CLI с
 * домена Nemo; доступ к GitHub и исходному коду не требуется.
 */
export const INSTALL_TABS: InstallTab[] = [
  {
    id: 'native-unix',
    label: { ru: 'macOS · Linux (одной строкой)', uz: 'macOS · Linux (bir qatorda)', en: 'macOS · Linux (one line)' },
    command: 'curl -fsSL https://nemo-ai-swart.vercel.app/install.sh | bash',
    note: {
      ru: 'Проверит Node.js, поставит CLI и скажет, если команда не попала в PATH. Рекомендуемый способ.',
      uz: 'Node.js ni tekshiradi, CLI ni oʻrnatadi va PATH ga tushmasa aytadi. Tavsiya etiladi.',
      en: 'Checks Node.js, installs the CLI, and tells you if the command did not land in PATH. Recommended.',
    },
  },
  {
    id: 'native-windows',
    label: { ru: 'Windows (одной строкой)', uz: 'Windows (bir qatorda)', en: 'Windows (one line)' },
    command: 'irm https://nemo-ai-swart.vercel.app/install.ps1 | iex',
    note: {
      ru: 'То же для PowerShell: проверит Node.js, поставит и обновит PATH текущей сессии.',
      uz: 'PowerShell uchun shu narsa: Node.js ni tekshiradi, oʻrnatadi va joriy sessiya PATH ini yangilaydi.',
      en: 'The same for PowerShell: checks Node.js, installs, and refreshes PATH for the current session.',
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
        command: 'nemo login',
        what: {
          ru: 'Откроет безопасный вход через Google в браузере. Сессия сохранится в ~/.nemo/auth.json с правами только для владельца.',
          uz: 'Brauzerda Google orqali xavfsiz kirishni ochadi. Sessiya ~/.nemo/auth.json faylida faqat egasi uchun saqlanadi.',
          en: 'Opens secure Google sign-in in your browser. The session is stored in ~/.nemo/auth.json with owner-only permissions.',
        },
      },
      {
        command: 'nemo',
        what: {
          ru: 'Запустить агента. Если сессии ещё нет, CLI сам откроет вход в браузере — пароль в терминале не нужен.',
          uz: 'Agentni ishga tushirish. Sessiya bo‘lmasa, CLI brauzerda kirishni o‘zi ochadi — terminalda parol kerak emas.',
          en: 'Starts the agent. If no session exists, the CLI opens browser sign-in automatically—no terminal password required.',
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
        command: 'nemo',
        what: {
          ru: 'Облачная модель Nemo по умолчанию. Отдельный API-ключ не нужен; лимиты учитываются в вашем тарифе.',
          uz: 'Standart Nemo bulut modeli. Alohida API kaliti kerak emas; limitlar tarifingiz bo‘yicha hisoblanadi.',
          en: 'Uses Nemo Cloud by default. No separate API key is needed; usage counts against your plan.',
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
    ru: 'После nemo login запросы идут через защищённый backend Nemo: он проверяет аккаунт и централизованно учитывает лимиты тарифа. Ключ OpenRouter в терминале не нужен. Для полностью локальной работы можно запустить Ollama и выбрать /model local.',
    uz: 'nemo login dan keyin so‘rovlar Nemo himoyalangan backendi orqali yuboriladi: u hisobni tekshiradi va tarif limitlarini markaziy hisoblaydi. Terminalda OpenRouter kaliti kerak emas. To‘liq lokal ishlash uchun Ollama va /model local dan foydalaning.',
    en: 'After nemo login, requests go through Nemo’s secured backend, which verifies the account and meters plan usage centrally. No OpenRouter key is needed in the terminal. For fully local use, run Ollama and select /model local.',
  },
}
