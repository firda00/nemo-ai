import { useMemo, useState } from 'react'
import {
  ArrowRight,
  Bot,
  Boxes,
  BriefcaseBusiness,
  Building2,
  Calculator,
  CalendarCheck,
  ChefHat,
  GraduationCap,
  HardHat,
  HeartPulse,
  Hotel,
  Loader2,
  PackageSearch,
  Scale,
  Search,
  ShieldCheck,
  ShoppingBag,
  Sprout,
  Stethoscope,
  Store,
  Truck,
  UserRoundSearch,
  Utensils,
} from 'lucide-react'
import { Button } from '../../components/ui/Button'
import { useI18n } from '../../i18n'
import { useNavigate } from 'react-router-dom'
import { useAgentStore } from '../../store/useAgentStore'
import { useToast } from '../../components/ui/Toast'
import { createUstudyOperationsTeam } from '../../lib/ustudyTeam'
import { createCommerceTeam, type CommerceTeamKind } from '../../lib/commerceTeams'
import { createIndustryTeam, type IndustryTeamKind } from '../../lib/industryTeams'
import type { LegacyMarketplaceTeamKind } from '../../lib/legacyMarketplaceTeams'

type TemplateCategory = 'all' | 'tourism' | 'sales' | 'commerce' | 'services' | 'operations' | 'people' | 'regulated'
type CopyLang = 'ru' | 'uz' | 'en'

interface TeamTemplate {
  kind: 'agent' | 'team'
  icon: typeof Bot
  title: string
  market: string
  setup: string
  agents: number
  tools: string[]
  desc: string
  category: Exclude<TemplateCategory, 'all'>
  secondaryCategories?: Array<Exclude<TemplateCategory, 'all'>>
  badge?: string
  commerceKey?: CommerceTeamKind
  industryKey?: IndustryTeamKind
  legacyKey?: LegacyMarketplaceTeamKind
}

const templates: TeamTemplate[] = [
  { kind: 'team', icon: Hotel, title: 'Hotel & Tourism Guest Team', market: 'Tourism and hospitality', setup: '8 min', agents: 6, category: 'tourism', badge: 'Saved team · review outputs', tools: ['multilingual guests', 'booking requests', 'itineraries', 'guest tasks', 'reports'], desc: 'A multilingual guest desk for hotels, tours and transfers. It prepares requests and service tasks; availability, price, visa advice, payments and refunds stay under human control.', industryKey: 'hotel-tourism' },
  { kind: 'team', icon: CalendarCheck, title: 'Local Services Team', market: 'Salons, repair, education and services', setup: '7 min', agents: 6, category: 'services', badge: 'Saved team · review outputs', tools: ['intake', 'booking requests', 'reminders', 'handoff', 'reports'], desc: 'Qualifies requests, answers from your knowledge base, prepares appointments and follow-ups, and reports open work. A booking is not confirmed without a calendar or operator.', industryKey: 'local-services' },
  { kind: 'team', icon: Building2, title: 'Real Estate Lead & Viewing Team', market: 'Real estate', setup: '8 min', agents: 6, category: 'sales', badge: 'Saved team · review outputs', tools: ['lead qualification', 'listing match', 'viewing requests', 'CRM', 'pipeline'], desc: 'Matches verified listings to buyer needs and prepares viewing requests and follow-ups. It never invents availability, price, ownership or legal status.', industryKey: 'real-estate' },
  { kind: 'team', icon: BriefcaseBusiness, title: 'B2B Sales & Account Team', market: 'B2B sales', setup: '8 min', agents: 6, category: 'sales', badge: 'Saved team · review outputs', tools: ['qualification', 'offer knowledge', 'follow-up', 'CRM handoff', 'pipeline'], desc: 'Qualifies business buyers and coordinates evidence-based sales follow-up. Discounts, contracts, credit, invoices and deal closure require an authorized person.', industryKey: 'b2b-sales' },
  { kind: 'team', icon: ChefHat, title: 'Restaurant & Catering Team', market: 'Restaurants and events', setup: '8 min', agents: 6, category: 'services', badge: 'Saved team · review outputs', tools: ['menu knowledge', 'reservation requests', 'events', 'prep tasks', 'guest follow-up'], desc: 'Handles guest and catering requests from approved menu and venue data. Capacity, allergy safety, deposits, refunds and custom commitments remain human decisions.', industryKey: 'restaurant-catering' },
  { kind: 'team', icon: UserRoundSearch, title: 'HR Recruiting Coordination Team', market: 'People operations', setup: '9 min', agents: 6, category: 'people', secondaryCategories: ['regulated'], badge: 'Safety beta · Nemo only', tools: ['role intake', 'CV evidence', 'interviews', 'onboarding tasks', 'review report'], desc: 'Structures job-related evidence, schedules interviews and coordinates onboarding. It never hires, rejects or scores people using protected characteristics. Live channels are blocked in this beta.', industryKey: 'hr-recruiting' },
  { kind: 'team', icon: Stethoscope, title: 'Clinic Front Desk Team', market: 'Healthcare administration only', setup: '9 min', agents: 6, category: 'regulated', badge: 'Safety beta · Nemo only', tools: ['service FAQ', 'appointment requests', 'reminders', 'document checklist', 'handoff'], desc: 'Automates only non-clinical front-desk routines. It cannot diagnose, triage clinically, prescribe or recommend treatment; live channels are blocked in this beta.', industryKey: 'clinic-front-desk' },
  { kind: 'team', icon: HardHat, title: 'Construction Procurement Team', market: 'Construction and procurement', setup: '9 min', agents: 6, category: 'operations', badge: 'Saved team · review outputs', tools: ['material requests', 'quote comparison', 'approvals', 'delivery tasks', 'risk report'], desc: 'Structures purchase requests and compares supplied quotes. Specifications, supplier choice, purchase orders, payments and acceptance require authorized approval.', industryKey: 'construction-procurement' },
  { kind: 'team', icon: Sprout, title: 'Agriculture Distribution Team', market: 'Agriculture and distribution', setup: '8 min', agents: 6, category: 'operations', badge: 'Saved team · review outputs', tools: ['dealer leads', 'product knowledge', 'order requests', 'delivery control', 'reports'], desc: 'Coordinates distributor inquiries, supplied stock and delivery data. It never guarantees yield, dosage, inventory, price, credit or regulated-product eligibility.', industryKey: 'agriculture-distribution' },
  { kind: 'team', icon: Calculator, title: 'Accounting & Collections Team', market: 'Finance operations', setup: '9 min', agents: 6, category: 'regulated', badge: 'Safety beta · Nemo only', tools: ['receivables', 'reconciliation', 'reminder drafts', 'collection tasks', 'review report'], desc: 'Analyzes supplied invoice and payment-status data and prepares respectful reminders. It never moves money, files taxes or writes off debt; live channels are blocked in this beta.', industryKey: 'accounting-collections' },
  { kind: 'team', icon: Scale, title: 'Legal Office Coordination Team', market: 'Legal operations', setup: '10 min', agents: 6, category: 'regulated', badge: 'Safety beta · Nemo only', tools: ['matter intake', 'documents', 'research drafts', 'deadlines', 'matter report'], desc: 'Organizes matters, documents, sources and deadlines for lawyer review. It does not give final legal advice or file, sign or settle; live channels are blocked in this beta.', industryKey: 'legal-office' },
  { kind: 'team', icon: ShieldCheck, title: 'Insurance Operations Team', market: 'Insurance operations', setup: '9 min', agents: 6, category: 'regulated', badge: 'Safety beta · Nemo only', tools: ['policy FAQ', 'claim intake', 'documents', 'status follow-up', 'SLA report'], desc: 'Coordinates policy and claim administration from verified records. Coverage, underwriting, denial and payout remain human decisions; live channels are blocked in this beta.', industryKey: 'insurance-operations' },
  { kind: 'agent', icon: Bot, title: 'Course Consultant', market: 'Single Agent', setup: '3 min', agents: 1, category: 'sales', tools: ['test chat', 'knowledge'], desc: 'Standalone course consultant that recommends courses and collects student next actions.' },
  { kind: 'team', icon: GraduationCap, title: 'Sales Team', market: 'Education sales', setup: '6 min', agents: 5, category: 'sales', tools: ['qualification', 'follow-up', 'crm rows'], desc: 'Student leads, follow-ups, CRM-ready rows and daily sales report for IT Academy.', legacyKey: 'sales' },
  { kind: 'team', icon: Building2, title: 'Operations Team', market: 'Education operations', setup: '8 min', agents: 7, category: 'operations', badge: 'Production team', tools: ['payments', 'admin escalation', 'meeting analysis', 'task management', 'reports'], desc: 'Routine admin and operations automation: payment reminders, admin escalation, meeting-to-tasks, weekly follow-up and manager reports.' },
  { kind: 'team', icon: PackageSearch, title: 'Marketplace Seller Team', market: 'Wildberries / Ozon', setup: '7 min', agents: 6, category: 'commerce', badge: 'Data / connector required', tools: ['seller data analysis', 'listing drafts', 'pricing advice', 'seller report'], desc: 'Create an AI seller team for data you provide. WB/Ozon connections are configured separately and remain read-only; marketplace writes are not automated.', commerceKey: 'marketplace' },
  { kind: 'team', icon: Boxes, title: 'Dropshipping Team', market: 'Dropshipping', setup: '8 min', agents: 6, category: 'commerce', badge: 'Data / connector required', tools: ['supplied product data', 'supplier comparison', 'SKU mapping', 'fulfillment tasks'], desc: 'Analyze supplied products and suppliers, protect margin and prepare fulfillment tasks. It never purchases from a supplier automatically.', commerceKey: 'dropshipping' },
  { kind: 'team', icon: Store, title: 'Online Store Team', market: 'E-commerce', setup: '7 min', agents: 6, category: 'commerce', badge: 'Data / connector required', tools: ['sales', 'CRM', 'follow-up', 'uploaded orders', 'content'], desc: 'Create a team for product consultation, leads, supplied order analysis, follow-up and reporting. Store connectors are configured separately.', commerceKey: 'online-store' },
  { kind: 'team', icon: Truck, title: 'Logistics Control Team', market: 'Manual logistics beta', setup: '8 min', agents: 6, category: 'operations', badge: 'Manual analysis beta', tools: ['CSV shipment analysis', 'SLA rules', 'exceptions', 'saved tasks', 'message drafts'], desc: 'Paste shipment rows to detect delays and stale scans, save responsible tasks and prepare drafts. Live carrier tracking and automatic sending are not connected.', commerceKey: 'logistics' },
  { kind: 'team', icon: Building2, title: 'Education Admin Team', market: 'Education ops', setup: '8 min', agents: 6, category: 'operations', tools: ['attendance', 'payments', 'risk report'], desc: 'Attendance, payment reminders, student risk, mentor quality and daily education admin report.', legacyKey: 'education-admin' },
  { kind: 'team', icon: ShoppingBag, title: 'Content Team', market: 'Marketing', setup: '7 min', agents: 5, category: 'services', tools: ['telegram', 'instagram', 'campaigns'], desc: 'Telegram/Instagram posts, course marketing ideas, content calendar and campaign briefs.', legacyKey: 'content' },
  { kind: 'team', icon: HeartPulse, title: 'Student Support Team', market: 'Support', setup: '7 min', agents: 4, category: 'services', tools: ['faq', 'handoff', 'summary'], desc: 'Student questions, FAQ responses, issue triage and human handoff summaries.', legacyKey: 'student-support' },
  { kind: 'team', icon: Utensils, title: 'Custom Team', market: 'Custom workflow', setup: '5 min', agents: 4, category: 'services', tools: ['custom', 'trace', 'results'], desc: 'Describe any repeatable workflow and configure Team Lead plus Specialist Agents.', legacyKey: 'custom' },
]

const categories: Array<{ id: TemplateCategory; label: string }> = [
  { id: 'all', label: 'All teams' },
  { id: 'tourism', label: 'Tourism' },
  { id: 'sales', label: 'Sales' },
  { id: 'commerce', label: 'Commerce' },
  { id: 'services', label: 'Services' },
  { id: 'operations', label: 'Operations' },
  { id: 'people', label: 'People' },
  { id: 'regulated', label: 'Regulated' },
]

type IndustryTemplateCopy = Pick<TeamTemplate, 'title' | 'market' | 'desc' | 'badge'>

const categoryLabels: Record<CopyLang, Record<TemplateCategory, string>> = {
  en: Object.fromEntries(categories.map((item) => [item.id, item.label])) as Record<TemplateCategory, string>,
  ru: { all: 'Все команды', tourism: 'Туризм', sales: 'Продажи', commerce: 'Коммерция', services: 'Услуги', operations: 'Операции', people: 'Персонал', regulated: 'Регулируемые' },
  uz: { all: 'Barcha jamoalar', tourism: 'Turizm', sales: 'Sotuv', commerce: 'Tijorat', services: 'Xizmatlar', operations: 'Operatsiyalar', people: 'Xodimlar', regulated: 'Tartibga solinadigan' },
}

const marketplaceUi: Record<CopyLang, {
  eyebrow: string
  bannerTitle: string
  bannerBody: string
  searchPlaceholder: string
  searchAria: string
  count: (value: number) => string
  empty: string
}> = {
  en: {
    eyebrow: 'AI Team Templates',
    bannerTitle: 'How templates work:',
    bannerBody: 'a saved industry team creates one lead and five specialists. Safety limits are prompt guardrails, not an enforced approval queue yet, so review every result before acting. HR, clinic, accounting, legal and insurance teams run inside Nemo only; live channel connections are blocked in this beta.',
    searchPlaceholder: 'Search by industry or task…',
    searchAria: 'Search AI team templates',
    count: (value) => `${value} teams`,
    empty: 'No matching team yet. Use “Create custom team” and describe the workflow you want.',
  },
  ru: {
    eyebrow: 'Шаблоны AI-команд',
    bannerTitle: 'Как работают шаблоны:',
    bannerBody: 'сохранённая отраслевая команда создаёт одного руководителя и пять специалистов. Ограничения безопасности пока работают как инструкции в промпте, а не как обязательная очередь согласований, поэтому проверяйте каждый результат перед действием. Команды для HR, клиник, бухгалтерии, юристов и страхования работают только внутри Nemo; подключения к внешним каналам в этой бета-версии заблокированы.',
    searchPlaceholder: 'Поиск по отрасли или задаче…',
    searchAria: 'Поиск шаблонов AI-команд',
    count: (value) => `${value} команд`,
    empty: 'Подходящей команды пока нет. Нажмите «Создать свою команду» и опишите нужный процесс.',
  },
  uz: {
    eyebrow: 'AI jamoa shablonlari',
    bannerTitle: 'Shablonlar qanday ishlaydi:',
    bannerBody: 'saqlangan sohaviy jamoa bitta rahbar va beshta mutaxassis yaratadi. Xavfsizlik cheklovlari hozircha majburiy tasdiqlash navbati emas, balki prompt ko‘rsatmalaridir, shuning uchun har bir natijani ishlatishdan oldin tekshiring. HR, klinika, buxgalteriya, yuridik va sug‘urta jamoalari faqat Nemo ichida ishlaydi; bu beta-versiyada tashqi kanallar bloklangan.',
    searchPlaceholder: 'Soha yoki vazifa bo‘yicha qidirish…',
    searchAria: 'AI jamoa shablonlarini qidirish',
    count: (value) => `${value} ta jamoa`,
    empty: 'Mos jamoa hozircha yo‘q. «Maxsus jamoa yaratish»ni tanlab, kerakli jarayonni tasvirlang.',
  },
}

const industryTemplateCopy: Record<'ru' | 'uz', Record<IndustryTeamKind, IndustryTemplateCopy>> = {
  ru: {
    'hotel-tourism': { title: 'Команда для отелей и туризма', market: 'Туризм и гостеприимство', badge: 'Сохранённая команда · проверяйте результаты', desc: 'Многоязычная служба для отелей, туров и трансферов. Готовит запросы гостей и сервисные задачи; наличие мест, цены, визовые рекомендации, платежи и возвраты остаются под контролем человека.' },
    'local-services': { title: 'Команда локальных услуг', market: 'Салоны, ремонт, обучение и услуги', badge: 'Сохранённая команда · проверяйте результаты', desc: 'Уточняет запросы, отвечает по вашей базе знаний, готовит записи и последующие контакты, показывает незакрытую работу. Запись не подтверждается без календаря или оператора.' },
    'real-estate': { title: 'Команда лидов и показов недвижимости', market: 'Недвижимость', badge: 'Сохранённая команда · проверяйте результаты', desc: 'Сопоставляет проверенные объекты с запросами покупателей, готовит заявки на показы и последующие контакты. Не выдумывает наличие, цену, владельца или юридический статус.' },
    'b2b-sales': { title: 'Команда B2B-продаж и клиентов', market: 'B2B-продажи', badge: 'Сохранённая команда · проверяйте результаты', desc: 'Квалифицирует корпоративных покупателей и координирует продажи на основе подтверждённых данных. Скидки, договоры, кредит, счета и закрытие сделки требуют уполномоченного сотрудника.' },
    'restaurant-catering': { title: 'Команда ресторана и кейтеринга', market: 'Рестораны и мероприятия', badge: 'Сохранённая команда · проверяйте результаты', desc: 'Обрабатывает запросы гостей и кейтеринга по утверждённым данным меню и площадки. Вместимость, безопасность при аллергиях, депозиты, возвраты и особые обязательства решает человек.' },
    'hr-recruiting': { title: 'Команда координации найма', market: 'HR-операции', badge: 'Безопасная бета · только Nemo', desc: 'Структурирует данные о кандидатах, планирует интервью и координирует адаптацию. Не нанимает, не отклоняет и не оценивает людей по защищённым характеристикам. Внешние каналы в этой бета-версии заблокированы.' },
    'clinic-front-desk': { title: 'Команда регистратуры клиники', market: 'Только административные процессы клиники', badge: 'Безопасная бета · только Nemo', desc: 'Автоматизирует только неклинические задачи регистратуры. Не ставит диагноз, не проводит медицинскую сортировку, не назначает и не рекомендует лечение; внешние каналы заблокированы.' },
    'construction-procurement': { title: 'Команда строительных закупок', market: 'Строительство и закупки', badge: 'Сохранённая команда · проверяйте результаты', desc: 'Структурирует заявки на закупку и сравнивает предоставленные предложения. Спецификации, выбор поставщика, заказы, оплаты и приёмка требуют подтверждения уполномоченного сотрудника.' },
    'agriculture-distribution': { title: 'Команда агродистрибуции', market: 'Сельское хозяйство и дистрибуция', badge: 'Сохранённая команда · проверяйте результаты', desc: 'Координирует запросы дилеров, предоставленные данные об остатках и доставке. Не гарантирует урожайность, дозировку, наличие, цену, кредит или допуск регулируемой продукции.' },
    'accounting-collections': { title: 'Команда бухгалтерии и взыскания', market: 'Финансовые операции', badge: 'Безопасная бета · только Nemo', desc: 'Анализирует предоставленные счета и статусы оплат, готовит корректные напоминания. Не переводит деньги, не подаёт налоговую отчётность и не списывает долги; внешние каналы заблокированы.' },
    'legal-office': { title: 'Команда координации юридического офиса', market: 'Юридические операции', badge: 'Безопасная бета · только Nemo', desc: 'Организует дела, документы, источники и сроки для проверки юристом. Не даёт окончательных юридических советов, не подаёт и не подписывает документы и не заключает соглашения; внешние каналы заблокированы.' },
    'insurance-operations': { title: 'Команда страховых операций', market: 'Страховые операции', badge: 'Безопасная бета · только Nemo', desc: 'Координирует администрирование полисов и заявлений по проверенным данным. Покрытие, андеррайтинг, отказ и выплата остаются решениями человека; внешние каналы заблокированы.' },
  },
  uz: {
    'hotel-tourism': { title: 'Mehmonxona va turizm jamoasi', market: 'Turizm va mehmondo‘stlik', badge: 'Saqlangan jamoa · natijalarni tekshiring', desc: 'Mehmonxona, tur va transferlar uchun ko‘p tilli xizmat. Mehmon so‘rovlari va xizmat vazifalarini tayyorlaydi; mavjudlik, narx, viza tavsiyasi, to‘lov va qaytarish inson nazoratida qoladi.' },
    'local-services': { title: 'Mahalliy xizmatlar jamoasi', market: 'Salon, ta’mir, ta’lim va xizmatlar', badge: 'Saqlangan jamoa · natijalarni tekshiring', desc: 'So‘rovlarni aniqlashtiradi, bilim bazangizdan javob beradi, yozilish va keyingi aloqalarni tayyorlaydi hamda ochiq ishlarni ko‘rsatadi. Kalendar yoki operator bo‘lmasa, yozilish tasdiqlanmaydi.' },
    'real-estate': { title: 'Ko‘chmas mulk lidlari va ko‘rish jamoasi', market: 'Ko‘chmas mulk', badge: 'Saqlangan jamoa · natijalarni tekshiring', desc: 'Tekshirilgan obyektlarni xaridor ehtiyojiga moslaydi, ko‘rish so‘rovlari va keyingi aloqalarni tayyorlaydi. Mavjudlik, narx, egalik yoki huquqiy holatni o‘ylab topmaydi.' },
    'b2b-sales': { title: 'B2B sotuv va mijozlar jamoasi', market: 'B2B sotuv', badge: 'Saqlangan jamoa · natijalarni tekshiring', desc: 'Biznes xaridorlarini saralaydi va tasdiqlangan ma’lumotlarga asoslangan sotuv aloqalarini muvofiqlashtiradi. Chegirma, shartnoma, kredit, hisob va bitimni yopish vakolatli xodimni talab qiladi.' },
    'restaurant-catering': { title: 'Restoran va keytering jamoasi', market: 'Restoranlar va tadbirlar', badge: 'Saqlangan jamoa · natijalarni tekshiring', desc: 'Tasdiqlangan menyu va joy ma’lumotlari asosida mehmon hamda keytering so‘rovlarini bajaradi. Sig‘im, allergiya xavfsizligi, depozit, qaytarish va maxsus majburiyatlarni inson hal qiladi.' },
    'hr-recruiting': { title: 'Ishga qabulni muvofiqlashtirish jamoasi', market: 'HR operatsiyalari', badge: 'Xavfsiz beta · faqat Nemo', desc: 'Nomzodlar haqidagi dalillarni tartiblaydi, suhbatlarni rejalashtiradi va moslashuvni muvofiqlashtiradi. Himoyalangan belgilar asosida ishga olmaydi, rad etmaydi yoki baholamaydi. Bu beta-versiyada tashqi kanallar bloklangan.' },
    'clinic-front-desk': { title: 'Klinika registraturasi jamoasi', market: 'Faqat klinika ma’muriyati', badge: 'Xavfsiz beta · faqat Nemo', desc: 'Faqat klinik bo‘lmagan registratura ishlarini avtomatlashtiradi. Tashxis qo‘ymaydi, klinik saralash qilmaydi, davolash buyurmaydi yoki tavsiya etmaydi; tashqi kanallar bloklangan.' },
    'construction-procurement': { title: 'Qurilish xaridlari jamoasi', market: 'Qurilish va xaridlar', badge: 'Saqlangan jamoa · natijalarni tekshiring', desc: 'Xarid so‘rovlarini tartiblaydi va taqdim etilgan takliflarni solishtiradi. Texnik talab, yetkazib beruvchini tanlash, buyurtma, to‘lov va qabul vakolatli tasdiqni talab qiladi.' },
    'agriculture-distribution': { title: 'Agrodistribyutsiya jamoasi', market: 'Qishloq xo‘jaligi va distribyutsiya', badge: 'Saqlangan jamoa · natijalarni tekshiring', desc: 'Diler so‘rovlari, taqdim etilgan qoldiq va yetkazib berish ma’lumotlarini muvofiqlashtiradi. Hosildorlik, doza, mavjudlik, narx, kredit yoki tartibga solinadigan mahsulotga ruxsatni kafolatlamaydi.' },
    'accounting-collections': { title: 'Buxgalteriya va undirish jamoasi', market: 'Moliyaviy operatsiyalar', badge: 'Xavfsiz beta · faqat Nemo', desc: 'Taqdim etilgan hisob va to‘lov holatini tahlil qiladi, hurmatli eslatmalar tayyorlaydi. Pul o‘tkazmaydi, soliq topshirmaydi va qarzni hisobdan chiqarmaydi; tashqi kanallar bloklangan.' },
    'legal-office': { title: 'Yuridik ofisni muvofiqlashtirish jamoasi', market: 'Yuridik operatsiyalar', badge: 'Xavfsiz beta · faqat Nemo', desc: 'Yurist tekshiruvi uchun ishlar, hujjatlar, manbalar va muddatlarni tartiblaydi. Yakuniy huquqiy maslahat bermaydi, hujjat topshirmaydi yoki imzolamaydi va kelishuv tuzmaydi; tashqi kanallar bloklangan.' },
    'insurance-operations': { title: 'Sug‘urta operatsiyalari jamoasi', market: 'Sug‘urta operatsiyalari', badge: 'Xavfsiz beta · faqat Nemo', desc: 'Tekshirilgan yozuvlar asosida polis va da’volarni boshqarishni muvofiqlashtiradi. Qamrov, anderrayting, rad etish va to‘lov inson qarori bo‘lib qoladi; tashqi kanallar bloklangan.' },
  },
}

function localizeTemplate(template: TeamTemplate, lang: CopyLang): TeamTemplate {
  if (lang === 'en' || !template.industryKey) return template
  return { ...template, ...industryTemplateCopy[lang][template.industryKey] }
}

export default function MarketplacePage() {
  const { t, lang } = useI18n()
  const copyLang: CopyLang = lang === 'ru' ? 'ru' : lang === 'uz' ? 'uz' : 'en'
  const ui = marketplaceUi[copyLang]
  const navigate = useNavigate()
  const addAgent = useAgentStore((s) => s.addAgent)
  const deleteAgent = useAgentStore((s) => s.deleteAgent)
  const toast = useToast()
  const [seeding, setSeeding] = useState('')
  const [query, setQuery] = useState('')
  const [category, setCategory] = useState<TemplateCategory>('all')

  const visibleTemplates = useMemo(() => {
    const search = query.trim().toLowerCase()
    return templates.filter((tpl) => {
      if (category !== 'all' && tpl.category !== category && !tpl.secondaryCategories?.includes(category)) return false
      if (!search) return true
      const localized = localizeTemplate(tpl, copyLang)
      return `${localized.title} ${localized.market} ${localized.desc} ${tpl.tools.join(' ')}`.toLowerCase().includes(search)
    })
  }, [category, copyLang, query])

  const applyTemplate = async (tpl: TeamTemplate) => {
    if (tpl.kind === 'agent') {
      localStorage.setItem('nemo-selected-agent-template', JSON.stringify({
        name: tpl.title,
        type: 'qualifier',
        role: 'AI course consultant for IT Academy',
        tasks: tpl.desc,
        tone: 'Friendly, practical, admissions-focused.',
      }))
      navigate('/app/create-agent')
      return
    }
    // Operations Team — create the REAL team (lead agent + department + 6 sub-agents)
    if (tpl.title === 'Operations Team') {
      setSeeding(tpl.title)
      try {
        const res = await createUstudyOperationsTeam(addAgent, deleteAgent)
        if (!res.error && res.agentId && res.departmentId) navigate(`/app/teams/${res.agentId}`)
        else toast(res.error ?? 'Could not create the complete team', 'error')
      } catch (error) {
        toast(error instanceof Error ? error.message : 'Could not create the complete team', 'error')
      } finally {
        setSeeding('')
      }
      return
    }
    if (tpl.commerceKey) {
      setSeeding(tpl.title)
      try {
        const res = await createCommerceTeam(tpl.commerceKey, addAgent, deleteAgent)
        if (!res.error && res.agentId && res.departmentId) navigate(`/app/teams/${res.agentId}`)
        else toast(res.error ?? 'Could not create the complete team', 'error')
      } catch (error) {
        toast(error instanceof Error ? error.message : 'Could not create the complete team', 'error')
      } finally {
        setSeeding('')
      }
      return
    }
    if (tpl.industryKey) {
      setSeeding(tpl.title)
      try {
        const localized = localizeTemplate(tpl, copyLang)
        const res = await createIndustryTeam(tpl.industryKey, addAgent, deleteAgent, { name: localized.title, niche: localized.market })
        if (!res.error && res.agentId && res.departmentId) navigate(`/app/teams/${res.agentId}`)
        else toast(res.error ?? 'Could not create the complete team', 'error')
      } catch (error) {
        toast(error instanceof Error ? error.message : 'Could not create the complete team', 'error')
      } finally {
        setSeeding('')
      }
      return
    }
    if (!tpl.legacyKey) {
      toast('This team template is not configured yet', 'error')
      return
    }
    const type = tpl.legacyKey === 'student-support' ? 'support' : tpl.legacyKey
    localStorage.setItem('nemo-selected-template', JSON.stringify({
      teamName: tpl.title,
      teamType: type,
      legacyKey: tpl.legacyKey,
      goal: tpl.desc,
      tools: tpl.tools,
      template: tpl.title,
      selectedAt: new Date().toISOString(),
    }))
    navigate('/app/create-team')
  }

  return (
    <div className="container-page max-w-7xl py-8">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="mono-label">{ui.eyebrow}</p>
          <h1 className="mt-2 text-3xl font-extrabold text-text">{t('marketplacePage.title')}</h1>
          <p className="mt-2 max-w-2xl text-sm leading-relaxed text-muted">{t('marketplacePage.subtitle')}</p>
        </div>
        <Button to="/app/create-team">{t('marketplacePage.custom')}</Button>
      </div>

      <div className="mt-7 rounded-2xl border border-cyan/20 bg-cyan/[0.06] p-4 text-sm leading-relaxed text-muted">
        <span className="font-semibold text-text">{ui.bannerTitle}</span> {ui.bannerBody}
      </div>

      <div className="mt-5 space-y-3">
        <div className="relative max-w-xl">
          <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={ui.searchPlaceholder}
            aria-label={ui.searchAria}
            className="h-11 w-full rounded-xl border border-ice/[0.1] bg-white/[0.04] pl-10 pr-4 text-sm text-text outline-none transition placeholder:text-muted focus:border-cyan/40"
          />
        </div>
        <div className="flex flex-wrap gap-2">
          {categories.map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => setCategory(item.id)}
              className={`rounded-pill border px-3 py-1.5 text-xs transition ${category === item.id ? 'border-cyan/40 bg-cyan/15 text-cyan' : 'border-ice/[0.1] bg-white/[0.03] text-muted hover:text-text'}`}
            >
              {categoryLabels[copyLang][item.id]}
            </button>
          ))}
          <span className="ml-auto self-center text-xs text-muted">{ui.count(visibleTemplates.length)}</span>
        </div>
      </div>

      <div className="mt-8 grid gap-5 md:grid-cols-2 xl:grid-cols-3">
        {visibleTemplates.map((tpl) => {
          const display = localizeTemplate(tpl, copyLang)
          return <div key={tpl.title} className="card flex flex-col rounded-3xl p-6">
            <div className="flex items-start justify-between gap-3">
              <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-violet/15 text-violet"><tpl.icon size={22} /></span>
              <span className="rounded-pill border border-amber/25 bg-amber/10 px-3 py-1 text-xs font-medium text-amber">{display.badge ?? (tpl.kind === 'agent' ? 'Single agent' : 'AI blueprint')}</span>
            </div>
            <h2 className="mt-5 text-xl font-bold text-text">{display.title}</h2>
            <p className="mt-1 text-xs uppercase tracking-[0.14em] text-muted">{display.market} · {tpl.agents} {t('marketplacePage.agents')}</p>
            <p className="mt-4 flex-1 text-sm leading-relaxed text-muted">{display.desc}</p>
            <div className="mt-5 grid grid-cols-3 gap-2 text-center">
              <Mini label={t('marketplacePage.status')} value={t('mvp.templates.ready')} />
              <Mini label={t('marketplacePage.setup')} value={tpl.setup} />
              <Mini label={t('marketplacePage.type')} value={t('mvp.templates.vertical')} />
            </div>
            <div className="mt-4 flex flex-wrap gap-1.5">
              {tpl.tools.map((tool) => <span key={tool} className="rounded-pill border border-cyan/20 bg-cyan/10 px-2 py-0.5 text-[10px] text-cyan">{tool}</span>)}
            </div>
            <Button onClick={() => applyTemplate(tpl)} disabled={!!seeding} size="sm" className="mt-5">
              {seeding === tpl.title ? <><Loader2 size={15} className="animate-spin" /> …</> : <>{t('marketplacePage.use')} <ArrowRight size={15} /></>}
            </Button>
          </div>
        })}
      </div>
      {!visibleTemplates.length && (
        <div className="mt-8 rounded-3xl border border-dashed border-ice/[0.12] p-10 text-center text-sm text-muted">
          {ui.empty}
        </div>
      )}
    </div>
  )
}

function Mini({ label, value }: { label: string; value: string }) {
  return <div className="rounded-xl border border-white/10 bg-white/[0.04] p-2"><p className="font-bold text-text">{value}</p><p className="text-[10px] text-muted">{label}</p></div>
}
