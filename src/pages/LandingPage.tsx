import {
  ArrowRight,
  Check,
  CheckCircle2,
  ClipboardCheck,
  Database,
  MessageCircleMore,
  ShieldCheck,
  Sparkles,
  UserRoundCheck,
} from 'lucide-react'
import { MarketingFooter } from '../components/layout/MarketingFooter'
import { MarketingHeader } from '../components/layout/MarketingHeader'
import { Accordion } from '../components/ui/Accordion'
import { Button } from '../components/ui/Button'
import { useI18n } from '../i18n'
import { cn } from '../lib/cn'

const copy = {
  ru: {
    launch: 'Публичный запуск 19 июля',
    heroKicker: 'Для учебных центров и онлайн-школ',
    title: 'AI-продажи\nучебного центра',
    subtitle: 'Квалифицирует лиды, готовит follow-up, обновляет CRM или Google Sheets и показывает руководителю следующий шаг.',
    primaryCta: 'Запустить пилот',
    secondaryCta: 'Посмотреть workflow',
    openTeam: 'Открыть AI-команду',
    notes: ['UZ, RU и EN', 'Руководитель подтверждает важные действия'],
    painKicker: 'Одна заявка. Один понятный маршрут.',
    painTitle: 'Лид не должен теряться между чатом, таблицей и менеджером',
    painSubtitle: 'Nemo собирает входящие обращения в управляемый процесс. Каждый шаг виден, а спорные решения остаются за человеком.',
    flow: [
      ['Входящие', 'Telegram, Instagram, форма или файл'],
      ['Квалификация', 'Цель, курс, срок, бюджет и готовность'],
      ['Действие', 'Персональный follow-up и следующая задача'],
      ['Контроль', 'CRM/Sheets и ежедневный отчёт руководителю'],
    ],
    before: 'Без Nemo',
    after: 'С Nemo',
    beforeItems: ['Ответ зависит от свободного менеджера', 'Данные копируются вручную', 'Следующий шаг легко забыть', 'Руководитель узнаёт результат слишком поздно'],
    afterItems: ['Первичная обработка идёт по одному стандарту', 'Лид получает статус и владельца', 'CRM или таблица обновляется структурно', 'Человек видит риски и подтверждает важные действия'],
    workflowKicker: 'Живой рабочий процесс',
    workflowTitle: 'Не чат-бот, а команда с ролями и проверкой результата',
    workflowSubtitle: 'Team Lead распределяет работу между специалистами. В интерфейсе видно, кто что сделал и что требуется дальше.',
    pilotKicker: 'Сценарий первого запуска',
    pilotTitle: 'Начните с одной задачи, которую можно измерить за неделю',
    pilotText: 'Мы настраиваем обработку входящих лидов, правила квалификации и формат вашей таблицы или CRM. После пилота вы видите скорость ответа, статусы лидов и следующий шаг по каждой заявке.',
    pilotSteps: ['Подключить источник заявок', 'Настроить вопросы и статусы', 'Проверить на реальных диалогах', 'Передать команде рабочий регламент'],
    controlKicker: 'Контроль встроен в продукт',
    controlTitle: 'Агенты помогают команде, но не действуют вслепую',
    controls: [
      ['Видимый trace', 'Каждое действие и результат доступны руководителю.', ClipboardCheck],
      ['Передача человеку', 'Неуверенный или важный случай уходит менеджеру.', UserRoundCheck],
      ['Изоляция данных', 'Данные разных компаний разделены политиками доступа.', ShieldCheck],
      ['Ваши инструменты', 'Google Sheets, CRM и модели подключаются по правилам компании.', Database],
    ],
    templatesKicker: 'После первого workflow',
    templatesTitle: 'Расширяйте Nemo на соседние процессы',
    templates: [
      ['Продажи курсов', 'Лиды, follow-up, CRM и отчёт'],
      ['Поддержка студентов', 'Вопросы, маршрутизация и передача человеку'],
      ['Планёрка', 'Запись встречи, задачи, сроки и напоминания'],
    ],
    faqTitle: 'Что важно знать до пилота',
    faq: [
      { q: 'Nemo сам отправляет сообщения клиентам?', a: 'Автоматический режим настраивается отдельно. На пилоте можно оставить подтверждение каждого внешнего действия за менеджером.' },
      { q: 'Нужно переносить нашу таблицу?', a: 'Нет. Можно подключить существующий Google Sheet или загрузить XLSX/CSV и настроить соответствие колонок.' },
      { q: 'Можно поменять модель AI?', a: 'Да. В команде можно выбрать разрешённого провайдера и модель с учётом тарифа и ключей компании.' },
      { q: 'Агенты работают без ошибок?', a: 'Ни одна AI-система не даёт нулевой риск ошибок. Поэтому Nemo показывает trace, использует проверки результата и передаёт критичные решения человеку.' },
    ],
    finalTitle: 'Подготовьте AI-отдел продаж к запуску 19 июля',
    finalText: 'Начните с одного сценария и реальных заявок. Мы поможем настроить роли, таблицу и правила контроля.',
  },
  uz: {
    launch: 'Ommaviy ishga tushirish 19-iyul',
    heroKicker: "O'quv markazlari va onlayn maktablar uchun",
    title: "O'quv markazida\nAI savdo",
    subtitle: "Lidlarni saralaydi, follow-up tayyorlaydi, CRM yoki Google Sheetsni yangilaydi va rahbarga keyingi qadamni ko'rsatadi.",
    primaryCta: 'Pilotni boshlash',
    secondaryCta: "Workflowni ko'rish",
    openTeam: 'AI-komandani ochish',
    notes: ['UZ, RU va EN', "Muhim harakatlarni rahbar tasdiqlaydi"],
    painKicker: "Bitta ariza. Bitta aniq yo'l.",
    painTitle: "Lid chat, jadval va menejer orasida yo'qolmasligi kerak",
    painSubtitle: "Nemo kiruvchi murojaatlarni boshqariladigan jarayonga aylantiradi. Har bir qadam ko'rinadi, muhim qaror esa insonda qoladi.",
    flow: [
      ['Kiruvchi lid', 'Telegram, Instagram, forma yoki fayl'],
      ['Saralash', 'Maqsad, kurs, muddat, budjet va tayyorlik'],
      ['Harakat', 'Shaxsiy follow-up va keyingi vazifa'],
      ['Nazorat', 'CRM/Sheets va rahbar uchun kunlik hisobot'],
    ],
    before: 'Nemo siz',
    after: 'Nemo bilan',
    beforeItems: ["Javob bo'sh menejerga bog'liq", "Ma'lumot qo'lda ko'chiriladi", "Keyingi qadam unutilishi mumkin", "Rahbar natijani kech ko'radi"],
    afterItems: ["Birinchi javob yagona standartda", "Lid status va egaga ega", "CRM yoki jadval tartibli yangilanadi", "Inson xatarlarni ko'rib muhim harakatni tasdiqlaydi"],
    workflowKicker: 'Jonli ish jarayoni',
    workflowTitle: 'Oddiy chatbot emas, rollar va tekshiruvli AI jamoa',
    workflowSubtitle: "Team Lead ishni mutaxassislarga bo'ladi. Interfeysda kim nima qilgani va keyin nima kerakligi ko'rinadi.",
    pilotKicker: 'Birinchi pilot ssenariysi',
    pilotTitle: "Bir haftada o'lchash mumkin bo'lgan bitta vazifadan boshlang",
    pilotText: "Kiruvchi lidlar, saralash qoidalari va mavjud jadval yoki CRM formatini sozlaymiz. Pilotdan keyin javob tezligi, lid statuslari va har bir murojaat bo'yicha keyingi qadam ko'rinadi.",
    pilotSteps: ['Ariza manbasini ulash', 'Savol va statuslarni sozlash', 'Real dialoglarda tekshirish', 'Jamoaga ish reglamentini berish'],
    controlKicker: 'Nazorat mahsulot ichida',
    controlTitle: "Agentlar yordam beradi, lekin nazoratsiz ishlamaydi",
    controls: [
      ['Ko‘rinadigan trace', "Har bir harakat va natijani rahbar ko'radi.", ClipboardCheck],
      ['Insonga topshirish', "Noaniq yoki muhim holat menejerga o'tadi.", UserRoundCheck],
      ['Ma’lumot izolyatsiyasi', "Turli kompaniyalar ma'lumoti kirish siyosati bilan ajratiladi.", ShieldCheck],
      ['Sizning vositalaringiz', 'Google Sheets, CRM va modellar kompaniya qoidasi bo‘yicha ulanadi.', Database],
    ],
    templatesKicker: 'Birinchi workflowdan keyin',
    templatesTitle: 'Nemo imkoniyatlarini qo‘shni jarayonlarga kengaytiring',
    templates: [
      ['Kurs savdosi', 'Lidlar, follow-up, CRM va hisobot'],
      ['Talabalar yordami', 'Savollar, yo‘naltirish va insonga topshirish'],
      ['Planerka', 'Uchrashuv yozuvi, vazifalar, muddatlar va eslatmalar'],
    ],
    faqTitle: 'Pilotdan oldin bilish kerak',
    faq: [
      { q: "Nemo mijozga o'zi yozadimi?", a: "Avtomatik rejim alohida sozlanadi. Pilotda har bir tashqi harakatni menejer tasdiqlashi mumkin." },
      { q: "Jadvalimizni ko'chirish kerakmi?", a: "Yo'q. Mavjud Google Sheetni ulash yoki XLSX/CSV yuklab, ustunlarni moslash mumkin." },
      { q: "AI modelini o'zgartirish mumkinmi?", a: "Ha. Tarif va kompaniya kalitlariga qarab ruxsat etilgan provayder va model tanlanadi." },
      { q: 'Agentlar xatosiz ishlaydimi?', a: "Hech bir AI tizimida xato xavfi nol emas. Nemo trace, natija tekshiruvi va muhim qarorlarni insonga topshirish orqali xavfni kamaytiradi." },
    ],
    finalTitle: "19-iyulga AI savdo bo'limingizni tayyorlang",
    finalText: "Bitta ssenariy va real lidlardan boshlang. Rollar, jadval va nazorat qoidalarini sozlashga yordam beramiz.",
  },
  en: {
    launch: 'Public launch July 19',
    heroKicker: 'For education centers and online schools',
    title: 'AI sales for\neducation teams',
    subtitle: 'Qualifies leads, prepares follow-up, updates CRM or Google Sheets, and shows managers the next action.',
    primaryCta: 'Start a pilot',
    secondaryCta: 'See the workflow',
    openTeam: 'Open the AI team',
    notes: ['UZ, RU and EN', 'Managers approve important actions'],
    painKicker: 'One inquiry. One clear route.',
    painTitle: 'A lead should not disappear between a chat, a spreadsheet, and a manager',
    painSubtitle: 'Nemo turns incoming inquiries into a controlled workflow. Every step is visible, while sensitive decisions stay with people.',
    flow: [
      ['Inbound', 'Telegram, Instagram, form, or file'],
      ['Qualification', 'Goal, course, timeline, budget, and intent'],
      ['Action', 'Personal follow-up and next task'],
      ['Control', 'CRM/Sheets and a daily manager report'],
    ],
    before: 'Without Nemo',
    after: 'With Nemo',
    beforeItems: ['Response depends on an available manager', 'Data is copied by hand', 'The next action is easy to forget', 'Managers learn the outcome too late'],
    afterItems: ['First response follows one standard', 'Every lead gets a status and owner', 'CRM or Sheets receives structured updates', 'People see risks and approve important actions'],
    workflowKicker: 'Live operating workflow',
    workflowTitle: 'Not a chatbot. A role-based team that checks its work',
    workflowSubtitle: 'The Team Lead routes work to specialists. The interface shows who did what and what needs to happen next.',
    pilotKicker: 'First launch workflow',
    pilotTitle: 'Start with one job you can measure in a week',
    pilotText: 'We configure incoming leads, qualification rules, and your existing CRM or spreadsheet format. The pilot shows response time, lead status, and the next action for every inquiry.',
    pilotSteps: ['Connect an inquiry source', 'Configure questions and statuses', 'Test with real conversations', 'Give the team a working playbook'],
    controlKicker: 'Control is built in',
    controlTitle: 'Agents help the team without operating blindly',
    controls: [
      ['Visible trace', 'Managers can inspect every action and result.', ClipboardCheck],
      ['Human handoff', 'Uncertain or sensitive cases go to a manager.', UserRoundCheck],
      ['Data isolation', 'Access policies separate each company’s data.', ShieldCheck],
      ['Your tools', 'Google Sheets, CRM, and models follow company rules.', Database],
    ],
    templatesKicker: 'After the first workflow',
    templatesTitle: 'Expand Nemo into adjacent work',
    templates: [
      ['Course sales', 'Leads, follow-up, CRM, and reporting'],
      ['Student support', 'Questions, routing, and human handoff'],
      ['Meetings', 'Recording, tasks, deadlines, and reminders'],
    ],
    faqTitle: 'What to know before a pilot',
    faq: [
      { q: 'Does Nemo message customers automatically?', a: 'Automatic mode is configured separately. During a pilot, managers can approve every external action.' },
      { q: 'Do we need to replace our spreadsheet?', a: 'No. Connect an existing Google Sheet or upload XLSX/CSV and map the columns.' },
      { q: 'Can we change the AI model?', a: 'Yes. Choose an allowed provider and model based on the plan and company keys.' },
      { q: 'Do agents work without errors?', a: 'No AI system has zero error risk. Nemo reduces risk with visible traces, result checks, and human approval for sensitive decisions.' },
    ],
    finalTitle: 'Prepare your AI sales team for the July 19 launch',
    finalText: 'Start with one workflow and real inquiries. We will help configure roles, data, and control rules.',
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

function WorkflowPreview() {
  const agents = ['Team Lead', 'Lead Qualifier', 'Follow-up', 'CRM Agent']
  const trace = ['Заявка принята', 'Цель и срок определены', 'Follow-up подготовлен', 'Строка CRM сохранена']

  return (
    <div className="relative mx-auto w-full max-w-3xl">
      <div className="absolute -inset-8 rounded-[2rem] bg-cyan/10 blur-3xl" />
      <div className="relative overflow-hidden rounded-[1.65rem] border border-cyan/25 bg-[#08111d] shadow-2xl shadow-black/40">
        <div className="flex items-center justify-between border-b border-white/10 px-5 py-4">
          <div>
            <p className="text-xs font-semibold text-muted">Nemo workflow</p>
            <p className="mt-1 text-sm font-bold text-text">Входящая заявка на IELTS</p>
          </div>
          <span className="inline-flex items-center gap-2 rounded-full bg-emerald-400/10 px-3 py-1 text-xs font-semibold text-emerald-300">
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-300" /> Готово
          </span>
        </div>
        <div className="grid gap-4 p-4 sm:grid-cols-[0.72fr_1.28fr] sm:p-5">
          <div className="rounded-2xl border border-white/10 bg-white/[0.035] p-4">
            <p className="text-[11px] font-bold uppercase tracking-[0.14em] text-fog">AI-команда</p>
            <div className="mt-4 space-y-2.5">
              {agents.map((agent, index) => (
                <div key={agent} className="flex items-center gap-2.5 rounded-xl border border-white/8 bg-black/20 px-3 py-2.5 text-xs font-semibold text-text">
                  <span className={cn('h-2.5 w-2.5 rounded-full', index === 0 ? 'bg-cyan' : index === 1 ? 'bg-emerald-400' : index === 2 ? 'bg-amber' : 'bg-blue')} />
                  {agent}
                </div>
              ))}
            </div>
          </div>
          <div className="space-y-4">
            <div className="rounded-2xl border border-white/10 bg-white/[0.035] p-4">
              <p className="text-[11px] font-bold uppercase tracking-[0.14em] text-fog">Входящее сообщение</p>
              <p className="mt-2 text-sm font-semibold leading-relaxed text-text">«Хочу IELTS. Какая цена и можно ли начать на этой неделе?»</p>
            </div>
            <div className="grid gap-4 md:grid-cols-[1.25fr_0.75fr]">
              <div className="rounded-2xl border border-white/10 bg-white/[0.035] p-4">
                <p className="text-sm font-bold text-text">Trace команды</p>
                <div className="mt-3 space-y-2.5">
                  {trace.map((item) => <div key={item} className="flex items-center gap-2 text-xs text-muted"><CheckCircle2 size={15} className="shrink-0 text-cyan" />{item}</div>)}
                </div>
              </div>
              <div className="rounded-2xl border border-amber/25 bg-amber/10 p-4">
                <p className="text-[11px] font-bold uppercase tracking-[0.12em] text-amber">Следующий шаг</p>
                <p className="mt-3 text-sm font-semibold leading-relaxed text-text">Позвонить сегодня до 18:00</p>
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
        <section className="relative overflow-hidden border-b border-white/8">
          <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_78%_16%,rgba(34,211,238,0.13),transparent_34%),radial-gradient(circle_at_12%_40%,rgba(16,185,129,0.08),transparent_32%)]" />
          <div className="container-page relative grid min-h-[calc(100vh-76px)] items-center gap-12 py-14 lg:grid-cols-[0.96fr_1.04fr] lg:py-20">
            <div className="max-w-2xl">
              <StatusPill><Sparkles size={13} />{c.launch}</StatusPill>
              <p className="mt-8 text-sm font-bold uppercase tracking-[0.16em] text-emerald-300">{c.heroKicker}</p>
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
            <WorkflowPreview />
          </div>
        </section>

        <section id="product" className="container-page py-20 sm:py-28">
          <SectionIntro kicker={c.painKicker} title={c.painTitle} text={c.painSubtitle} />
          <div className="mt-12 grid gap-3 lg:grid-cols-4">
            {c.flow.map(([title, text], index) => (
              <div key={title} className="relative rounded-2xl border border-white/10 bg-white/[0.035] p-5">
                <span className="text-xs font-black text-cyan">0{index + 1}</span>
                <h3 className="mt-6 text-lg font-bold text-text">{title}</h3>
                <p className="mt-2 text-sm leading-relaxed text-muted">{text}</p>
              </div>
            ))}
          </div>
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

        <section id="workflow" className="border-y border-white/8 bg-[#08101c]">
          <div className="container-page grid items-center gap-12 py-20 sm:py-28 lg:grid-cols-[0.82fr_1.18fr]">
            <div>
              <SectionIntro kicker={c.workflowKicker} title={c.workflowTitle} text={c.workflowSubtitle} />
              <Button to="/app/create-team" variant="outline" className="mt-8">{c.openTeam}<ArrowRight size={15} /></Button>
            </div>
            <WorkflowPreview />
          </div>
        </section>

        <section id="how" className="container-page py-20 sm:py-28">
          <div className="grid gap-10 lg:grid-cols-[1.02fr_0.98fr] lg:items-start">
            <SectionIntro kicker={c.pilotKicker} title={c.pilotTitle} text={c.pilotText} />
            <div className="rounded-3xl border border-cyan/20 bg-cyan/[0.055] p-6 sm:p-8">
              {c.pilotSteps.map((step, index) => (
                <div key={step} className="flex gap-4 border-b border-white/10 py-4 first:pt-0 last:border-0 last:pb-0">
                  <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-cyan text-xs font-black text-[#041018]">{index + 1}</span>
                  <p className="pt-1 text-sm font-semibold text-text sm:text-base">{step}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        <section id="features" className="container-page pb-20 sm:pb-28">
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

        <section id="templates" className="border-y border-white/8 bg-[#08101c]">
          <div className="container-page py-20 sm:py-24">
            <SectionIntro kicker={c.templatesKicker} title={c.templatesTitle} />
            <div className="mt-10 grid gap-4 lg:grid-cols-3">
              {c.templates.map(([title, text], index) => (
                <div key={title} className="rounded-2xl border border-white/10 bg-black/20 p-6">
                  <div className="flex items-center justify-between"><MessageCircleMore size={20} className="text-emerald-300" /><span className="text-xs font-black text-fog">0{index + 1}</span></div>
                  <h3 className="mt-8 text-xl font-bold text-text">{title}</h3>
                  <p className="mt-2 text-sm text-muted">{text}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        <section id="faq" className="container-page grid gap-10 py-20 sm:py-28 lg:grid-cols-[0.72fr_1.28fr]">
          <div>
            <p className="text-xs font-bold uppercase tracking-[0.16em] text-cyan">FAQ</p>
            <h2 className="mt-4 text-4xl font-black leading-tight text-text">{c.faqTitle}</h2>
          </div>
          <Accordion items={c.faq} />
        </section>

        <section className="container-page pb-20 sm:pb-28">
          <div className="relative overflow-hidden rounded-[2rem] border border-cyan/25 bg-[#0b1c25] p-8 sm:p-12 lg:flex lg:items-end lg:justify-between">
            <div className="pointer-events-none absolute -right-16 -top-24 h-72 w-72 rounded-full bg-cyan/15 blur-3xl" />
            <div className="relative max-w-3xl">
              <StatusPill>{c.launch}</StatusPill>
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
