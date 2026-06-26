import type { AgentConfig } from '../types'

// Beta starter agents (TZ 9.4): Researcher, Writer, Analyst, Reviewer, Integrator.
// These are code/JSON config — the user never builds them. Faithful to schema 9.3.
export const defaultAgents: AgentConfig[] = [
  {
    id: 'researcher',
    name: { uz: 'Tadqiqotchi', ru: 'Исследователь' },
    role: {
      uz: 'Ma’lumot to‘playdi va manbalarni tekshiradi',
      ru: 'Собирает информацию и проверяет источники',
    },
    instruction:
      "Foydalanuvchi maqsadiga oid ishonchli ma'lumotlarni to'pla, manbalarni qisqacha keltir. O'zbek yoki rus tilida aniq yoz.",
    tools: ['web_search', 'knowledge_base'],
    model: 'auto',
    enabled: true,
    color: 'blue',
    glyph: 'search',
  },
  {
    id: 'writer',
    name: { uz: 'Yozuvchi', ru: 'Копирайтер' },
    role: {
      uz: 'Mijozlarga javob va kontent loyihasini yozadi',
      ru: 'Пишет ответы клиентам и черновики контента',
    },
    instruction:
      "O'zbek/rus tilida muloyim, aniq va jonli matn yoz. Mavzuga mos uslubni tanla, ortiqcha so'z ishlatma.",
    tools: ['web_search', 'knowledge_base'],
    model: 'auto',
    enabled: true,
    color: 'cyan',
    glyph: 'pen',
  },
  {
    id: 'analyst',
    name: { uz: 'Tahlilchi', ru: 'Аналитик' },
    role: {
      uz: 'Ma’lumotni tahlil qiladi va xulosa chiqaradi',
      ru: 'Анализирует данные и делает выводы',
    },
    instruction:
      "To'plangan ma'lumotni tahlil qil, asosiy xulosalar va tavsiyalarni ro'yxat ko'rinishida ber.",
    tools: ['code_interpreter', 'knowledge_base'],
    model: 'auto',
    enabled: true,
    color: 'violet',
    glyph: 'chart',
  },
  {
    id: 'reviewer',
    name: { uz: 'Tekshiruvchi', ru: 'Ревьюер' },
    role: {
      uz: 'Natija sifatini nazorat qiladi',
      ru: 'Контролирует качество результата',
    },
    instruction:
      'Yakuniy natijani aniqlik, til va to‘liqlik bo‘yicha tekshir. Kamchiliklarni ko‘rsat va tuzatishni taklif qil.',
    tools: ['knowledge_base'],
    model: 'auto',
    enabled: true,
    color: 'teal',
    glyph: 'check',
  },
  {
    id: 'integrator',
    name: { uz: 'Integrator', ru: 'Интегратор' },
    role: {
      uz: 'Tashqi xizmatlar bilan bog‘laydi (Telegram/Google)',
      ru: 'Подключает внешние сервисы (Telegram/Google)',
    },
    instruction:
      'Natijani kerakli xizmatga (Telegram, Google Sheets/Docs) tayyorla yoki eksport formatini shakllantir.',
    tools: ['telegram', 'google_sheets', 'google_docs'],
    model: 'auto',
    enabled: false,
    color: 'amber',
    glyph: 'plug',
  },
]
