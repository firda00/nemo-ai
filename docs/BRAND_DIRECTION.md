# Nemo: направление текущего лендинга

Существующая идентичность сохранена. Маркетинговый знак с петлями используется как эмблема; компактный N в приложении пока остаётся прежним монограммным вариантом. Полная унификация favicon и всех продуктовых вариантов ещё не выполнена, поэтому это не новая завершённая бренд-система.

Изменения: двухстрочный заголовок с понятным результатом, более короткое описание, один cyan-цвет основного действия, менее яркая предметная иллюстрация эмблемы. Старый `nemo-logo-neon.jpeg` сохранён. Новая иллюстрация: `public/brand/nemo-emblem-studio-v2.png`. Исходный файл Image Gen также сохранён в каталоге Codex.

Позиционирование: помощник для рабочих процессов с проверяемым результатом. Возможности закрытой беты показаны без неподтверждённых счётчиков. Нарисованный сценарий работы помечен примером, не выдаётся за выполненную клиентскую операцию.

Ближайшие проверки перед публикацией: производственная загрузка шрифтов и изображений, качество на слабом соединении, единообразие маленьких вариантов знака, реальная воронка приглашений. Локальный аудит не доказывает production Core Web Vitals или юридическую уникальность логотипа.

## Иллюстрация

Создана встроенным Image Gen, без API-key fallback. Входное изображение: существующий `public/brand/nemo-logo-neon.jpeg`. Финальный промпт:

> Create a refined website hero brand photograph based on the supplied NEMO logo reference. Reference role: preserve the recognizable three-lobed continuous-loop emblem including circular aperture top and looping lower arms; use that identity, do not invent a different symbol. Render the emblem as a precision-machined matte titanium object with restrained cyan illuminated inner edges, subtle very small violet reflections from the original brand, sitting on a dark midnight navy architectural plinth in a quiet studio. Landscape 4:3 composition, entire object visible centered, elegant controlled directional light, sharp geometry, substantial negative space, premium enterprise software brand campaign, photorealistic material. No text, no NEMO letters, no captions, no interface, no status indicators, no badges, no stars or sparkles, no glowing background fog. Background #090c19. This is a brand illustration, not a UI screenshot.

Для доставки используется lossless WebP (1 169 444 байта вместо 1 616 146). Исходный PNG сохранён; декодированные пиксели совпадают побайтно. Проверка: agent-hub/artifacts/astra-product-stage/asset-encoding.json.
