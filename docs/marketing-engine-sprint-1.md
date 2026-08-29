# Marketing Engine 2.0 — Sprint 1 API

## Endpoint

Authenticated product URL:

```text
POST /api/marketing/generate-campaign
Authorization: Bearer <Supabase user JWT>
Content-Type: application/json
```

Canonical Edge Function URL: `/functions/v1/generate-campaign`.

## Request

```json
{
  "topic": "Как AI-команда ускоряет обработку лидов",
  "platform": "instagram_carousel",
  "goal": "lead_gen",
  "brand_kit_id": "11111111-1111-4111-8111-111111111111",
  "image_ratio": "4:5",
  "language": "ru",
  "context": "Не использовать неподтвержденные цифры"
}
```

Допустимые значения:

- `platform`: `reels`, `shorts`, `telegram`, `linkedin`, `instagram_carousel`;
- `goal`: `lead_gen`, `reach`, `sales`, `expert_authority`;
- `image_ratio`: `1:1`, `4:5`, `9:16`;
- `language`: `uz`, `ru`, `en`.

## Response

При успехе `campaign` строго соответствует `MarketingOutputSchema`. Блок `usage.estimated`
показывает верхнюю оценку до вызова, а `usage.actual` — фактические токены и стоимость,
возвращённые OpenRouter. Ответ модели повторно валидируется Zod на сервере.

## Brand Kit

`brand_kit_id` всегда ищется вместе с `account_id` текущего пользователя. Чужой или отсутствующий
идентификатор возвращает `BRAND_KIT_NOT_FOUND`. Таблица `brand_kits` защищена RLS.

Визуальные пресеты:

- `editorial_photo_35mm`;
- `minimal_tech_ui`;
- `3d_modern_clay_isometric`;
- `flat_vector_infographic`.

3D и иллюстрации не запрещены глобально: positive/negative anchors выбираются из активного пресета.
