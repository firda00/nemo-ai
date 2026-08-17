// Схемы данных лидогенерации. Единственное место, где описано, что считается лидом.
//
// Zod здесь не для красоты типов. Данные приходят из четырёх чужих источников — справочник карт,
// сайт компании, поиск людей, ответ модели — и каждый однажды пришлёт не то: пустую строку вместо
// телефона, число вместо строки, сто тысяч знаков вместо имени. Разбор без проверки означает, что
// мусор доедет до таблицы продавца и до сообщения в Telegram, где его увидит человек и решит, что
// сломался Nemo.
//
// ГРАНИЦА, КОТОРУЮ СТОИТ ЗНАТЬ ЗАРАНЕЕ. Здесь обрабатываются имена и должности живых людей —
// руководителей компаний. Это персональные данные, даже когда они лежат в открытом доступе:
// собрать их в базу и рассылать по ним холодные письма регулируется отдельно от B2B-справочников.
// Схема ниже помечает такие поля явно, чтобы их нельзя было незаметно смешать с фирменными.

// npm-специфик, не Deno-URL: этот модуль сейчас читается только Node-стороной пайплайна
// (agent-hub/sdr-run.mjs через --experimental-strip-types). Если он когда-нибудь понадобится
// внутри настоящей Edge Function, здесь нужен будет Deno-совместимый спецификатор
// (npm:zod@3.23.8 или esm.sh-URL) — общего написания, которое работает в обеих средах без
// отдельной сборки, не существует.
import { z } from 'zod'

/** Телефон в E.164: плюс и от восьми до пятнадцати цифр. Всё остальное — не номер. */
export const PhoneE164 = z.string().regex(/^\+[1-9]\d{7,14}$/, 'ожидается формат E.164')

export const Website = z.string().url().max(300)

/**
 * Сырая запись из справочника карт. Полей мало и все необязательные, кроме тех, без которых
 * запись не запись: у неё должен быть свой идентификатор и название.
 */
export const RawPlace = z.object({
  place_id: z.string().min(1).max(200),
  name: z.string().min(1).max(300),
  formatted_address: z.string().max(500).optional(),
  international_phone_number: z.string().max(60).optional(),
  website: z.string().max(300).optional(),
  rating: z.number().min(0).max(5).optional(),
  user_ratings_total: z.number().int().min(0).optional(),
  business_status: z.string().max(40).optional(),
})
export type RawPlace = z.infer<typeof RawPlace>

/** Компания после очистки. Здесь телефон уже нормализован, а сайт проверен как адрес. */
export const CleanCompany = z.object({
  place_id: z.string().min(1),
  name: z.string().min(1).max(300),
  /** Название без регистра, лишних пробелов и правовых форм — основа ключа дедупликации. */
  normalized_name: z.string().min(1).max(300),
  city: z.string().min(1).max(120),
  dedupe_key: z.string().length(64),
  address: z.string().max(500).nullable(),
  phone: PhoneE164.nullable(),
  website: Website.nullable(),
  rating: z.number().min(0).max(5).nullable(),
  reviews: z.number().int().min(0).nullable(),
  operational: z.boolean(),
})
export type CleanCompany = z.infer<typeof CleanCompany>

/**
 * Найденное о компании в открытых источниках.
 *
 * ЛЮДИ ВЫНЕСЕНЫ В ОТДЕЛЬНОЕ ПОЛЕ И ПОМЕЧЕНЫ ИСТОЧНИКОМ. Имя руководителя, найденное поиском, и
 * имя из формы обратной связи на сайте — разные по надёжности и по тому, что с ними можно делать.
 * Смешать их в одну строку значит потерять и то, и другое: через месяц никто не вспомнит, откуда
 * взялась фамилия в письме.
 */
export const Enrichment = z.object({
  description: z.string().max(1000).nullable(),
  emails: z.array(z.string().email().max(200)).max(10),
  socials: z.object({
    linkedin: z.string().url().max(300).nullable(),
    instagram: z.string().url().max(300).nullable(),
    telegram: z.string().url().max(300).nullable(),
    facebook: z.string().url().max(300).nullable(),
    /**
     * WhatsApp — в Узбекистане и соседних странах это ОСНОВНОЙ канал для малого бизнеса, часто
     * единственный. Поле появилось вместе с разбором браузером: ссылки `wa.me` находились, но их
     * некуда было положить, и самый ценный найденный контакт молча выбрасывался.
     *
     * default(null) обязателен: записи, сохранённые до появления поля, должны проходить проверку
     * при чтении из базы.
     */
    whatsapp: z.string().url().max(300).nullable().default(null),
  }),
  people: z.array(z.object({
    name: z.string().min(2).max(160),
    role: z.string().max(160).nullable(),
    /** Откуда это имя. Без источника оно непроверяемо, а значит непригодно для письма. */
    source: z.enum(['website', 'search', 'registry']),
    profile_url: z.string().url().max(300).nullable(),
  })).max(10),
  /**
   * Виджеты онлайн-записи и чата на сайте: yclients, dikidi, calendly, jivosite…
   *
   * Сильный признак для оценки: компания, поставившая YClients, уже платит за приём заявок — значит
   * понимает его ценность, и разговор с ней начинается не с объяснения, зачем это нужно.
   *
   * default([]) обязателен: поле появилось позже самой таблицы, и записи, сохранённые до него, не
   * должны переставать проходить проверку при чтении из базы.
   */
  booking_widgets: z.array(z.string().max(40)).max(20).default([]),
  /**
   * Читалось ли содержимое настоящим браузером.
   *
   * Происхождение данных, а не украшение — тот же смысл, что у `source` у людей. Текст, дорисованный
   * JavaScript, и текст из ответа сервера получены по-разному и надёжны по-разному, и знать это надо
   * при разборе спорных случаев.
   */
  rendered_by_browser: z.boolean().default(false),
  /** Что не удалось прочитать. Пустое обогащение и неудавшееся — разные вещи. */
  failed: z.array(z.string().max(60)).max(10),
})
export type Enrichment = z.infer<typeof Enrichment>

export const LeadStatus = z.enum(['HOT', 'QUALIFIED', 'LOW_PRIORITY'])
export type LeadStatus = z.infer<typeof LeadStatus>

/**
 * Оценка от модели.
 *
 * `reason` и `icebreaker_pitch` — тексты, которые человек прочитает и, возможно, отправит клиенту.
 * Длина ограничена жёстко: питч на две тысячи знаков не персонализация, а простыня, которую никто
 * не отправит.
 */
export const LeadScore = z.object({
  score: z.number().int().min(0).max(100),
  status: LeadStatus,
  reason: z.string().min(1).max(300),
  key_decision_maker: z.string().max(160).nullable(),
  icebreaker_pitch: z.string().max(400).nullable(),
})
export type LeadScore = z.infer<typeof LeadScore>

/** Порог, за которым лид считается горячим и уходит в Telegram немедленно. */
export const HOT_SCORE = 70

/**
 * Статус выводится ИЗ ЧИСЛА, а не берётся от модели.
 *
 * Модель охотно ставит «HOT» рядом с оценкой 45, если формулировка ей понравилась. Порог — это
 * решение владельца, а не стилистический выбор: два источника истины здесь означают, что уведомления
 * начнут приходить не по тому правилу, которое настроено.
 */
export function statusFor(score: number): LeadStatus {
  if (score >= HOT_SCORE) return 'HOT'
  return score >= 40 ? 'QUALIFIED' : 'LOW_PRIORITY'
}

/** Запрос на поиск. limit ограничен сверху: чужой API платный, а «все клиники мира» — не задача. */
export const LeadSearchRequest = z.object({
  query: z.string().min(2).max(200),
  city: z.string().min(2).max(120),
  limit: z.number().int().min(1).max(200).default(50),
  /** Профиль идеального клиента — то, с чем модель сравнивает компанию. */
  icp: z.string().max(2000).optional(),
})
export type LeadSearchRequest = z.infer<typeof LeadSearchRequest>

/** Лид целиком — то, что ложится в базу и уходит в таблицу и в Telegram. */
export const Lead = CleanCompany.extend({
  enrichment: Enrichment,
  score: LeadScore.nullable(),
  found_at: z.string().datetime(),
})
export type Lead = z.infer<typeof Lead>
