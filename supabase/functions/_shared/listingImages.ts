// Фотографии товара: путь в приватном бакете, подпись на минуты, и граница между арендаторами.
//
// Модель ходит за картинкой сама, поэтому адрес должен быть доступен извне — и именно поэтому он
// обязан быть коротким. Публичный бакет отдал бы ассортимент продавца любому, кто угадает имя
// файла; подписанная ссылка живёт минуты и умирает вместе с генерацией.

export const IMAGE_BUCKET = 'listing-temp-images'
/** Столько живёт подпись. Генерация занимает секунды; минуты — запас на очередь и повтор. */
export const SIGNED_URL_TTL_SECONDS = 900
/** Столько картинок берётся в работу. Пятая почти никогда не добавляет фактов — только счёт. */
export const MAX_IMAGES = 4

/**
 * Путь принадлежит этому аккаунту?
 *
 * Первый сегмент пути — account_id, и это единственная граница между арендаторами в бакете.
 * Проверка стоит на сервере, потому что путь приходит из тела запроса: браузер может прислать
 * любой, и RLS защищает загрузку, а не ЧТЕНИЕ сервисным ключом — им читается что угодно.
 */
export function ownsImagePath(path: unknown, accountId: string): boolean {
  if (typeof path !== 'string' || !path) return false
  // Никаких переходов вверх и абсолютных путей: `..%2F` в имени объекта Storage не раскрывает,
  // но проверку префикса обошло бы.
  if (path.includes('..') || path.startsWith('/')) return false
  const [folder, ...rest] = path.split('/')
  return folder === accountId && rest.length > 0 && rest.every(Boolean)
}

/**
 * Подписанные адреса для тех путей, которые действительно принадлежат аккаунту.
 *
 * Чужой или битый путь молча отбрасывается, а не роняет генерацию: владелец, приложивший к
 * товару четыре фото, из которых одно не загрузилось, должен получить карточку по трём.
 */
export async function signImages(admin: any, accountId: string, paths: unknown): Promise<string[]> {
  const wanted = (Array.isArray(paths) ? paths : [])
    .filter((path) => ownsImagePath(path, accountId))
    .slice(0, MAX_IMAGES) as string[]
  if (!wanted.length) return []
  const signed: string[] = []
  for (const path of wanted) {
    const { data } = await admin.storage.from(IMAGE_BUCKET).createSignedUrl(path, SIGNED_URL_TTL_SECONDS)
    if (data?.signedUrl) signed.push(data.signedUrl)
  }
  return signed
}

/** Расширение по типу файла. Storage хранит тип отдельно, но имя без расширения читается как сбой. */
const EXTENSIONS: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
}

export function imagePathFor(accountId: string, mimeType: string, id: string): string | null {
  const extension = EXTENSIONS[String(mimeType).toLowerCase()]
  return extension ? `${accountId}/${id}.${extension}` : null
}

/**
 * Фото из Telegram.
 *
 * Бот получает `file_id`, а не файл: за самим файлом надо сходить дважды — сначала за путём
 * (`getFile`), потом за содержимым. Ошибка на любом шаге возвращает null, и карточка соберётся
 * по тексту: отсутствие фотографии — это меньше фактов, а не отказ в работе.
 */
export async function fetchTelegramPhoto(botToken: string, fileId: string): Promise<{ bytes: Uint8Array; mimeType: string } | null> {
  try {
    const info = await (await fetch(`https://api.telegram.org/bot${botToken}/getFile?file_id=${encodeURIComponent(fileId)}`)).json()
    const filePath = info?.result?.file_path
    if (typeof filePath !== 'string' || !filePath) return null
    const res = await fetch(`https://api.telegram.org/file/bot${botToken}/${filePath}`)
    if (!res.ok) return null
    const bytes = new Uint8Array(await res.arrayBuffer())
    // Telegram отдаёт фотографии как jpg; расширение из пути — единственный признак, который у
    // нас есть, и на нём же стоит ограничение бакета по типам.
    const mimeType = /\.png$/i.test(filePath) ? 'image/png' : /\.webp$/i.test(filePath) ? 'image/webp' : 'image/jpeg'
    return { bytes, mimeType }
  } catch {
    return null
  }
}

/**
 * Самый крупный размер из присланных.
 *
 * Telegram отдаёт одну фотографию несколькими размерами по возрастанию, и мелкий превью-вариант
 * — это 90 пикселей, на которых не видно ни материала, ни узора. Порядок в массиве документирован,
 * но полагаться на него не нужно: сравнение по площади надёжнее и стоит одну строку.
 */
export function largestPhotoId(photo: unknown): string | null {
  if (!Array.isArray(photo) || !photo.length) return null
  let best: { id: string; area: number } | null = null
  for (const size of photo) {
    const id = (size as Record<string, unknown>)?.file_id
    if (typeof id !== 'string' || !id) continue
    const area = Number((size as Record<string, unknown>)?.width ?? 0) * Number((size as Record<string, unknown>)?.height ?? 0)
    if (!best || area > best.area) best = { id, area: Number.isFinite(area) ? area : 0 }
  }
  return best?.id ?? null
}

/**
 * Фотография из сообщения бота — в бакет.
 *
 * ОДНА за раз, и это ограничение Telegram, а не лень: альбом приходит несколькими отдельными
 * обновлениями с общим media_group_id, подпись несёт только первое, а связать их между собой без
 * хранимого состояния нельзя. Вебхук состояния не держит, поэтому в работу идёт снимок из того
 * сообщения, где написан текст. Владельцу это сказано словами в подсказке, а не оставлено на
 * догадку.
 */
export async function storeTelegramPhoto(admin: any, botToken: string, accountId: string, message: unknown): Promise<string[]> {
  const fileId = largestPhotoId((message as Record<string, unknown>)?.photo)
  if (!fileId || !botToken) return []
  const file = await fetchTelegramPhoto(botToken, fileId)
  if (!file) return []
  const path = await storeImage(admin, accountId, file.bytes, file.mimeType, crypto.randomUUID())
  return path ? [path] : []
}

/** Кладёт байты в бакет и возвращает путь. Null — если тип не поддержан или запись не удалась. */
export async function storeImage(admin: any, accountId: string, bytes: Uint8Array, mimeType: string, id: string): Promise<string | null> {
  const path = imagePathFor(accountId, mimeType, id)
  if (!path) return null
  const { error } = await admin.storage.from(IMAGE_BUCKET).upload(path, bytes, { contentType: mimeType, upsert: false })
  return error ? null : path
}
