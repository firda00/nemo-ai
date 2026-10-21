# Запись на пробное занятие: локальная реализация

> Исторический отчёт первого этапа ниже. Продолжение локальной приёмки 2026-09-08: Docker восстановлен, первый настоящий прогон 21/21 прошёл; дальнейшие повторные прогоны, браузер и quality фиксируются в `agent-hub/artifacts/trial-booking-acceptance/acceptance-report.md`. Старое состояние «заблокировано» ниже не является текущим. Отчёты каждого запуска сохраняются отдельно и привязаны к SHA256 рабочих исходников.

2026-09-08. Ветка: `codex/trial-booking-local`. Статус: **код реализован; приёмка настоящего Auth/PostgREST и конкуренции заблокирована локальной средой**. Это не полный LLM E2E и не готовность к production.

Существовавшие незакоммиченные изменения сохранены. Ни коммит, ни production-миграция, ни deploy, ни сообщение клиенту, ни платный вызов модели не выполнялись.

## Изменённые файлы этого этапа

| Файл | Изменение |
|---|---|
| `supabase/migrations/20260908120000_trial_booking.sql` | Новая additive migration: расписание, RPC, исполнение, права, аудит, idempotency, исключение внутреннего действия из общего worker |
| `deploy/init-supabase.sql` | Канонический артефакт пересобран из 179 миграций для обязательного schema contract; к базе не применялся |
| `src/lib/trialBookingClient.ts` | Единый прикладной HTTP-клиент для чата и настоящих интеграционных тестов; fixed JWT/account, localhost-only, без автоматического повтора мутаций |
| `src/components/platform/TrialBookingChatCard.tsx` | Карточка в существующем чате: расписание, согласование, выполнение, повторное чтение, восстановление |
| `src/components/platform/SmartTaskDesk.tsx` | Локальный DEV-вход по «пробное занятие» / «trial lesson» / «sinov dars»; ни нового экрана, ни новой роли |
| `src/i18n/trialBooking.ts` | RU/UZ/EN тексты карточки |
| `tests/trial_booking_client.test.ts` | Шесть тестов транспорта с явно подменённым fetch |
| `agent-hub/trial-booking-ui-smoke.mjs` | Четыре проверки смонтированной карточки с MOCK Auth/fetch |
| `agent-hub/trial-booking-local/` | Изолированная среда, manifest, подготовка/очистка, genuine Auth harness, отдельный embedded SQL smoke, запуск приложения |
| `agent-hub/trial-booking-model-probe.mjs` | Ограниченная подготовка OpenRouter-пробы, запуск по умолчанию запрещён |

## Механизм

Переиспользуются `public.bookings`, `approval_requests` и durable runtime: inbox, workflow, policy decision, outbox, transitions, append-only audit. `RuntimeClient.resolveApprovalAndEnqueue` изучен: его серверная операция `runtime_resolve_approval_and_enqueue_action` вызывается из нового авторизованного RPC. Второй механизм очередей не создавался.

Добавлены только предметные таблицы `trial_courses` и `trial_sessions`: существующая схема не содержит занятия с вместимостью. В `bookings` добавлены ссылки на занятие и workflow, tenant FK и unique operation index. Старые записи не переписываются.

1. `trial_booking_schedule`: проверяет `auth.uid()`, членство организации, роль owner/operator, blocked/E2E ограничения; читает занятия только этой организации.
2. `trial_booking_request`: получает конкретный slot, сохраняет course, время, timezone, attendee label и requested_by. Старый operation key с другими параметрами отклоняется. Заявка записывается через durable inbox/policy/approval в одной транзакции.
3. `trial_booking_decide`: только owner, одобрение/отказ конкретного hash-bound payload через существующий atomic runtime resolver. Общий approval endpoint не может обойти owner-проверку.
4. `trial_booking_execute`: повторно проверяет организацию, пользователя, инициатора и владельца, blocked/E2E и runtime kill switch, срок/статус согласования, payload hash, статус/время/курс занятия и вместимость. Блокировки операции, места и строк прав удерживаются до commit.
5. Booking ID, завершение outbox/workflow и обязательный audit сохраняются атомарно. Ошибка аудита откатывает всё. Unique operation index и operation lock предотвращают повторное исполнение; session lock сериализует конкуренцию за место.
6. `trial_booking_result` отдельно читает сохранённый результат. Только этот readback может показать в чате подтверждение и booking ID. Успешный первый execute сам по себе не является подтверждением UI.
7. `recover` ищет прежнюю операцию по user-scoped key; `recent` даёт владельцу заявки своей организации, оператору — только свои. Браузер сохраняет key и slot **до** mutation. После потери ответа повторяются исходные параметры/ключ, а не создаётся новая идентичность.

`runtime_claim_outbox_actions` сохранён с прежними ограничениями и одним исключением: общий worker не забирает `internal_trial_booking`. Исполнитель этой внутренней операции — транзакционный RPC. Это не отключение worker или общих защит.

## Изолированная среда и синтетические данные

Проект `nemo-trial-booking-local`, API `http://127.0.0.1:55431`, DB port 55432, приложение port 55439. Production URL/ключи не используются. Подготовка копирует восемь точных исходных миграций, перечисленных в `agent-hub/trial-booking-local/migration-manifest.json`; схему вручную не имитирует.

Fixture создаёт две организации, владельцев, оператора и пользователя без прав; курсы, свободные занятия, последнее место, заполненное занятие, отменённое и чужое занятие. Время — **Asia/Tashkent, UTC+05:00**, начало через семь дней от подготовки, чтобы fixture не протухал. Идентификаторы и локальный пароль генерируются заново. Чистая база перед запуском делает сценарий воспроизводимым.

Из корня репозитория, при установленных зависимостях и работающем Docker Linux engine:

```powershell
node agent-hub/trial-booking-local/setup.mjs prepare
node agent-hub/trial-booking-local/setup.mjs start
node agent-hub/trial-booking-local/setup.mjs reset
node agent-hub/trial-booking-local/integration.mjs
node agent-hub/trial-booking-local/app.mjs
```

Последняя команда запускает приложение с локальными env; загрузка проектных `.env` отключена. Синтетические логины после успешного seed находятся в защищённом и игнорируемом `agent-hub/trial-booking-local/local-login.json`; они не печатаются. Войти на `/auth`, открыть существующий чат и написать «пробное занятие». Владелец может выбрать заявку оператора из списка в карточке.

Очистка только изолированной базы:

```powershell
node agent-hub/trial-booking-local/setup.mjs reset
# либо остановка с удалением disposable local data
node agent-hub/trial-booking-local/setup.mjs stop
```

Не заменять эти команды `--linked`/production DB URL. Append-only audit не ослабляется ради очистки: сбрасывается только disposable локальная база. Детали — `agent-hub/trial-booking-local/README.md`.

## Результаты настоящих интеграционных проверок

**Не выполнены.** Docker CLI установлен, запуск Docker Desktop предпринят, но Linux engine не предоставляет `dockerDesktopLinuxEngine`. `setup start`, настоящий integration harness и app launcher завершаются с блокером среды. Никакая рабочая база вместо него не использована.

Доказательство: `agent-hub/trial-booking-local/results.json`: `status: blocked`, `tests: []`, `modelCalls: 0`, `mocks: false`. Это отсутствие выполненных тестов, не успешный результат.

Подготовлена 21 настоящая интеграционная проверка через Supabase Auth password login → JWT → общий прикладной клиент → PostgREST → RPC. Среди них:

- успешная запись и отдельный readback;
- отказ, выполнение до согласования, отсутствие прав и чужая организация;
- изменённые параметры, отзыв прав, blocked/E2E, изменённое/отменённое занятие;
- повтор execute и восстановление после намеренно отброшенного ответа уже выполненного HTTP-запроса;
- два разных конкурентных запроса на последнее место;
- конкурентные повторы одной операции и конкурентное создание заявки с одним ключом;
- ошибка обязательного audit insert с проверкой отката booking/result;
- недоступный loopback transport и сохранённая операция после восстановления.

Потеря ответа в тесте моделируется отбрасыванием настоящего committed HTTP-результата; это не физическое отключение кабеля. До запуска нельзя считать ни этот случай, ни конкурентность подтверждёнными.

## Отдельные проверки с подменами

- `node agent-hub/trial-booking-local/embedded-sql.mjs`: **PASS**, восемь миграций и пять групп поведения. Реальное исполнение SQL внутри PGlite, но Auth infrastructure/`auth.uid`, pgcrypto wrapper и realtime явно заменены. Проверены последовательный цикл, replay, запрет изменённых параметров/прав, заполненное место, blocked/E2E и rollback ошибки аудита. **Не доказывает настоящий JWT, PostgREST или многосессионную конкурентность.** Evidence: `embedded-results.json`.
- `npx vitest run tests/trial_booking_client.test.ts`: **6 PASS**, подменённый fetch; localhost restriction, JWT/account binding, сохранение key, отсутствие автоматического mutation retry и отдельный result read.
- `node agent-hub/trial-booking-ui-smoke.mjs`: **4 PASS**, настоящий смонтированный компонент, MOCK Auth/fetch, browser HTTP заблокирован. Execute-success при failed-readback не показывает подтверждение; refresh читает существующий результат без повторной mutation; remount восстанавливает ту же операцию; user switch скрывает прежнее подтверждение. Это не настоящая Auth-интеграция и не физический обрыв соединения.
- TypeScript build и targeted ESLint прошли. `npm run quality` **PASS**, 37 ESLint warnings, 0 errors. Первый запуск остановился на устаревшем `deploy/init-supabase.sql`; артефакт пересобран и повторный общий запуск прошёл. Итоговый лог: `agent-hub/trial-booking-local/quality-final.log`; первый: `quality.log`. Последнее уточнение локального представления времени отдельно повторно проверено embedded SQL; артефакт пересобран снова, к базе не применён.
- Браузерная приёмка карточки с реальной локальной авторизацией не выполнена из-за того же блокера среды.

## Независимое ревью

Codex `/root/function_register`, 2026-09-08, read-only. Проверены SQL, авторизация, executor, клиент, UI, локальная подготовка и model probe. Исправлены и повторно проверены: перехват операции общим worker, гонка отзыва прав, обход owner-policy, отсутствие blocked/E2E checks, доступ оператора к чужой операции, перенос старого UI-состояния между пользователями.

Открытых блокирующих замечаний к проверенному исходному коду не осталось. Ревью исходников **не заменяет** ещё не выполненную настоящую интеграцию и не разрешает production-деплой.

## Подготовленная проверка модели — НЕ ЗАПУЩЕНА

Dry run:

```powershell
node --experimental-strip-types agent-hub/trial-booking-model-probe.mjs
```

Он не обращается к модели. План: OpenRouter Chat Completions, явно выбранная `openai/gpt-4o-mini`, upstream `openai`, максимум **2 запроса**, до 16000 байт сериализованного prompt (консервативная оценка 20000 input tokens на запрос), до **512 output tokens** на запрос. Автоматические retries и model/provider fallback запрещены. Повтор запуска после неизвестного результата запрещает эксклюзивный файл evidence.

Оценка токенной стоимости: `2 × (20000 × 0.15 + 512 × 0.60) / 1e6 = $0.0066144`. Это верхняя оценка по указанным лимитам/тарифам, не фактическое списание; комиссии пополнения/налоги не включены. Provider max-price ограничивает тариф. Предложенные **$5 суммарно остаются НЕ СОГЛАСОВАНЫ**; подготовленный probe существенно уже этого потолка.

Источник тарифов и поддержки tools: [официальный endpoints API OpenRouter](https://openrouter.ai/api/v1/models/openai/gpt-4o-mini/endpoints), прочитан 2026-09-08; [ограничение маршрутизации и max_price](https://openrouter.ai/docs/guides/routing/provider-selection). Эти публичные metadata-запросы не являлись платной генерацией.

Исполнение отдельно требует флаг и явный маркер owner approval; в этом этапе они не устанавливались. Probe записывает requested model, actual model/provider, usage, факт tool call, SHA256 результата чтения и SHA256/длину ответа без текста/PII. Несовпадение модели/провайдера завершает тест ошибкой. Фактическая production-конфигурация и доступность модели этим планом не подтверждены.

## Оставшиеся блокеры

1. Работающий Docker Linux engine для настоящего Auth/PostgREST и конкурентных проверок.
2. Реальная браузерная приёмка подтверждения/readback/recovery после появления среды.
3. Отдельное явное разрешение владельца перед платной модельной пробой.

После устранения первого блокера надо запустить подготовленный harness и исправить найденные реальные ошибки, а не переименовывать embedded результаты в полноценные интеграционные.
