import type {
  AgentKind,
  AgentPrompt,
  Dialogue,
  LLMModelOption,
  ModelProvider,
  PlatformAgent,
  Template,
} from '../types/platform'
import type { Lang } from '../types'

// Model catalog. FREE + efficient models are open to every plan; models flagged `premium:true`
// are gated to Pro+ (the server enforces this via gateModel() — a non-premium plan is silently
// downgraded to the cheap primary). Set PREMIUM_ENABLED=false to hide the whole premium block.
// Model ids verified against the live OpenRouter catalog (Jul 2026).
export const PREMIUM_ENABLED = true

export const PROVIDERS: ModelProvider[] = [
  {
    id: 'openai',
    name: 'OpenAI',
    models: [
      { id: 'openai/gpt-4o-mini', label: 'GPT-4o mini · reliable', tokenRate: 1 },
      { id: 'openai/gpt-5.4-mini', label: 'GPT-5.4 mini · fast', tokenRate: 2 },
      { id: 'openai/gpt-4o', label: 'GPT-4o', tokenRate: 4, premium: true },
      { id: 'openai/gpt-5.5', label: 'GPT-5.5 · frontier', tokenRate: 6, premium: true },
    ],
  },
  {
    id: 'anthropic',
    name: 'Anthropic · Claude',
    models: [
      { id: 'anthropic/claude-3.5-sonnet', label: 'Claude 3.5 Sonnet', tokenRate: 4, premium: true },
      { id: 'anthropic/claude-sonnet-5', label: 'Claude Sonnet 5', tokenRate: 5, premium: true },
      { id: 'anthropic/claude-opus-4.8', label: 'Claude Opus 4.8 · max', tokenRate: 8, premium: true },
    ],
  },
  {
    id: 'google-gemini',
    name: 'Google · Gemini',
    models: [
      { id: 'google/gemini-flash-1.5', label: 'Gemini Flash 1.5', tokenRate: 1 },
      { id: 'google/gemini-3.1-flash-lite', label: 'Gemini 3.1 Flash Lite', tokenRate: 1 },
      { id: 'google/gemini-3.5-flash', label: 'Gemini 3.5 Flash', tokenRate: 2 },
    ],
  },
  {
    id: 'deepseek',
    name: 'DeepSeek',
    models: [
      { id: 'deepseek/deepseek-v4-flash', label: 'DeepSeek V4 Flash · cheap', tokenRate: 1 },
      { id: 'deepseek/deepseek-v4-pro', label: 'DeepSeek V4 Pro', tokenRate: 3, premium: true },
    ],
  },
  {
    id: 'qwen',
    name: 'Qwen',
    models: [
      { id: 'qwen/qwen3-next-80b-a3b-instruct:free', label: 'Qwen3 80B (free)', tokenRate: 0 },
      { id: 'qwen/qwen3.7-plus', label: 'Qwen3.7 Plus', tokenRate: 2 },
      { id: 'qwen/qwen3.7-max', label: 'Qwen3.7 Max', tokenRate: 3, premium: true },
    ],
  },
  {
    id: 'zai',
    name: 'Z.ai · GLM',
    models: [{ id: 'z-ai/glm-5.2', label: 'GLM 5.2', tokenRate: 2 }],
  },
  {
    id: 'google',
    name: 'Google · Gemma (free)',
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
export const COUNTRIES: Record<Lang, string[]> = {
  uz: ['O‘zbekiston', 'Rossiya', 'Qozog‘iston', 'Qirg‘iziston', 'Tojikiston', 'Turkmaniston',
    'Ozarbayjon', 'Turkiya', 'BAA', 'AQSH', 'Germaniya', 'Buyuk Britaniya'],
  ru: ['Узбекистан', 'Россия', 'Казахстан', 'Кыргызстан', 'Таджикистан', 'Туркменистан',
    'Азербайджан', 'Турция', 'ОАЭ', 'США', 'Германия', 'Великобритания'],
  en: ['Uzbekistan', 'Russia', 'Kazakhstan', 'Kyrgyzstan', 'Tajikistan', 'Turkmenistan',
    'Azerbaijan', 'Turkey', 'UAE', 'USA', 'Germany', 'United Kingdom'],
}
export const NICHES: Record<Lang, string[]> = {
  uz: ['Ta’lim', 'E-commerce', 'Ko‘chmas mulk', 'Tibbiyot', 'Moliya', 'Restoranlar',
    'Turizm', 'Avto', 'Go‘zallik', 'Logistika', 'IT / SaaS', 'Ishlab chiqarish'],
  ru: ['Образование', 'E-commerce', 'Недвижимость', 'Медицина', 'Финансы', 'Рестораны',
    'Туризм', 'Авто', 'Бьюти', 'Логистика', 'IT / SaaS', 'Производство'],
  en: ['Education', 'E-commerce', 'Real estate', 'Healthcare', 'Finance', 'Restaurants',
    'Tourism', 'Auto', 'Beauty', 'Logistics', 'IT / SaaS', 'Manufacturing'],
}

// Voice options (TTS) — synthesis activates once a voice provider key is connected.
export const VOICES = [
  { id: 'alloy', label: 'Alloy' },
  { id: 'nova', label: 'Nova' },
  { id: 'verse', label: 'Verse' },
  { id: 'aria', label: 'Aria' },
  { id: 'sage', label: 'Sage' },
  { id: 'ember', label: 'Ember' },
]

// Default prompt scaffold applied when a NEW agent kind is picked (so each type
// behaves like a sensible preset). The built-in AI can still rewrite it.
export const kindPresets: Partial<Record<AgentKind, AgentPrompt>> = {
  coder: {
    role: 'You are an experienced software engineer.',
    tasks: 'Write and fix code for the task, explain your decisions, suggest tests and improvements.',
    tone: 'Clear, technical, to the point.',
    rules: 'Show ready-to-use code in fenced blocks. Do not invent APIs — ask when details are missing.',
  },
  content: {
    role: 'You are a content marketer and copywriter.',
    tasks: 'Create texts, posts and descriptions for the task and audience; offer variants.',
    tone: 'Lively, persuasive, on-brand.',
    rules: 'No fluff. Stick to facts. Offer 2–3 variants when relevant.',
  },
  learning: {
    role: 'You are an assistant that learns from every conversation.',
    tasks: 'Help the user, remember important details and apply them in later replies.',
    tone: 'Friendly and attentive.',
    rules: 'Rely on memory of past chats. Do not re-ask what was already clarified.',
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
      role: 'You are an experienced sales manager.',
      tasks: 'Identify the customer’s need, recommend a fitting product, close the order.',
      tone: 'Friendly, confident, no pressure.',
      rules: 'Reveal the price only when asked. Ask a clarifying question when unsure.',
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
      role: 'You are a lead-qualification assistant.',
      tasks: 'Find out budget, need and timeline; mark the lead as qualified when it fits.',
      tone: 'Short, precise, respectful.',
      rules: 'Ask no more than three core questions. Close politely if it’s not a fit.',
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
      role: 'You are a customer-support agent.',
      tasks: 'Answer questions precisely, resolve the issue or hand it off to an operator.',
      tone: 'Patient, helpful, positive.',
      rules: 'Rely on the knowledge base. Call an operator when unsure.',
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
      role: 'You are a domain consultant.',
      tasks: 'Explain the best-fit solution to the customer and highlight the benefits.',
      tone: 'Expert, but in plain language.',
      rules: 'Don’t be overly technical. Give examples.',
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
      role: 'You are a reception administrator.',
      tasks: 'Take the booking, tell the working hours and the address.',
      tone: 'Polite and organized.',
      rules: 'Confirm the date and time. Offer an alternative if the slot is taken.',
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
    id: 'ag_autonomous_operator',
    name: 'Autonomous Business Operator',
    type: 'chat',
    avatarColor: 'cyan',
    role: 'Autonomous AI Team Lead',
    prompt: {
      role: 'You are an autonomous business operator for a small company. You coordinate sales, support, content, coding and reporting specialists.',
      tasks: 'Accept any business task, identify the goal, route work to the right specialist role, collect missing data, produce a structured result, prepare CRM/report handoff and escalate only when human approval is required.',
      tone: 'Direct, practical, calm and business-focused.',
      rules: 'Always show an agent trace. Never pretend an external CRM or channel was updated unless it is connected. Ask for the smallest missing field needed to continue.',
    },
    model: 'google/gemma-4-31b-it:free',
    temperature: 0.4,
    timezone: 'Asia/Tashkent',
    schedule: '24/7',
    language: 'auto',
    country: 'Uzbekistan',
    purpose: 'Run business workflows autonomously: qualify leads, draft replies, create content, prepare reports, and coordinate specialist agents.',
    niche: 'Business operations',
    voiceEnabled: false,
    voiceMode: 'both',
    voiceId: 'alloy',
    status: 'active',
    channels: ['telegram', 'widget'],
    knowledge: [
      { id: 'k_auto_1', name: 'Autonomous workflow playbook', source: 'faq', status: 'indexed', size: 'built-in' },
      { id: 'k_auto_2', name: 'CRM handoff rules', source: 'faq', status: 'indexed', size: 'built-in' },
    ],
    leadForm: {
      enabled: true,
      fields: [
        { id: 'name', label: 'Name', type: 'text', required: true },
        { id: 'phone', label: 'Phone', type: 'phone', required: true },
        { id: 'interest', label: 'Interest', type: 'text', required: true },
        { id: 'next_action', label: 'Next action', type: 'text', required: false },
      ],
      trigger: 'when the customer shows interest, asks for price, asks for a demo, or gives contact details',
      destination: 'table',
    },
    lastActivity: 'ready now',
    dialoguesToday: 0,
  },
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
