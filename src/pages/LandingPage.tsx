import {
  ArrowRight,
  BrainCircuit,
  Check,
  CheckCircle2,
  ClipboardCheck,
  Database,
  Globe,
  Layers,
  MessageCircleMore,
  Mic,
  Plug,
  Repeat,
  Rocket,
  ShieldCheck,
  Sparkles,
  UserRoundCheck,
  X,
  Zap,
} from 'lucide-react'
import { MarketingFooter } from '../components/layout/MarketingFooter'
import { MarketingHeader } from '../components/layout/MarketingHeader'
import { Accordion } from '../components/ui/Accordion'
import { Button } from '../components/ui/Button'
import { useI18n } from '../i18n'
import { cn } from '../lib/cn'

const copy = {
  ru: {
    launch: "Публичная бета",
    heroKicker: "AI-платформа для автоматизации бизнеса",
    title: "Оркестрируйте\nAI-команды\nза минуты",
    subtitle: "Интегрируйте координированные команды AI-агентов в ваши бизнес-процессы. От квалификации лидов и поддержки до сложных операций — без кода.",
    primaryCta: "Создать команду бесплатно",
    secondaryCta: "Посмотреть, как работает",
    openTeam: "Создать AI-команду",
    notes: ["Бесплатный план — 150 000 токенов", "Без кода", "UZ / RU / EN"],
    statsTitle: "Платформа, готовая к масштабированию",
    stats: [
      ["12", "интеграций работают"],
      ["790", "сервисов в каталоге"],
      ["3", "языка интерфейса"],
      ["5 мин", "до первой команды"],
    ],
    painKicker: "Как это работает",
    painTitle: "От идеи до рабочей AI-команды — четыре шага",
    painSubtitle: "Не нужно писать код или разбираться в API. Опишите задачу, настройте поведение, подключите каналы — и команда работает.",
    flow: [
      ["Опишите задачу", "Расскажите, что должна делать команда — на любом языке"],
      ["Настройте роли", "Выберите специалистов, инструменты, базу знаний и каналы"],
      ["Запустите", "Подключите Telegram, виджет на сайте или API"],
      ["Масштабируйте", "Добавляйте агентов, создавайте новые AI-команды и отделы"],
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
      "Первый ответ всегда соответствует высшему стандарту компании",
      "Единая платформа для агентов, команд и каналов связи",
      "Масштабирование — это просто запуск ещё одной AI-команды",
      "Полный аудит: история действий, метрики качества и передача человеку",
    ],
    workflowKicker: "Координированные AI-команды",
    workflowTitle: "Не один бот, а координированная AI-команда с ролями",
    workflowSubtitle: "Operations Lead распределяет задачи между специалистами. Вы видите, кто что сделал и какой шаг будет следующим.",
    capKicker: "Возможности AI-команды",
    capTitle: "Всё, что нужно для умной автоматизации",
    capabilities: [
      ["Мессенджеры", "Telegram и виджет на сайте; WhatsApp и Instagram — в разработке", MessageCircleMore],
      ["База знаний", "Загрузите PDF, DOCX, XLSX — агенты учатся на ваших данных", Database],
      ["Инструменты", "CRM, Google Sheets, API, браузер, генерация файлов", Plug],
      ["Голос", "Распознавание и генерация речи для голосовых каналов", Mic],
      ["Автопосты", "Планируйте и автоматически публикуйте контент по расписанию", Repeat],
      ["Аналитика", "Отслеживайте эффективность каждого агента и всей команды", Layers],
    ],
    templatesKicker: "Сценарии использования",
    templatesTitle: "AI-команды для любой сферы бизнеса",
    templates: [
      ["Поддержка клиентов", "Мгновенные ответы, маршрутизация и передача оператору"],
      ["Продажи и лиды", "Квалификация заявок, follow-up и обновление CRM"],
      ["Контент и маркетинг", "Генерация текстов, постов и креативов по расписанию"],
      ["Аналитика и отчёты", "Ежедневные сводки, мониторинг отклонений и уведомления"],
      ["HR и рекрутинг", "Скрининг резюме, ответы кандидатам, онбординг"],
      ["Исследования", "Поиск информации, анализ конкурентов и рынка"],
    ],
    controlKicker: "Безопасность и контроль",
    controlTitle: "AI-агенты помогают команде, но не действуют вслепую",
    controls: [
      ["История действий", "Каждое действие и результат доступны вам в реальном времени.", ClipboardCheck],
      ["Передача человеку", "Сложные или критичные случаи передаются оператору.", UserRoundCheck],
      ["Изоляция данных", "Данные каждого аккаунта изолированы политиками доступа.", ShieldCheck],
      ["Ваши инструменты", "Подключайте свои API, модели и базы данных.", Database],
    ],
    faqTitle: "Частые вопросы",
    faq: [
      { q: "Что такое AI-агент?", a: "AI-агент — это автономная программа, которая выполняет задачи по вашим правилам: отвечает клиентам, обрабатывает заявки, генерирует контент или анализирует данные. Агент работает 24/7 и подключается к вашим каналам и инструментам." },
      { q: "Нужно ли уметь программировать?", a: "Нет. Вы описываете задачу на обычном языке, выбираете инструменты и каналы — Nemo настроит команду автоматически. Для продвинутых пользователей есть API и кастомные инструменты." },
      { q: "Какие каналы поддерживаются?", a: "Сейчас работают Telegram, веб-виджет и API. WhatsApp и Instagram — в разработке: вебхуки написаны, но канал не включаем, пока в продакшене не проверена подпись Meta. Статус каждого сервиса виден на странице «Интеграции»." },
      { q: "Что такое AI-команда?", a: "AI-команда — это несколько агентов с разными ролями, управляемых координатором. Например: один агент квалифицирует заявку, другой готовит ответ, третий обновляет CRM. Координатор распределяет работу автоматически." },
      { q: "Агенты работают без ошибок?", a: "Ни одна AI-система не гарантирует нулевой риск ошибок. Nemo снижает риск через историю действий, проверку результатов и автоматическую передачу сложных случаев человеку." },
      { q: "Сколько это стоит?", a: "Регистрация бесплатна: на бесплатном плане 150 000 токенов. Платные планы — от $25/мес. Актуальные лимиты и расход — на странице тарифов." },
    ],
    previewSales: {
      process: "AI-команда Nemo", request: "Квалификация лида (B2B)", done: "В процессе", team: "Состав команды", message: "Входящий запрос",
      quote: "«Здравствуйте! Хотим запросить корпоративное демо на 50 пользователей. Какие у вас тарифы?»", history: "История действий", next: "Следующий шаг", action: "Назначить демо-звонок с менеджером продаж",
      agents: ["Координатор", "Lead Qualifier", "Product Expert", "Quality Reviewer"],
      steps: ["Запрос демо классифицирован (50 лицензий)", "Сетка корпоративных цен найдена в базе знаний", "Лид сохранен в CRM с высоким приоритетом", "Черновик ответа с тарифами проверен и отправлен"],
    },
    previewOps: {
      process: "AI-команда Nemo", request: "Разбор встречи и задачи", done: "Завершено", team: "Состав команды", message: "Стенограмма встречи",
      quote: "«Синхронизация по онбордингу клиентов. Дилшод должен позвонить должникам до пятницы. Мадина пишет инструкции.»", history: "История действий", next: "Следующий шаг", action: "Отправить напоминания исполнителям в Slack/Telegram",
      agents: ["Operations Lead", "Meeting Analyst", "Task Manager", "Report Agent"],
      steps: ["Стенограмма встречи проанализирована", "Созданы задачи для Дилшода (звонки) и Мадины (инструкции)", "Сроки и ответственные занесены в таблицу задач", "Сводный операционный отчет отправлен руководству"],
    },
    finalTitle: "Создайте свою AI-команду прямо сейчас",
    finalText: "Бесплатный план — 150 000 токенов. Опишите задачу — и ваша команда начнёт работать через 5 минут.",
  },
  uz: {
    launch: "Ommaviy beta",
    heroKicker: "Biznesni avtomatlashtirish uchun AI-platforma",
    title: "AI-jamoalarni\nminutlarda\nboshqaring",
    subtitle: "AI-agentlar jamoasini biznes jarayonlaringizga integratsiya qiling. Sotuv va qo'llab-quvvatlashdan tortib murakkab operatsiyalargacha — kodsiz.",
    primaryCta: "Jamoani bepul yaratish",
    secondaryCta: "Qanday ishlashini ko'rish",
    openTeam: "AI-jamoa yaratish",
    notes: ["Bepul reja — 150 000 token", "Kodsiz", "UZ / RU / EN"],
    statsTitle: "Masshtablashga tayyor platforma",
    stats: [
      ["12", "integratsiya ishlaydi"],
      ["790", "katalogdagi xizmat"],
      ["3", "interfeys tili"],
      ["5 min", "birinchi jamoagacha"],
    ],
    painKicker: "Qanday ishlaydi",
    painTitle: "G'oyadan ishlaydigan AI-jamoagacha — to'rt qadam",
    painSubtitle: "Kod yozish yoki API bilan ishlash shart emas. Vazifani tushuntiring, xatti-harakatni sozlang, kanallarni ulang — jamoa ishlaydi.",
    flow: [
      ["Vazifani tushuntiring", "Jamoa nima qilishi kerakligini aytib bering — istalgan tilda"],
      ["Rollarni sozlang", "Mutaxassislar, asboblar, bilim bazasi va kanallarni tanlang"],
      ["Ishga tushiring", "Telegram, saytdagi vidjet yoki APIni ulang"],
      ["Masshtablang", "Agentlar qo'shing, yangi AI-jamoalar va bo'limlar yarating"],
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
      "Birinchi javob doimo kompaniyaning eng yuqori standartiga mos keladi",
      "Agentlar, jamoalar va aloqa kanallari uchun yagona platforma",
      "Masshtablash — shunchaki yana bitta AI-jamoani ishga tushirish",
      "To'liq audit: harakatlar tarixi, sifat ko'rsatkichlari va insonga topshirish",
    ],
    workflowKicker: "Muvofiqlashtirilgan AI-jamoalar",
    workflowTitle: "Bitta bot emas, rollar bilan muvofiqlashtirilgan AI-jamoa",
    workflowSubtitle: "Operations Lead vazifalarni mutaxassislarga taqsimlaydi. Kim nima qilganini va keyingi qadamni ko'rasiz.",
    capKicker: "AI-jamoa imkoniyatlari",
    capTitle: "Aqlli avtomatlashtirish uchun kerak bo'lgan hamma narsa",
    capabilities: [
      ["Messenjerlar", "Telegram va saytdagi vidjet; WhatsApp va Instagram — ishlab chiqilmoqda", MessageCircleMore],
      ["Bilim bazasi", "PDF, DOCX, XLSX yuklang — agentlar ma'lumotlaringizdan o'rganadi", Database],
      ["Asboblar", "CRM, Google Sheets, API, brauzer, fayl yaratish", Plug],
      ["Ovoz", "Ovozli kanallar uchun nutq tanish va yaratish", Mic],
      ["Autopostlar", "Kontentni rejaga ko'ra rejalashtiring va joylashtiring", Repeat],
      ["Analitika", "Har bir agent va jamoa samaradorligini kuzating", Layers],
    ],
    templatesKicker: "Foydalanish senariylari",
    templatesTitle: "Har qanday biznes sohasi uchun AI-agentlar",
    templates: [
      ["Mijozlarni qo'llab-quvvatlash", "Tezkor javoblar, yo'naltirish va operatorga topshirish"],
      ["Savdo va lidlar", "Arizalarni saralash, follow-up va CRM yangilash"],
      ["Kontent va marketing", "Matnlar, postlar va kreativlarni rejaga ko'ra yaratish"],
      ["Analitika va hisobotlar", "Kundalik xulosalar, monitoring va bildirishnomalar"],
      ["HR va recruiting", "Rezumeni skrining qilish, nomzodlarga javob, onboarding"],
      ["Tadqiqotlar", "Ma'lumot qidirish, raqobatchilar va bozor tahlili"],
    ],
    controlKicker: "Xavfsizlik va nazorat",
    controlTitle: "AI-agentlar jamoaga yordam beradi, lekin nazoratsiz ishlamaydi",
    controls: [
      ["Harakatlar tarixi", "Har bir harakat va natijani real vaqtda ko'rasiz.", ClipboardCheck],
      ["Insonga topshirish", "Murakkab yoki muhim holatlar operatorga o'tadi.", UserRoundCheck],
      ["Ma'lumot izolyatsiyasi", "Har bir akkaunt ma'lumoti kirishlar siyosati bilan ajratiladi.", ShieldCheck],
      ["Sizning vositalaringiz", "O'z API, modellar va ma'lumotlar bazangizni ulang.", Database],
    ],
    faqTitle: "Ko'p beriladigan savollar",
    faq: [
      { q: "AI-agent nima?", a: "AI-agent — bu sizning qoidalaringiz bo'yicha vazifalarni bajaradigan avtonom dastur: mijozlarga javob beradi, arizalarni qayta ishlaydi, kontent yaratadi yoki ma'lumotlarni tahlil qiladi. Agent 24/7 ishlaydi va sizning kanallar va vositalaringizga ulanadi." },
      { q: "Dasturlash bilish kerakmi?", a: "Yo'q. Vazifani oddiy tilda tushuntirasiz, vositalar va kanallarni tanlaysiz — Nemo agentni avtomatik sozlaydi. Ilg'or foydalanuvchilar uchun API va maxsus vositalar mavjud." },
      { q: "Qaysi kanallar qo'llab-quvvatlanadi?", a: "Hozir Telegram, veb-vidjet va API ishlaydi. WhatsApp va Instagram — ishlab chiqilmoqda: webhook kodi tayyor, lekin Meta imzosi produksiyada tekshirilmaguncha kanal yoqilmaydi. Har bir xizmat holati «Integratsiyalar» sahifasida ko'rinadi." },
      { q: "AI-jamoa nima?", a: "AI-jamoa — turli rollarga ega bir nechta agentlar, koordinator tomonidan boshqariladi. Masalan: bitta agent arizani saralaydi, ikkinchisi javob tayyorlaydi, uchinchisi CRM yangilaydi." },
      { q: "Agentlar xatosiz ishlaydimi?", a: "Hech bir AI tizimida xato xavfi nol emas. Nemo harakatlar tarixi, natijalarni tekshirish va murakkab holatlarni avtomatik insonga topshirish orqali xavfni kamaytiradi." },
      { q: "Narxi qancha?", a: "Ro'yxatdan o'tish bepul: bepul rejada 150 000 token. Pullik rejalar — $25/oy dan. Amaldagi limitlar va sarf — tariflar sahifasida." },
    ],
    previewSales: {
      process: "Nemo AI-jamoasi", request: "Lid malakasi (B2B)", done: "Faol", team: "Jamoa tarkibi", message: "Kiruvchi so'rov",
      quote: "«Assalomu alaykum! 50 ta foydalanuvchi uchun korporativ demo so'ramoqchi edik. Tariflaringiz qanday?»", history: "Harakatlar tarixi", next: "Keyingi qadam", action: "Savdo direktori bilan demo-qo'ng'iroqni rejalashtirish",
      agents: ["Koordinator", "Lead Qualifier", "Product Expert", "Quality Reviewer"],
      steps: ["Demo so'rovi klassifikatsiya qilindi (50 litsenziya)", "Korporativ narxlar bilimlar bazasidan olindi", "Lid yuqori ustuvorlik bilan CRM-ga saqlandi", "Korporativ tariflar bilan javob loyihasi tekshirildi va yuborildi"],
    },
    previewOps: {
      process: "Nemo AI-jamoasi", request: "Uchrashuv tahlili va vazifalar", done: "Bajarildi", team: "Jamoa tarkibi", message: "Uchrashuv transkripti",
      quote: "«Mijozlarni jalb qilish bo'yicha sinxronizatsiya. Dilshod juma kunigacha qarzdorlarga qo'ng'iroq qilishi kerak. Madina qo'llanmalarni yozadi.»", history: "Harakatlar tarixi", next: "Keyingi qadam", action: "Slack/Telegram orqali mas'ullarga eslatmalar yuborish",
      agents: ["Operations Lead", "Meeting Analyst", "Task Manager", "Report Agent"],
      steps: ["Uchrashuv transkripti tahlil qilindi va qarorlar olindi", "Vazifalar yaratildi: Dilshod (qo'ng'iroqlar), Madina (qo'llanmalar)", "Muddati va mas'ullar vazifalar jadvaliga kiritildi", "Operatsion hisobot tuzildi va rahbarga yuborildi"],
    },
    finalTitle: "AI-agentingizni hoziroq yarating",
    finalText: "Bepul reja — 150 000 token. Vazifani tushuntiring — agentingiz 5 daqiqada ishlaydi.",
  },
  en: {
    launch: "Public beta",
    heroKicker: "AI platform for modern business operations",
    title: "Orchestrate\nAI Teams\nin Minutes",
    subtitle: "Integrate coordinated teams of AI agents into your business workflows. From inbound sales and support to complex operations — zero code required.",
    primaryCta: "Create Team for Free",
    secondaryCta: "See How It Works",
    openTeam: "Create AI Team",
    notes: ["Free plan — 150,000 tokens", "No code required", "UZ / RU / EN"],
    statsTitle: "A platform ready to scale",
    stats: [
      ["12", "integrations live"],
      ["790", "services catalogued"],
      ["3", "interface languages"],
      ["5 min", "to first team"],
    ],
    painKicker: "How it works",
    painTitle: "From idea to a working AI team — four steps",
    painSubtitle: "No code, no API docs. Describe a task, configure behavior, connect channels — and the team is live.",
    flow: [
      ["Describe the task", "Tell the team what to do — in any language"],
      ["Configure roles", "Choose specialists, tools, knowledge base, and channels"],
      ["Launch", "Connect Telegram, the website widget, or API"],
      ["Scale", "Add agents, build new AI teams and departments"],
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
      "First response always matches your highest company standard",
      "One platform for agents, swarms, and channels",
      "Scaling operations means deploying another AI team",
      "Full audit trail: action history, evaluation metrics, and human handoff",
    ],
    workflowKicker: "Coordinated AI teams",
    workflowTitle: "Not a single bot — a coordinated AI team with roles",
    workflowSubtitle: "An Operations Lead routes tasks to specialists. You see who did what and what happens next.",
    capKicker: "Agent capabilities",
    capTitle: "Everything you need for intelligent automation",
    capabilities: [
      ["Messengers", "Telegram and the website widget; WhatsApp and Instagram in development", MessageCircleMore],
      ["Knowledge base", "Upload PDF, DOCX, XLSX — the agent learns from your data", Database],
      ["Tools", "CRM, Google Sheets, API, browser, file generation", Plug],
      ["Voice", "Speech recognition and generation for voice channels", Mic],
      ["Auto-posts", "Plan and publish content on a schedule", Repeat],
      ["Analytics", "Track the performance of every agent and team", Layers],
    ],
    templatesKicker: "Use cases",
    templatesTitle: "AI agents for any business domain",
    templates: [
      ["Customer support", "Instant replies, routing, and human handoff"],
      ["Sales & leads", "Lead qualification, follow-up, and CRM updates"],
      ["Content & marketing", "Generate copy, posts, and creatives on schedule"],
      ["Analytics & reports", "Daily summaries, monitoring, and alerts"],
      ["HR & recruiting", "Resume screening, candidate replies, onboarding"],
      ["Research", "Information search, competitor and market analysis"],
    ],
    controlKicker: "Security & control",
    controlTitle: "AI agents help the team without operating blindly",
    controls: [
      ["Action history", "Every action and result is available to you in real time.", ClipboardCheck],
      ["Human handoff", "Complex or critical cases are routed to a human operator.", UserRoundCheck],
      ["Data isolation", "Each account's data is separated by access policies.", ShieldCheck],
      ["Your tools", "Connect your own APIs, models, and databases.", Database],
    ],
    faqTitle: "Frequently asked questions",
    faq: [
      { q: "What is an AI agent?", a: "An AI agent is an autonomous program that performs tasks by your rules: answers customers, processes requests, generates content, or analyzes data. It works 24/7 and connects to your channels and tools." },
      { q: "Do I need to code?", a: "No. Describe the task in plain language, choose tools and channels — Nemo configures the agent automatically. Advanced users can use the API and custom tools." },
      { q: "Which channels are supported?", a: "Telegram, the web widget and the API are live today. WhatsApp and Instagram are in development: the webhooks are written, but we keep the channel off until Meta signature verification is confirmed in production. Every service shows its status on the Integrations page." },
      { q: "What is an AI team?", a: "An AI team is multiple agents with different roles managed by a coordinator. For example: one agent qualifies a request, another prepares a reply, a third updates the CRM. The coordinator routes work automatically." },
      { q: "Do agents work without errors?", a: "No AI system guarantees zero errors. Nemo reduces risk through action history, result checks, and automatic handoff of complex cases to humans." },
      { q: "How much does it cost?", a: "Registration is free: the free plan includes 150,000 tokens. Paid plans start at $25/mo. Current limits and usage are on the pricing page." },
    ],
    previewSales: {
      process: "Nemo AI Team", request: "Lead Qualification (B2B)", done: "Active", team: "Team Swarm", message: "Inbound Inquiry",
      quote: "\"Hi! We would like to request an enterprise demo for 50 users. What are your corporate rates?\"", history: "Action History", next: "Next Action", action: "Schedule enterprise demo call with sales director",
      agents: ["Coordinator", "Lead Qualifier", "Product Expert", "Quality Reviewer"],
      steps: ["Demo request classified for 50 licenses", "Enterprise pricing retrieved from knowledge base", "Lead saved to CRM with high priority", "Draft response with corporate rates verified and sent"],
    },
    previewOps: {
      process: "Nemo AI Team", request: "Meeting Sync & Task Dispatch", done: "Done", team: "Team Swarm", message: "Meeting Transcript",
      quote: "\"Sync on customer onboarding. Dilshod must call unpaid clients by Friday. Madina will write the help guides.\"", history: "Action History", next: "Next Action", action: "Send automated task reminders to owners via Slack/Telegram",
      agents: ["Operations Lead", "Meeting Analyst", "Task Manager", "Report Agent"],
      steps: ["Sync transcript parsed and decisions extracted", "Tasks created: Dilshod (calls), Madina (guides)", "Deadlines and owners mapped in task table", "Operations report compiled and delivered to manager"],
    },
    finalTitle: "Create your AI Team right now",
    finalText: "Free plan — 150,000 tokens. Describe a task — your team starts working in 5 minutes.",
  },
}

function SectionIntro({ kicker, title, text }: { kicker: string; title: string; text?: string }) {
  return (
    <div className="max-w-3xl">
      <p className="text-xs font-bold uppercase tracking-[0.16em] text-cyan">{kicker}</p>
      <h2 className="mt-4 text-[clamp(2rem,4vw,3.35rem)] font-black leading-[1.05] tracking-tight text-text">{title}</h2>
      {text && <p className="mt-5 max-w-2xl text-base leading-relaxed text-muted sm:text-lg">{text}</p>}
    </div>
  )
}

type PreviewCopy = {
  process: string
  request: string
  done: string
  team: string
  message: string
  quote: string
  history: string
  next: string
  action: string
  agents: string[]
  steps: string[]
}

function WorkflowPreview({ copy: preview }: { copy: PreviewCopy }) {
  return (
    <div className="relative mx-auto w-full max-w-3xl">
      <div className="absolute -inset-8 rounded-[2rem] bg-cyan/10 blur-3xl" />
      <div className="relative overflow-hidden rounded-[1.65rem] border border-cyan/25 bg-[#08111d] shadow-2xl shadow-black/40">
        <div className="flex items-center justify-between border-b border-white/10 px-5 py-4">
          <div>
            <p className="text-xs font-semibold text-muted">{preview.process}</p>
            <p className="mt-1 text-sm font-bold text-text">{preview.request}</p>
          </div>
          <span className="inline-flex items-center gap-2 rounded-full bg-emerald-400/10 px-3 py-1 text-xs font-semibold text-emerald-300">
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-300" /> {preview.done}
          </span>
        </div>
        <div className="grid gap-4 p-4 sm:grid-cols-[0.72fr_1.28fr] sm:p-5">
          <div className="rounded-2xl border border-white/10 bg-white/[0.035] p-4">
            <p className="text-[11px] font-bold uppercase tracking-[0.14em] text-fog">{preview.team}</p>
            <div className="mt-4 space-y-2.5">
              {preview.agents.map((agent, index) => (
                <div key={agent} className="flex items-center gap-2.5 rounded-xl border border-white/8 bg-black/20 px-3 py-2.5 text-xs font-semibold text-text">
                  <span className={cn('h-2.5 w-2.5 rounded-full', index === 0 ? 'bg-cyan' : index === 1 ? 'bg-emerald-400' : index === 2 ? 'bg-amber' : 'bg-blue')} />
                  {agent}
                </div>
              ))}
            </div>
          </div>
          <div className="space-y-4">
            <div className="rounded-2xl border border-white/10 bg-white/[0.035] p-4">
              <p className="text-[11px] font-bold uppercase tracking-[0.14em] text-fog">{preview.message}</p>
              <p className="mt-2 text-sm font-semibold leading-relaxed text-text">{preview.quote}</p>
            </div>
            <div className="grid gap-4 md:grid-cols-[1.25fr_0.75fr]">
              <div className="rounded-2xl border border-white/10 bg-white/[0.035] p-4">
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

export default function LandingPage() {
  const { lang } = useI18n()
  const c = copy[lang]

  return (
    <div className="min-h-screen bg-[#060b14]">
      <MarketingHeader />

      <main>
        {/* ─── HERO ─── */}
        <section className="relative overflow-hidden border-b border-white/8">
          <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_78%_16%,rgba(34,211,238,0.13),transparent_34%),radial-gradient(circle_at_12%_40%,rgba(139,124,248,0.10),transparent_32%)]" />
          <div className="container-page relative grid min-h-[calc(100vh-76px)] items-center gap-12 py-14 lg:grid-cols-[0.96fr_1.04fr] lg:py-20">
            <div className="max-w-2xl">
              <p className="text-sm font-bold uppercase tracking-[0.16em] text-cyan">{c.heroKicker}</p>
              <h1 className="mt-4 max-w-2xl whitespace-pre-line text-[clamp(2.8rem,5.2vw,4.6rem)] font-black leading-[0.96] tracking-[-0.055em] text-text">{c.title}</h1>
              <p className="mt-7 max-w-xl text-lg leading-relaxed text-muted">{c.subtitle}</p>
              <div className="mt-9 flex flex-wrap gap-3">
                <Button to="/auth?mode=signup" size="lg" className="!bg-cyan !bg-none !text-[#041018] shadow-[0_8px_28px_rgba(34,211,238,0.2)] hover:!brightness-110">
                  {c.primaryCta}<ArrowRight size={17} />
                </Button>
                <Button href="#workflow" variant="outline" size="lg">{c.secondaryCta}</Button>
              </div>
              <div className="mt-6 flex flex-wrap gap-x-5 gap-y-2 text-xs text-fog">
                {c.notes.map((note) => <span key={note} className="inline-flex items-center gap-2"><Check size={14} className="text-emerald-300" />{note}</span>)}
              </div>
            </div>
            <WorkflowPreview copy={c.previewSales} />
          </div>
        </section>

        {/* ─── SOCIAL PROOF STATS ─── */}
        <section className="border-b border-white/8 bg-[#08101c]">
          <div className="container-page py-16 sm:py-20">
            <p className="text-center text-sm font-bold uppercase tracking-[0.16em] text-muted">{c.statsTitle}</p>
            <div className="mt-10 grid grid-cols-2 gap-6 lg:grid-cols-4">
              {c.stats.map(([value, label]) => (
                <div key={label} className="text-center">
                  <p className="text-[clamp(2.5rem,5vw,4rem)] font-black tracking-tight text-cyan">{value}</p>
                  <p className="mt-1 text-sm font-medium text-muted">{label}</p>
                </div>
              ))}
            </div>
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
                    <CheckCircle2 size={16} className="mt-0.5 shrink-0 text-cyan animate-pulse" />
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
              <Button to="/app/create-team" variant="outline" className="mt-8">{c.openTeam}<ArrowRight size={15} /></Button>
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

        {/* ─── SECURITY & CONTROL ─── */}
        <section id="features" className="container-page py-20 sm:py-28">
          <SectionIntro kicker={c.controlKicker} title={c.controlTitle} />
          <div className="mt-12 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {c.controls.map(([title, text, Icon]) => (
              <div key={title as string} className="rounded-2xl border border-white/10 bg-white/[0.035] p-6">
                <Icon size={21} className="text-cyan" />
                <h3 className="mt-6 text-lg font-bold text-text">{title as string}</h3>
                <p className="mt-2 text-sm leading-relaxed text-muted">{text as string}</p>
              </div>
            ))}
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
            <Button to="/auth?mode=signup" size="lg" className="relative mt-8 !bg-cyan !bg-none !text-[#041018] shadow-none hover:!brightness-110 lg:mt-0">{c.primaryCta}<ArrowRight size={17} /></Button>
          </div>
        </section>
      </main>

      <MarketingFooter />
    </div>
  )
}
