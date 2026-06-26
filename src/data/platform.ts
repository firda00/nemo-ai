import type {
  AgentKind,
  AgentPrompt,
  Dialogue,
  LLMModelOption,
  ModelProvider,
  PlatformAgent,
  Template,
} from '../types/platform'

// FREE models only (OpenRouter ":free" tier) — zero cost. Grouped by company.
// Keep in sync with the FREE_MODEL constants in the edge functions.
export const PROVIDERS: ModelProvider[] = [
  {
    id: 'google',
    name: 'Google · Gemma',
    models: [
      { id: 'google/gemma-4-31b-it:free', label: 'Gemma 4 31B (free)', tokenRate: 0 },
      { id: 'google/gemma-4-26b-a4b-it:free', label: 'Gemma 4 26B (free)', tokenRate: 0 },
    ],
  },
  {
    id: 'meta-llama',
    name: 'Meta · Llama',
    models: [{ id: 'meta-llama/llama-3.3-70b-instruct:free', label: 'Llama 3.3 70B (free)', tokenRate: 0 }],
  },
  {
    id: 'qwen',
    name: 'Qwen',
    models: [{ id: 'qwen/qwen3-next-80b-a3b-instruct:free', label: 'Qwen3 80B (free)', tokenRate: 0 }],
  },
  {
    id: 'nousresearch',
    name: 'Nous · Hermes',
    models: [{ id: 'nousresearch/hermes-3-llama-3.1-405b:free', label: 'Hermes 3 405B (free)', tokenRate: 0 }],
  },
]

// Flat list + lookups (back-compat for label/vendor by id).
export const MODELS: LLMModelOption[] = PROVIDERS.flatMap((p) =>
  p.models.map((m) => ({ id: m.id, label: m.label, vendor: p.name, tokenRate: m.tokenRate })),
)
export const findModel = (id: string) => MODELS.find((m) => m.id === id)
export const providerOf = (id: string) => PROVIDERS.find((p) => p.models.some((m) => m.id === id))

// Common presets (Central Asia / CIS first, then global). The timezone field is
// a free-text input backed by this <datalist>, so any IANA zone can be typed in.
export const TIMEZONES = [
  'Asia/Tashkent',
  'Asia/Samarkand',
  'Asia/Almaty',
  'Asia/Bishkek',
  'Asia/Dushanbe',
  'Asia/Ashgabat',
  'Asia/Baku',
  'Asia/Tbilisi',
  'Asia/Yerevan',
  'Asia/Dubai',
  'Asia/Istanbul',
  'Asia/Karachi',
  'Europe/Moscow',
  'Europe/Kyiv',
  'Europe/Minsk',
  'Europe/London',
  'Europe/Berlin',
  'Europe/Warsaw',
  'America/New_York',
  'America/Los_Angeles',
  'UTC',
]

// Detailed-settings datalist suggestions (free text — any value can be typed in).
export const COUNTRIES = [
  'Узбекистан', 'Россия', 'Казахстан', 'Кыргызстан', 'Таджикистан', 'Туркменистан',
  'Азербайджан', 'Турция', 'ОАЭ', 'США', 'Германия', 'Великобритания',
]
export const NICHES = [
  'Образование', 'E-commerce', 'Недвижимость', 'Медицина', 'Финансы', 'Рестораны',
  'Туризм', 'Авто', 'Бьюти', 'Логистика', 'IT / SaaS', 'Производство',
]

// Default prompt scaffold applied when a NEW agent kind is picked (so each type
// behaves like a sensible preset). The built-in AI can still rewrite it.
export const kindPresets: Partial<Record<AgentKind, AgentPrompt>> = {
  coder: {
    role: 'Ты — опытный инженер-программист.',
    tasks: 'Пиши и правь код по задаче, объясняй решения, предлагай тесты и улучшения.',
    tone: 'Чёткий, технический, по делу.',
    rules: 'Показывай готовый код блоками. Не выдумывай API — уточняй, если данных мало.',
  },
  content: {
    role: 'Ты — контент-маркетолог и копирайтер.',
    tasks: 'Создавай тексты, посты и описания под задачу и аудиторию; предлагай варианты.',
    tone: 'Живой, убедительный, в стиле бренда.',
    rules: 'Без воды. Соблюдай факты. Предлагай 2–3 варианта, когда уместно.',
  },
  learning: {
    role: 'Ты — ассистент, который учится на каждом диалоге.',
    tasks: 'Помогай пользователю, запоминай важные детали и применяй их в следующих ответах.',
    tone: 'Дружелюбный, внимательный.',
    rules: 'Опирайся на память о прошлых диалогах. Не переспрашивай уже выясненное.',
  },
}

export const templates: Template[] = [
  {
    id: 'sales',
    industry: 'sales',
    name: { uz: 'Sotuv menejeri', ru: 'Менеджер продаж', en: 'Sales manager' },
    description: {
      uz: 'Mahsulotni taklif qiladi, e’tirozlar bilan ishlaydi, buyurtmaga olib keladi.',
      ru: 'Предлагает продукт, работает с возражениями, доводит до заказа.',
      en: 'Pitches the product, handles objections, drives to an order.',
    },
    color: 'violet',
    preset: {
      role: 'Siz tajribali sotuv menejerisiz.',
      tasks: 'Mijoz ehtiyojini aniqlang, mos mahsulotni taklif qiling, buyurtmani rasmiylashtiring.',
      tone: 'Do‘stona, ishonchli, bosim o‘tkazmasdan.',
      rules: 'Narxni faqat so‘ralganda ayting. Noaniq bo‘lsa aniqlovchi savol bering.',
    },
  },
  {
    id: 'qualifier',
    industry: 'sales',
    name: { uz: 'Lead kvalifikatori', ru: 'Квалификатор лидов', en: 'Lead qualifier' },
    description: {
      uz: 'Murojaatlarni saralaydi va sifatli leadlarni operatorga uzatadi.',
      ru: 'Отбирает обращения и передаёт качественные лиды оператору.',
      en: 'Filters inquiries and passes qualified leads to an operator.',
    },
    color: 'blue',
    preset: {
      role: 'Siz lead kvalifikatsiya bo‘yicha yordamchisiz.',
      tasks: 'Byudjet, ehtiyoj va muddatni aniqlang; mos leadni belgilab oping.',
      tone: 'Qisqa, aniq, hurmatli.',
      rules: 'Uchta asosiy savoldan oshmang. Mos kelmasa muloyim yakunlang.',
    },
  },
  {
    id: 'support',
    industry: 'support',
    name: { uz: 'Qo‘llab-quvvatlash', ru: 'Поддержка', en: 'Support' },
    description: {
      uz: 'Tez-tez beriladigan savollarga javob beradi, muammolarni hal qiladi.',
      ru: 'Отвечает на частые вопросы, решает проблемы клиентов.',
      en: 'Answers frequent questions and resolves customer issues.',
    },
    color: 'teal',
    preset: {
      role: 'Siz mijozlarni qo‘llab-quvvatlash agentisiz.',
      tasks: 'Savollarga aniq javob bering, muammoni hal qiling yoki operatorga uzating.',
      tone: 'Sabrli, yordamchi, ijobiy.',
      rules: 'Bilim bazasiga tayaning. Aniq bo‘lmasa operatorni chaqiring.',
    },
  },
  {
    id: 'consultant',
    industry: 'consulting',
    name: { uz: 'Maslahatchi', ru: 'Консультант', en: 'Consultant' },
    description: {
      uz: 'Xizmatlar bo‘yicha batafsil maslahat beradi va yo‘naltiradi.',
      ru: 'Даёт подробную консультацию по услугам и направляет.',
      en: 'Gives detailed advice about services and guides customers.',
    },
    color: 'cyan',
    preset: {
      role: 'Siz soha bo‘yicha maslahatchisiz.',
      tasks: 'Mijozga mos yechimni tushuntiring, afzalliklarni ko‘rsating.',
      tone: 'Ekspert, ammo sodda tilda.',
      rules: 'Haddan tashqari texnik bo‘lmang. Misollar keltiring.',
    },
  },
  {
    id: 'reception',
    industry: 'admin',
    name: { uz: 'Administrator', ru: 'Администратор', en: 'Administrator' },
    description: {
      uz: 'Yozilish/bron qabul qiladi, ish vaqti va manzilni aytadi.',
      ru: 'Принимает записи/брони, сообщает часы работы и адрес.',
      en: 'Takes bookings, tells working hours and address.',
    },
    color: 'amber',
    preset: {
      role: 'Siz qabul administratorisiz.',
      tasks: 'Yozilishni rasmiylashtiring, ish vaqti va manzilni ayting.',
      tone: 'Muloyim, tartibli.',
      rules: 'Sana va vaqtni tasdiqlang. Band bo‘lsa muqobil taklif qiling.',
    },
  },
]

const emptyLeadForm = {
  enabled: false,
  fields: [
    { id: 'f1', label: 'Ism', type: 'text' as const, required: true },
    { id: 'f2', label: 'Telefon', type: 'phone' as const, required: true },
  ],
  trigger: 'qiziqish bildirilganda',
  destination: 'table' as const,
}

export const seedAgents: PlatformAgent[] = [
  {
    id: 'ag_sales',
    name: 'Sotuv menejeri',
    type: 'chat',
    avatarColor: 'violet',
    role: 'Sotuv',
    prompt: templates[0].preset,
    model: 'google/gemma-4-31b-it:free',
    temperature: 0.6,
    timezone: 'Asia/Tashkent',
    schedule: '24/7',
    language: 'auto',
    status: 'active',
    channels: ['telegram', 'widget'],
    knowledge: [
      { id: 'k1', name: 'Katalog_2026.pdf', source: 'file', status: 'indexed', size: '2.4 MB' },
      { id: 'k2', name: 'Narxlar va aksiyalar', source: 'faq', status: 'indexed', size: '18 ta' },
    ],
    leadForm: { ...emptyLeadForm, enabled: true },
    lastActivity: '2 daqiqa oldin',
    dialoguesToday: 34,
  },
  {
    id: 'ag_support',
    name: 'Qo‘llab-quvvatlash',
    type: 'chat',
    avatarColor: 'teal',
    role: 'Support',
    prompt: templates[2].preset,
    model: 'meta-llama/llama-3.3-70b-instruct:free',
    temperature: 0.4,
    timezone: 'Asia/Tashkent',
    schedule: '24/7',
    language: 'auto',
    status: 'active',
    channels: ['whatsapp', 'instagram'],
    knowledge: [{ id: 'k3', name: 'help.example.uz', source: 'link', status: 'indexed', size: '—' }],
    leadForm: emptyLeadForm,
    lastActivity: '14 daqiqa oldin',
    dialoguesToday: 21,
  },
  {
    id: 'ag_qualifier',
    name: 'Lead kvalifikatori',
    type: 'qualifier',
    avatarColor: 'blue',
    role: 'Sotuv',
    prompt: templates[1].preset,
    model: 'qwen/qwen3-next-80b-a3b-instruct:free',
    temperature: 0.5,
    timezone: 'Asia/Tashkent',
    schedule: 'work-hours',
    language: 'auto',
    status: 'paused',
    channels: ['telegram'],
    knowledge: [],
    leadForm: { ...emptyLeadForm, enabled: true },
    lastActivity: '3 soat oldin',
    dialoguesToday: 0,
  },
]

export const mockDialogues: Dialogue[] = [
  {
    id: 'd1',
    agentId: 'ag_sales',
    channel: 'telegram',
    customerName: 'Jahongir',
    customerContact: '@jahongir',
    status: 'open',
    tags: ['qiziqish', 'narx'],
    operatorTakeover: false,
    unread: 2,
    updatedAt: '14:32',
    messages: [
      { id: 'm1', author: 'customer', content: 'Salom, kurslar narxini bilsam bo‘ladimi?', time: '14:30' },
      { id: 'm2', author: 'agent', content: 'Albatta! Qaysi yo‘nalish qiziqtiradi — dasturlash, dizayn yoki marketing?', time: '14:30' },
      { id: 'm3', author: 'customer', content: 'Dasturlash', time: '14:31' },
      { id: 'm4', author: 'agent', content: 'Dasturlash kursi oyiga 1 200 000 so‘m. Hozir chegirma ham bor. Batafsil yuboraymi?', time: '14:31' },
      { id: 'm5', author: 'customer', content: 'Ha, yuboring', time: '14:32' },
    ],
  },
  {
    id: 'd2',
    agentId: 'ag_support',
    channel: 'whatsapp',
    customerName: 'Malika',
    customerContact: '+998 90 123 45 67',
    status: 'needs_operator',
    tags: ['shikoyat'],
    operatorTakeover: true,
    unread: 0,
    updatedAt: '13:58',
    messages: [
      { id: 'm1', author: 'customer', content: 'To‘lov o‘tdi lekin kurs ochilmadi', time: '13:55' },
      { id: 'm2', author: 'agent', content: 'Uzr so‘rayman. Tranzaksiya raqamini yuboring, tekshiramiz.', time: '13:55' },
      { id: 'm3', author: 'customer', content: 'TX99201', time: '13:56' },
      { id: 'm4', author: 'operator', content: 'Salom, men operator Sevara. Hozir qo‘lda tekshiryapman, bir daqiqa.', time: '13:58' },
    ],
  },
  {
    id: 'd3',
    agentId: 'ag_sales',
    channel: 'widget',
    customerName: 'Aziz',
    customerContact: 'sayt mehmoni',
    status: 'resolved',
    tags: ['buyurtma'],
    operatorTakeover: false,
    unread: 0,
    updatedAt: '12:40',
    messages: [
      { id: 'm1', author: 'customer', content: 'Dizayn kursiga yozilmoqchiman', time: '12:38' },
      { id: 'm2', author: 'agent', content: 'Ajoyib tanlov! Ism va telefon raqamingizni qoldiring, menejer bog‘lanadi.', time: '12:38' },
      { id: 'm3', author: 'customer', content: 'Aziz, +998 91 222 33 44', time: '12:39' },
      { id: 'm4', author: 'agent', content: 'Rahmat, Aziz! Arizangiz qabul qilindi. Tez orada bog‘lanamiz. ✅', time: '12:40' },
    ],
  },
  {
    id: 'd4',
    agentId: 'ag_support',
    channel: 'instagram',
    customerName: 'Nodira',
    customerContact: '@nodira.uz',
    status: 'open',
    tags: ['savol'],
    operatorTakeover: false,
    unread: 1,
    updatedAt: '11:20',
    messages: [
      { id: 'm1', author: 'customer', content: 'Dars jadvali qanaqa?', time: '11:19' },
      { id: 'm2', author: 'agent', content: 'Dushanba, chorshanba, juma — 18:00 dan 20:00 gacha. Sizga qulaymi?', time: '11:20' },
    ],
  },
  {
    id: 'd5',
    agentId: 'ag_sales',
    channel: 'telegram',
    customerName: 'Bekzod',
    customerContact: '@bekzod',
    status: 'error',
    tags: [],
    operatorTakeover: false,
    unread: 0,
    updatedAt: '10:05',
    messages: [
      { id: 'm1', author: 'customer', content: 'Aksiya bormi?', time: '10:04' },
      { id: 'm2', author: 'agent', content: '⚠️ Javob yuborishda xatolik (token limiti).', time: '10:05' },
    ],
  },
]

// analytics aggregates (mock)
export const analytics = {
  metrics: {
    dialogues: 412,
    avgResponseSec: 2.4,
    resolvedPct: 78,
    leadConvPct: 31,
    satisfaction: 4.6,
  },
  // 14-day dialogue volume
  daily: [18, 24, 21, 30, 27, 35, 40, 33, 38, 44, 41, 50, 47, 53],
  channels: [
    { channel: 'telegram', value: 47 },
    { channel: 'whatsapp', value: 28 },
    { channel: 'instagram', value: 16 },
    { channel: 'widget', value: 9 },
  ],
  funnel: [
    { label: 'dialogues', value: 412 },
    { label: 'qualified', value: 198 },
    { label: 'leads', value: 128 },
    { label: 'orders', value: 54 },
  ],
}
