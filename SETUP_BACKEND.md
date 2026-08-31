# Nemo AI — запуск настоящего бэкенда (Supabase + OpenRouter + Telegram)

Эта инструкция превращает прототип в **реально работающего** Telegram-агента:
клиент пишет боту → агент отвечает через LLM (OpenRouter) по своему промпту и базе
знаний → ответ уходит в Telegram → диалог сохраняется в БД → оператор может перехватить.

Всё, что в коде, уже готово. Тебе нужно выполнить шаги ниже (≈15 минут).
**Ключи нигде не попадают во фронтенд** — только в секреты Supabase.

---

## 0. Что получить заранее (3 вещи)

1. **Telegram bot token** — открой [@BotFather](https://t.me/BotFather) → `/newbot` → имя и username → получишь токен вида `123456789:AAH...`.
2. **OpenRouter API key** — [openrouter.ai](https://openrouter.ai) → войди → *Keys* → *Create key* (`sk-or-...`). Пополни баланс на пару $ (модели платные, но дёшево: `openai/gpt-4o-mini` — копейки за диалог).
3. **Supabase аккаунт** — [supabase.com](https://supabase.com) (бесплатный тариф подойдёт для старта).

---

## 1. Создать проект Supabase

1. [supabase.com](https://supabase.com) → **New project**. Придумай пароль БД (запиши).
2. Дождись создания. В **Project Settings → API** скопируй:
   - **Project URL** (`https://xxxx.supabase.co`)
   - **Project Reference ID** (`xxxx` из URL)
   - **service_role key** (секретный — не публикуй)
   - **anon key** (публичный — пригодится позже для фронтенда)

---

## 2. Установить Supabase CLI и подключиться

В PowerShell, в папке проекта:

```powershell
cd C:\Users\firda\nemo-ai
# Supabase CLI уже установлен как dev-зависимость проекта — зовём через npx
npx supabase --version
npx supabase login                       # откроет браузер для входа
npx supabase link --project-ref ВАШ_REF
```

> Дальше **каждую** команду `supabase …` запускай с префиксом `npx` (CLI стоит локально в проекте, не глобально).

> Если `npx supabase link` ругается на `config.toml` — выполни `npx supabase init` (он его пересоздаст),
> затем верни два блока `[functions.telegram-webhook]` и `[functions.setup-telegram]` с `verify_jwt = false` из нашего `supabase/config.toml`.

---

## 3. Применить схему БД

```powershell
npx supabase db push
```

Это создаст таблицы `accounts, users, agents, channels, dialogues, messages, leads, knowledge_docs, usage`, RLS-политики, триггеры и realtime (см. `supabase/migrations`).

---

## 4. Задать секреты (живут только на сервере)

```powershell
npx supabase secrets set OPENROUTER_API_KEY=sk-or-ВАШ_КЛЮЧ
npx supabase secrets set SETUP_SECRET=придумайте-длинную-случайную-строку
# Обязателен для публичных форм /waitlist и «Запросить доступ»: минимум 32 случайных символа.
# Не ставьте сюда NEMO_TOKEN_PEPPER и не добавляйте это значение в VITE_* или .env.production.example.
npx supabase secrets set WAITLIST_IP_PEPPER="$(openssl rand -hex 32)"
```

Для Marketing Engine 2.0 можно переопределить модели, поддерживающие OpenRouter Structured Outputs:

```powershell
npx supabase secrets set MARKETING_MODEL=openai/gpt-4o-mini
npx supabase secrets set MARKETING_FALLBACK_MODEL=google/gemini-2.5-flash
```

Если переменные не заданы, используются эти же значения по умолчанию. Маршрутизация требует
поддержку `response_format: json_schema`, поэтому несовместимый провайдер не получит запрос.

> `SUPABASE_URL` и `SUPABASE_SERVICE_ROLE_KEY` Supabase подставляет в функции автоматически — их задавать НЕ нужно.

---

## 5. Задеплоить Edge Functions

```powershell
npx supabase functions deploy telegram-webhook --no-verify-jwt
npx supabase functions deploy setup-telegram --no-verify-jwt
npx supabase functions deploy connect-telegram
npx supabase functions deploy operator-send
```

> `connect-telegram` и `operator-send` деплоятся **без** `--no-verify-jwt` — они требуют
> входа пользователя (вызываются из панели с его сессией).
>
> Если ты уже деплоил раньше: после security-правок повтори `npx supabase db push` (новая миграция
> закрывает RLS-дыру, прячет секреты каналов, добавляет cost-guard) и передеплой
> `telegram-webhook` + `operator-send`.

---

## 6. Подключить бота одной командой

Подставь свой `bot_token` и `SETUP_SECRET` из шага 4:

```powershell
$body = @{ bot_token = "123456789:AAH..." } | ConvertTo-Json
Invoke-RestMethod -Method Post `
  -Uri "https://ВАШ_REF.supabase.co/functions/v1/setup-telegram" `
  -Headers @{ "x-setup-secret" = "ваш-SETUP_SECRET" } `
  -ContentType "application/json" -Body $body
```

В ответе будет `ok: True`, а также `agent_id`, `channel_id` и `webhook`.
Эта команда: создала демо-агента, привязала бота как канал и зарегистрировала вебхук Telegram.

---

## 7. Проверить — оно работает 🎉

1. Открой своего бота в Telegram (по username из @BotFather), нажми **Start**.
2. Напиши: `Salom! Narxlaringiz qanday?` или `Привет, расскажи про вас`.
3. Бот ответит **реальным** ответом от LLM на языке сообщения.
4. В Supabase → **Table editor → messages** появятся строки `customer` и `agent`.

---

## 8. Настроить агента под себя

Пока UI ещё не подключён к бэкенду (это следующий шаг), агента можно править прямо в
**Table editor → agents**:
- `prompt` (jsonb): `role`, `tasks`, `tone`, `rules` — кто агент и что делает.
- `model`: любой id из OpenRouter, например `openai/gpt-4o-mini`, `anthropic/claude-3.5-sonnet`, `google/gemini-flash-1.5`.
- `default_lang`: `auto` (язык клиента) / `uz` / `ru`.

База знаний: добавь строки в **knowledge_docs** (`owner_id` = id агента, `content` = текст/FAQ) —
агент будет на них опираться.

---

## Полезное / отладка

- Логи функции: `npx supabase functions logs telegram-webhook`
- Статус вебхука: открой в браузере `https://api.telegram.org/botВАШ_ТОКЕН/getWebhookInfo`
- Сбросить вебхук: `https://api.telegram.org/botВАШ_ТОКЕН/deleteWebhook`
- Стоимость: платит твой ключ OpenRouter; `gpt-4o-mini` ≈ доли цента за ответ.

---

## 9. Включить live-режим интерфейса (Supabase Auth)

Интерфейс работает в двух режимах: **демо** (моки, без бэкенда) и **live**. Чтобы включить live:

1. Скопируй `.env.example` → `.env.local` и заполни:
   ```
   VITE_SUPABASE_URL=https://ВАШ_REF.supabase.co
   VITE_SUPABASE_ANON_KEY=ваш-anon-public-key
   ```
2. В Supabase → **Authentication → Providers → Email**: для быстрого старта **выключи**
   «Confirm email» (иначе после регистрации нужно подтверждать почту).
3. Перезапусти фронт: `npm run dev`. Вход/регистрация пойдут через **настоящий** Supabase Auth.

> Без `.env.local` всё остаётся в демо-режиме — показ не ломается.

---

## Что уже готово на бэкенде
- ✅ Схема БД + RLS + realtime (`supabase/migrations`)
- ✅ `telegram-webhook` — бот реально отвечает через OpenRouter
- ✅ `setup-telegram` — подключение бота одной командой
- ✅ `connect-telegram` — подключение бота из UI (под входом)
- ✅ `operator-send` — реальная отправка от оператора
- ✅ Реальный вход в интерфейсе (Supabase Auth) за фичефлагом

## 10. Дополнительные каналы и CRM (Фаза 4)

Деплой новых функций:

```powershell
npx supabase functions deploy whatsapp-webhook --no-verify-jwt
npx supabase functions deploy instagram-webhook --no-verify-jwt
npx supabase functions deploy setup-meta --no-verify-jwt
npx supabase functions deploy crm-push
```

### WhatsApp (Meta Cloud API)
1. developers.facebook.com → создай приложение → WhatsApp → получи `phone_number_id` и постоянный `token`.
2. Зарегистрируй канал:
   ```powershell
   $body = @{ type="whatsapp"; credentials=@{ phone_number_id="..."; token="..." } } | ConvertTo-Json
   Invoke-RestMethod -Method Post -Uri "https://ВАШ_REF.supabase.co/functions/v1/setup-meta" -Headers @{ "x-setup-secret"="ваш-SETUP_SECRET" } -ContentType "application/json" -Body $body
   ```
3. В ответе будут `webhook` и `verify_token`. В Meta App → WhatsApp → Configuration → Webhook вставь этот URL и verify token, подпишись на `messages`.

### Instagram (Meta)
То же самое, но `type="instagram"`, credentials `{ page_token, ig_id }`. В Meta App → Webhooks (Instagram) вставь webhook URL + verify token и подпишись на `messages`.

> WhatsApp/Instagram требуют бизнес-аккаунта Meta и проверки приложения — это внешние одобрения, не код. Логика агента та же, что у Telegram (общий runtime `_shared/agent.ts`).

### CRM (AmoCRM / Bitrix24 / Google)
Функция `crm-push` пересылает лид на «входящий вебхук» CRM (Bitrix24 inbound webhook, хук AmoCRM или URL Google Apps Script) — работает без полного OAuth. Полноценные OAuth-приложения и захват лидов из диалога — следующий этап.

---

Скажи, когда бот заработает — и где застрял; продолжу подключать остальное.
