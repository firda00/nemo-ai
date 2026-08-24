# ADR 001: Durable Operations Runtime

- **Статус:** Proposed
- **Дата:** 2026-08-24
- **Владельцы решения:** Nemo AI architecture, security и runtime teams
- **Область:** исполнение бизнес-процессов, интеграционные события, внешние действия и аудит
- **Связанный источник продукта:** `NEMO_AI_SPEC.md`

## Контекст

Nemo AI уже содержит несколько проверенных примитивов надёжного исполнения:

- `public.autonomous_run_checkpoints` сохраняет этапы автономных прогонов, использует lease,
  `claim_token`, ограниченные повторы и `FOR UPDATE SKIP LOCKED`;
- `public.org_memory_outbox` транзакционно отделяет обязательный результат от необязательной
  обработки памяти;
- `public.approval_requests` отделяет решение человека от фактического исполнения действия;
- `public.crm_sync_logs`, `public.webhook_events` и специализированные webhook-таблицы защищают
  отдельные интеграции от повторной доставки;
- контрактные тесты проверяют tenant isolation, идемпотентность, публикацию агентов и критические
  security-инварианты.

Эти механизмы появились в разных подсистемах и решают локальные задачи. У них нет общей модели
входящего события, жизненного цикла workflow, policy decision, внешнего действия и причинного
аудита. Дальнейшее копирование локальных очередей увеличит вероятность расхождения семантики,
гонок, потерянных действий и несовместимых способов восстановления.

Nemo нужен единый durable runtime для реальной операционки бизнеса: CRM, лидов, телефонии,
сообщений, документов и последующих интеграций. Он должен переживать повторную доставку событий,
падение процесса, потерянный HTTP-ответ, перезапуск контейнера и параллельную работу нескольких
воркеров без нарушения tenant isolation и без самовольных критических действий.

## Решение

Nemo создаёт общий **Durable Operations Runtime** как закрытый слой исполнения. Внедрение идёт
аддитивно по strangler pattern: существующие механизмы продолжают работать, пока новый runtime не
пройдёт shadow/canary-проверки и каждый старый consumer не будет перенесён отдельно.

Решение состоит из следующих частей:

1. приватная PostgreSQL-схема `runtime` для состояния исполнения;
2. Inbox для нормализованных входящих событий;
3. конечный автомат workflow с durable transitions и checkpoints;
4. lease, `claim_token` и монотонный `lease_epoch` для fencing зомби-воркеров;
5. Policy Engine и существующая очередь Human Approval перед критическими side effects;
6. транзакционный Outbox для внешних действий;
7. неизменяемый причинный audit trail;
8. retries, dead-letter и circuit breakers;
9. безопасные feedback events, которые становятся кандидатами в eval-наборы, а не автоматически
   меняют production-логику.

## Цели

- Не терять принятые события и сохранённые переходы при падении процесса.
- Не допускать параллельное владение одним workflow двумя актуальными воркерами.
- Не выполнять одно логическое внешнее действие повторно, когда провайдер поддерживает
  idempotency или Nemo может выполнить reconciliation.
- Проверять policy и approval перед каждым критическим side effect.
- Обеспечить структурную tenant integrity, не полагаясь только на дисциплину application-кода.
- Восстанавливать причинную цепочку: событие → решение → approval → действие → результат.
- Поддержать безопасный dry-run replay без повторного исполнения внешних действий.
- Переиспользовать существующие механизмы Nemo и постепенно свести их к общему runtime.

## Не-цели

- Немедленная замена всех 82 Edge Functions или существующих очередей.
- Переписывание runtime на Rust/Go до измеренной необходимости.
- Обещание истинного exactly-once execution через произвольные внешние API.
- Автоматическое изменение весов моделей, политик или production-кода по сырым данным клиентов.
- Объединение документов, памяти или PII разных tenants в общий датасет.
- Заявление, что durable runtime сам по себе является AGI.

## Семантика доставки

Nemo использует **at-least-once delivery** событий и заданий. Для внешних эффектов runtime стремится
к **effectively-once effect** посредством:

- уникальных входящих и исходящих idempotency keys;
- fencing tokens;
- сохранения результата провайдера;
- проверки состояния перед повтором;
- reconciliation после неоднозначного ответа.

Если внешний провайдер не поддерживает idempotency и невозможно проверить результат, runtime не
называет действие exactly-once. Такое действие требует более строгой policy, approval или ручного
разбора после неопределённого результата.

## Первый shadow connector: amoCRM

Первым shadow connector выбран **amoCRM**. Решение принято потому, что у Nemo уже есть единый CRM
контракт, детерминированный idempotency key, gateway-приём событий и журнал `crm_sync_logs`, а у
первого пилота есть наблюдаемый бизнес-процесс: лиды, задачи и просроченные follow-ups.

Цель shadow-этапа — проверить ingestion, дедупликацию, tenant integrity, state transitions, policy
и наблюдаемость Durable Runtime на реальном потоке без изменения данных amoCRM и без влияния на
ответ старого обработчика.

### Реальная граница текущего CRM-контракта

Текущий `UnifiedCRMEventSchema` поддерживает только:

- `DEAL_STAGE_CHANGED`;
- `NEW_CONTACT_CREATED`;
- `TASK_COMPLETED`.

Поэтому первый shadow-релиз принимает только эти события. Пропущенные звонки, создание входящей
задачи и другие события со скриншота не объявляются поддержанными до отдельного расширения контракта,
fixtures и provider-specific tests. Нормализатор не угадывает отсутствующий event type по тексту или
произвольным custom fields.

Текущий gateway защищён общим `x-nemo-crm-secret`, но не проверяет нативную подпись amoCRM. Прямой
provider adapter допускается только после реализации и проверки официальной схемы подписи, replay
window и key rotation. До этого shadow получает события через контролируемый внутренний адаптер.

`account_id` нельзя брать из непроверенного webhook body. Адаптер выводит tenant из найденного
`crm_integrations`/endpoint credential и передаёт подтверждённый account в runtime отдельно от
payload. Переданный в старом unified body `tenantId` считается legacy-полем и обязан совпасть с
подтверждённой интеграцией либо событие отклоняется.

`externalDealId` не является event ID: одна сделка законно меняется много раз. В первом shadow
релизе `external_event_id` строится из существующей детерминированной identity
`crmIdempotencyKey(provider, INBOUND, eventType, externalDealId, occurredAt)`. Использовать один
`externalDealId` в inbox UNIQUE запрещено — это молча потеряло бы второе настоящее изменение той же
сделки. После появления нативного provider event/delivery ID контракт мигрирует на него с явной
версией identity algorithm.

### Shadow execution mode

Shadow и live являются режимами исполнения, а не одним смешанным статусом очереди. Предлагаемое
действие сохраняется в outbox со следующими независимыми атрибутами:

- `execution_mode = 'shadow'`;
- `status = 'simulated'` после успешного расчёта;
- полный action payload не выдаётся live connector worker;
- hash, policy decision, причины и сравнимый результат сохраняются для оценки.

Значение `shadow_simulated` не добавляется в общий status: смешивание режима и жизненного состояния
делает claim-условия хрупкими. DB constraint и claim RPC обязаны гарантировать, что строка с
`execution_mode = 'shadow'` никогда не переходит в `pending`/`processing` и не выбирается live
воркером. У shadow-консьюмера нет egress credentials amoCRM. Feature flag/kill switch отключает
shadow ingestion без изменения legacy traffic.

### Первый shadow flow

1. Gateway проверяет внутренний секрет, contract и подтверждённую привязку integration → account.
2. Legacy handler продолжает существующее поведение и остаётся production source of truth.
3. Копия нормализованного поддерживаемого события передаётся в `runtime_ingest_event`.
4. Inbox атомарно создаёт событие либо возвращает существующее по
   `(account_id, provider, external_event_id)`.
5. Создаётся/возвращается workflow в `received`; его contract/version фиксируется.
6. Runtime классифицирует событие, строит policy decision и предлагаемое действие.
7. Предлагаемое действие сохраняется только как shadow/simulated; внешний API не вызывается.
8. Comparator связывает legacy outcome и shadow outcome по correlation/idempotency key.
9. Расхождение, latency, дубликат, отказ нормализации и redaction failure попадают в защищённый
   audit/metrics контур.

Ошибка shadow runtime не меняет HTTP-ответ, который получил бы legacy handler, но обязана создавать
метрику и alert. До canary отсутствие shadow-записи не должно вызывать повтор webhook провайдером и
тем самым менять production-нагрузку.

Текущий gateway legacy path фиксирует accepted/duplicate/rejected событие в `crm_sync_logs`, но сам
не формирует бизнес-решение уровня «создать задачу менеджеру». Поэтому первая доступная parity —
ingestion/dedup/status. Decision parity считается только там, где legacy consumer сохраняет
структурированный outcome. Отсутствующий legacy outcome маркируется `no_baseline`, а не выдумывается
из текста лога.

### Метрики допуска к canary

- accepted/duplicate/rejected события по типу и account;
- доля событий, для которых создан ровно один ожидаемый workflow;
- decision parity и матрица расхождений с legacy: same, shadow-only, legacy-only, conflict;
- false positive/false negative для просроченных задач и необработанных лидов на размеченной выборке;
- ingest-to-decision latency p50/p95/p99;
- shadow processing failures, lease recoveries и stale-fence rejections;
- число потенциальных side effects и подтверждение, что реально выполнено **ноль**;
- PII/redaction violations и oversized payload rejections;
- возраст самой старой необработанной shadow-записи.

Пороговые SLO и размер canary cohort утверждаются до включения canary, а не подбираются после
просмотра результатов.

### Pilot payload, PII и retention baseline

Лимиты считаются по UTF-8 байтам канонического JSON, а не по числу JavaScript-символов:

- нормализованный `inbox_events.payload`: не более 64 KiB;
- `workflow_runs` operational context: не более 64 KiB;
- один transition/policy/audit details payload: не более 16 KiB;
- сохранённый error detail: не более 2 KiB и без stack trace/secret;
- большие тела, файлы и документы хранятся как private encrypted evidence objects; runtime хранит
  только reference, media type, byte size, hash и retention class.

Полный телефон/email допускается только в минимальном operational/evidence-контуре, если он нужен
для утверждённой задачи. Audit, metrics и обычные логи содержат mask/token/hash. Маска не считается
анонимизацией и не используется как разрешение на cross-tenant обучение. Secrets, access tokens и
provider credentials запрещены во всех payload.

Baseline shadow pilot:

- raw evidence и нормализованный inbox payload — 30 дней hot retention;
- operational context успешно завершённого workflow — 30 дней;
- audit metadata без raw PII хранится дольше по отдельной tenant/legal policy;
- failed/dead-letter данные не удаляются обычным success-cleanup, но получают отдельный срок и
  операторскую процедуру разрешения;
- удаление/архивирование выполняется audited retention job и не реализуется каскадным удалением
  workflow.

Эти сроки являются пилотным техническим baseline, а не универсальным юридическим обещанием. Перед
canary они сверяются с договором клиента, требованиями региона и процедурой data subject deletion.

## Архитектурные границы

```text
amoCRM / Facebook / телефония / Telegram
                    │
                    ▼
       подписанный интеграционный адаптер
                    │
                    ▼
     public.runtime_ingest_event(...) RPC
                    │
                    ▼
 runtime.inbox → workflow → policy/approval
                    │
                    ▼
             runtime.outbox
                    │
                    ▼
        connector worker → внешний API
                    │
                    ▼
       transition + audit + следующий шаг
```

Интеграционные адаптеры отвечают за проверку подписи источника и преобразование формата. Runtime
отвечает за дедупликацию, состояние, порядок переходов, policy, исполнение и аудит. Модель не пишет
в runtime напрямую: она возвращает предложение, которое валидируется схемой и проходит policy.

## Приватная схема и RPC-граница

Таблицы размещаются в схеме `runtime`. Эта схема:

- отсутствует в `PGRST_DB_SCHEMAS`;
- не добавляется в список exposed schemas Supabase;
- закрыта от `PUBLIC`, `anon` и `authenticated`;
- имеет безопасные default privileges;
- не предоставляет прикладным ролям прямые `SELECT`, `INSERT`, `UPDATE` или `DELETE`.

Все runtime-мутации выполняют точечные функции-обёртки в схеме `public`, доступные только
`service_role`. Каждая функция:

- объявлена `SECURITY DEFINER`;
- использует `SET search_path = ''`;
- обращается к объектам по полностью квалифицированным именам;
- проверяет допустимые статусы, размеры и структуру входа;
- выполняет связанные записи одной транзакцией;
- не принимает tenant identity из непроверенного payload;
- не возвращает секреты, внутренние ошибки SQL или чужие данные.

Interactive-запросы пользователя проходят через Edge Function/API, который проверяет JWT,
account membership и роль, а затем вызывает закрытый RPC. Наличие `service_role` у вызывающего
кода не считается tenant boundary: boundary обязан быть установлен до RPC и подтверждён внутри
операции по связанным идентификаторам.

## Логическая модель данных

Имена окончательных таблиц утверждаются в Phase 1, но модель содержит:

### `runtime.inbox_events`

Неизменяемый нормализованный вход:

- `id`, `account_id`, `provider`, `event_type`, `external_event_id`;
- `correlation_id`, `causation_id`, `occurred_at`, `received_at`;
- ограниченный нормализованный payload либо ссылка на зашифрованное evidence-хранилище;
- `payload_hash`, версия контракта и результат нормализации;
- `UNIQUE (account_id, provider, external_event_id)`.

Повторный ingest не создаёт строку со статусом `duplicate`. `ON CONFLICT` атомарно возвращает уже
существующее событие и связанный workflow. Одинаковый внешний ID разрешён у разных tenants.

### `runtime.workflow_runs`

Текущий материализованный снимок выполнения:

- `UNIQUE (account_id, id)` как родительский ключ tenant-safe ссылок;
- ссылка на inbox event и версию workflow definition;
- текущий бизнес-статус;
- ограниченный operational state без секретов и больших документов;
- `claim_token`, `lease_epoch`, `lease_holder`, `lease_until`;
- `attempt_count`, `max_attempts`, `next_attempt_at`, `last_error_code`;
- timestamps и terminal reason.

Долгоживущие статусы ограничены `CHECK` constraint:

- `received`;
- `queued`;
- `running`;
- `waiting_for_policy`;
- `waiting_for_approval`;
- `retry_scheduled`;
- `completed`;
- `failed`;
- `dead_letter`;
- `cancelled`.

`classified` и `checkpointed` являются типами переходов, а не долгоживущими статусами.

### `runtime.workflow_transitions`

Append-only журнал переходов:

- `(account_id, workflow_id)` ссылается на тот же tenant в `workflow_runs`;
- `transition_seq` уникален внутри workflow;
- `from_status`, `to_status`, `transition_type` имеют allowlist;
- хранятся actor, correlation/causation, версия workflow/policy и hash evidence;
- payload ограничен по размеру и не дублирует исходные документы.

Переход создаётся только вместе с обновлением materialized state через один RPC.

### `runtime.policy_decisions`

Неизменяемый результат Policy Engine:

- tenant-safe связь с workflow и переходом;
- `decision` ограничен значениями `allow`, `deny`, `require_approval`;
- фиксируются ruleset/version, причины, входной hash и action hash;
- после создания решение не редактируется.

### `runtime.outbox_actions`

Очередь side effects:

- tenant-safe связь с workflow, transition и policy decision;
- connector, action type, ограниченный payload/reference и payload hash;
- `UNIQUE (account_id, connector_id, idempotency_key)`;
- независимый `execution_mode` со значениями `shadow` и `live`; shadow нельзя claim для egress;
- статусы `pending`, `processing`, `retry_scheduled`, `completed`, `failed`, `dead_letter`,
  `cancelled`, а также терминальный `simulated` только для shadow;
- собственные `claim_token`, `lease_epoch`, `claimed_at`, `lease_until`;
- attempts, max attempts, next attempt, provider result/reference и last error code.

Зависшее `processing` действие возвращается в работу после истечения lease. Завершить действие
может только текущий владелец claim с актуальной эпохой.

### `public.approval_requests`

Существующая таблица расширяется nullable-полями для обратной совместимости:

- `workflow_id`, `transition_id`, `policy_decision_id`, `outbox_action_id`;
- `policy_version`, `action_payload_hash`;
- tenant-safe составные FK для каждой runtime-связи.

Approval меняет только состояние решения. Оно не вызывает внешний API. Отдельный атомарный RPC
после одобрения переводит workflow и делает outbox action доступным исполнителю.

### `runtime.audit_events`

Неизменяемый причинный журнал:

- tenant-safe workflow linkage;
- actor type/id, event type, correlation и causation;
- ссылки/hashes входа, policy, approval, action и результата;
- версия runtime-контракта;
- запрет обычных `UPDATE` и `DELETE`.

Workflow не удаляются физически. Для retention используются документированная архивная процедура,
tombstone и отдельное привилегированное обслуживание. Вмешательство администратора также создаёт
audit event.

### `runtime.dead_letters`

Содержит tenant-safe ссылку на исходный workflow/event/action, классифицированную ошибку, историю
попыток, evidence reference и поля разрешения: кто, когда, почему и каким действием закрыл инцидент.
Простой boolean `resolved` недостаточен.

### `runtime.connector_health`

Durable-состояние circuit breaker по tenant, connector и операции:

- `closed`, `open`, `half_open`;
- failure window и threshold;
- `opened_until`, cooldown, last success/failure;
- ограниченное число half-open probes;
- атомарный claim единственного пробного запроса.

### `runtime.feedback_events`

Структурированное исправление человека:

- actor, workflow/transition, reason code, before/after references;
- PII redaction и tenant ownership;
- признак согласия на использование в eval;
- статус review.

Feedback становится кандидатом в eval case. Он не изменяет production prompt, policy, модель или
код автоматически.

## Tenant integrity

`account_id` входит во все runtime-сущности. Каждая дочерняя ссылка использует составной FK:

```sql
foreign key (account_id, workflow_id)
  references runtime.workflow_runs(account_id, id)
  on delete restrict
```

Родительские таблицы имеют соответствующий `UNIQUE (account_id, id)`. Аналогичные связи нужны для
transition, policy decision и outbox action. UUID без `account_id` не считается tenant-safe FK.

RLS используется как defense in depth там, где таблица технически доступна прикладной роли. Для
закрытых runtime-таблиц основными границами являются отсутствие grants, отсутствие exposed schema,
составные FK и RPC-инварианты. `service_role` обходит RLS, поэтому один RLS не считается достаточной
защитой воркера.

## Lease и fencing

Claim выполняется одной транзакцией:

1. выбирает доступную или просроченную работу через `FOR UPDATE SKIP LOCKED`;
2. увеличивает `lease_epoch`;
3. создаёт новый `claim_token`;
4. устанавливает bounded `lease_until`;
5. увеличивает attempt count только по определённому правилу;
6. возвращает claim без выдачи чужого tenant-контекста.

Renew/transition/finish требуют одновременно:

- правильный workflow/action ID;
- правильный `account_id`;
- актуальные `claim_token` и `lease_epoch`;
- допустимый исходный статус;
- неистёкший lease либо явно документированную recovery-операцию.

Старый или потерявший lease воркер не может записать переход, завершить действие или продлить
чужую аренду.

## Policy и критические действия

Policy проверяется перед постановкой критического действия в исполнимое состояние. Минимально
критическими считаются:

- отправка клиентского сообщения;
- инициирование звонка;
- финансовое действие;
- удаление или существенное изменение данных;
- изменение CRM-статуса с бизнес-последствиями;
- передача данных новому внешнему получателю;
- изменение permissions, secrets, billing или policy.

Policy decision фиксирует версию правил и hash действия. Approval действительно только для того же
hash. Изменение payload после approval требует нового policy decision и нового approval.

## Audit и replay

Audit append-only на прикладном уровне. Прямые права изменения отсутствуют; защитный trigger
отклоняет обычные `UPDATE/DELETE`. Обход для retention/архивации оформляется отдельной процедурой,
ролью и аудитом.

Replay по умолчанию:

- читает зафиксированные версии входа, workflow и policy;
- выполняется в sandbox/dry-run;
- создаёт новый replay ID и отдельный audit trail;
- не использует production outbox;
- никогда не повторяет side effects без нового явного approval.

## Payload, PII и retention

- JSONB имеет проверяемый предел размера на входе и в БД.
- Большие документы, медиа и исходные webhook bodies хранятся как зашифрованные evidence objects,
  а в runtime остаются reference, media type, size и hash.
- Secrets, access tokens и service credentials никогда не входят в transitions или audit.
- Нормализованный payload содержит только данные, нужные workflow.
- Для inbox, transitions, audit, dead letters и evidence определяются отдельные retention policies.
- Cross-tenant обучение по raw payload запрещено.
- Обезличенные паттерны могут использоваться только по утверждённой политике и с необходимым
  согласием.

Hash вычисляется по документированному каноническому представлению. Алгоритм и версия canonical
format сохраняются рядом с hash, чтобы последующее изменение сериализации не разрушило проверку.

## Первый production loop после shadow/canary

Первый вертикальный сценарий:

1. принять поддерживаемое и аутентифицированное событие amoCRM;
2. нормализовать и атомарно дедуплицировать событие;
3. создать или вернуть связанный workflow;
4. классифицировать обращение и определить следующий безопасный шаг;
5. проверить рабочее время, согласие, канал и policy;
6. создать CRM-задачу либо запросить approval для сообщения/звонка;
7. выполнить разрешённое действие через outbox;
8. сохранить provider result, transition и audit;
9. контролировать срок и эскалировать просрочку;
10. выполнить reconciliation или dead-letter при неоднозначном результате.

## Наблюдаемость

Минимальные метрики:

- ingest accepted/duplicate/rejected по provider и tenant;
- возраст oldest queued workflow/outbox action;
- lease claims, expirations и stale-fence rejections;
- attempts, retries, dead letters и время восстановления;
- policy allow/deny/approval и время ожидания человека;
- connector latency/error/rate-limit и circuit state;
- ambiguous external outcomes и reconciliation success;
- end-to-end latency и доля просроченных CRM follow-ups.

Логи и метрики не содержат raw PII. Correlation ID позволяет связать технические записи с
защищённым audit trail.

## План внедрения

### Phase 0 — ADR и инварианты

- Утвердить этот ADR после architecture/security review.
- Зафиксировать state/transition matrix и payload contracts.
- Согласовать retention, размеры и первый connector.

### Phase 1 — закрытая схема и таблицы

- Создать schema/tables/constraints/indexes.
- В той же миграции закрыть схему, таблицы и default privileges.
- Расширить `public.approval_requests` nullable-полями.
- Не предоставлять consumer grants и не переключать production traffic.

### Phase 2 — security-definer RPC

- Реализовать ingest, claim, renew, transition, policy, approval release, outbox claim/finish,
  reconciliation и dead-letter RPC.
- Выдать execute только `service_role`.
- Добавить структурированные error codes без утечки SQL details.

### Phase 3 — контрактные и конкурентные тесты

- Проверить SQL-инварианты статически.
- Провести реальные параллельные транзакции против тестовой БД.
- Проверить negative auth/tenant paths.

### Phase 4 — shadow mode

- Копировать поддерживаемые amoCRM-события в runtime без side effects.
- Начать с `DEAL_STAGE_CHANGED`, затем включать `NEW_CONTACT_CREATED` и `TASK_COMPLETED` отдельно.
- Сравнивать решения со старым контуром по общей correlation/idempotency identity.
- Измерять дубликаты, latency, recovery и расхождения.

### Phase 5 — canary

- Разрешить безопасное `create_crm_task` ограниченной группе tenants.
- Сообщения и звонки оставить за approval.
- Иметь kill switch и автоматическую остановку по SLO/error budget.

### Phase 6 — постепенная миграция

- Переносить consumers по одному.
- Не удалять `autonomous_run_checkpoints`, `org_memory_outbox` и другие примитивы до подтверждения
  эквивалентности, завершения backfill и отдельного решения о выводе из эксплуатации.

## Rollback

Runtime внедряется аддитивно. Rollback означает:

- выключить новых producers/consumers feature flag;
- остановить outbox claims;
- вернуть traffic на прежний обработчик;
- сохранить runtime rows для расследования;
- не удалять схему и не откатывать audit history.

Миграции первой версии не должны удалять или менять семантику существующих таблиц, кроме добавления
nullable runtime-ссылок в `approval_requests`.

## Обязательные проверки

До canary должны проходить сценарии:

1. два воркера одновременно claim один workflow — владелец только один;
2. зомби-воркер завершает шаг после нового claim — fencing отклоняет запись;
3. один webhook доставлен десять раз — создано одно событие и ожидаемое число workflow;
4. одинаковый external ID у разных tenants — события независимы;
5. child row пытается сослаться на workflow другого tenant — FK отклоняет запись;
6. потерян ответ внешнего API — повтор не создаёт второй эффект либо уходит в reconciliation;
7. зависшее `processing` возвращается после lease expiry;
8. retries исчерпаны — создаётся один dead-letter;
9. approval другого account или для другого payload hash отклоняется;
10. прямой доступ `anon`/`authenticated` к runtime невозможен;
11. обычные `UPDATE/DELETE` audit event отклоняются;
12. replay не создаёт production side effects;
13. oversized/invalid payload отклоняется до сохранения;
14. connector circuit допускает только ограниченный half-open probe;
15. выключение feature flag возвращает traffic на старый контур без потери входа.

Статические regex-контракты не заменяют интеграционные тесты конкурентности.

## Последствия

### Положительные

- Единая модель надёжности вместо новых локальных очередей.
- Восстанавливаемое исполнение и доказуемая причинность.
- Снижение риска дублей, потерянных действий и tenant leakage.
- Основа для replay, human feedback, контролируемых eval и enterprise-аудита.
- Возможность постепенно переносить интеграции без полного переписывания платформы.

### Отрицательные

- Увеличивается стоимость схемы, тестов и эксплуатации.
- Любой новый side effect требует contract, policy, idempotency и observability.
- Понадобятся retention, архивирование и операционные процедуры dead-letter/reconciliation.
- Миграция существующих обработчиков займёт несколько независимых релизов.
- `service_role` остаётся высокорисковой возможностью и требует минимизации поверхности воркера.

## Альтернативы

### Продолжать добавлять специализированные очереди

Отклонено: быстро локально, но размножает несовместимые статусы, retries, leases и способы аудита.

### Немедленно внедрить внешний workflow engine

Отложено: Temporal или аналог может стать будущим execution backend, но не отменяет tenant model,
policy, approvals, audit и integration contracts Nemo. Сначала нужны собственные инварианты и
измерение нагрузки; затем backend можно заменить за стабильной runtime-границей.

### Переписать существующие механизмы одним релизом

Отклонено: blast radius и невозможность безопасного rollback слишком велики.

## Открытые вопросы

- Где хранится encrypted evidence и как выполняется per-tenant key rotation?
- Как версионируются workflow definitions и policy rulesets?
- Какие действия могут быть auto-allowed в первом canary?
- При каком объёме audit/inbox потребуется partitioning?
- Какой операторский интерфейс нужен для dead-letter и reconciliation?
- Какие SLO и error budgets утверждаются для первого пилота?
- Какая tenant/legal policy заменяет 30-дневный технический baseline после shadow-пилота?

## Условия перевода ADR в Accepted

ADR получает статус `Accepted`, когда:

- architecture и security reviewers согласовали инварианты;
- утверждены state transition matrix и threat model;
- выбор amoCRM и pilot payload/PII/retention baseline подтверждены владельцем пилота;
- подготовлен план Phase 1/2 миграций без промежуточно открытого состояния;
- подготовлены конкурентные и tenant-negative тесты;
- назначены владельцы runtime, incident response и rollback;
- подтверждено, что существующие контуры не удаляются до отдельного решения.
