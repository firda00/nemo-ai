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
    launch: "Публичный запуск 19 июля",
    heroKicker: "AI-платформа для любого бизнеса",
    title: "Создайте\nAI-агента\nза минуты",
    subtitle: "Опишите задачу — Nemo соберёт AI-команду: от поддержки клиентов до автоматизации любых рабочих процессов.",
    primaryCta: "Создать агента бесплатно",
    secondaryCta: "Посмотреть, как работает",
    openTeam: "Создать AI-команду",
    notes: ["1 000 кредитов бесплатно", "67 AI-функций", "Без кода"],
    statsTitle: "Платформа, готовая к масштабированию",
    stats: [
      ["67", "AI-функций"],
      ["20+", "интеграций"],
      ["6", "каналов связи"],
      ["5 мин", "до первого агента"],
    ],
    painKicker: "Как это работает",
    painTitle: "От идеи до рабочего AI-агента — четыре шага",
    painSubtitle: "Не нужно писать код или разбираться в API. Опишите задачу, настройте поведение, подключите каналы — и агент работает.",
    flow: [
      ["Опишите задачу", "Расскажите, что должен делать агент — на любом языке"],
      ["Настройте команду", "Выберите роли, инструменты, базу знаний и каналы"],
      ["Запустите", "Подключите Telegram, WhatsApp, виджет или API"],
      ["Масштабируйте", "Добавляйте агентов, создавайте AI-команды и отделы"],
    ],
    before: "Без AI-агентов",
    after: "С Nemo AI",
    beforeItems: ["Рутинные задачи съедают часы каждый день", "Каждый процесс требует отдельного инструмента", "Масштабирование = найм новых людей", "Нет единой системы автоматизации"],
    afterItems: ["AI-агент работает 24/7 по вашим правилам", "Одна платформа для агентов, команд и каналов", "Масштабирование = добавить ещё одного агента", "Полный контроль: история действий, передача человеку"],
    workflowKicker: "AI-команды по запросу",
    workflowTitle: "Не один бот, а координированная AI-команда с ролями",
    workflowSubtitle: "Координатор распределяет задачи между специалистами. Вы видите, кто что сделал и какой шаг будет следующим.",
    capKicker: "Возможности AI-агента",
    capTitle: "Всё, что нужно для умной автоматизации",
    capabilities: [
      ["Мессенджеры", "Telegram, WhatsApp, Instagram, виджет на сайте", MessageCircleMore],
      ["База знаний", "Загрузите PDF, DOCX, XLSX — агент учится на ваших данных", Database],
      ["Инструменты", "CRM, Google Sheets, API, браузер, генерация файлов", Plug],
      ["Голос", "Распознавание и генерация речи для голосовых каналов", Mic],
      ["Автопосты", "Планируйте и публикуйте контент по расписанию", Repeat],
      ["Аналитика", "Отслеживайте эффективность каждого агента и команды", Layers],
    ],
    templatesKicker: "Сценарии использования",
    templatesTitle: "AI-агенты для любой сферы бизнеса",
    templates: [
      ["Поддержка клиентов", "Мгновенные ответы, маршрутизация и передача оператору"],
      ["Продажи и лиды", "Квалификация заявок, follow-up и обновление CRM"],
      ["Контент и маркетинг", "Генерация текстов, постов и креативов по расписанию"],
      ["Аналитика и отчёты", "Ежедневные сводки, мониторинг и уведомления"],
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
      { q: "Нужно ли уметь программировать?", a: "Нет. Вы описываете задачу на обычном языке, выбираете инструменты и каналы — Nemo настроит агента автоматически. Для продвинутых пользователей есть API и кастомные инструменты." },
      { q: "Какие каналы поддерживаются?", a: "Telegram, WhatsApp, Instagram, веб-виджет и API. Список постоянно расширяется — Discord, YouTube и другие в планах." },
      { q: "Что такое AI-команда?", a: "AI-команда — это несколько агентов с разными ролями, управляемых координатором. Например: один агент квалифицирует заявку, другой готовит ответ, третий обновляет CRM. Координатор распределяет работу автоматически." },
      { q: "Агенты работают без ошибок?", a: "Ни одна AI-система не гарантирует нулевой риск ошибок. Nemo снижает риск через историю действий, проверку результатов и автоматическую передачу сложных случаев человеку." },
      { q: "Сколько это стоит?", a: "Регистрация бесплатна — вы получаете 1 000 кредитов. Пакеты кредитов от $10. Планы для команд от $59/мес. Подробнее — на странице Billing." },
    ],
    finalTitle: "Создайте своего AI-агента прямо сейчас",
    finalText: "1 000 кредитов бесплатно при регистрации. Опишите задачу — и ваш агент начнёт работать через 5 минут.",
    preview: {
      process: "AI-команда Nemo", request: "Обработка входящего запроса", done: "Готово", team: "Команда", message: "Запрос пользователя",
      quote: "«Нужна помощь с выбором тарифа и подключением Telegram бота»", history: "Что сделано", next: "Следующий шаг", action: "Отправить рекомендацию клиенту",
      agents: ["Координатор", "Аналитик запросов", "Специалист по продукту", "Контроль качества"],
      steps: ["Запрос принят и классифицирован", "Тарифы подобраны по критериям", "Инструкция по подключению готова", "Ответ проверен и отправлен"],
    },
  },
  uz: {
    launch: "Ommaviy ishga tushirish 19-iyul",
    heroKicker: "Har qanday biznes uchun AI-platforma",
    title: "AI-agentni\nminutlarda\nyarating",
    subtitle: "Vazifani tushuntiring — Nemo AI-jamoani yig'adi: mijozlarga yordam berishdan jarayonlarni avtomatlashtrishgacha.",
    primaryCta: "Bepul agent yaratish",
    secondaryCta: "Qanday ishlashini ko'rish",
    openTeam: "AI-jamoa yaratish",
    notes: ["1 000 kredit bepul", "67 AI-funksiya", "Kodsiz"],
    statsTitle: "Masshtablashga tayyor platforma",
    stats: [
      ["67", "AI-funksiya"],
      ["20+", "integratsiya"],
      ["6", "aloqa kanali"],
      ["5 min", "birinchi agentgacha"],
    ],
    painKicker: "Qanday ishlaydi",
    painTitle: "G'oyadan ishlaydigan AI-agentgacha — to'rt qadam",
    painSubtitle: "Kod yozish yoki API bilan ishlash shart emas. Vazifani tushuntiring, xatti-harakatni sozlang, kanallarni ulang — agent ishlaydi.",
    flow: [
      ["Vazifani tushuntiring", "Agent nima qilishi kerakligini aytib bering — istalgan tilda"],
      ["Jamoani sozlang", "Rollarni, asboblarni, bilim bazasi va kanallarni tanlang"],
      ["Ishga tushiring", "Telegram, WhatsApp, vidjeti yoki APIni ulang"],
      ["Masshtablang", "Agentlar qo'shing, AI-jamoalar va bo'limlar yarating"],
    ],
    before: "AI-agentlarsiz",
    after: "Nemo AI bilan",
    beforeItems: ["Kundalik vazifalar har kuni soatlarni yeydi", "Har bir jarayon alohida vosita talab qiladi", "Masshtablash = yangi odamlar yollash", "Yagona avtomatlashtirish tizimi yo'q"],
    afterItems: ["AI-agent 24/7 sizning qoidalaringiz bo'yicha ishlaydi", "Agentlar, jamoalar va kanallar uchun bitta platforma", "Masshtablash = yana bitta agent qo'shish", "To'liq nazorat: harakatlar tarixi, insonga topshirish"],
    workflowKicker: "So'rov bo'yicha AI-jamoalar",
    workflowTitle: "Bitta bot emas, rollar bilan muvofiqlashtirilgan AI-jamoa",
    workflowSubtitle: "Koordinator vazifalarni mutaxassislarga taqsimlaydi. Kim nima qilganini va keyingi qadam nimani ko'rasiz.",
    capKicker: "AI-agent imkoniyatlari",
    capTitle: "Aqlli avtomatlashtirish uchun kerak bo'lgan hamma narsa",
    capabilities: [
      ["Messenjerlar", "Telegram, WhatsApp, Instagram, saytdagi vidjet", MessageCircleMore],
      ["Bilim bazasi", "PDF, DOCX, XLSX yuklang — agent sizning ma'lumotlaringizdan o'rganadi", Database],
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
      { q: "Qaysi kanallar qo'llab-quvvatlanadi?", a: "Telegram, WhatsApp, Instagram, veb-vidjet va API. Ro'yxat doimiy kengaymoqda — Discord, YouTube va boshqalar rejalashtirilgan." },
      { q: "AI-jamoa nima?", a: "AI-jamoa — turli rollarga ega bir nechta agentlar, koordinator tomonidan boshqariladi. Masalan: bitta agent arizani saralaydi, ikkinchisi javob tayyorlaydi, uchinchisi CRM yangilaydi." },
      { q: "Agentlar xatosiz ishlaydimi?", a: "Hech bir AI tizimida xato xavfi nol emas. Nemo harakatlar tarixi, natijalarni tekshirish va murakkab holatlarni avtomatik insonga topshirish orqali xavfni kamaytiradi." },
      { q: "Narxi qancha?", a: "Ro'yxatdan o'tish bepul — 1 000 kredit olasiz. Kredit paketlari $10 dan. Jamoa rejalari $59/oy dan. Batafsil — Billing sahifasida." },
    ],
    preview: {
      process: "Nemo AI-jamoasi", request: "Kiruvchi so'rovni qayta ishlash", done: "Tayyor", team: "Jamoa", message: "Foydalanuvchi so'rovi",
      quote: "«Tarif tanlash va Telegram bot ulashda yordam kerak»", history: "Nima bajarildi", next: "Keyingi qadam", action: "Mijozga tavsiya yuborish",
      agents: ["Koordinator", "So'rov tahlilchisi", "Mahsulot mutaxassisi", "Sifat nazorati"],
      steps: ["So'rov qabul qilindi va tasniflandi", "Tariflar mezonlar bo'yicha tanlandi", "Ulash bo'yicha ko'rsatma tayyor", "Javob tekshirildi va yuborildi"],
    },
    finalTitle: "AI-agentingizni hoziroq yarating",
    finalText: "Ro'yxatdan o'tishda 1 000 kredit bepul. Vazifani tushuntiring — agentingiz 5 daqiqada ishlaydi.",
  },
  en: {
    launch: "Public launch July 19",
    heroKicker: "AI platform for any business",
    title: "Build your\nAI agent\nin minutes",
    subtitle: "Describe a task — Nemo assembles an AI team: from customer support to automating any workflow.",
    primaryCta: "Create agent for free",
    secondaryCta: "See how it works",
    openTeam: "Create AI team",
    notes: ["1,000 free credits", "67 AI functions", "No code required"],
    statsTitle: "A platform ready to scale",
    stats: [
      ["67", "AI functions"],
      ["20+", "integrations"],
      ["6", "channels"],
      ["5 min", "to first agent"],
    ],
    painKicker: "How it works",
    painTitle: "From idea to a working AI agent — four steps",
    painSubtitle: "No code, no API docs. Describe a task, configure behavior, connect channels — and the agent is live.",
    flow: [
      ["Describe the task", "Tell the agent what to do — in any language"],
      ["Configure the team", "Choose roles, tools, knowledge base, and channels"],
      ["Launch", "Connect Telegram, WhatsApp, a widget, or API"],
      ["Scale", "Add agents, build AI teams and departments"],
    ],
    before: "Without AI agents",
    after: "With Nemo AI",
    beforeItems: ["Routine tasks consume hours every day", "Each process requires a separate tool", "Scaling = hiring more people", "No unified automation system"],
    afterItems: ["AI agent works 24/7 by your rules", "One platform for agents, teams, and channels", "Scaling = adding one more agent", "Full control: action history, human handoff"],
    workflowKicker: "AI teams on demand",
    workflowTitle: "Not a single bot — a coordinated AI team with roles",
    workflowSubtitle: "A coordinator routes tasks to specialists. You see who did what and what happens next.",
    capKicker: "Agent capabilities",
    capTitle: "Everything you need for intelligent automation",
    capabilities: [
      ["Messengers", "Telegram, WhatsApp, Instagram, website widget", MessageCircleMore],
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
      { q: "Which channels are supported?", a: "Telegram, WhatsApp, Instagram, web widget, and API. The list is constantly growing — Discord, YouTube, and more are planned." },
      { q: "What is an AI team?", a: "An AI team is multiple agents with different roles managed by a coordinator. For example: one agent qualifies a request, another prepares a reply, a third updates the CRM. The coordinator routes work automatically." },
      { q: "Do agents work without errors?", a: "No AI system guarantees zero errors. Nemo reduces risk through action history, result checks, and automatic handoff of complex cases to humans." },
      { q: "How much does it cost?", a: "Registration is free — you get 1,000 credits. Credit packs start at $10. Team plans start at $59/mo. See the Billing page for details." },
    ],
    preview: {
      process: "Nemo AI team", request: "Processing incoming request", done: "Done", team: "Team", message: "User request",
      quote: "\"I need help choosing a plan and connecting a Telegram bot\"", history: "What was done", next: "Next step", action: "Send recommendation to customer",
      agents: ["Coordinator", "Request analyst", "Product specialist", "Quality control"],
      steps: ["Request received and classified", "Plans matched by criteria", "Connection guide prepared", "Response verified and sent"],
    },
    finalTitle: "Create your AI agent right now",
    finalText: "1,000 free credits on signup. Describe a task — your agent starts working in 5 minutes.",
  },
}

function StatusPill({ children }: { children: React.ReactNode }) {
  return <span className="inline-flex items-center gap-2 rounded-full border border-cyan/25 bg-cyan/10 px-3 py-1.5 text-xs font-semibold text-cyan">{children}</span>
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
              <StatusPill><Sparkles size={13} />{c.launch}</StatusPill>
              <p className="mt-8 text-sm font-bold uppercase tracking-[0.16em] text-cyan">{c.heroKicker}</p>
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
            <WorkflowPreview copy={c.preview} />
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
            <div className="rounded-3xl border border-rose-300/10 bg-rose-300/[0.035] p-7 sm:p-8">
              <p className="text-sm font-bold text-rose-200">{c.before}</p>
              <div className="mt-5 space-y-3">{c.beforeItems.map((item) => <p key={item} className="flex gap-3 text-sm leading-relaxed text-muted"><span className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-rose-300/70" />{item}</p>)}</div>
            </div>
            <div className="rounded-3xl border border-emerald-300/20 bg-emerald-300/[0.06] p-7 sm:p-8">
              <p className="text-sm font-bold text-emerald-300">{c.after}</p>
              <div className="mt-5 space-y-3">{c.afterItems.map((item) => <p key={item} className="flex gap-3 text-sm leading-relaxed text-text"><CheckCircle2 size={16} className="mt-0.5 shrink-0 text-emerald-300" />{item}</p>)}</div>
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
            <WorkflowPreview copy={c.preview} />
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
                <Rocket size={13} />1,000 free credits
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
