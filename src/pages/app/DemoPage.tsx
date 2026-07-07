import { ArrowRight, Bot, CheckCircle2, Database, GitBranch, MessageSquareText, Play, UserPlus } from 'lucide-react'
import { Button } from '../../components/ui/Button'
import { useI18n } from '../../i18n'
import { AgentOrchestrationDemo } from '../../components/platform/AgentOrchestrationDemo'

const copy = {
  ru: {
    eyebrow: '2-минутное демо для инвестора',
    title: 'AI-команда продаж и поддержки для онлайн-школы',
    subtitle: 'Сценарий показывает весь wedge: создать AI-команду, ответить клиенту, показать Agent Trace, собрать лид и доказать ROI.',
    build: 'Создать эту команду',
    live: 'Живой диалог',
    user: 'Здравствуйте, сколько стоит курс frontend и можно ли начать на этой неделе?',
    assistant: 'Да. Следующий поток стартует в понедельник. Стандартный план стоит $199/месяц. Оставьте номер телефона, и консультант подтвердит расписание.',
    lead: 'Лид создан',
    crm: 'CRM: John Doe · интерес есть · бюджет подтверждён · старт на этой неделе',
    trace: 'Agent Trace',
    traceItems: ['Главный агент понял намерение покупки', 'Knowledge Agent проверил цены', 'Квалификатор запросил телефон', 'CRM Agent подготовил лид'],
    takeaway: 'Вывод для инвестора',
    takeawayText: 'Nemo не chatbot builder. Это измеримый слой AI workforce: команды, память, инструменты, trace, quality checks и ROI.',
    pitch: 'Открыть pitch page',
    steps: [
      ['Цель', 'Онлайн-школе нужны лиды, поддержка и передача в CRM.'],
      ['Команда создана', 'Leader + qualifier + knowledge + CRM + escalation agents.'],
      ['Сообщение клиента', '“Сколько стоит курс и можно ли начать на этой неделе?”'],
      ['Company Brain', 'Nemo проверяет цены, расписание и FAQ.'],
      ['Лид собран', 'Телефон, бюджет и намерение переданы в CRM/table.'],
    ],
  },
  en: {
    eyebrow: '2-minute investor demo', title: 'AI Sales + Support Team for an online school', subtitle: 'This scripted demo shows the full wedge: create an AI team, answer a customer, trace sub-agents, capture a lead and prove ROI.', build: 'Build this team', live: 'Live conversation', user: 'Hi, how much is the frontend course and can I start this week?', assistant: 'Yes. The next cohort starts Monday. The standard plan is $199/month. Can I get your phone number so our advisor confirms your schedule?', lead: 'Lead created', crm: 'CRM row: John Doe · interested · budget confirmed · start this week', trace: 'Agent Trace', traceItems: ['Leader detected sales intent', 'Knowledge Agent checked pricing', 'Qualifier captured phone need', 'CRM Agent prepared lead'], takeaway: 'Investor takeaway', takeawayText: 'Nemo is not a chatbot builder. It is a measurable AI workforce layer: teams, memory, tools, trace, quality checks and ROI.', pitch: 'Open pitch page', steps: [['Goal', 'Online school needs leads, support and CRM handoff.'], ['Team created', 'Leader + qualifier + knowledge + CRM + escalation agents.'], ['Customer message', '“How much is the course and can I start this week?”'], ['Company Brain', 'Nemo checks pricing, schedule and FAQ.'], ['Lead captured', 'Phone, budget and intent pushed to CRM/table.']],
  },
  uz: {
    eyebrow: 'Investor uchun 2 daqiqalik demo', title: 'Onlayn maktab uchun AI sotuv va support komandasi', subtitle: 'Demo: AI-komanda yaratish, mijozga javob berish, Agent Trace, lead yig‘ish va ROI ko‘rsatish.', build: 'Shu komandani yaratish', live: 'Jonli suhbat', user: 'Salom, frontend kurs narxi qancha va shu hafta boshlash mumkinmi?', assistant: 'Ha. Keyingi guruh dushanba kuni boshlanadi. Standart tarif $199/oy. Jadvalni tasdiqlash uchun telefon raqamingizni qoldiring.', lead: 'Lead yaratildi', crm: 'CRM: John Doe · qiziqish bor · budget tasdiqlandi · shu hafta start', trace: 'Agent Trace', traceItems: ['Bosh agent sotib olish niyatini aniqladi', 'Knowledge Agent narxlarni tekshirdi', 'Kvalifikator telefon so‘radi', 'CRM Agent lead tayyorladi'], takeaway: 'Investor uchun xulosa', takeawayText: 'Nemo chatbot builder emas. Bu o‘lchanadigan AI workforce qatlami: komandalar, xotira, tools, trace, quality checks va ROI.', pitch: 'Pitch page ochish', steps: [['Maqsad', 'Onlayn maktabga lead, support va CRM handoff kerak.'], ['Komanda yaratildi', 'Leader + qualifier + knowledge + CRM + escalation agents.'], ['Mijoz xabari', '“Kurs narxi qancha va shu hafta boshlash mumkinmi?”'], ['Company Brain', 'Nemo narx, jadval va FAQ tekshiradi.'], ['Lead yig‘ildi', 'Telefon, budget va intent CRM/table ga yuborildi.']],
  },
}

const icons = [MessageSquareText, GitBranch, Bot, Database, UserPlus]

export default function DemoPage() {
  const { lang } = useI18n()
  const c = copy[lang]
  return (
    <div className="container-page max-w-7xl py-8">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="mono-label">{c.eyebrow}</p>
          <h1 className="mt-2 text-3xl font-extrabold text-text">{c.title}</h1>
          <p className="mt-2 max-w-2xl text-sm leading-relaxed text-muted">{c.subtitle}</p>
        </div>
        <Button to="/onboarding?team=AI Sales Team" leftIcon={<Play size={16} />}>{c.build}</Button>
      </div>

      <div className="mt-8">
        <AgentOrchestrationDemo />
      </div>

      <div className="mt-8 grid gap-4 lg:grid-cols-[0.8fr_1.2fr]">
        <div className="space-y-3">
          {c.steps.map(([title, text], index) => {
            const Icon = icons[index]
            return (
            <div key={title} className="card rounded-2xl p-4">
              <div className="flex gap-3">
                <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-violet/15 text-violet"><Icon size={18} /></span>
                <div>
                  <p className="text-sm font-semibold text-text">{index + 1}. {title}</p>
                  <p className="mt-1 text-xs leading-relaxed text-muted">{text}</p>
                </div>
              </div>
            </div>
          )})}
        </div>

        <div className="gradient-ring rounded-3xl p-px">
          <div className="rounded-[1.45rem] bg-panel/90 p-5">
            <div className="grid gap-4 lg:grid-cols-[1fr_0.9fr]">
              <div className="rounded-2xl border border-white/10 bg-bg/70 p-4">
                <p className="text-sm font-semibold text-text">{c.live}</p>
                <div className="mt-4 space-y-3">
                  <div className="max-w-[86%] rounded-2xl rounded-tl-md border border-white/10 bg-white/[0.05] px-4 py-3 text-sm text-text">{c.user}</div>
                  <div className="ml-auto max-w-[90%] rounded-2xl rounded-tr-md border border-violet/30 bg-violet/10 px-4 py-3 text-sm leading-relaxed text-text">{c.assistant}</div>
                </div>
                <div className="mt-5 rounded-2xl border border-teal/20 bg-teal/10 p-4">
                  <p className="flex items-center gap-2 text-sm font-semibold text-teal"><CheckCircle2 size={16} /> {c.lead}</p>
                  <p className="mt-1 text-xs text-muted">{c.crm}</p>
                </div>
              </div>

              <div className="rounded-2xl border border-white/10 bg-bg/70 p-4">
                <p className="flex items-center gap-2 text-sm font-semibold text-text"><GitBranch size={16} className="text-violet" /> {c.trace}</p>
                <div className="mt-4 space-y-3">
                  {c.traceItems.map((item) => (
                    <div key={item} className="rounded-xl border border-white/10 bg-white/[0.04] p-3 text-xs text-muted">{item}</div>
                  ))}
                </div>
                <div className="mt-5 grid grid-cols-2 gap-3">
                  <Metric label="Nemo Score" value="94" />
                  <Metric label="Cost" value="$0.03" />
                  <Metric label="Response" value="0.8s" />
                  <Metric label="Automation" value="97%" />
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      <div className="mt-8 rounded-3xl bg-brand p-7 text-white">
        <h2 className="text-2xl font-extrabold text-white">{c.takeaway}</h2>
        <p className="mt-2 max-w-3xl text-white/85">{c.takeawayText}</p>
        <Button to="/pitch" size="sm" className="mt-5 !bg-white !bg-none !text-bg">{c.pitch} <ArrowRight size={15} /></Button>
      </div>
    </div>
  )
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-white/10 bg-white/[0.04] p-3">
      <p className="text-xl font-bold text-text">{value}</p>
      <p className="text-[11px] text-muted">{label}</p>
    </div>
  )
}
