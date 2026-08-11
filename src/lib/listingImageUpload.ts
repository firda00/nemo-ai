/**
 * Отбор файлов до загрузки.
 *
 * Бакет и так ограничен типом и размером, но отказ от Storage приходит текстом вроде
 * «mime type application/pdf is not supported» — по-английски, посреди чужого интерфейса и уже
 * после ожидания. Проверка здесь стоит ровно для того, чтобы владелец узнал причину сразу и
 * своими словами.
 *
 * Ограничения ДУБЛИРУЮТ серверные намеренно. Разойтись они могут только в одну сторону: клиент
 * пропустит то, что отвергнет бакет, — и это увидят, а не проглотят.
 */
export const IMAGE_BUCKET = 'listing-temp-images'
export const MAX_IMAGES = 4
export const MAX_BYTES = 8 * 1024 * 1024
export const ALLOWED_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const

const EXTENSIONS: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
}

export type RejectedFile = { name: string; reason: 'type' | 'size' | 'limit' }
export type PickedFiles = { accepted: File[]; rejected: RejectedFile[] }

/**
 * Что берём и что отклоняем — с причиной на каждый отклонённый файл.
 *
 * Молчаливое отбрасывание здесь было бы худшим вариантом: владелец перетащил пять фотографий,
 * увидел четыре и не знает, какая пропала и почему. Причина у каждого файла своя.
 */
export function pickImages(incoming: File[], already: number): PickedFiles {
  const accepted: File[] = []
  const rejected: RejectedFile[] = []
  for (const file of incoming) {
    if (!(ALLOWED_TYPES as readonly string[]).includes(file.type)) { rejected.push({ name: file.name, reason: 'type' }); continue }
    if (file.size > MAX_BYTES) { rejected.push({ name: file.name, reason: 'size' }); continue }
    // Пятая фотография почти никогда не добавляет фактов — она добавляет счёт за токены.
    if (already + accepted.length >= MAX_IMAGES) { rejected.push({ name: file.name, reason: 'limit' }); continue }
    accepted.push(file)
  }
  return { accepted, rejected }
}

/**
 * Путь в бакете. Первый сегмент — account_id, и это единственная граница между арендаторами:
 * ровно её проверяет и RLS на загрузку, и сервер перед подписью.
 */
export function imagePath(accountId: string, type: string, id: string): string | null {
  const extension = EXTENSIONS[String(type).toLowerCase()]
  return extension && accountId ? `${accountId}/${id}.${extension}` : null
}
