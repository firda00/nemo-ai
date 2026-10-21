# NEMO: аудит сквозной записи на пробное занятие

Дата: 2026-09-08. Итог: BLOCKED / НЕ ПОДТВЕРЖДЕНО.
Область: существующий чат, расписание → согласование → запись → повторное чтение → подтверждение. Новых экранов/ролей нет. Платные вызовы, сообщения клиентам, миграции и деплой в ходе аудита не выполнялись.

## 1. Провайдер и модель: что установлено

По исполняемому локальному коду инструментальный цикл использует OpenRouter, POST https://openrouter.ai/api/v1/chat/completions. PRIMARY_MODEL читается из окружения; default — openai/gpt-4o-mini; fallback — google/gemini-flash-1.5. Доказательства: supabase/functions/_shared/llm.ts:52 и tools.ts:500–503.
Это НЕ доказательство фактического production model ID: значение production PRIMARY_MODEL и ответ провайдера не получены. Скрытая подмена fallback также мешает проверке конкретной модели.
Отдельный direct-chat имеет OpenAI /v1/responses и Anthropic /v1/messages (frontierChat.ts:178,186), но SmartTaskDesk.tsx:400,414 передаёт tools: []. Наличие выбора модели не означает, что выбранная модель исполняет сценарий.
Локальная проверка наличия: OpenRouter credential обнаружен; OpenAI/Anthropic ключи в process/root env не обнаружены. Валидность не проверена; хранилище tenant credentials этим не обследовано. Значения секретов не выводились.
Реальный ответ LLM и реальный вызов schedule-read НЕ выполнены: отдельный платный лимит не согласован; schedule-read в инструментальном наборе отсутствует. Заглушка вместо этого не создавалась.

## 2. Реестр отсутствующих серверных функций

Реальный Supabase CLI inventory от 2026-09-08: 92 развёрнутые функции. Все шесть ниже отсутствуют; локальные index.ts существуют. Наличие исходника не означает deployment. Тесты в таблице — подходящие существующие проверки, НЕ заявление о запуске их в этом аудите.

| Функция | Назначение / зависимости | Авторизация | Deployment | Подтверждающий тест и его предел | Нужна сценарию |
|---|---|---|---|---|---|---|
| amocrm-event-hook | CRM events → Forge; trigger, runtime_resolve_forge_event_trigger, runtime_enqueue_forge_event | Собственная подпись/секрет, provider amocrm, tenant из server trigger; JWT gateway выключен | ABSENT | test:forge-event-hooks + test:forge-event-bridge, mock RPC | Нет для внутреннего чата |
| telegram-forge-hook | Telegram commands → Forge; те же RPC/trigger | Подпись или Telegram secret token по trigger; bound provider telegram | ABSENT | Те же mock tests | Только если выбрать Telegram-вход; сейчас нет |
| uzum-event-hook | Order/stock events → Forge; те же RPC/trigger | Подпись/секрет, timestamp, bound provider uzum | ABSENT | Те же mock tests | Нет |
| daily-briefing-worker | Сводки/напоминания; briefing/reminder RPC, channel credentials, Google/Telegram/Storage по ветке | x-cron-secret, отсутствие →403 | ABSENT | test:reminder-wrapper, подменённые зависимости; briefing offline tests | Нет |
| amocrm-webhook-secret | Статус/ротация/отзыв webhook identity; provider_keys, secretBox, identity RPC, gateway URL | JWT + auth.getUser + owner/admin + tenant credential scope | ABSENT | test:amocrm-webhook-secret, helpers/static endpoint assertions | Нет |
| research-analyze-multimodal | Grounded transcript/text analysis; users/accounts/keys, OpenRouter, usage RPC | JWT, auth.getUser, совпадение workspace источников, balance/account checks | ABSENT | test:research-notebook, helpers/schema/static assertions; не live LLM | Нет |

Источники: соответствующие supabase/functions/<name>/index.ts; _shared/forgeEventBridge.ts:135–183; deployment-manifest.json. DAILY_BRIEFING_DELIVERY отключает сводки лишь при явном off; только REMINDER_DELIVERY default-OFF. Не разворачивать посторонний worker ради закрытия реестра.

## 3. Реализовано ранее / обнаруженные разрывы

Существуют очередь согласований, owner-only endpoint, guard read_only/approval_required, таблица bookings и tool_runs. В этом аудите функциональный код НЕ изменён.

- Чтение расписания отсутствует: capabilitySkills.ts:24 scheduling содержит только book_appointment; tools.ts:72 имеет calendar_create_event, не чтение.
- approval-queue/index.ts:34 меняет статус. agentActionPolicy.ts:79–89 намеренно не исполняет approved action. Одобрение ≠ запись.
- tools.ts:33–47 вставляет booking без проверки доступности/ёмкости слота, без возврата ID и readback.
- agentActionPolicy.ts:55–61 делает SELECT → INSERT для pending request: нет атомарной защиты от конкурентных дублей.
- 20260709040000_bookings.sql: account_id nullable, dialogue_id без tenant FK; нет idempotency key/approval reference.
- tools.ts:544,553 пишет аудит отдельно; создание записи и журнал не образуют атомарную операцию.
- Production E2E account блокируется guard (agentActionPolicy.ts:36). Его нельзя объявить подходящим положительным fixture или отключать защиту ради теста.
- RuntimeClient.resolveApprovalAndEnqueue и durable runtime RPC существуют, но booking wiring не найден.

Нужные зависимости сценария: авторизованный инструмент расписания с tenant scope; сохраняемая заявка с выбранным slot ID; owner decision; исполнитель approved request; атомарная запись + idempotency + журнал; readback по request/booking ID; восстановление и подтверждение в существующем чате. Ни одна из шести функций выше не закрывает эти разрывы сама по себе.

## 4. Проверено реальным вызовом

1. supabase functions list: успешно; все шесть ABSENT. cli-chat ACTIVE v6, approval-queue ACTIVE v23, agent-tool ACTIVE v94, verify_jwt=true.
2. POST {} без Authorization к этим трём production endpoints: каждый HTTP 401. Секреты и данные клиентов не передавались. Проверяется отказ на входе, НЕ tenant isolation и НЕ выполнение модели.

## 5. Проверено только тестовой подменой

Независимый reviewer запустил npm run test:approvals: exit 0; 50 unit cases и 9 executable smoke cases. HTTP/DB/auth подменяются (agent-action-policy-smoke.mjs:95–107). Доказаны ветки guard, создание pending вместо действия, ошибки профиля/аккаунта, tenant bindings, отказ hidden tools, повтор pending request с requestKey. Это НЕ доказательство созданной записи и НЕ реальные model/tool calls.

| Проверка | Фактическое покрытие | Остаток |
|---|---|---|
| Полный положительный цикл | Не выполнен | Все переходы с реальными тестовыми данными и LLM |
| Отказ в согласовании | Queue decision существует по коду | End-to-end reject → отсутствие booking не выполнен |
| Нет прав | Реальные 401 без JWT; mock profile/policy failures | Authenticated non-owner и booking scope на реальной БД |
| Повторный запрос | Mock reuse pending ID | Конкурентные запросы/повтор после commit, уникальность booking |
| Обрыв соединения | Не проверен в booking flow | Commit → потеря ответа → reconnect/readback без дубля |
| Сервис недоступен | Mock ошибки/throw approval storage | Schedule/booking provider outage, timeout, uncertain outcome |
| Изоляция организаций | Mock tenant bindings | Реальные два synthetic tenant, чужой slot/request/booking denied |
| Журнал и восстановление | Есть отдельные записи по коду | Атомарность/долговечность/восстановление в полном сценарии |
| Подтверждение в чате | Не проверено | Только после readback сохранённой записи |

## 6. Заблокировано и условия продолжения

- Не согласован платный лимит: 0 платных вызовов выполнено. Требуется явный бюджет и использование существующего провайдера; без silent fallback. До платного запуска нужен технически ограниченный probe, максимум запросов/токенов и запрет автоматических повторов.
- Не установлен тестовый источник расписания и доступная изолированная среда для положительной записи. Production test account с egress guard не обходить. Не использовать данные клиентов.
- Сам путь schedule/approval execution/readback ещё не реализован. Нельзя исправить его только промптом, развёртыванием шести функций или заменой модели.

Порядок следующей проверки: фактический model ID из ответа и tool call → реальное чтение synthetic schedule → pending сохраняется → отдельное согласование конкретных аргументов → транзакционный executor с повторной проверкой слота/прав → readback → chat confirmation. Затем все негативные случаи из таблицы. Изменения авторизации/SQL/исполнителя требуют независимого review по AGENTS.md.

Этот документ — отчёт о блокерах, НЕ акт приёмки сценария. Общий quality gate не перезапускался: функциональных изменений нет, готовность функции не заявляется.
