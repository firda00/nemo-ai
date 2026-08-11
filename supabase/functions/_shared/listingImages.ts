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

/** Кладёт байты в бакет и возвращает путь. Null — если тип не поддержан или запись не удалась. */
export async function storeImage(admin: any, accountId: string, bytes: Uint8Array, mimeType: string, id: string): Promise<string | null> {
  const path = imagePathFor(accountId, mimeType, id)
  if (!path) return null
  const { error } = await admin.storage.from(IMAGE_BUCKET).upload(path, bytes, { contentType: mimeType, upsert: false })
  return error ? null : path
}
