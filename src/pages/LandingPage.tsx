import { useState } from 'react'
import {
  ArrowLeftRight,
  ArrowRight,
  BrainCircuit,
  CalendarClock,
  CheckCircle2,
  Cpu,
  Database,
  Globe,
  Layers,
  Lock,
  MessageCircleMore,
  Mic,
  Plug,
  Rocket,
  ShieldCheck,
  Sparkles,
  X,
  Zap,
} from 'lucide-react'
import { Link } from 'react-router-dom'
import { MarketingFooter } from '../components/layout/MarketingFooter'
import { MarketingHeader } from '../components/layout/MarketingHeader'
import { Accordion } from '../components/ui/Accordion'
import { Button } from '../components/ui/Button'
import { HeroInteractiveShowcase } from '../components/platform/HeroInteractiveShowcase'
import { useI18n } from '../i18n'
import { cn } from '../lib/cn'

const copy = {
  ru: {
    launch: "Закрытая бета",
    heroKicker: "PR-релиз · Создание вашего AI-Джарвиса по 1 промпту",
    title: "Поручите задачу.\nПолучите AI-Джарвиса.",
    subtitle: "Что умеет наш сервис: собирает корпоративного AI-Джарвиса по одному промпту. Автономные агенты 24/7 в облаке, двусторонняя интеграция с 1С и CRM, расписания задач и нулевой риск галлюцинаций.",
    primaryCta: "Создать аккаунт",
    secondaryCta: "Посмотреть, как работает",
    openTeam: "Получить доступ",
    notes: ["По коду приглашения", "Без кода", "UZ / RU / EN"],
    statsTitle: "Что можно изучить в закрытой бете",
    stats: [
      ["Файлы", "документы и исходники"],
      ["Расчёты", "периоды и строки-основания"],
      ["Задачи", "сценарии и правила"],
      ["3 языка", "UZ / RU / EN"],
    ],
    painKicker: "Как это работает",
    painTitle: "От задачи до проверенного результата",
    painSubtitle: "Начните с одного процесса. Подключите нужные источники, проверьте разрешения и результат на тестовых данных.",
    flow: [
      ["Опишите задачу", "Расскажите, что должна делать команда. на любом языке"],
      ["Настройте роли", "Выберите специалистов, инструменты, базу знаний и каналы"],
      ["Согласуйте действие", "Владелец проверяет параметры перед выполнением"],
      ["Проверьте результат", "Сверьте сохранённый результат с исходной задачей"],
    ],
    before: "Без AI-агентов",
    after: "С Nemo AI",
    beforeItems: [
      "Время ответа зависит от загрузки менеджеров",
      "Каждый процесс требует отдельного разрозненного инструмента",
      "Масштабирование требует найма новых людей",
      "Нет единой системы для отслеживания рабочих процессов",
    ],
    afterItems: [
      "Ответы по вашим инструкциям с нулевым риском галлюцинаций",
      "Единая платформа: двусторонняя интеграция и автономный шедулер задач",
      "Новые процессы добавляются после проверки на ваших данных",
      "Полный аудит: история действий, метрики качества и передача человеку",
    ],
    connectorsKicker: "Двусторонняя интеграция",
    connectorsTitle: "Интегрируйте ваши данные в Nemo — или Nemo в свои системы",
    connectorsSubtitle: "Двусторонний обмен 24/7: подключайте 1С, amoCRM, Sheets и мессенджеры к нам, либо встраивайте веб-виджет Nemo, REST API и MCP Server в свои существующие продукты.",
    connectorsTabs: {
      all: "Все системы",
      crm: "CRM & Продажи",
      docs: "Таблицы & Файлы",
      chat: "Мессенджеры & Виджет",
      erp: "1C & Склад",
      data: "Базы, API & Шедулер",
    },
    workflowKicker: "Координированные AI-команды",
    workflowTitle: "Запись на занятие с решением владельца",
    workflowSubtitle: "Этот путь проверен локально на тестовых данных: от сообщения и выбора занятия до согласования и чтения сохранённой записи. Ниже — иллюстрация процесса, не рабочая клиентская запись.",
    capKicker: "Возможности AI-команды",
    capTitle: "Инструменты под вашу задачу",
    capabilities: [
      ["Мессенджеры & Виджет", "Telegram, WhatsApp, виджет на сайте и интеграция в сторонние CRM", MessageCircleMore],
      ["База знаний без галлюцинаций", "Документы PDF, DOCX и XLSX как строгие первоисточники для ответов", Database],
      ["Двусторонние инструменты", "1C, CRM, Google Sheets, REST API, браузер, генерация файлов", Plug],
      ["Голос", "Голосовые сценарии требуют доступного провайдера и настройки", Mic],
      ["Автономный шедулер", "Агент сам ставит себе cron-задачи: утренние дайджесты и follow-up клиентам", CalendarClock],
      ["Аналитика и аудит", "Отслеживайте эффективность каждого агента и полной цепочки шагов", Layers],
    ],
    templatesKicker: "Сценарии использования",
    templatesTitle: "Выберите процесс для совместной проверки",
    templates: [
      ["Поддержка клиентов", "Мгновенные ответы, маршрутизация и передача оператору"],
      ["Продажи и лиды", "Квалификация заявок, follow-up и обновление CRM"],
      ["Контент и маркетинг", "Генерация текстов, постов и креативов по расписанию"],
      ["Аналитика и отчёты", "Ежедневные сводки, мониторинг отклонений и уведомления"],
      ["HR и рекрутинг", "Скрининг резюме, ответы кандидатам, онбординг"],
      ["Исследования", "Поиск информации, анализ конкурентов и рынка"],
    ],
    controlKicker: "Стек защиты от ошибок",
    controlTitle: "6 технологических барьеров: сведение галлюцинаций к нулю",
    controlSubtitle: "Модель — лишь исполнитель в рамках детерминированного кода. Проверки схем, песочницы и строгий отказ от фантазий исключают искажение реальных данных.",
    controls: [
      {
        title: "Детерминированные схемы (Zod)",
        text: "Строгая типизация входящих и исходящих данных блокирует невалидные структуры до сохранения в базу.",
        tag: "SCHEMA_GUARD",
        icon: ShieldCheck,
      },
      {
        title: "Изолированная песочница (Sandbox)",
        text: "Математика, формулы и пересчеты курсов вычисляются кодом в песочнице, а не придумываются моделью.",
        tag: "WASM_EXEC",
        icon: Cpu,
      },
      {
        title: "Grounded RAG & Строгий отказ",
        text: "Ответы строго по файлам компании (1С, XLSX, CRM). Если данных нет, агент не угадывает, а запрашивает документ.",
        tag: "ZERO_HALLUCINATION",
        icon: Database,
      },
      {
        title: "Автономный шедулер задач (Cron)",
        text: "Агент сам ставит себе отложенные задачи (follow-up через 48ч, утренний дайджест в 09:00) в облачном рантайме.",
        tag: "AUTO_SCHEDULER",
        icon: CalendarClock,
      },
      {
        title: "Двойной аудит Supervisor-Worker",
        text: "Независимый агент-аудитор перепроверяет промежуточный результат до совершения ключевого действия.",
        tag: "A2A_CONSENSUS",
        icon: CheckCircle2,
      },
      {
        title: "Осознанный Human-in-the-Loop",
        text: "Ручное подтверждение владельцем сохранено только для критических финансовых проводок и договоров.",
        tag: "OWNER_GATE",
        icon: Lock,
      },
    ],
    faqTitle: "Частые вопросы",
    faq: [
      { q: "Что такое AI-агент?", a: "AI-агент. это автономная программа, которая выполняет задачи по вашим правилам: отвечает клиентам, обрабатывает заявки, генерирует контент или анализирует данные. Агент работает 24/7 в облаке и подключается к вашим каналам и инструментам." },
      { q: "Как Nemo борется с галлюцинациями?", a: "Мы не полагаемся на слепое доверие к модели. Nemo использует 6 уровней защиты: детерминированные Zod-схемы, вычисления в изолированной песочнице (WASM), 100% привязку к первоисточникам с отказом от выдумок, перекрестный аудит Supervisor-Worker и автономный шедулер задач." },
      { q: "Можно ли интегрировать Nemo в нашу систему?", a: "Да, поддерживается двусторонняя интеграция: вы можете как подключить свои сервисы (1С, amoCRM, Sheets, базы данных) в Nemo, так и встроить веб-виджет Nemo на свой сайт, вызывать агентов через REST API или подключить Nemo как MCP Server к другим системам." },
      { q: "Может ли агент сам ставить задачи по расписанию?", a: "Да! Агент обладает встроенным шедулером (Cron & Delayed Tasks): он может сам назначить follow-up клиенту через 48 часов, поставить утреннюю сверку отчетов на 09:00 или настроить еженедельный аудит остатков." },
      { q: "Сколько это стоит?", a: "Сейчас идёт закрытая бета. доступ по коду приглашения. Участие в бете бесплатно: 50 диалогов на старте. Платные планы. от $59/мес, лимиты и расход на странице тарифов." },
    ],
    previewSales: {
      process: "AI-команда Nemo", request: "Квалификация лида (B2B)", done: "В процессе", team: "Состав команды", message: "Входящий запрос",
      quote: "«Здравствуйте! Хотим запросить корпоративное демо на 50 пользователей. Какие у вас тарифы?»", history: "История действий", next: "Следующий шаг", action: "Назначить демо-звонок с менеджером продаж",
      agents: ["Координатор", "Lead Qualifier", "Product Expert", "Quality Reviewer"],
      steps: ["Запрос демо классифицирован (50 лицензий)", "Сетка корпоративных цен найдена в базе знаний", "Лид сохранен в CRM с высоким приоритетом", "Черновик ответа с тарифами проверен и отправлен"],
    },
    previewOps: {
      process: "Локальный тестовый сценарий", request: "Запись на пробное занятие", done: "Иллюстрация", team: "Участники процесса", message: "Сообщение в чате",
      quote: "«Запиши тестового ученика на пробное занятие по английскому в 15:00.»", history: "Проверяемые шаги", next: "Подтверждение", action: "Показать номер записи только после отдельного чтения сохранённого результата",
      agents: ["Оператор", "Nemo", "Владелец", "Исполнитель записи"],
      steps: ["Прочитать расписание и проверить место", "Сохранить заявку с выбранным занятием", "Получить решение владельца", "Создать запись и повторно прочитать результат"],
    },
    finalTitle: "Займите место в закрытой бете",
    finalText: "Расскажите о вашей задаче в форме заявки. Доступ к закрытой бете предоставляется по приглашению.",
  },
  uz: {
    launch: "Yopiq beta",
    heroKicker: "Biznesni avtomatlashtirish uchun AI-platforma",
    title: "Vazifani topshiring.\nAI-Jarvisni oling.",
    subtitle: "Bizning servis bitta promt orqali kompaniya uchun avtonom AI-Jarvisni yig‘ib beradi. 24/7 bulutli agentlar, 1C va CRM bilan ikki tomonlama integratsiya va nol gallyutsinatsiya.",
    primaryCta: "Hisob yaratish",
    secondaryCta: "Qanday ishlashini ko'rish",
    openTeam: "Kirish olish",
    notes: ["Taklif kodi bo'yicha", "Kodsiz", "UZ / RU / EN"],
    statsTitle: "Yopiq betada tanishish mumkin",
    stats: [
      ["Fayllar", "hujjatlar va manbalar"],
      ["Hisob-kitob", "davrlar va manba satrlari"],
      ["Vazifalar", "ssenariylar va qoidalar"],
      ["3 til", "UZ / RU / EN"],
    ],
    painKicker: "Qanday ishlaydi",
    painTitle: "Vazifadan tekshirilgan natijagacha",
    painSubtitle: "Bitta jarayondan boshlang. Kerakli manbalarni ulang, ruxsatlar va natijani sinov maʼlumotlarida tekshiring.",
    flow: [
      ["Vazifani tushuntiring", "Jamoa nima qilishi kerakligini aytib bering. istalgan tilda"],
      ["Rollarni sozlang", "Mutaxassislar, asboblar, bilim bazasi va kanallarni tanlang"],
      ["Amalni tasdiqlang", "Bajarishdan oldin egasi parametrlarni tekshiradi"],
      ["Natijani tekshiring", "Saqlangan natijani asl vazifa bilan solishtiring"],
    ],
    before: "AI-agentlarsiz",
    after: "Nemo AI bilan",
    beforeItems: [
      "Javob berish vaqti menejerlarning bandligiga bog'liq",
      "Har bir jarayon alohida va tarqoq vosita talab qiladi",
      "Masshtablash yangi odamlarni yollashni talab qiladi",
      "Ish jarayonlarini kuzatish uchun yagona tizim yo'q",
    ],
    afterItems: [
      "Javoblar ko‘rsatmalaringiz asosida nol-xatolik bilan beriladi",
      "Yagona platforma: ikki tomonlama integratsiya va avtonom cron-rejachi",
      "Yangi jarayonlar maʼlumotlaringizda tekshirilgandan so‘ng qo‘shiladi",
      "To'liq audit: harakatlar tarixi, sifat ko'rsatkichlari va insonga topshirish",
    ],
    connectorsKicker: "Ikki tomonlama integratsiya",
    connectorsTitle: "Maʼlumotlaringizni Nemoga ulang — yoki Nemoning o‘zini tizimingizga integratsiya qiling",
    connectorsSubtitle: "24/7 ikki tomonlama almashinuv: 1C, amoCRM, Jadvallar va messenjerlarni ulang yoki Nemoning veb-vidjeti, REST API va MCP Serverini o‘z tizimingizga kiriting.",
    connectorsTabs: {
      all: "Barcha tizimlar",
      crm: "CRM va Savdo",
      docs: "Jadvallar va Fayllar",
      chat: "Messenjerlar va Vidjet",
      erp: "1C va Ombor",
      data: "Bazalar, API va Rejachi",
    },
    workflowKicker: "Muvofiqlashtirilgan AI-jamoalar",
    workflowTitle: "Egasi tasdiqlashi bilan darsga yozilish",
    workflowSubtitle: "Bu yo‘l mahalliy sinov maʼlumotlarida tekshirildi: xabar va dars tanlashdan tasdiqlash hamda saqlangan yozuvni o‘qishgacha. Quyida jarayon tasviri, haqiqiy mijoz yozuvi emas.",
    capKicker: "AI-jamoa imkoniyatlari",
    capTitle: "Vazifangiz uchun vositalar",
    capabilities: [
      ["Messenjerlar va Vidjet", "Telegram, WhatsApp, sayt vidjeti va tashqi CRM-larga integratsiya", MessageCircleMore],
      ["Nol-xatolik bilimlar bazasi", "PDF, DOCX va XLSX hujjatlari javoblar uchun qatʼiy manba sifatida", Database],
      ["Ikki tomonlama vositalar", "1C, CRM, Google Sheets, REST API, brauzer, fayl yaratish", Plug],
      ["Ovoz", "Ovozli ssenariylar uchun mavjud provayder va sozlash kerak", Mic],
      ["Avtonom vazifalar rejachisi", "Agent o‘zi uchun cron-vazifalar qo‘yadi: tonggi monitoring va mijozga follow-up", CalendarClock],
      ["Analitika va audit", "Har bir agent va jarayon samaradorligini kuzating", Layers],
    ],
    templatesKicker: "Foydalanish senariylari",
    templatesTitle: "Birgalikda tekshirish uchun jarayon tanlang",
    templates: [
      ["Mijozlarni qo'llab-quvvatlash", "Tezkor javoblar, yo'naltirish va operatorga topshirish"],
      ["Savdo va lidlar", "Arizalarni saralash, follow-up va CRM yangilash"],
      ["Kontent va marketing", "Matnlar, postlar va kreativlarni rejaga ko'ra yaratish"],
      ["Analitika va hisobotlar", "Kundalik xulosalar, monitoring va bildirishnomalar"],
      ["HR va recruiting", "Rezumeni skrining qilish, nomzodlarga javob, onboarding"],
      ["Tadqiqotlar", "Ma'lumot qidirish, raqobatchilar va bozor tahlili"],
    ],
    controlKicker: "Xavfsizlik va aniqlik steki",
    controlTitle: "Xatolik va gallyutsinatsiyalardan 6 bosqichli texnologik himoya",
    controlSubtitle: "Model — tizimning faqat bir qismi. Barcha qatʼiy tekshiruvlar, qumloq va to‘qib yozishni qatʼiy rad etish kodi orqali xavfsiz bajariladi.",
    controls: [
      {
        title: "Deterministik sxemalar (Zod)",
        text: "Kiruvchi va chiquvchi maʼlumotlar turlarini qatʼiy tekshirish bazaga xato yozilishini oldini oladi.",
        tag: "SCHEMA_GUARD",
        icon: ShieldCheck,
      },
      {
        title: "Izolyatsiyalangan qumloq (Sandbox)",
        text: "Matematika va kurs hisob-kitoblari model tomonidan to‘qilmaydi, xavfsiz kod orqali hisoblanadi.",
        tag: "WASM_EXEC",
        icon: Cpu,
      },
      {
        title: "Manbali RAG & Rad etish qoidasi",
        text: "Faktlar faqat sizning hujjatlaringizdan olinadi. Agar maʼlumot bo‘lmasa, agent taxmin qilmaydi, balki so‘raydi.",
        tag: "ZERO_HALLUCINATION",
        icon: Database,
      },
      {
        title: "Avtonom vazifalar rejachisi (Cron)",
        text: "Agent o‘zi uchun kechiktirilgan vazifalar qo‘yadi (48 soatdan so‘ng follow-up, 09:00 dagi monitoring).",
        tag: "AUTO_SCHEDULER",
        icon: CalendarClock,
      },
      {
        title: "Nazoratchi agent auditi",
        text: "Mustaqil nazoratchi agent asosiy harakatni bajarishdan oldin oraliq natijani qayta tekshiradi.",
        tag: "A2A_CONSENSUS",
        icon: CheckCircle2,
      },
      {
        title: "Ongli ravishda inson nazorati",
        text: "Faqat moliyaviy o‘tkazmalar va mijozga yuboriladigan muhim shartnomalar uchun rahbar tasdig‘i.",
        tag: "OWNER_GATE",
        icon: Lock,
      },
    ],
    faqTitle: "Ko'p beriladigan savollar",
    faq: [
      { q: "AI-agent nima?", a: "AI-agent. bu sizning qoidalaringiz bo'yicha vazifalarni bajaradigan avtonom dastur: mijozlarga javob beradi, arizalarni qayta ishlaydi, kontent yaratadi yoki ma'lumotlarni tahlil qiladi. Agent 24/7 bulutda ishlaydi." },
      { q: "Nemo qanday qilib gallyutsinatsiyalarni yo‘qotadi?", a: "Biz modelga ko‘r-ko‘rona ishonmaymiz: Zod-sxemalar, qumloqdagi hisob-kitoblar, asl manbaga 100% tayanib to‘qishni rad etish va nazoratchi auditi orqali xatolar bartaraf etiladi." },
      { q: "Nemoning o‘zini tizimimizga integratsiya qilsa bo‘ladimi?", a: "Ha! Ikki tomonlama integratsiya mavjud: ham o‘z 1C, CRM va jadvallaringizni Nemoga ulashingiz, ham Nemoning vidjeti, REST API va MCP Serverini o‘z tizimlaringizga kiritishingiz mumkin." },
      { q: "Agent o‘ziga vazifa rejalashtira oladimi?", a: "Albatta! Ichki Cron va rejalashtirish tizimi orqali agent 48 soatdan keyin follow-up vazifasini qo‘yishi yoki har tong soat 09:00 ga hisobot tayyorlashni o‘zi belgilashi mumkin." },
      { q: "Narxi qancha?", a: "Hozir yopiq beta. kirish taklif kodi bo'yicha. Betada ishtirok bepul: boshlanishida 50 dialog. Pullik rejalar $59/oy dan boshlanadi." },
    ],
    previewSales: {
      process: "Nemo AI-jamoasi", request: "Lid malakasi (B2B)", done: "Faol", team: "Jamoa tarkibi", message: "Kiruvchi so'rov",
      quote: "«Assalomu alaykum! 50 ta foydalanuvchi uchun korporativ demo so'ramoqchi edik. Tariflaringiz qanday?»", history: "Harakatlar tarixi", next: "Keyingi qadam", action: "Savdo direktori bilan demo-qo'ng'iroqni rejalashtirish",
      agents: ["Koordinator", "Lead Qualifier", "Product Expert", "Quality Reviewer"],
      steps: ["Demo so'rovi klassifikatsiya qilindi (50 litsenziya)", "Korporativ narxlar bilimlar bazasidan olindi", "Lid yuqori ustuvorlik bilan CRM-ga saqlandi", "Korporativ tariflar bilan javob loyihasi tekshirildi va yuborildi"],
    },
    previewOps: {
      process: "Mahalliy sinov ssenariysi", request: "Sinov darsiga yozilish", done: "Namuna", team: "Jarayon ishtirokchilari", message: "Chatdagi xabar",
      quote: "«Sinov o‘quvchisini soat 15:00 dagi ingliz tili sinov darsiga yozing.»", history: "Tekshiriladigan qadamlar", next: "Tasdiq", action: "Yozuv raqamini faqat saqlangan natijani alohida o‘qigandan keyin ko‘rsatish",
      agents: ["Operator", "Nemo", "Egasi", "Yozuv ijrochisi"],
      steps: ["Jadval va bo‘sh joyni tekshirish", "Tanlangan dars bilan arizani saqlash", "Egasining qarorini olish", "Yozuv yaratish va natijani qayta o‘qish"],
    },
    finalTitle: "Yopiq betada joy oling",
    finalText: "Arizada vazifangiz haqida yozing. Yopiq betaga kirish taklif orqali beriladi.",
  },
  en: {
    launch: "Closed beta",
    heroKicker: "AI platform for modern business operations",
    title: "Delegate the work.\nGet your custom Jarvis.",
    subtitle: "What our platform does: builds an autonomous enterprise Jarvis from a single prompt. 24/7 cloud agent swarm, bi-directional 1C & CRM integration, self-scheduled cron tasks, and zero hallucinations.",
    primaryCta: "Create account",
    secondaryCta: "See How It Works",
    openTeam: "Request access",
    notes: ["By invite code", "No code required", "UZ / RU / EN"],
    statsTitle: "Explore the private beta",
    stats: [
      ["Files", "documents and sources"],
      ["Calculations", "periods and source rows"],
      ["Tasks", "workflows and rules"],
      ["3 languages", "UZ / RU / EN"],
    ],
    painKicker: "How it works",
    painTitle: "From a task to a verified result",
    painSubtitle: "Start with one process. Connect its sources, check permissions, and verify the result using test data.",
    flow: [
      ["Describe the task", "Tell the team what to do. in any language"],
      ["Configure roles", "Choose specialists, tools, knowledge base, and channels"],
      ["Approve the action", "The owner reviews its parameters before execution"],
      ["Verify the result", "Compare the saved result with the original task"],
    ],
    before: "Without AI agents",
    after: "With Nemo AI",
    beforeItems: [
      "Response times depend on manager availability",
      "Each process requires a separate, disconnected tool",
      "Scaling operations requires manual hiring cycles",
      "No single system of record for workflow execution",
    ],
    afterItems: [
      "Responses follow your instructions with near-zero hallucinations",
      "Unified platform: two-way integrations and autonomous task scheduling",
      "Add new processes after checking them against your data",
      "Full audit trail: action history, evaluation metrics, and human handoff",
    ],
    connectorsKicker: "Two-Way Integration",
    connectorsTitle: "Connect your enterprise data to Nemo — or embed Nemo into your systems",
    connectorsSubtitle: "Bi-directional sync 24/7: integrate 1C, amoCRM, spreadsheets, and messengers into Nemo, or embed the Nemo web widget, REST API, and MCP Server into your existing platforms.",
    connectorsTabs: {
      all: "All Systems",
      crm: "CRM & Sales",
      docs: "Sheets & Files",
      chat: "Messengers & Widget",
      erp: "ERP & Inventory",
      data: "Databases, API & Scheduler",
    },
    workflowKicker: "Coordinated AI teams",
    workflowTitle: "Book a lesson with owner approval",
    workflowSubtitle: "This path was verified locally with test data: from a message and lesson selection to approval and reading the saved booking. The example below illustrates the process; it is not a live customer booking.",
    capKicker: "Agent capabilities",
    capTitle: "Tools for your task",
    capabilities: [
      ["Messengers & Widget", "Telegram, WhatsApp, web widget, and embedded CRM integration", MessageCircleMore],
      ["Zero-Hallucination Knowledge", "PDF, DOCX, and XLSX documents as strict grounding sources for answers", Database],
      ["Two-Way Tools", "1C, CRM, Google Sheets, REST API, browser, file generation", Plug],
      ["Voice", "Voice workflows require an available provider and setup", Mic],
      ["Autonomous Scheduler", "Agents self-schedule cron jobs: morning summaries and customer follow-ups", CalendarClock],
      ["Analytics & Audit", "Track performance of every agent and verified execution trajectory", Layers],
    ],
    templatesKicker: "Use cases",
    templatesTitle: "Choose a process to verify together",
    templates: [
      ["Customer support", "Instant replies, routing, and human handoff"],
      ["Sales & leads", "Lead qualification, follow-up, and CRM updates"],
      ["Content & marketing", "Generate copy, posts, and creatives on schedule"],
      ["Analytics & reports", "Daily summaries, monitoring, and alerts"],
      ["HR & recruiting", "Resume screening, candidate replies, onboarding"],
      ["Research", "Information search, competitor and market analysis"],
    ],
    controlKicker: "Reliability Architecture",
    controlTitle: "6 technological barriers: driving hallucinations down to near-zero",
    controlSubtitle: "The model is only an operator inside deterministic code. Schema validation, execution sandboxes, and strict abstention policies eliminate data distortion.",
    controls: [
      {
        title: "Deterministic Schemas (Zod)",
        text: "Strict data validation gates prevent malformed data from ever touching your production database.",
        tag: "SCHEMA_GUARD",
        icon: ShieldCheck,
      },
      {
        title: "Isolated Code Sandbox",
        text: "Pricing math, margins, and currency conversions run in a secured runtime rather than being guessed.",
        tag: "WASM_EXEC",
        icon: Cpu,
      },
      {
        title: "Grounded RAG & Strict Abstention",
        text: "Grounding in enterprise files (1C, XLSX, CRM). If data is absent, the agent abstains from guessing and requests clarification.",
        tag: "ZERO_HALLUCINATION",
        icon: Database,
      },
      {
        title: "Autonomous Task Scheduler (Cron)",
        text: "Agents autonomously schedule their own delayed tasks (48h follow-ups, 09:00 morning audits) in the cloud runtime.",
        tag: "AUTO_SCHEDULER",
        icon: CalendarClock,
      },
      {
        title: "Dual Supervisor-Worker Audit",
        text: "An independent auditor agent inspects execution steps before any consequential action is recorded.",
        tag: "A2A_CONSENSUS",
        icon: CheckCircle2,
      },
      {
        title: "Deliberate Human-in-the-Loop",
        text: "Owner authorization is reserved specifically for high-stakes financial transactions and contract signing.",
        tag: "OWNER_GATE",
        icon: Lock,
      },
    ],
    faqTitle: "Frequently asked questions",
    faq: [
      { q: "What is an AI agent?", a: "An AI agent is an autonomous program that performs tasks by your rules: answers customers, processes requests, generates content, or analyzes data. It works 24/7 and connects to your channels and tools." },
      { q: "How does Nemo eliminate hallucinations?", a: "We do not rely on blind trust. Nemo enforces 6 reliability layers: deterministic Zod schemas, WASM execution sandboxes, 100% grounded RAG with strict abstention, supervisor consensus, and autonomous task queues." },
      { q: "Can we integrate Nemo into our platform?", a: "Yes, bi-directional integration is native: connect your sources (1C, amoCRM, Sheets, databases) into Nemo, or embed the Nemo web widget, REST API, and MCP Server into your software." },
      { q: "Can the agent schedule tasks autonomously?", a: "Yes! With its native scheduler engine, an agent can queue follow-ups in 48 hours, schedule daily 09:00 morning checks, or set up weekly inventory reconciliations." },
      { q: "How much does it cost?", a: "We are in closed beta. access is by invite code. Taking part is free: 50 dialogues to start. Paid plans start at $59/mo; limits and usage are on the pricing page." },
    ],
    previewSales: {
      process: "Nemo AI Team", request: "Lead Qualification (B2B)", done: "Active", team: "Team Swarm", message: "Inbound Inquiry",
      quote: "\"Hi! We would like to request an enterprise demo for 50 users. What are your corporate rates?\"", history: "Action History", next: "Next Action", action: "Schedule enterprise demo call with sales director",
      agents: ["Coordinator", "Lead Qualifier", "Product Expert", "Quality Reviewer"],
      steps: ["Demo inquiry classified (50 seats)", "Corporate rate deck matched in grounded RAG", "Lead logged in CRM with High Priority", "Checked proposal draft dispatched to prospect"],
    },
    previewOps: {
      process: "Local Test Scenario", request: "Book a trial lesson", done: "Illustration", team: "Participants", message: "Chat message",
      quote: "\"Book a trial student for an English lesson at 3:00 PM.\"", history: "Verification steps", next: "Confirmation", action: "Display booking code only after confirming state in database",
      agents: ["Operator", "Nemo", "Owner", "Booking Executor"],
      steps: ["Check schedule and slot availability", "Record appointment draft with selected slot", "Obtain owner resolution", "Create booking and re-verify database state"],
    },
    finalTitle: "Claim your private beta seat",
    finalText: "Tell us about your business workflow in the request form. Access is granted on a rolling invite basis.",
  },
}

interface ConnectorItem {
  id: string
  name: string
  category: 'crm' | 'docs' | 'chat' | 'erp' | 'data'
  protocol: string
  flowDirection: 'two-way' | 'inbound' | 'outbound'
  status: string
  description: { ru: string; uz: string; en: string }
}

const CONNECTORS_LIST: ConnectorItem[] = [
  {
    id: '1c',
    name: '1С:Предприятие',
    category: 'erp',
    protocol: 'REST / OData',
    flowDirection: 'two-way',
    status: 'Двусторонний обмен',
    description: {
      ru: 'Чтение номенклатуры, выгрузка накладных и переоценка 1 420 SKU без ручного ввода',
      uz: 'Tovarlar qoldig‘ini o‘qish, schyot-fakturalar yuklash va narxlarni avtomatlashtirish',
      en: 'Realtime inventory sync, SKU reconciliation, and bi-directional invoicing',
    },
  },
  {
    id: 'amocrm',
    name: 'amoCRM',
    category: 'crm',
    protocol: 'Bi-directional Sync',
    flowDirection: 'two-way',
    status: 'Двусторонний обмен',
    description: {
      ru: 'Прием лидов из воронки, авто-скоринг BANT и обратная запись сделок и задач',
      uz: 'Lidlarni qabul qilish, BANT baholash va bitimlarni avtomatik yangilash',
      en: 'Lead ingestion, BANT scoring, and automatic deal pipeline updates',
    },
  },
  {
    id: 'gsheets',
    name: 'Google Sheets',
    category: 'docs',
    protocol: 'Two-Way OAuth',
    flowDirection: 'two-way',
    status: 'Двусторонний обмен',
    description: {
      ru: 'Чтение таблиц в реальном времени и авто-запись формул и отчетов без искажений',
      uz: 'Jadvallarni real vaqtda o‘qish va hisobotlarni xatosiz qayta yozish',
      en: 'Spreadsheet ingestion, anomaly detection, and clean formula writes',
    },
  },
  {
    id: 'widget',
    name: 'Nemo Web Widget',
    category: 'chat',
    protocol: 'Embed Script',
    flowDirection: 'outbound',
    status: 'Встраивание в ваш сайт',
    description: {
      ru: 'Встраивание автономного AI-агента Nemo на любой сайт одной строчкой <script>',
      uz: 'Istalgan veb-saytingizga bir qator <script> kodi bilan agentni o‘rnatish',
      en: 'Embed autonomous Nemo agents into any website or web application via a script tag',
    },
  },
  {
    id: 'mcp-server',
    name: 'Nemo MCP Server',
    category: 'data',
    protocol: 'Model Context Protocol',
    flowDirection: 'outbound',
    status: 'Встраивание в сторонние LLM',
    description: {
      ru: 'Подключение инструментов Nemo в другие агентские среды, IDE и внешние платформы',
      uz: 'Nemo asboblarini tashqi LLM va agent tizimlariga MCP orqali ulash',
      en: 'Expose Nemo enterprise tools and databases to external LLM runtimes via MCP',
    },
  },
  {
    id: 'scheduler',
    name: 'Автономный Шедулер (Cron)',
    category: 'data',
    protocol: 'Cloud Queue / Cron',
    flowDirection: 'two-way',
    status: 'Самостоятельные задачи',
    description: {
      ru: 'Агент сам ставит отложенные задачи: follow-up через 48ч, утренний мониторинг в 09:00',
      uz: 'Agent o‘zi kechiktirilgan vazifalar qo‘yadi: 48 soatdan keyin follow-up, 09:00 monitoring',
      en: 'Agents autonomously schedule cron and delayed follow-up tasks in the cloud runtime',
    },
  },
  {
    id: 'bitrix24',
    name: 'Bitrix24',
    category: 'crm',
    protocol: 'Webhook & REST',
    flowDirection: 'two-way',
    status: 'Двусторонний обмен',
    description: {
      ru: 'Двусторонняя интеграция с задачами, сделками и карточками клиентов 24/7',
      uz: 'Vazifalar, bitimlar va mijozlar kartalari bilan 24/7 ikki tomonlama integratsiya',
      en: 'Bi-directional integration with tasks, deals, and client profiles in the cloud',
    },
  },
  {
    id: 'telegram',
    name: 'Telegram',
    category: 'chat',
    protocol: 'Bot & Group Mesh',
    flowDirection: 'two-way',
    status: 'Live Sync',
    description: {
      ru: 'Личные боты для клиентов и внутренние боты-задачники для рабочих групп',
      uz: 'Mijozlar uchun shaxsiy botlar va jamoalar uchun guruh botlari',
      en: 'Customer-facing bots and internal taskbots across private group chats',
    },
  },
  {
    id: 'whatsapp',
    name: 'WhatsApp Business',
    category: 'chat',
    protocol: 'Official Cloud API',
    flowDirection: 'two-way',
    status: 'Cloud Ready',
    description: {
      ru: 'Мгновенный ответ входящим обращениям за 2.4 секунды без потерь заявок',
      uz: 'Kiruvchi murojaatlarga soniyalar ichida arizalarni yo‘qotmasdan javob berish',
      en: 'Instant 24/7 response to inbound customer inquiries within seconds',
    },
  },
  {
    id: 'moysklad',
    name: 'МойСклад',
    category: 'erp',
    protocol: 'Webhook & API',
    flowDirection: 'two-way',
    status: 'Двусторонний обмен',
    description: {
      ru: 'Синхронизация заказов, отгрузок и остатков на складе в реальном времени',
      uz: 'Buyurtmalar, jo‘natmalar va ombor qoldiqlarini real vaqtda yangilash',
      en: 'Realtime order processing, shipments, and inventory balance sync',
    },
  },
  {
    id: 'excel',
    name: 'MS Excel (OneDrive)',
    category: 'docs',
    protocol: 'Office 365 Sync',
    flowDirection: 'two-way',
    status: 'Cloud Ready',
    description: {
      ru: 'Парсинг сложных корпоративных смет и автоматическая выгрузка отчетов XLSX',
      uz: 'Murakkab smetalarni tahlil qilish va XLSX hisobotlarini yig‘ish',
      en: 'Corporate budget parsing, margin checks, and typed XLSX generation',
    },
  },
  {
    id: 'postgres',
    name: 'PostgreSQL & Supabase',
    category: 'data',
    protocol: 'Direct SQL & RLS',
    flowDirection: 'two-way',
    status: 'Live Sync',
    description: {
      ru: 'Изолированное хранение данных, строгие политики RLS и неизменяемый аудит-лог',
      uz: 'Xavfsiz maʼlumotlar ombori, qatʼiy RLS huquqlari va to‘liq audit jurnali',
      en: 'Isolated tenant storage, strict RLS access policies, and immutable audit logs',
    },
  },
]

function ConnectorsExplorer({ lang, copyData }: { lang: 'ru' | 'uz' | 'en'; copyData: typeof copy.ru }) {
  const [filter, setFilter] = useState<'all' | 'crm' | 'docs' | 'chat' | 'erp' | 'data'>('all')

  const filtered = filter === 'all'
    ? CONNECTORS_LIST
    : CONNECTORS_LIST.filter((item) => item.category === filter)

  return (
    <div className="mt-10">
      {/* Category selector */}
      <div className="flex flex-wrap items-center justify-center gap-1.5 rounded-2xl bg-[#060813] p-1.5 border border-white/8 max-w-2xl mx-auto">
        {(['all', 'crm', 'docs', 'chat', 'erp', 'data'] as const).map((cat) => (
          <button
            key={cat}
            type="button"
            onClick={() => setFilter(cat)}
            className={cn(
              'rounded-xl px-3.5 py-2 text-xs font-semibold transition-colors',
              filter === cat
                ? 'bg-[#182346] text-[#42edf5] shadow-sm'
                : 'text-[#94A3B8] hover:text-white hover:bg-white/5'
            )}
          >
            {copyData.connectorsTabs[cat]}
          </button>
        ))}
      </div>

      {/* Grid of connectors */}
      <div className="mt-8 grid gap-3.5 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        {filtered.map((item) => (
          <div
            key={item.id}
            className="group rounded-2xl border border-white/10 bg-[#090D1C] p-4 transition-all hover:border-[#42edf5]/40 hover:bg-[#0D152D]"
          >
            <div className="flex items-center justify-between">
              <span className="text-sm font-bold text-white">{item.name}</span>
              <span className="inline-flex items-center gap-1 rounded bg-[#42edf5]/10 px-2 py-0.5 font-mono text-[9px] text-[#42edf5] border border-[#42edf5]/20">
                {item.protocol}
              </span>
            </div>
            <p className="mt-2.5 text-xs text-[#94A3B8] leading-relaxed">
              {item.description[lang] ?? item.description.ru}
            </p>
            <div className="mt-4 flex items-center justify-between border-t border-white/6 pt-2.5">
              <span className="inline-flex items-center gap-1 text-[10px] font-medium text-[#34D399]">
                <ArrowLeftRight size={11} className="text-[#10B981]" />
                {item.status}
              </span>
              <span className="text-[10px] font-mono text-muted uppercase">24/7 Mesh</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

function SectionIntro({ kicker, title, text }: { kicker: string; title: string; text?: string }) {
  return (
    <div className="max-w-2xl">
      <p className="text-xs font-bold uppercase tracking-[0.16em] text-cyan">{kicker}</p>
      <h2 className="mt-4 text-3xl font-black tracking-tight text-text sm:text-4xl">{title}</h2>
      {text ? <p className="mt-4 text-base leading-relaxed text-muted">{text}</p> : null}
    </div>
  )
}

function WorkflowPreview({ copy: preview }: { copy: (typeof copy.ru)['previewSales'] }) {
  return (
    <div className="overflow-hidden rounded-3xl border border-white/10 bg-[#070b14] shadow-2xl">
      <div className="flex items-center justify-between border-b border-white/8 px-5 py-3.5">
        <div className="flex items-center gap-2">
          <span className="h-2 w-2 rounded-full bg-cyan animate-pulse" />
          <span className="text-xs font-semibold text-text">{preview.process}</span>
        </div>
        <span className="rounded-full bg-cyan/10 px-2.5 py-1 text-[11px] font-semibold text-cyan">{preview.done}</span>
      </div>
      <div className="p-5">
        <div className="rounded-2xl border border-white/8 bg-white/[0.02] p-4">
          <p className="text-[11px] font-bold uppercase tracking-[0.14em] text-cyan">{preview.request}</p>
          <p className="mt-2 text-sm font-bold text-text">{preview.quote}</p>
        </div>
        <div className="grid gap-4 p-4 sm:grid-cols-[0.72fr_1.28fr] sm:p-5">
          <div className="glass-card lift rounded-2xl p-4">
            <p className="text-[11px] font-bold uppercase tracking-[0.14em] text-fog">{preview.team}</p>
            <div className="mt-4 space-y-2.5">
              {preview.agents.map((agent, index) => (
                <div key={agent} className="lift flex items-center gap-2.5 rounded-xl border border-navy-line/50 bg-navy-ground/60 px-3 py-2.5 text-xs font-semibold text-text">
                  <span className={cn('h-2.5 w-2.5 rounded-full', index === 0 ? 'bg-cyan' : index === 1 ? 'bg-emerald-400' : index === 2 ? 'bg-amber' : 'bg-blue')} />
                  {agent}
                </div>
              ))}
            </div>
          </div>
          <div className="space-y-4">
            <div className="glass-card lift rounded-2xl p-4">
              <p className="text-[11px] font-bold uppercase tracking-[0.14em] text-fog">{preview.message}</p>
              <p className="mt-2 text-sm font-semibold leading-relaxed text-text">{preview.quote}</p>
            </div>
            <div className="grid gap-4 md:grid-cols-[1.25fr_0.75fr]">
              <div className="glass-card lift rounded-2xl p-4">
                <p className="text-sm font-bold text-text">{preview.history}</p>
                <div className="mt-3 space-y-2.5">
                  {preview.steps.map((item) => <div key={item} className="flex items-center gap-2 text-xs text-muted"><CheckCircle2 size={15} className="shrink-0 text-cyan" />{item}</div>)}
                </div>
              </div>
              <div className="rounded-2xl border border-amber/25 bg-amber/10 p-4">
                <p className="text-[11px] font-bold uppercase tracking-[0.12em] text-amber">{preview.next}</p>
                <p className="mt-3 text-sm font-semibold leading-relaxed text-text">{preview.action}</p>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

function NeonBrandShowcase({ lang }: { lang: 'ru' | 'uz' | 'en' }) {
  return <HeroInteractiveShowcase lang={lang} />
}

export default function LandingPage() {
  const { lang, t } = useI18n()
  const c = copy[lang]

  return (
    <div className="theme-dark-scope landing-brand min-h-screen overflow-x-clip">
      <MarketingHeader />

      <main>
        {/* ─── HERO ─── */}
        <section className="relative overflow-hidden border-b border-white/8 bg-[#090c19]">
          <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_78%_16%,rgba(66,237,245,0.16),transparent_34%),radial-gradient(circle_at_12%_40%,rgba(185,76,255,0.14),transparent_34%)]" />
          <div className="container-page relative grid min-h-[calc(88dvh-64px)] items-center gap-10 py-12 lg:grid-cols-[1.12fr_0.88fr] lg:py-14">
            <div className="max-w-2xl">
              <p className="text-xs font-bold uppercase tracking-[0.16em] text-cyan">{c.heroKicker}</p>
              <h1 className="mt-3 max-w-2xl whitespace-pre-line text-[clamp(1.85rem,2.8vw,3rem)] font-black leading-[1.1] tracking-[-0.03em] text-text">{c.title}</h1>
              <p className="mt-5 max-w-lg text-base leading-relaxed text-muted sm:text-lg">{c.subtitle}</p>
              <div className="mt-9 flex flex-wrap gap-3">
                <Button to="/auth/signup" size="lg" className="lift !bg-none !bg-[#42edf5] !text-[#050816] shadow-[0_18px_50px_-20px_rgba(66,237,245,0.9)] hover:!brightness-110">
                  {c.primaryCta}<ArrowRight size={17} />
                </Button>
                <Button href="#product" variant="outline" size="lg">{c.secondaryCta}</Button>
              </div>
              <Link to="/waitlist" className="mt-5 inline-flex text-sm text-muted underline underline-offset-4 hover:text-text">{t('marketingHeader.book')}</Link>
            </div>
            <NeonBrandShowcase lang={lang} />
          </div>
        </section>

        {/* ─── SOCIAL PROOF STATS ─── */}
        <section className="border-b border-white/8 bg-[#08101c]">
          <div className="container-page py-10 sm:py-12">
            <p className="text-center text-sm font-bold uppercase tracking-[0.16em] text-muted">{c.statsTitle}</p>
            <div className="mt-10 grid grid-cols-2 gap-6 lg:grid-cols-4">
              {c.stats.map(([value, label]) => (
                <div key={label} className="text-center">
                  <p className="text-[clamp(1.35rem,2.4vw,2rem)] font-black tracking-tight text-cyan">{value}</p>
                  <p className="mt-1 text-sm font-medium text-muted">{label}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* ─── CONNECTORS HUB (TWO-WAY INTEGRATION) ─── */}
        <section id="connectors" className="border-b border-white/8 bg-[#070B18] py-20 sm:py-28">
          <div className="container-page">
            <div className="text-center max-w-3xl mx-auto">
              <p className="text-xs font-bold uppercase tracking-[0.16em] text-cyan">{c.connectorsKicker}</p>
              <h2 className="mt-4 text-3xl font-black tracking-tight text-text sm:text-4xl">{c.connectorsTitle}</h2>
              <p className="mt-4 text-base leading-relaxed text-muted">{c.connectorsSubtitle}</p>
            </div>
            <ConnectorsExplorer lang={lang} copyData={c} />
          </div>
        </section>

        {/* ─── HOW IT WORKS (FLOW) ─── */}
        <section id="product" className="container-page py-20 sm:py-28">
          <SectionIntro kicker={c.painKicker} title={c.painTitle} text={c.painSubtitle} />
          <div className="mt-12 grid gap-3 lg:grid-cols-4">
            {c.flow.map(([title, text], index) => (
              <div key={title} className="group relative rounded-2xl border border-white/10 bg-white/[0.035] p-5 transition-colors hover:border-cyan/30 hover:bg-cyan/[0.04]">
                <span className="text-xs font-black text-cyan">0{index + 1}</span>
                <h3 className="mt-6 text-lg font-bold text-text">{title}</h3>
                <p className="mt-2 text-sm leading-relaxed text-muted">{text}</p>
              </div>
            ))}
          </div>
          {/* Before / After */}
          <div className="mt-5 grid gap-5 lg:grid-cols-2">
            <div className="rounded-3xl border border-rose-950/30 bg-rose-950/[0.02] p-7 sm:p-8 transition-all duration-300 hover:border-rose-500/40 hover:bg-rose-950/[0.04] hover:shadow-[0_0_30px_rgba(244,63,94,0.15)]">
              <p className="text-sm font-bold text-rose-400">{c.before}</p>
              <div className="mt-5 space-y-3">
                {c.beforeItems.map((item) => (
                  <p key={item} className="flex gap-3 text-sm leading-relaxed text-muted">
                    <X size={16} className="mt-0.5 shrink-0 text-rose-500" />
                    {item}
                  </p>
                ))}
              </div>
            </div>
            <div className="rounded-3xl border border-cyan/20 bg-cyan/[0.02] p-7 sm:p-8 transition-all duration-300 hover:border-cyan/50 hover:bg-cyan/[0.04] hover:shadow-[0_0_30px_rgba(34,211,238,0.2)]">
              <p className="text-sm font-bold text-cyan">{c.after}</p>
              <div className="mt-5 space-y-3">
                {c.afterItems.map((item) => (
                  <p key={item} className="flex gap-3 text-sm leading-relaxed text-text">
                    <CheckCircle2 size={16} className="mt-0.5 shrink-0 text-cyan" />
                    {item}
                  </p>
                ))}
              </div>
            </div>
          </div>
        </section>

        {/* ─── WORKFLOW / AI TEAMS ─── */}
        <section id="workflow" className="border-y border-white/8 bg-[#08101c]">
          <div className="container-page grid items-center gap-12 py-20 sm:py-28 lg:grid-cols-[0.82fr_1.18fr]">
            <div>
              <SectionIntro kicker={c.workflowKicker} title={c.workflowTitle} text={c.workflowSubtitle} />
              <Button to="/auth/signup" variant="outline" className="mt-8">{c.primaryCta}<ArrowRight size={15} /></Button>
            </div>
            <WorkflowPreview copy={c.previewOps} />
          </div>
        </section>

        {/* ─── AGENT CAPABILITIES ─── */}
        <section id="capabilities" className="container-page py-20 sm:py-28">
          <SectionIntro kicker={c.capKicker} title={c.capTitle} />
          <div className="mt-12 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {c.capabilities.map(([title, text, Icon]) => (
              <div key={title as string} className="group rounded-2xl border border-white/10 bg-white/[0.035] p-6 transition-colors hover:border-violet/30 hover:bg-violet/[0.04]">
                <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-violet/15">
                  <Icon size={20} className="text-violet" />
                </div>
                <h3 className="mt-5 text-lg font-bold text-text">{title as string}</h3>
                <p className="mt-2 text-sm leading-relaxed text-muted">{text as string}</p>
              </div>
            ))}
          </div>
        </section>

        {/* ─── USE CASES ─── */}
        <section id="templates" className="border-y border-white/8 bg-[#08101c]">
          <div className="container-page py-20 sm:py-24">
            <SectionIntro kicker={c.templatesKicker} title={c.templatesTitle} />
            <div className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {c.templates.map(([title, text], index) => (
                <div key={title} className="group rounded-2xl border border-white/10 bg-black/20 p-6 transition-colors hover:border-cyan/25 hover:bg-cyan/[0.03]">
                  <div className="flex items-center justify-between">
                    <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-cyan/10">
                      {index === 0 ? <MessageCircleMore size={18} className="text-cyan" /> :
                       index === 1 ? <Zap size={18} className="text-cyan" /> :
                       index === 2 ? <Sparkles size={18} className="text-cyan" /> :
                       index === 3 ? <Layers size={18} className="text-cyan" /> :
                       index === 4 ? <Globe size={18} className="text-cyan" /> :
                       <BrainCircuit size={18} className="text-cyan" />}
                    </div>
                    <span className="text-xs font-black text-fog">0{index + 1}</span>
                  </div>
                  <h3 className="mt-6 text-xl font-bold text-text">{title}</h3>
                  <p className="mt-2 text-sm text-muted">{text}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* ─── 6 LAYERS OF RELIABILITY & ZERO-HALLUCINATION ─── */}
        <section id="features" className="container-page py-20 sm:py-28">
          <SectionIntro kicker={c.controlKicker} title={c.controlTitle} text={c.controlSubtitle} />
          <div className="mt-12 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {c.controls.map((ctrl) => {
              const Icon = ctrl.icon
              return (
                <div
                  key={ctrl.title}
                  className="rounded-2xl border border-white/10 bg-[#090D1C] p-6 transition-colors hover:border-[#42edf5]/30 hover:bg-[#0D1429]"
                >
                  <div className="flex items-center justify-between">
                    <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-[#42edf5]/10 border border-[#42edf5]/20">
                      <Icon size={20} className="text-[#42edf5]" />
                    </div>
                    <span className="font-mono text-[10px] text-[#42edf5] bg-[#42edf5]/10 px-2 py-0.5 rounded border border-[#42edf5]/20">
                      {ctrl.tag}
                    </span>
                  </div>
                  <h3 className="mt-5 text-base font-bold text-white">{ctrl.title}</h3>
                  <p className="mt-2 text-sm leading-relaxed text-[#94A3B8]">{ctrl.text}</p>
                </div>
              )
            })}
          </div>
        </section>

        {/* ─── FAQ ─── */}
        <section id="faq" className="container-page grid gap-10 py-20 sm:py-28 lg:grid-cols-[0.72fr_1.28fr]">
          <div>
            <p className="text-xs font-bold uppercase tracking-[0.16em] text-cyan">FAQ</p>
            <h2 className="mt-4 text-4xl font-black leading-tight text-text">{c.faqTitle}</h2>
          </div>
          <Accordion items={c.faq} />
        </section>

        {/* ─── FINAL CTA ─── */}
        <section className="container-page pb-20 sm:pb-28">
          <div className="relative overflow-hidden rounded-[2rem] border border-cyan/25 bg-[#0b1c25] p-8 sm:p-12 lg:flex lg:items-end lg:justify-between">
            <div className="pointer-events-none absolute -right-16 -top-24 h-72 w-72 rounded-full bg-cyan/15 blur-3xl" />
            <div className="pointer-events-none absolute -left-20 -bottom-16 h-56 w-56 rounded-full bg-violet/15 blur-3xl" />
            <div className="relative max-w-3xl">
              <div className="inline-flex items-center gap-2 rounded-full bg-emerald-400/10 px-3 py-1.5 text-xs font-semibold text-emerald-300">
                <Rocket size={13} />{c.notes[0]}
              </div>
              <h2 className="mt-6 text-[clamp(2.2rem,4.5vw,4rem)] font-black leading-[1.02] text-text">{c.finalTitle}</h2>
              <p className="mt-5 max-w-2xl text-base leading-relaxed text-muted sm:text-lg">{c.finalText}</p>
            </div>
            <Button to="/auth/signup" size="lg" className="relative mt-8 !bg-cyan !bg-none !text-[#041018] shadow-none hover:!brightness-110 lg:mt-0">{c.primaryCta}<ArrowRight size={17} /></Button>
          </div>
        </section>
      </main>

      <MarketingFooter />
    </div>
  )
}
