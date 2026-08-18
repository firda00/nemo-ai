// Контракты медиа-пайплайна: задача на рендер и её результат.
//
// Соответствуют §1 задания Фазы 4 спецификации V5. Как и контракты V5, лежат отдельно от кода рендера:
// задачу ставит один процесс (шлюз или планировщик кампаний), выполняет другой (медиа-воркер), а между
// ними — очередь и JSON. Общая схема здесь единственное, что мешает им разойтись.
//
// ПОЧЕМУ ПРОВЕРКА ЖЁСТКАЯ. Рендер стоит минуты процессорного времени и десятки мегабайт диска. Задача с
// опечаткой в адресе сцены не падает сразу — она падает на середине, потратив всё это впустую, и
// сообщение ffmpeg об ошибке при этом описывает не опечатку, а неудачу открытия потока. Отсеять такую
// задачу ДО запуска дешевле в разы.

import { z } from 'zod'

/** Предел сцен в ролике. Больше сотни — это уже не короткое видео, а слайд-шоу на полчаса. */
const MAX_SCENES = 100
/** Предел длительности ролика. TikTok и Reels ограничивают загрузку примерно этим порядком. */
const MAX_TOTAL_SECONDS = 600

export const SceneTransitionSchema = z.enum(['fade', 'slide', 'none'])
export type SceneTransition = z.infer<typeof SceneTransitionSchema>

export const SceneSchema = z.object({
  id: z.string().min(1).max(64),
  /**
   * Адрес картинки или видео сцены.
   *
   * Полный URL, а не путь на диске, и это ограничение намеренное: воркер работает в контейнере, чья
   * файловая система исчезнет вместе с ним, и путь `/tmp/scene1.png` из чужого процесса там не
   * существует. Скачивание идёт по адресу, и оно же — единственная точка, где проверяется доступность.
   */
  mediaUrl: z.string().url('нужен полный адрес сцены, включая https://'),
  /**
   * Длительность показа.
   *
   * Нижняя граница 0.3 с не формальность: кадр короче трети секунды человек не успевает разглядеть, а
   * при склейке он превращается в мигание. Верхняя — 120 с: одна сцена длиннее двух минут означает,
   * что ролик собирают не тем инструментом.
   */
  durationSec: z.number().positive().min(0.3).max(120),
  transition: SceneTransitionSchema.default('none'),
})
export type Scene = z.infer<typeof SceneSchema>

export const SubtitleCueSchema = z.object({
  startMs: z.number().int().nonnegative(),
  endMs: z.number().int().positive(),
  text: z.string().min(1).max(200),
  /**
   * Слово, которое подсвечивается внутри реплики.
   *
   * Необязательное: подсветка — приём, а не обязанность. Если слова нет в тексте, генератор субтитров
   * просто не подсветит ничего, а не сломается: разметка важнее эффекта.
   */
  highlightWord: z.string().min(1).max(60).optional(),
}).refine((cue) => cue.endMs > cue.startMs, {
  message: 'конец реплики должен быть позже начала',
  path: ['endMs'],
})
export type SubtitleCue = z.infer<typeof SubtitleCueSchema>

/** Пока один формат. Перечисление, а не строка: добавление 16:9 обязано быть заметным изменением. */
export const OutputFormatSchema = z.enum(['mp4_9_16'])

export const VideoRenderTaskSchema = z.object({
  id: z.string().uuid(),
  tenantId: z.string().uuid(),
  scenes: z.array(SceneSchema).min(1, 'ролик без сцен собрать не из чего').max(MAX_SCENES),
  voiceoverUrl: z.string().url(),
  bgmUrl: z.string().url().optional(),
  /**
   * Громкость фоновой музыки, доля от исходной.
   *
   * 0.15 по умолчанию — из спецификации. Верхняя граница 1 стоит здесь не зря: значение больше единицы
   * означает музыку ГРОМЧЕ голоса, и ролик становится непригодным, а заметит это человек уже после
   * публикации.
   */
  bgmVolume: z.number().min(0).max(1).default(0.15),
  subtitles: z.array(SubtitleCueSchema).max(2_000).optional(),
  outputFormat: OutputFormatSchema.default('mp4_9_16'),
  webhookUrl: z.string().url().optional(),
}).refine(
  (task) => task.scenes.reduce((sum, scene) => sum + scene.durationSec, 0) <= MAX_TOTAL_SECONDS,
  { message: `суммарная длительность сцен превышает ${MAX_TOTAL_SECONDS} с`, path: ['scenes'] },
).refine(
  // Одинаковые идентификаторы сцен ломают не рендер, а РАЗБОР: по ним потом ищут, какая сцена не
  // отрисовалась, и две одинаковые делают ответ невозможным.
  (task) => new Set(task.scenes.map((scene) => scene.id)).size === task.scenes.length,
  { message: 'идентификаторы сцен должны быть уникальны', path: ['scenes'] },
)
export type VideoRenderTask = z.infer<typeof VideoRenderTaskSchema>

export const RenderStatusSchema = z.enum(['COMPLETED', 'FAILED'])

export const VideoRenderResultSchema = z.object({
  id: z.string().uuid(),
  outputPath: z.string(),
  durationSec: z.number().nonnegative(),
  renderTimeMs: z.number().int().nonnegative(),
  fileSizeBytes: z.number().int().nonnegative(),
  status: RenderStatusSchema,
  /** Причина неудачи. Обязательна при FAILED — см. проверку ниже. */
  error: z.string().max(2_000).nullable().default(null),
}).refine(
  // FAILED без причины — бесполезная запись: она сообщает, что не получилось, и не даёт ни одного
  // способа узнать почему. Разбирать такое приходится повторным запуском на боевых данных.
  (result) => result.status !== 'FAILED' || Boolean(result.error),
  { message: 'у неудачного рендера обязана быть причина', path: ['error'] },
)
export type VideoRenderResult = z.infer<typeof VideoRenderResultSchema>

/** Разрешение 9:16. Одно место на весь пайплайн: расхождение даёт чёрные полосы по краям. */
export const OUTPUT_WIDTH = 1080
export const OUTPUT_HEIGHT = 1920
export const OUTPUT_FPS = 30

export { MAX_SCENES, MAX_TOTAL_SECONDS }
