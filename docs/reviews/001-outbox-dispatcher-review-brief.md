# Review Brief: диспетчер outbox (EffectGate) — ADR 001 Phase 4→5

- **Дата:** 2026-08-27
- **Тип:** architecture + security review brief для Codex (read-only)
- **Связанные документы:** `docs/adr/001-durable-operations-runtime.md` (статус: **Proposed**), `NEMO_AI_SPEC.md`
- **Правило проекта:** `CLAUDE.md` — agent routing и external integrations требуют обсуждения с Codex **до** реализации и повторного ревью после появления диффа.
- **Статус брифа:** ожидает ревью. Реализация не начата.
- **Верификация:** все пути, номера строк, счётчики и SQL-цитаты в §2 перепроверены по репозиторию 2026-08-27 независимым проходом. Открытый вопрос §4.1B (проверяет ли claim RPC kill switch в той же транзакции) в ходе верификации закрыт — да, проверяет.

---

## 0. Как запустить ревью

```powershell
cd "C:\Users\firda\nemo-ai"
powershell -ExecutionPolicy Bypass -File .\agent-hub\start-team.ps1
```

Codex вызывается с `sandbox: read-only`. `threadId` сохраняется в `agent-hub/state/codex-threads.json`
под ключом `outbox-dispatcher`; продолжение обсуждения — через `codex-reply` с этим же `threadId`.

Промпт для первого сообщения — в §9.

---

## 1. Зачем этот бриф

ADR 001 описывает Durable Operations Runtime, в котором **единственный путь к внешнему эффекту** —
`policy decision → outbox → connector worker → внешний API`. Схема, RPC и инварианты БД реализованы.
**Сам connector worker не написан, и ни один production-путь через outbox не проходит.**

Одновременно в проде работает параллельный, несовместимый механизм защиты
(`blocksExternalActions`), а вендорские API вызываются inline из Edge Functions.

Ревью нужно, чтобы утвердить конструкцию диспетчера и порядок миграции **до** написания кода,
потому что задача затрагивает agent routing, external integrations и security-инварианты сразу.

---

## 2. Проверенное состояние кода

Все факты ниже получены грепом по репозиторию 2026-08-27, `node_modules` исключены.

### 2.1 Что готово

| Фаза ADR 001 | Состояние | Evidence |
|---|---|---|
| Phase 0 (ADR + инварианты) | **не завершена** — ADR в статусе `Proposed` | `docs/adr/001-durable-operations-runtime.md:3` |
| Phase 1 (схема, таблицы, constraints) | готово | `supabase/migrations/20260824120000_durable_runtime_phase1.sql` |
| Phase 2 (SECURITY DEFINER RPC) | готово | `supabase/migrations/20260824140000_durable_runtime_phase2_rpc.sql` |
| Phase 3 (контрактные/конкурентные тесты) | готово | `tests/runtime_schema_invariants.sql`, `tests/runtime_rpc_invariants.sql`, `tests/runtime_phase3_invariants.sql` |
| Phase 4 (shadow mode) | **частично** — только ingest | см. §2.3 |
| Phase 5 (canary) | заблокирована отсутствием диспетчера | — |

Инварианты shadow действительно закреплены в БД (не только в коде). Два ограничения ниже **не соседние** и приведены в обратном порядке относительно файла: unique — `phase1.sql:348-350`, check — `phase1.sql:369-375`.

```sql
-- phase1.sql:369-375
constraint outbox_actions_shadow_invariants_check check (
  (execution_mode = 'shadow' and status = 'simulated')
  or (execution_mode = 'live' and status in ('pending','processing','retry_scheduled',
      'completed','failed','dead_letter','cancelled'))
),
-- phase1.sql:348-350
constraint outbox_actions_idempotency_key unique (account_id, connector_id, idempotency_key_hash)
```

RPC сам выставляет режим (`phase2_rpc.sql:672` и `:931`, оба вхождения идентичны):

```sql
v_status := case when v_run.execution_mode = 'shadow' then 'simulated' else 'pending' end;
```

### 2.2 Типизированный клиент существует, но его исполнительная половина не используется

`supabase/functions/_shared/runtime.ts` объявляет `RuntimeClient` с методами `ingestEvent`,
`claimWorkflows`, `checkpointAndTransition`, `acquireConnectorPermit`, `recordConnectorSuccess`,
`recordConnectorFailure`, `transitionWorkflow`, `recordPolicyDecision`, `enqueueOutboxAction`,
`resolveApprovalAndEnqueue`, `claimOutboxActions`, `finishOutboxAction`.

Греп по всем вызовам цепочки policy→outbox вне самого `runtime.ts`:

| Метод | Вызовы в production-коде | Единственные вызовы вообще |
|---|---|---|
| `recordPolicyDecision` | **0** | — |
| `enqueueOutboxAction` | **0** | `tests/e2e_multimodal_flow.test.ts:481` |
| `resolveApprovalAndEnqueue` | **0** | — |
| `claimOutboxActions` | **0** | `agent-hub/runtime-client-behavior.mjs:109` |
| `finishOutboxAction` | **0** | — (только определение) |

**Вывод: ни одно действие в истории системы не проходило через policy decision и не переходило
в `live`.** Аутбокс — пустая труба с проверенными стенками.

### 2.3 Что реально вызывает runtime

Важно не переупростить: **без вызовов остались именно пять методов цепочки policy→outbox** из §2.2. Методы жизненного цикла workflow и здоровья коннекторов уже используются — их вызывает shadow-воркер amoCRM (`npm run amocrm:worker`):

| Метод | Вызывающий |
|---|---|
| `claimWorkflows` | `agent-hub/workers/amocrm-enrichment.ts:202` |
| `checkpointAndTransition` | `agent-hub/workers/amocrm-enrichment.ts:170` |
| `transitionWorkflow` | `agent-hub/workers/amocrm-enrichment.ts:60,81` |
| `acquireConnectorPermit` | `agent-hub/amocrm/circuit-breaker.ts:7` |
| `recordConnectorSuccess` | `agent-hub/amocrm/circuit-breaker.ts:13` |
| `recordConnectorFailure` | `agent-hub/amocrm/circuit-breaker.ts:24` |

Этот воркер работает строго в shadow: передаёт `executionMode: 'shadow'` (`:206`) и отклоняет любой не-shadow claim (`:110`).

`ingestEvent` вызывается только в shadow-режиме:

- `agent-hub/server/gateway.ts:366` — `ingestCrmEventInShadow(...)`
- `agent-hub/server/amocrm-native.ts:201` — `executionMode: 'shadow'`
- `agent-hub/server/vision-gateway.ts:112` — вызов `ingestEvent(`; литералы режима на `:106` (`execution_mode`, snake_case, защитный блок), `:117` и `:148` (`executionMode`)
- `supabase/functions/_shared/runtimeCrm.ts:42` — `executionMode: 'shadow'` захардкожен

**То есть недостающее звено — ровно исполнительная половина: policy decision, постановка в аутбокс и диспетчеризация.** Приём событий и управление состоянием workflow уже обкатаны на реальном shadow-трафике.

### 2.4 Параллельный механизм защиты

`supabase/functions/_shared/productionE2E.ts`:

```ts
// productionE2E.ts:5-8; перенос строки и комментарий добавлены здесь для читаемости
export async function blocksExternalActions(db: any, accountId: string): Promise<boolean> {
  const { data, error } = await db.from('accounts').select('is_production_e2e').eq('id', accountId).maybeSingle()
  return Boolean(error || !data || data.is_production_e2e === true)   // ← fail-closed
}
```

**109 вхождений в 45 файлах** внутри `supabase/functions/`: 1 определение, 44 импорта и **64 фактических вызова в 44 файлах**. Для оценки объёма миграции значимо именно последнее число. Свойства:

- привязан к признаку аккаунта `accounts.is_production_e2e`, **не к прогону** — то есть это не
  execution mode в терминах ADR;
- бинарный: блокирует, но **не записывает, что действие было бы выполнено** — теряется именно тот
  артефакт, ради которого нужен shadow;
- копируется в каждый call site, единой точки нет.

Полуцентрализованное применение — в диспетчере инструментов чата:

```ts
// supabase/functions/_shared/tools.ts:312-316
const internalOnly = new Set(['run_code', 'book_appointment'])
const publicReads = new Set(['read_webpage','web_search','notion_search','notion_read_page',
  'wb_products','wb_orders','ozon_products','ozon_orders','uzum_shops','uzum_products'])
if (!internalOnly.has(name) && !publicReads.has(name)
    && await blocksExternalActions(ctx.db, ctx.accountId)) {
  return { ok: false, result: 'External tools are disabled for the isolated production test account.' }
}
```

Классификация «читает / действует» существует, но живёт в двух руками поддерживаемых `Set`
внутри функции. Новый инструмент по умолчанию попадает в категорию «действует» — это
fail-closed и это правильно, но список не декларативен и не виден policy.

### 2.5 Вендорские вызовы делаются inline

**139 вызовов `fetch(` в 46 файлах** `supabase/functions/` (подсчёт подтверждён). Каждый коннектор открывает своё соединение к вендору напрямую:
`_shared/amocrm.ts`, `_shared/telegram.ts`, `_shared/meta.ts`, `_shared/metaPost.ts`,
`_shared/twitter.ts`, `_shared/reddit.ts`, `_shared/google.ts`, `_shared/uzum*.ts`,
`_shared/marketplace.ts`, `_shared/media.ts`, `_shared/transcribe.ts`, `_shared/browser.ts`,
плюс ветки `execProvider()` в `_shared/tools.ts:208-304` (GitHub, Slack, HubSpot, Notion, Airtable,
Bitrix24, Stripe).

Дубли одной и той же интеграции в разных файлах (кандидаты на схлопывание до миграции):

- **Google — четыре независимые реализации:** `_shared/google.ts` (только oauth2 + Sheets; Docs там нет), `_shared/tools.ts:129-188` (`execGoogle`, включая `docs.googleapis.com` на `:185,188`), `supabase/functions/google-tools/index.ts` (Gmail `:44,47,106,115`, Sheets `:125,141,152,173`) и `supabase/functions/agent-tool/index.ts` (Gmail `:105`, Calendar `:110`, Sheets `:116,120,124`, Docs `:128,131`);
- HubSpot и Bitrix24 — `_shared/agent.ts:160` (Bitrix24 `crm.lead.add.json`) и `:170` (HubSpot `crm/v3/objects/contacts`) дублируют `_shared/tools.ts:276` и `:220` внутри `execProvider` (`:208-304`);
- **OpenRouter — не менее 8 файлов.** Инференс: `_shared/llm.ts:68`, `_shared/tools.ts:497`, `_shared/transcribe.ts:85`, `_shared/media.ts:42` (`images/generations`), `_shared/media.ts:68` (`chat/completions`), `_shared/leadgen/scorer.ts:68`, `agent-tool/index.ts:180`, `analyze-content/index.ts:47`, `google-tools/index.ts:93`. Плюс валидация ключа: `connect-model/index.ts:41,58` и `qtest/index.ts:49`. Второй клиент задокументирован в `_shared/apiTokens.ts:5`.

`_shared/net.ts` (`safeFetch`) **не является** гейтом: по собственному заголовку (`:1`) это «SSRF egress guard for server-side fetches of user-supplied URLs». Он не знает про account, execution mode, класс эффекта, идемпотентность и аудит. Импортируется **7 модулями** (`crm-push/index.ts:9`, `fetch-url/index.ts:10`, `orchestrate/index.ts:22`, `_shared/customTools.ts:6`, `_shared/automationEngine.ts:4`, `_shared/tools.ts:11`, `_shared/taskbot.ts:11`); вендорские коннекторы его сознательно обходят, потому что бьют по известным хостам.

---

## 3. Разрыв, который выносится на ревью

ADR 001 §Архитектурные границы утверждает:

```text
runtime.outbox → connector worker → внешний API → transition + audit
```

Фактически production-трафик идёт мимо: Edge Function → `fetch` → вендор. Поэтому сегодня
**не выполняются** следующие заявленные свойства — не из-за бага, а потому что путь не подключён:

- policy decision перед критическим действием (ADR §Policy) — недостижим, нет вызовов;
- идемпотентность внешнего эффекта (T09) — нет `idempotency_key` на пути отправки;
- причинный аудит «событие → решение → approval → действие → результат» (ADR §Цели) — обрывается;
- T10 «shadow action случайно ушло в production» — контроль есть только на уровне таблицы
  outbox, куда чат-путь не заходит вовсе;
- kill switch `runtime.system_controls` — не останавливает inline-вызовы.

Это следует зафиксировать явно: сейчас ADR 001 описывает подсистему, которая не обслуживает
production-трафик. Пока миграция не завершена, риск нужно держать в реестре как принятый и
отслеживаемый, а не считать закрытым.

---

## 4. Предлагаемая конструкция

Ключевое ограничение: **не вводить новую таблицу и новый статус**. `runtime.outbox_actions` +
`execution_mode` + `status='simulated'` уже кодируют shadow с инвариантами на уровне БД,
идемпотентностью, привязкой к policy hash и approval. Работа — дописать недостающий раннер и
завести в него коннекторы.

### 4.1 Компоненты

**A. Реестр коннекторов (декларативный).**
`(connector_id, action_type)` → handler + класс эффекта + стратегия идемпотентности + компенсация.
Регистрация обязательна: действие без объявления не регистрируется (ошибка сборки, а не рантайма).
Классы эффектов предлагается взять из уже существующего словаря `agent-hub/tools/registry.ts`
(`read_only` | `action`), расширив его до различения «внешняя отправка» и «мутация данных», чтобы
два тира сошлись на одном вокабуляре.

**B. Диспетчер аутбокса.** Цикл: `claimOutboxActions` → `acquireConnectorPermit` → handler →
`recordConnectorSuccess`/`recordConnectorFailure` → `finishOutboxAction`.

Требование ADR §Kill switch — проверять `runtime.system_controls` в той же транзакции, что и выбор работы — **уже выполнено в RPC** (проверено): `public.runtime_claim_outbox_actions` (`phase2_rpc.sql:997`) читает `runtime.system_controls ... where singleton for share` на `:1037-1040` и возвращает пусто при `kill_switch_active or claims_paused` (`:1041-1043`) **до** `for update skip locked` на `:1045-1067`. `FOR SHARE` блокирует переключение рубильника до коммита claim. Дополнительно `:1048` фильтрует `execution_mode = 'live'`, а `:1056-1064` fail-closed по состоянию circuit `open`/`half_open`.

Следствие: диспетчеру не нужно реализовывать ни kill switch, ни исключение shadow-строк, ни проверку circuit — всё это уже в RPC. Он обязан лишь корректно использовать claim/finish и не ходить в БД мимо них.

**C. Рефакторинг `execAnyTool`.** Руками поддерживаемые `internalOnly`/`publicReads` заменяются
на объявленный класс эффекта. Инструменты класса `action` не исполняются на месте, а ставятся в
аутбокс через policy.

**D. Shadow.** Отдельного кода не требует: RPC сам ставит `simulated`, live-claim структурно
исключает shadow-строки. Но требуется контракт симулированного результата — см. D8.

**E. Схлопывание `blocksExternalActions`.** 64 фактических вызова в 44 файлах сводятся к одной
проверке в гейте с сохранением fail-closed семантики. Порядок — см. D3.

### 4.2 Что остаётся вне аутбокса (предложение, требует утверждения)

- чтения (`read_only`) — идут напрямую, но через `safeFetch` там, где URL пользовательский;
- внутренние действия (`run_code`, `book_appointment`) — внутри контура, не внешний эффект;
- LLM-вызовы — см. D4, вопрос открыт.

---

## 5. Открытые решения для Codex

Каждое требует явного вердикта: принять / отклонить / изменить, с обоснованием.

**D1. Где исполняется диспетчер.** Edge Function по расписанию, долгоживущий Node-воркер в
`agent-hub/`, или оба. У Edge — лимит времени выполнения, но там уже лежат все коннекторы
(`_shared/*`). У Node — долгий процесс и нормальный lease, но коннекторы придётся импортировать
через тир (прецедент есть: `agent-hub/workers/amocrm-enrichment.ts:8-9` тянет `_shared` напрямую
под `node --experimental-strip-types`). Требуется вердикт с учётом lease/renew семантики.

**D2. Синхронный чат-путь против аутбокса — главный вопрос.**
ADR §Policy относит «отправку клиентского сообщения» к критическим действиям. Но основной
production-путь — это Telegram-бот, который отвечает клиенту в диалоге непрерывно и синхронно;
пользователь ждёт ответ. Полный прогон `policy → outbox → claim → dispatch` добавит задержку и
превратит диалог в асинхронный.
Варианты: (a) все отправки через аутбокс с блокирующим ожиданием; (b) документированное
разграничение — ответ внутри inbound-диалога, инициированного клиентом, не считается «передачей
данных новому получателю», а исходящая инициация считается и требует policy; (c) всё асинхронно.
Нужен вердикт **и** формулировка разграничения, которая войдёт в ADR, иначе policy будет
обходиться де-факто.

**D3. Судьба `blocksExternalActions`.** Схлопнуть в гейт или оставить вторым слоем defence in
depth? Объём: 64 вызова в 44 файлах (плюс 44 импорта и 1 определение — всего 109 вхождений).
Если схлопывать — в каком порядке относительно миграции коннекторов, чтобы не возникло окна,
где старая защита снята, а новая ещё не покрывает путь.

**D4. Проходят ли LLM-вызовы через гейт.** Они тратят деньги и передают данные тенанта третьей
стороне (OpenRouter), что по ADR §Policy подпадает под «передачу данных новому внешнему
получателю». Но заводить их в аутбокс — это добавить очередь в горячий путь генерации.
Предложение: не через аутбокс, а через отдельную metered-egress обёртку, согласованную с
ADR 003 (usage metering / reservation safety). Предварительное условие в любом случае — схлопнуть
**все точки вызова OpenRouter (не менее 8 файлов, перечислены в §2.5)** в один клиент. Обратить
внимание, что часть из них — не инференс, а валидация ключа (`connect-model`, `qtest`); их режим
прохождения через метр нужно определить отдельно.

**D5. Где источник истины по классам эффектов.** В коде (манифест рядом с действием) или в БД
(`runtime.connector_capabilities` уже существует). Если в БД — policy может рассуждать о
классе эффекта, но появляется дрейф между кодом и таблицей; нужен контракт-тест на расхождение.
Если в коде — policy получает класс как вход и обязан ему доверять.

**D6. Кто и из чего считает `idempotency_key`.** Ключ должен быть детерминирован для логического
действия и одинаков между попытками. Отдельно: у Telegram `sendMessage` нет провайдерской
идемпотентности и нет способа спросить «я уже отправил?». По T09 неоднозначный исход обязан уходить
в dead-letter без слепого повтора — значит, для сообщений нужен либо pre-claim маркер, либо явно
принятая семантика at-most-once. Требуется решение по каждому классу коннекторов.

**D7. Порядок миграции коннекторов.** ADR Phase 5 называет первым безопасное `create_crm_task`
для ограниченной группы тенантов. Предложение: amoCRM (`create_lead`, `create_task`) первым,
Telegram вторым, остальное — после подтверждения метрик. Требуется подтверждение или другой
порядок с обоснованием.

**D8. Контракт симулированного результата.** ADR не определяет, что видит workflow, когда действие
получило `simulated`. Без правдоподобного возвращаемого значения нижележащие шаги DAG не смогут
досчитаться, и shadow-прогон умрёт на первом же действии — а именно ради полного прогона shadow и
затевается. Варианты: `runtime_enqueue_outbox_action` возвращает симулированный
`provider_result_ref`; или workflow сам ветвится по `execution_mode`. Первый вариант держит знание
о режиме внутри runtime, второй размазывает его по бизнес-логике.

**D9. Kill switch: глобальный против по-аккаунтного.** `runtime.system_controls` — singleton, это
рубильник оператора платформы. Продукту (см. роадмап P1 «стоп-кран») нужна пауза на уровне одного
аккаунта, доступная владельцу. Это отдельный контроль или расширение существующего? Важно, чтобы
владелец аккаунта не мог влиять на глобальный рубильник.

**D10. Условия перевода ADR 001 в `Accepted`.** ADR §Условия перечисляет их; Codex — именно тот
architecture/security reviewer, чьё согласование там требуется. Какие условия уже выполнены, какие
блокируют, и достаточно ли этого брифа как входа для Phase 0.

---

## 6. Дельта к threat model ADR 001

Предлагается добавить в реестр §Threat Model:

| ID | Угроза | Статус | Комментарий |
|---|---|---|---|
| T23 | Внешнее действие исполняется inline и полностью минует policy, идемпотентность и аудит | **активна** | Текущее состояние production-пути. Единственный смягчающий контроль — `blocksExternalActions`, привязанный к аккаунту, а не к прогону. Закрывается только завершением миграции; до тех пор — принятый и отслеживаемый риск с явным владельцем |
| T10 | Shadow action случайно ушло в production | частично | Контроль в БД корректен, но применим лишь к пути через outbox. Для inline-пути не применим вовсе |

---

## 7. План проверок

ADR §Обязательные проверки перечисляет 15 сценариев до canary. Часть покрыта SQL-инвариантами
(`tests/runtime_*_invariants.sql`). Диспетчер добавляет к ним:

1. два диспетчера одновременно claim одно действие — исполнитель один;
2. зомби-диспетчер завершает действие после нового claim — fencing отклоняет;
3. потерянный ответ провайдера — повтора эффекта нет либо уход в reconciliation;
4. зависшее `processing` возвращается после истечения lease;
5. попытка live-claim строки с `execution_mode='shadow'` — пусто/отказ, счётчик egress = 0 (*уже обеспечено RPC на `:1048`; тест подтверждает, а не добавляет поведение*);
6. enqueue без policy decision — отказ;
7. approval для другого `action_payload_hash` — отказ;
8. активный kill switch останавливает выдачу работы в той же транзакции (*уже обеспечено RPC на `:1037-1043`*);
9. circuit breaker допускает ровно один half-open probe (*частично обеспечено RPC на `:1056-1064`*);
10. shadow-прогон DAG досчитывается до конца и не делает ни одного внешнего вызова — **новое поведение, зависит от D8**.

Суиты `npm run quality`, которые будут затронуты: `test:approvals`, `test:runtime-client`,
`test:tools`, `test:amocrm-enrichment`, `test:dashboard`, `test:e2e`, `test:integrations`,
`test:data-leakage`, `test:security`, `test:production-account`, `test:schema-drift`.

---

## 8. Что НЕ входит в объём

- Замена оставшихся Edge Functions.
- Внешний workflow engine (ADR §Альтернативы — отложено).
- Удаление `autonomous_run_checkpoints` и `org_memory_outbox`.
- UI сплит-экрана shadow-сравнения — отдельная задача, зависит от D8.

---

## 9. Промпт для Codex

> Ты выступаешь независимым архитектурным и security-ревьюером проекта Nemo AI. Режим read-only.
>
> Прочитай `docs/adr/001-durable-operations-runtime.md` и
> `docs/reviews/001-outbox-dispatcher-review-brief.md`. Проверь факты из §2 брифа по репозиторию
> самостоятельно — особенно два: (а) что пять методов цепочки policy→outbox не имеют
> production-вызовов, при том что методы жизненного цикла workflow уже используются shadow-воркером
> amoCRM; (б) разбивку `blocksExternalActions` на 1 определение / 44 импорта / **64 фактических
> вызова в 44 файлах** — именно последнее число определяет объём миграции в D3.
>
> Затем дай вердикт по каждому из решений D1–D10 из §5: принять / отклонить / изменить, с
> обоснованием и указанием последствий для threat model. Отдельно ответь, согласен ли ты с
> добавлением T23 в реестр угроз и с формулировкой в §6.
>
> Приоритет: D2 (разграничение синхронного чат-пути и аутбокса) и D6 (идемпотентность отправки
> сообщений) — от них зависит остальное. Если считаешь предложенную конструкцию §4 неверной,
> скажи об этом прямо и предложи альтернативу, а не правь детали.
>
> Не предлагай код. На этом этапе нужен архитектурный вердикт.

---

## 10. После ревью

1. Зафиксировать вердикты Codex в этом файле разделом «Итоги ревью» с датой и `threadId`.
2. Обновить ADR 001: статус, §Threat Model (T23), формулировка разграничения из D2.
3. Только после этого — реализация, затем второе ревью Codex по диффу (требование `CLAUDE.md`).
4. `npm run quality` до второго ревью.
