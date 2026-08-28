# Конкурентный ландшафт Nemo AI — срез на август 2026

**Дата документа:** 28.08.2026. **Дата среза исходных исследований:** 27.08.2026 (оба отчёта).

**Источники документа:** три исследовательских отчёта (глобальный ландшафт, Узбекистан/СНГ, консолидированная выжимка) + `yc/fall-2026/application-draft.md`. Все цифры ниже приведены с годом и источником так, как они были зафиксированы в отчётах. Ничего не усреднено, ничего не экстраполировано.

**Курсы, использованные в отчётах:**
- 1 USD = **11 778,52 UZS** — офиц. курс ЦБ РУз на 26.08.2026 ([gazeta.uz](https://www.gazeta.uz/ru/2026/08/25/usd-sum/))
- 1 USD ≈ **84,7 RUB** — кросс-курс, **выведен автором отчёта** из котировок Kapital.kz на 26.08.2026 (USD 458,87 ₸ / RUB 5,42 ₸). Это расчёт, **не цитируемая котировка**.

**Как читать пометки:**
- «**не подтверждено**» — исследование искало и не смогло подтвердить.
- «**данные не найдены**» — в открытых источниках отсутствует.
- «⚠️ расхождение» — два источника противоречат друг другу; **обе цифры сохранены, ни одна не выбрана за нас**.
- «*вывод, не факт*» — интерпретация автора отчёта, а не измерение.

---

## 1. Резюме для основателя

1. **Бенчмарк замещения задаёт потолок цены жёстче, чем любой конкурент.** Линейный менеджер по продажам в Ташкенте — **$297/мес** (практический кейс клиники, 2 менеджера ~7 млн UZS суммарно, май 2026, [tipa.uz](https://tipa.uz/ru/news/chat-boty-biznes-uzbekistan-telegram-whatsapp/)) против медианы вакансий **$897/мес** (10 563 025 UZS, февраль 2026, [hh.uz](https://hh.uz/article/34255)). Рекомендация отчёта — **брать нижнюю границу $297–340**. Потолок комфортной self-serve покупки — **$30–100/мес**; ниже $25/мес стоят Bitrix24 и Salebot, «туда идти опасно».

2. **amoCRM — прямая, немедленная угроза, и она уже затарифицирована в сумах.** Не «доступен в Узбекистане», а **имеет UZS в переключателе валют**: Базовый **79 000 сум/юзер/мес**, Профессиональный **249 000 сум до 1 сентября, далее 259 000** ([amocrm.ru/buy](https://www.amocrm.ru/buy), проверено автором отчёта лично, 27.08.2026). AI-агент в GA, заперт за Профессиональным, делает действия в CRM и передаёт оператору; Telegram подключается токеном BotFather **бесплатно**. Партнёры в Ташкенте, Самарканде, Намангане, Нукусе. **Каждый питч Nemo обязан отвечать на вопрос «почему не проапгрейдить amoCRM до Профессионального».**

3. **Ценовое окно для узбекского SMB, которому агент нужен сейчас, — между 288 000 и 747 000 UZS/мес** (Bitrix24 Базовый за всё против amoCRM Профессиональный ×3 юзера, мин. 6 мес), отчёт 1.

4. **MoonAI — не безымянный конструктор, а казахстанский стартап с узбекской дочкой и деньгами IT Park Uzbekistan**: 170+ клиентов, MRR +35%/мес (окт. 2025, [the-tech.kz](https://the-tech.kz/startap-kotoryj-zamenyaet-otdel-prodazh-kak-moonai-doshel-do-oczenki-5-millionov/)), $50/мес + токены. **Узбекской локализации интерфейса нет** — сайт только `/ru` и `/en`, контакты казахстанские. Отчёт прямо предупреждает: **MoonAI, вероятно, добавит узбекский; окно 12–18 месяцев.**

5. **Узбекский язык — единственный настоящий ров. Telegram — тонкий.** Узбекский интерфейс: **0 из ~35 глобальных вендоров**; Salebot и Aimylogic локализовались в **казахский и пропустили узбекский**. Нативный Telegram при этом есть у всех российских платформ, Bitrix24 катает Telegram-витрину в бете, PuzzleBot уже принимает сумы через Payme и Click.

6. **Жёсткий бюджет-кэп на уровне ОДНОГО ПРОГОНА — свободная позиция. Предварительной оценки стоимости до запуска нет ни у кого вообще.** Кэпы на уровне аккаунта/места есть у Dust (лучший), Relevance AI, Lindy, Gumloop, Fin. Ближайшие аналоги на прогон — потолок действий у Zapier Agents (10/40) и пауза Gumloop — **это действия, а не деньги**.

7. **Прозрачность биллинга — самая жалуемая вещь в категории, и её никто не решил.** Разрыв G2 против Trustpilot: Lindy 4,9 против 1,7; Zapier 4,5 против 1,3 (74% — одна звезда). Make (09.12.2025) и Gumloop (30.01.2025) **официально признали**, что стоимость агента предсказать заранее нельзя.

8. **Голос на узбекском требует другого стека: Whisper Large v3 даёт 96,7% WER на FLEURS uz** ([elevenlabs.io](https://elevenlabs.io/speech-to-text/uzbek), 2026) — из коробки неприменим вообще. Лучший проверенный коммерческий — ElevenLabs Scribe v1, **15,9% WER** (та же таблица; ⚠️ текст на той же странице заявляет 3,1%).

9. **Два связывающих операционных ограничения, а не модели и не их цена.** (а) **Stripe не поддерживает ни Узбекистан, ни Казахстан** ([stripe.com/global](https://stripe.com/global)); единственный подтверждённый merchant-side рекуррент — **Payme Business Subscribe API**. (б) **Локализация персданных, ЗРУ-547** — данные граждан РУз, обрабатываемые через интернет, должны храниться физически в Узбекистане; несоблюдение → блокировка сайта внутри страны.

10. **Рынок консолидируется: за 12 месяцев из списка целей выбыли шесть компаний**, включая **закрытие OpenAI Agent Builder** (дословно: «*winding down… From November 30, 2026 onward, they will no longer be available*»). *Вывод отчёта, не факт:* отдельно стоящий «конструктор агентов» как бизнес-модель на глобальном рынке сжимается; ценность — в данных и канале.

11. **Uzum: 18 000+ продавцов, ~90% МСБ, оборот +60% г/г — и AI-инструмента для селлеров нет.** «**Данные не найдены**» — в открытых источниках на август 2026 нет ни одного упоминания AI-инструмента для продавцов Uzum Market.

12. **Рынок ранний, продавать придётся ROI, а не технологию.** Проникновение генеративного ИИ — **7,2%** трудоспособного населения Q1 2026 против мирового среднего **17,8%** ([Microsoft Global AI Diffusion Q1 2026](https://www.microsoft.com/en-us/corporate-responsibility/dmc/topics/ai-economy-institute/reports/global-ai-adoption-2026-q1/)). Онбординг MoonAI не случайно включает бесплатный 30-минутный созвон с интегратором.

---

## 2. Структурные сдвиги рынка за 12 месяцев

Шесть компаний выбыли из списка целей за 12 месяцев. Это меняет постановку задачи.

| Событие | Детали и дата | Источник | Что это значит для Nemo |
|---|---|---|---|
| **OpenAI сворачивает Agent Builder и Evals** | Дословно: *«Update on June 3, 2026: OpenAI is winding down the Agent Builder and Evals products. From November 30, 2026 onward, they will no longer be available on the OpenAI platform.»* Визуальный конструктор прожил ~14 месяцев. Agents SDK и ChatKit живут; преемник — Workspace Agents в ChatGPT (GA) | [openai.com](https://openai.com/index/introducing-agentkit/) — **проверено автором отчёта лично** | Снимает возражение «зачем вы, если это сделает OpenAI». Компания, изобретшая категорию, убила свой визуальный конструктор за 14 месяцев. Цитата дословная и проверяемая |
| **Salesforce покупает Fin (б. Intercom) за ~$3,6 млрд** | Соглашение 15.06.2026, закрытие ожидается в Q4 FY27. Intercom переименовал себя в Fin | [salesforce.com](https://www.salesforce.com/news/press-releases/2026/06/15/salesforce-signs-definitive-agreement-to-acquire-fin/) | Единственный вендор с узбекским в списке языков уходит внутрь Salesforce, который **не имеет UZS в списке валют**, а Fin биллит **только в USD** |
| **Zendesk купил Forethought** | Объявлено 11.03.2026, закрыто 26.03.2026, **сумма не раскрыта** | [zendesk.com](https://www.zendesk.com/newsroom/press-releases/zendesk-completes-acquisition-of-forethought/) | Ещё один independent support-агент исчез в helpdesk-инкумбенте |
| **Asana купила Stack AI за ~$75 млн** | Закрыто 28.05.2026 | [investors.asana.com](https://investors.asana.com/news-releases/news-release-details/asana-acquires-stackai-adding-cross-system-execution-human-agent) · [TechCrunch](https://techcrunch.com/2026/05/28/asana-acquires-no-code-agent-builder-stack-ai/) | Конструктор с ~$20 млн привлечённых вышел за ~$75 млн — референс по потолку выхода для чистого конструктора без канала |
| **Salesforce купил Qualified (Piper AI SDR)** | Подписано 17.12.2025, **закрыто 01.04.2026** | [salesforce.com](https://www.salesforce.com/news/stories/salesforce-signs-definitive-agreement-to-acquire-qualified/) | AI SDR как отдельная категория схлопывается в CRM. В релизе слов «AI SDR» нет — «agentic AI marketing» |
| **Cognosys мёртв** | Cognosys → Ottogrid → куплен Cohere 16.05.2025, продукт закрыт. `cognosys.ai` отдаёт заглушку Vercel «Deployment Paused». Crunchbase: статус **Closed** | [techcouver](https://techcouver.com/2025/05/16/cohere-acquires-ottogrid-to-bolster-enterprise-ai-tool-north/) · проверено в день отчёта | — |
| **MultiOn ушёл из категории** | `multion.ai` → 301-редирект на `theagi.company` («AGI, Inc.»). Пивот в on-device мобильный ИИ | проверено в день отчёта · [Crunchbase](https://www.crunchbase.com/organization/multi-on) | — |

**Смежные события того же периода:**

- **Poetic** (ex-Forge): **$50 млн Series A при оценке $500M, 12.06.2026**, Kleiner Perkins **с участием OpenAI**. Прямо анти-агентная компания: компилирует регламенты в *«deterministic, near-tokenless execution»*. Клиенты SoFi, AIG, Chime ([TechFundingNews](https://techfundingnews.com/poetic-lands-50m-from-kleiner-perkins-and-openai-to-run-the-enterprise-work-ai-agents-keep-getting-wrong/)). **Для Nemo:** это валидация тезиса о детерминированных DAG-пайплайнах — но в корпоративном сегменте США. В SMB позиция свободна. ⚠️ Отчёт помечает: **aifunding.me недостоверен, он выдумал итоговые суммы для Poetic** — не использовать этот источник.
- **n8n**: стратегическая инвестиция SAP **12.05.2026**, оценка удвоилась до **$5,2 млрд**, встраивание в SAP Joule Studio ([PRNewswire](https://www.prnewswire.com/news-releases/n8n-valuation-doubles-to-5-2bn-as-sap-makes-strategic-investment-and-plans-to-embed-the-ai-platform-into-joule-studio-302767227.html)).
- **Kommo убрал AI-агента из начального тарифа**: *«Starting June 1, 2026, new Base plan users won't have access to the AI agent»* ([support.kommo.com](https://support.kommo.com/docs/plans-limits.md), обновлено 14.08.2026).
- **Zendesk переписал определение решения 18.05.2026** — три уровня, списывается только *Verified resolution*. Отчёт: это **самое дружественное к клиенту определение решения на рынке, строже, чем у Fin**.

**Общий вывод отчёта (помечен как «вывод, не факт»):** консолидация идёт снизу вверх — CRM/helpdesk-гиганты скупают агентские стартапы, чтобы приклеить агентов к своим данным. Это одновременно угроза и подтверждение, что ценность — в данных и канале, а не в конструкторе.

---

## 3. MoonAI — главный бенчмарк

### 3.1. Происхождение и корпоративная структура

| Параметр | Значение | Источник |
|---|---|---|
| Основатель | Асхат Адхамов, Алматы (серийный фаундер, ранее EdTech) | [the-tech.kz, 21.10.2025](https://the-tech.kz/startap-kotoryj-zamenyaet-otdel-prodazh-kak-moonai-doshel-do-oczenki-5-millionov/) |
| Головная компания | **MoonAI, Inc., Delaware, EIN 36-5142965**, 131 Continental Dr Suite 305, Newark, DE 19713 | [mooonai.com/en](https://mooonai.com/en) (футер) |
| Дочерние | Казахстан и **Узбекистан** | the-tech.kz, 2025 |
| Юрлицо KZ | БИН 250640027102, свидетельство участника Astana Hub №3307 от 21.03.2026, действует до 30.12.2029 | [astanahub.com](https://astanahub.com/account/company/17837/) |
| Год создания | 2024 | astanahub.com |
| Адрес KZ | Алматы, ул. Масанчи 98Б, оф. 100 | astanahub.com |
| Команда | **19 человек, из них 6 ML/AI-инженеров** | the-tech.kz, окт. 2025 |
| Клиенты | **более 170** | the-tech.kz, окт. 2025 |
| Рост | MRR **+35% в месяц** в среднем | the-tech.kz, окт. 2025 |
| Оценка | **$4 млн** (лето 2025) → бридж по **$5 млн SAFE** (окт. 2025) | the-tech.kz |
| Первоначальные вложения | ~$50 тыс. (личные + первый ангел $15 тыс.) | [kapital.kz, 11.02.2026](https://kapital.kz/business/144835/moonai-kak-kazahstanskij-startap-delaet-ii-sputnikom-biznesa.html) |

### 3.2. Инвесторы и программы — прямо конкурентно значимо

| Источник | Сумма / формат | Год |
|---|---|---|
| MOST Acceleration Program | **$200 000** | 2025 |
| **IT Park Uzbekistan, DSA Acceleration** | **$50 000 по SAFE** + проживание + поддержка выхода на рынок UZ | 2025–2026 |
| **Clash of Startups, Ташкент** | **1-е место, $25 000 от IT Park Uzbekistan** | 2025 |
| Astana Hub Ventures («Ticket to the Future», Digital Bridge) | **$25 000 SAFE** | 2025 |
| Оскар Хартманн (бизнес-ангел, «Арена единорогов») | **$50 000** | февр. 2026 |
| Также инвестировали | Astana Hub Fund, Most Ventures, Activate, IT Park KZ и UZ | kapital.kz |
| Акселерации | SelectUSA (Вашингтон), Alchemist + Draper (прошли отбор, **отказались**), Quick Startup (Nazarbayev Univ.), Go Broad / SIT Foundation | the-tech.kz |

Логотипы на сайте: IT Park Uzbekistan, Astana Hub, MOST, Silicon Valley Residence, SIT Foundation, Activat VC, NU Impact, Оскар Хартманн.

### 3.3. Позиционирование и стратегия

- **EN-лендинг, дословно:** *«AI agents — Connect AI agents via a no-code platform and automate your team's workflow»*. RU: «ИИ-продажник», автоматизация продаж.
- **Целевой сегмент по словам основателя:** владельцы и топ-менеджеры МСБ, **у которых уже есть CRM/ERP и выделенные отделы работы с клиентами**. Микробизнес отсекают явно: *«У совсем малого бизнеса нет базового уровня автоматизации… AI не на что накладывать»* (kapital.kz).
- **Стратегия:** Казахстан → лидер Центральной Азии → **MENA и Турция**; в США «скорее всего нужен другой продукт» (kapital.kz, февр. 2026). Ранее (окт. 2025) декларировался выход в США — **стратегия сместилась**.
- **Дистрибуция:** партнёрская сеть «**интеграторов AI-агентов**» — обучение профессии за 1–2 месяца, кабинеты для партнёров, чтобы те сами находили и вели клиентов. Отчёт: «это дистрибуционная модель, которую стоит воспринимать всерьёз».

### 3.4. Онбординг — 4 шага

Со страницы [mooonai.com/en](https://mooonai.com/en), раздел «Configure AI in just a few steps»:

1. **Create an AI agent** — имя, часовой пояс, график работы
2. **Configure the prompt** — кто агент и какие задачи решает
3. **Connect channels** — выбор каналов
4. **Test and launch** — «минимальной настройки достаточно для старта, остальное потом»

Плюс: **«Book a 30-minute call — we'll help you get started. Free»** (человек-интегратор на онбординге) и **3 дня бесплатно**.

> Отчёт 2 фиксирует прямо: это «то, что копирует спека Nemo», а табы продукта — «фактически один в один структура, заложенная в `NEMO_AI_SPEC.md` §6.4–6.6».

### 3.5. Функциональные модули и фичи

**Табы продукта:** Chat Manager / Knowledge Base / CRM and ERP Integrations / Live Communication / Lead Forms / LLM Models.

**Отдельные фичи:**
- **No-code без промптов** — «агент настраивает себя по вашим данным, логика правится дизлайком на неверный ответ»
- Follow-up сообщения (автонапоминания, реактивация)
- Понимание **изображений и голосовых сообщений**
- Мультиязычность (на уровне ответов агента клиенту)
- **Автосбор оплаты** — бот выставляет счёт (например, Kaspi) прямо в диалоге и доводит сделку до оплаты
- Готовые сценарии: AI Sales Manager, AI Qualifier, AI Tech Support Operator, AI Consultant, AI Administrator

### 3.6. Каналы, интеграции, модели

| Категория | Что заявлено |
|---|---|
| Каналы | **WhatsApp, Instagram, Telegram, чат на сайте** (порядок с лендинга) |
| CRM/ERP | **amoCRM, Bitrix24, Google** и др. |
| Платежи | Kaspi (счёт в диалоге) |
| LLM | Gemini, OpenAI, DeepSeek (логотипы на лендинге) |

### 3.7. Ценообразование

| Компонент | Цена | В UZS (курс 11 778,52) |
|---|---|---|
| Подписка | **$50 / мес** | ~589 000 UZS/мес |
| В подписку входит | AI-агент 24/7, все каналы, все интеграции, обучение на своих данных, история чатов + AI-аналитика, поддержка в рабочее время, **бонус 1000 центов ($10)** | — |
| AI-токены | **оплачиваются отдельно** | — |
| Калькулятор токенов | **~$1,31 за 100 диалогов** на GPT-4o mini (средний диалог ≈ 5 ответов ИИ) | ~15 400 UZS |
| Триал | **3 дня** | — |

Источник: [mooonai.com/pricing](https://mooonai.com/pricing/), [mooonai.com/en](https://mooonai.com/en).

**Эффективный чек:** при 1000 диалогов/мес ≈ $50 + ~$13 = **$63/мес ≈ 742 000 UZS/мес**.

### 3.8. Заявленные метрики продукта (маркетинг, не аудит)

- Точность ответов **98,8%** на сайте (**98%** в интервью — ⚠️ два разных числа в двух местах)
- Среднее время ответа **8 секунд**
- До **80% задач воронки продаж**
- Кейс Impact: **8 200 обращений/мес против 4 800** до внедрения; время ответа 5 сек вместо 5–10 мин; **19% обращений закрывается без менеджера**; удовлетворённость с 85% до 93%
- Кейс Just To Study: один AI-ассистент вместо **3–4 менеджеров** на первичном этапе

### 3.9. В чём они сильнее Nemo — честно

1. **У них есть клиенты и выручка, у Nemo по репозиторию — нет.** 170+ клиентов и MRR +35%/мес (окт. 2025) против прямой записи в `yc/fall-2026/application-draft.md`: *«repository evidence does not establish production customers, revenue, or live integration reliability»*.
2. **Деньги и статус внутри узбекской экосистемы уже получены.** $50 000 SAFE от IT Park Uzbekistan через DSA Acceleration + 1-е место и $25 000 на Clash of Startups в Ташкенте. Это тот же институциональный канал, на который рассчитывает Nemo, и MoonAI прошёл его первым.
3. **Дистрибуция через обученных партнёров-интеграторов** — механизм, который масштабируется без найма, и он уже запущен.
4. **Онбординг короче и человечнее:** 4 шага + бесплатный 30-минутный созвон с живым интегратором + 3 дня триала. Для рынка с проникновением генИИ 7,2% (Microsoft, Q1 2026) человек на онбординге — не роскошь, а обязательное условие.
5. **Автосбор оплаты прямо в диалоге** (счёт Kaspi в чате) — это доведение до денег, а не до лида. Функционально это дальше по воронке, чем «лид-форма».
6. **Мультимодальность уже заявлена:** понимание изображений и голосовых сообщений. Для сравнения — агент Microsoft Copilot Studio дословно *«can't send or upload attachments to the chat… This limitation applies to all channels»*.
7. **Готовые сценарии как вход** (AI Sales Manager, AI Qualifier, AI Tech Support Operator, AI Consultant, AI Administrator) — рынок сошёлся на том, что «пустой холст» умер как единственный вход.

### 3.10. В чём они уязвимы

1. **🔴 Узбекской локализации интерфейса нет.** Сайт только `/ru` и `/en` (переключатель в футере даёт лишь эти две опции). Контакты и соцсети казахстанские: **+7 700 410 19 01, instagram.com/moonai_kz, admin@mooonai.kz**. «Мультиязычность» заявлена на уровне ответов агента клиенту, **не интерфейса**. Для рынка, где **>90% потребительской коммуникации идёт на узбекском** (оценка Cybernet AI, [gazeta.uz, 10.06.2025](https://www.gazeta.uz/ru/2025/06/10/cybernet-ai/)) — структурный разрыв.
2. **Показывают цену в долларах, а не в сумах.** Дословно из [fera-tech.com](https://fera-tech.com/ru/blog/ai-and-business-automation-in-uzbekistan-2026-state-of-market/): *«Всегда указывайте цены и бюджет в сумах — использование долларов для локальных цен сразу выдаёт, что вы на самом деле не работаете здесь»*. Отчёт называет это культурной ошибкой.
3. **Канальная оптика казахстанская, не узбекская.** WhatsApp стоит первым в списке каналов. В Узбекистане WhatsApp — **~25% аудитории** активно (2026, [tipa.uz](https://tipa.uz/ru/news/chat-boty-biznes-uzbekistan-telegram-whatsapp/)), Telegram — доминирующая поверхность (см. §6.3, где цифра спорная).
4. **Платёжный рельс казахстанский.** Автосбор оплаты завязан на Kaspi. Для Узбекистана рабочий merchant-side рекуррент — **Payme Business Subscribe API**; Kaspi merchant-initiated recurring помечен как **не подтверждено**.
5. **Структурная негибкость: Delaware + Kaspi + $50.** Отчёт формулирует это как операционное преимущество Nemo, которое MoonAI «структурно не может быстро повторить».
6. **Отсекают микробизнес по собственному признанию** — требуют наличия CRM/ERP и выделенного отдела работы с клиентами. Это оставляет незанятым нижний сегмент.
7. **Триал 3 дня** — короче, чем у большинства сопоставимых (Bitrix24 free-тариф бессрочно, BotHelp START 14 дней, Google Gemini Enterprise 30 дней).
8. **Метрики — маркетинговые, не аудированные.** «98,8%» на сайте против «98%» в интервью; методика не раскрыта.

**🔴 Риск, зафиксированный отчётом:** MoonAI, вероятно, добавит узбекский, раз у него дочка в UZ и деньги IT Park. **Окно по языку — 12–18 месяцев**, за которые нужно построить что-то более защитимое (данные, качество на узбекском, дистрибуция).

---

## 4. Глобальные конкуренты

Все цены проверены авторами отчёта 27.08.2026. ⚠️ **Lindy перетарифицировался недавно:** обзоры авг.–окт. 2025 указывают «Pro ~$50/мес, 5 000 кредитов» и «free 400 кредитов/мес» — сегодня этого нет. **Любую цену Lindy старше ~3 месяцев считать протухшей.**

### 4.1. Конструкторы агентов / «AI workforce»

| Компания | Позиционирование (дословно) | Сегмент | Цена | Единица тарификации | Онбординг / TTFV | Источник |
|---|---|---|---|---|---|---|
| **Lindy** | *«The AI employee that connects to all your tools, knows everything about your company, and does real work for the whole team»*; *«The teammate that punches above its price»* | SMB/mid | Plus **$29,99**/мес/юзер · Pro **$99,99** · Max **$199,99** · Enterprise custom. **Free нет**, 7-дневный триал только через Slack | **Место + кредиты** (3k/15k/35k на юзера, пул общий). Не переносятся, овераж **2×**, топ-ап $10/1 000 кредитов | Шаблоны + галерея + установка в Slack. **Числового обещания TTFV нет** | [lindy.ai/pricing](https://www.lindy.ai/pricing) · [docs.lindy.ai](https://docs.lindy.ai/account-billing/usage) |
| **Relevance AI** | *«Specialist agents for every task»* / *«The home of the AI Workforce»* | mid/enterprise (разворот в sales-led) | Free · Pro **от $19**/мес (год) / $29 · Team **от $234**/мес (год) / $349 · Enterprise | **Два счётчика: Actions + Vendor Credits.** $80 за 1 000 Actions, $20 за 10 000 VC; VC переносятся бессрочно, Actions сгорают | Встроенная команда внедрения: недели 1–2 карта сценариев, 3–6 команда строит агентов. **«Drive ROI in six weeks or less»** | [docs](https://relevanceai.com/docs/get-started/pricing) ⚠️ публичная `/pricing` показывает только «Enterprise / Talk to sales» |
| **Beam AI** | *«Your 200-page SOP becomes a working agent. Self-learning. Enterprise-ready.»* | mid/enterprise | Free (20 задач/мес) · Pro **$50**/мес · Scale **$3 990**/мес · Custom | **Задачи/мес** (20/200/high-volume) | **Генерация из ваших документов — единственный на рынке.** *«Drive ROI in 4 weeks»* / *«Pilot to production in 4 weeks»* | [beam.ai/pricing](https://beam.ai/pricing) |
| **Stack AI** | *«Build secure, compliant AI applications in minutes»* | enterprise (**среднего тарифа нет**) | Free (500 запусков/мес) · Enterprise custom | **Запуски/мес** | Шаблоны + drag-and-drop. **«in minutes»** | [stackai.com/pricing](https://www.stackai.com/pricing) |
| **Dust** | *«Multiplayer AI for human-agent collaboration… with people in control»* | mid/enterprise | Free (500 кредитов **пожизненно**) · Pro **$24**/место/мес (год)/$30 · Max **$120**/$150 · Enterprise | **Место + кредиты** (500/8 000/40 000). API $0,01/кредит. Не переносятся | Self-serve + 70+ коннекторов. TTFV **не подтверждено** | [dust.tt/home/pricing](https://dust.tt/home/pricing) |
| **CrewAI** | *«The Leading Multi-Agent Platform»* · *«Used by 65% of the Fortune 500»* | OSS + enterprise (**среднего тарифа нет**) | Free (50 выполнений/мес) · Enterprise custom | **Выполнения воркфлоу/мес** | OSS-first (pip install) + Studio + AI-копилот. Enterprise: **«45-day onboarding»** — самый медленный в выборке | [crewai.com/pricing](https://crewai.com/pricing) |

**Финансирование и масштаб:**

| Компания | Привлечено | Оценка | ARR |
|---|---|---|---|
| **Dust** | **>$60 млн**; Series B **$40 млн**, 18.05.2026, Abstract + Sequoia | не подтверждено | **>$20 млн** (нач. 2026), рост 20× за ~20 мес. >300 000 агентов, нулевой отток в 2025 ([Sifted](https://sifted.eu/articles/dust-series-b-40m)) |
| **Relevance AI** | **$37 млн**; Series B $24 млн, 06.05.2025, Bessemer | **Явно не раскрыта** — TechCrunch: *«The company did not provide its valuation»* | не подтверждено |
| **CrewAI** | **$18 млн** Series A, 22.10.2024, Insight. **Series B нет** | не подтверждено | не подтверждено |
| **Stack AI** | ~$20 млн до выхода | **Выход ~$75 млн** | — |
| **Lindy** | ⚠️ **Публично подтверждённого раунда с 2023 нет.** PitchBook: $53,6 млн всего, последняя сделка $4 млн (01.08.2023) | не подтверждено | не подтверждено |
| **Beam AI** | ⚠️ PitchBook: **$1,35 млн**; Crunchbase суммы скрыты | не подтверждено | не подтверждено |

🚩 **Дезинформация, которую отчёт требует отбросить:** «Lindy подняла $50M Series A от a16z при оценке ~$200M, ARR ~$7M» встречается **только на SEO-агрегаторах**, противоречит Crunchbase и PitchBook. **Не использовать.**

**Задокументированные слабости:**

- **Lindy.** G2 **4,9/5 (171 отзыв)** против Trustpilot **1,7/5 (39 отзывов, 77% — одна звезда)**; разрыв 3,2 пункта — **цитировать обязательно обе цифры** ([G2](https://www.g2.com/products/lindy-lindy/reviews) · [Trustpilot](https://uk.trustpilot.com/review/lindy.ai)). Дословно: *«The credits are black box. You have no idea how they get spent or how much a task will cost»* (2★, 15.03.2026); *«they decided to charge me 550 USD for using 44,000 credits. Whilst my monthly subscription is only 25 USD per month. And I never permitted overcharge»* (1★, 18.01.2026); *«Their AI agent burnt through over 2000 paid credits, just to decide it wasn't right and delete everything, without asking»* (1★, 09.09.2025). G2-темы недостатков: «high subscription cost… especially for scaling and **non-US users** (35 reviews)»; G2 14.10.2025: *«it is difficult to pay for AI tools in my country.»*
- **Stack AI.** *«As workflows get more complex, debugging can feel a bit opaque… Pricing can be a stretch for very small teams»* (3,0★, 31.12.2025); *«stack-AI has some speed issues in Europe»* (19.11.2024). Документированный предел HITL: *«only works inside the Chat Assistant interface. It does not function when workflows are triggered via API or used in Form mode»* ([docs](https://docs.stackai.com/workflow-builder/core-nodes/stackai/human-in-the-loop)). ⚠️ Четыре самых критичных свежих отзыва помечены «Incentivized / Seller invite».
- **CrewAI.** Практик, 02.06.2026: *«CrewAI abstracts away fundamental concepts you should own… a frustrating black box»*, *«Non-optimized token consumption… A CrewAI workflow that "works" in dev might cost five times more than expected in production»* ([ianas.fr](https://ianas.fr/en/blog/2026/06/02/crewai-langchain-langgraph-comparatif-pragmatique/)). Там же: **5,2 млн загрузок PyPI/мес против 34,5 млн у LangGraph**. GitHub issue #6125, 11.06.2026: гонка в JsonProvider — *«A test with 5 concurrent agents performing 50 updates each resulted in a final count of 1 instead of 250»*.
- **Beam AI.** Отсутствие корпуса отзывов и есть находка: G2 **4,5/5 при ровно 1 отзыве**, Trustpilot 1 отзыв, AWS Marketplace 0 оценок, HN — ничего. Единственный неспровоцированный отзыв: *«Scam Company, claiming AI and Agents, total bullshit, they are an AI Wrapper nothing more»* (Trustpilot 1★, 11.11.2025). ⚠️ **Ловушка нейминга:** G2 `/products/beam-ai/` (4,9, 34 отзыва) — **совсем другая компания** (Attentive AI, ПО для строительных обмеров). **Не цитировать.**
- **Dust.** G2 4,6/5 при 86 отзывах и **нулевым блоком «Top Cons»** при том, что у других он рендерится. Trustpilot-профиля нет. **Дословных жалоб пользователей: не подтверждено.** G2-метрики: воспринимаемая стоимость **$$$$$ (5/5)**, внедрение 1 месяц, ROI 4 месяца.
- **Relevance AI.** ⚠️ ~45% отзывов на G2 — **за подарочные карты**. Telegram: **токены ботов от BotFather не поддерживаются**.

**Матрица возможностей (конструкторы):**

| Платформа | Telegram | RU/UZ интерфейс | Жёсткий бюджет-кэп | Dry-run без сайд-эффектов | HITL | Трассы |
|---|---|---|---|---|---|---|
| **Lindy** | ⚠️ только отправка; входящий триггер **не подтверждено** | ❌ только EN | ✅ кэп кредитов на участника + автопауза | ❌ | ⚠️ только в общих Slack-тредах; веб-чат, Slack DM, SMS — без защиты | ❌ только агрегаты |
| **Relevance AI** | ✅✅ нативный Premium Trigger (Pro+). ⚠️ **без BotFather-токенов** | ❌ не подтверждено | ✅ hard stop org+project, **на всех тарифах** | ✅✅ Evals + Tool simulations (*«emulate Tool usage without actually calling the underlying Tools»*); минимальный балл **блокирует публикацию** | ✅ Auto / Approval required / Let agent decide | ✅ + стоимость на задачу, OTEL |
| **Beam AI** | ❌ не подтверждено | ❌ маркетинг EN/DE/AR/ES; приложение не подтверждено | ❌ **документации по биллингу/квотам не существует вовсе** | ✅✅ **лучший:** *«integrations are sandboxed, so test runs do not create, update, or delete live records»* | ✅ «Consent required» на узел + API approve/reject | ✅ полная трасса + расход токенов |
| **Stack AI** | ❌ не подтверждено | ❌ не подтверждено | ❌ не подтверждено | ⚠️ частично (Test Action, Pin/Skip) | ⚠️ **только чат-UI, ломается на API и Form** | ✅ поузловая аналитика |
| **Dust** | ❌ не подтверждено | ❌ не подтверждено | ✅✅ **лучший:** личный + воркспейсный + **программный** (0 = блок всего API/Zapier/n8n) | ⚠️ только превью в билдере | ✅✅ **«stake levels»**: High/Medium/Low/Never ask; `send_mail` выключен по умолчанию | ✅✅ аудит-логи + SIEM, различает человека и ИИ |
| **CrewAI** | ❌ не подтверждено | ❌ (доки EN/pt-BR/KO/AR; RU нет) | ❌ не подтверждено | ⚠️ `crewai test` — **реальное выполнение** | ✅ `human_input`, Flow HITL | ✅✅ лучший OTel + 17 интеграций |

> **Будут ли конкурировать за ташкентский SMB?** Нет. Ни у одного нет UZS, узбекского или локализованной консоли; Lindy собирает прямые отзывы «трудно платить за ИИ-инструменты в моей стране»; Relevance ушёл в sales-led; Stack AI куплен Asana; Beam AI при $1,35 млн PitchBook и одном отзыве не имеет ресурса на выход в регион. **Опасны как источник ожиданий покупателя о цене и как библиотека паттернов** (dry-run Beam, stake levels Dust, симуляции Relevance), а не как продавцы в Ташкенте.

### 4.2. Workflow-автоматизация с агентами

| Платформа | Позиционирование / модель | Сегмент | Цена | Единица тарификации | Онбординг | Источник |
|---|---|---|---|---|---|---|
| **Zapier** | Классическая автоматизация + AI-шаги | SMB→enterprise | Free $0 (100 задач) · Professional **от $19,99** · Team **от $69** · Enterprise | **Задача.** AI-шаги, код, MCP и SDK — в общем пуле. **MCP: 1 вызов = 2 задачи** | Шаблоны + Zapier Copilot (генерация из промпта) | [zapier.com/pricing](https://zapier.com/pricing) |
| **Zapier Agents** | Отдельный продукт поверх Zapier | SMB | Free (400 activities) · Pro **$400/год = $33,33/мес** (1 500) · Enterprise | **Activity** — второй счётчик: каждый триггер, действие, запрос к базе знаний, веб-поиск. **На free тестирование тоже считается** | Шаблоны | [help.zapier.com](https://help.zapier.com/hc/en-us/articles/26559132765325-How-is-Zapier-Agents-usage-measured) |
| **n8n** | Fair-code автоматизация, self-host | SMB→enterprise | Starter **€20/мес** (год, 2 500 вып.) · Pro **€50** (10 000) · Business **€667** (40 000) · Enterprise. Овераж Business: €4 000 за 300 000 | **Выполнение воркфлоу** (один запуск сценария вне зависимости от числа шагов) | **10 000+ шаблонов**, «минуты» | [n8n.io/pricing](https://n8n.io/pricing/) |
| **Make** | Визуальная автоматизация (принадлежит Celonis) | SMB→mid | Free (1 000 кредитов) · Core **$12** · Pro **$21** · Teams **$38** · Enterprise (от 10k кредитов/мес) | **Кредит.** 1 действие модуля = 1 кредит; роутеры и обработчики ошибок бесплатны | Шаблоны + Make Maia (генерация из промпта) | [make.com](https://www.make.com/en/pricing) |
| **Gumloop** | Chat-first автоматизация | SMB/mid | Pro **от $37/мес** (20k кредитов) · Enterprise. **Free-плана нет**, 14-дн. триал | **Кредиты + 8% orchestration fee**; `Fee = 8% × (Chat&Reasoning + Compute + Tool Calls)`. **BYOK поднимает fee до 16%** | Chat-first генерация | [gumloop.com/pricing](https://www.gumloop.com/pricing) · [docs](https://docs.gumloop.com/core-concepts/credits) |
| **Activepieces** | OSS-автоматизация + embed | SMB→embed | Free · Plus **$16/мес** (год, до 5 юзеров) · Team **$166/мес** (25 юзеров, далее $25/юзер) · Ultimate · **Embed от $36 тыс/год** | **Кредиты.** Запуск флоу = 1 кредит, **все шаги внутри бесплатны**; агентское действие 1; AI fast 2 / smart 10 / frontier 20; **свой ключ = 1**. Сверх плана $0,007 | «chat to automation» | [activepieces.com/pricing](https://www.activepieces.com/pricing) |

**Три вещи, которые надо знать про этот сегмент:**

**(а) 🔴 Лицензия n8n прямо запрещает бизнес-модель Nemo.** Sustainable Use License (fair-code, **не OSI open source**), [docs.n8n.io](https://docs.n8n.io/privacy-and-security/sustainable-use-license.md):

| ❌ Запрещено | ✅ Разрешено |
|---|---|
| White-labelling n8n и продажа клиентам | Синхронизация данных вашей компании |
| Хостинг n8n и взимание платы за доступ | Разработка нод/интеграций |
| **Сбор собственных учётных данных конечных пользователей** для питания фичи вашего приложения | Консалтинг: сборка воркфлоу для клиентов |

Платформа, где клиенты подключают свои Telegram-боты и CRM, попадает под запрет **по обеим строкам**. Нужен отдельный коммерческий договор (`license@n8n.io`). Отчёт помечает: **эскалировать внутри команды до любых решений об архитектуре.**

**(б) У n8n идёт бунт по тарификации.** Команда на ~10 млн выполнений/мес, платившая ~$400/мес, посчитала **~$107 000/мес** по новым тарифам (авг. 2025); пользователь на 40 млн/мес сформулировал это как **«$0 или $428 000/мес»** ([community.n8n.io](https://community.n8n.io/t/new-plan-no-active-workflow-limits-introducing-n8n-new-pricing/163840)).

**(в) 🎯 Два вендора официально признали, что стоимость агента непредсказуема заранее — самый ценный материал во всём исследовании.**
- **Make**, руководитель по решениям, 09.12.2025 ([community.make.com](https://community.make.com/t/what-is-the-ai-agent-pricing-model/98179)): выбор инструментов LLM недетерминирован, кредиты от инструментов **предсказать с какой-либо точностью нельзя**; рекомендация — прогнать ~50 тестов и замерить разброс.
- **Gumloop**, сотрудники, 30.01.2025 ([forum.gumloop.com](https://forum.gumloop.com/t/significant-increase-in-credits-used/643)): **узнать стоимость флоу до запуска невозможно**; стоимость запуска подскочила с 1–2 до ~70 кредитов после одной строки в подфлоу.

**Оценки G2 против Trustpilot:** Zapier **4,5/5 (2 088)** против **1,3/5 (316, 74% — 1★)**; n8n 4,7/5 (308) против 3,2/5 (49); Make 4,6/5 (339) против 2,8/5 (170); Activepieces 4,8/5, профиля Trustpilot нет; Gumloop 4,8/5 при **7 отзывах**.

⚠️ **Zapier противоречит сам себе:** «Over 2 million businesses» на /about против «3 million+» на главной. Финансирование/оценка/ARR Zapier — **не подтверждено**.

> **Будут ли конкурировать за ташкентский SMB?** Косвенно — да, как субстрат: у n8n, Make и Activepieces есть нативный Telegram, и местный интегратор может собрать на них решение. Как прямой продавец — нет: нет UZS, нет узбекского, нет консоли оператора, нет лид-форм. **Главный риск для Nemo здесь юридический, а не рыночный** — лицензия n8n.

### 4.3. Агенты поддержки

| Вендор | Позиционирование / модель | Сегмент | Цена | Единица тарификации | Онбординг | Источник |
|---|---|---|---|---|---|---|
| **Fin (б. Intercom)** | Outcome-based агент поддержки | mid/enterprise | **$0,99** за outcome (Qualification **$9,99**). Хелпдеск Intercom: Essential $29 / Advanced $85 / Expert $132 за место/мес | **Outcome — четыре события:** Resolution, Procedure handoff, Disqualification, Qualification | Self-serve + Simulations, Regression Tests, Previews, Audience Testing | [fin.ai/pricing](https://fin.ai/pricing) — **проверено автором лично** · [intercom.com/pricing](https://www.intercom.com/pricing) |
| **Zendesk** | AI-агенты внутри helpdesk | mid/enterprise | По квоте; ~$2 PAYG. Sunshine Conversations требует Suite Professional+ (**$115/агент/мес**) | **Verified resolution** — только прошедшие LLM-верификацию, с 18.05.2026 | Внутри Zendesk | [support.zendesk.com](https://support.zendesk.com/hc/en-us/articles/9570369117338) |
| **Agentforce (Salesforce)** | Агенты на данных CRM | enterprise | Foundations **$0** (Agentforce Builder) · **Flex Credits $500 за 100 000** ($0,005/кредит) · **Conversations $2,00** · Agentforce User License $5/юзер/мес · надстройки $125–150/юзер/мес · Agentforce 1 Editions **от $550/юзер/мес** | Conversation / Flex Credit / Help Agent Resolution. Действие = 20 кредитов ($0,10); голосовое = 30 ($0,15) | Конструктор бесплатен в Foundations | [salesforce.com/agentforce/pricing](https://www.salesforce.com/agentforce/pricing/) |
| **Sierra** | Enterprise outcome-агенты | enterprise, sales-led | **Публичной цены нет** | Outcome; **не подтверждено** | Только через менеджера | — |
| **Decagon** | Enterprise агенты поддержки | enterprise, sales-led | **Публичной цены нет** | **не подтверждено** | Только через менеджера | — |
| **Ada** | Enterprise агенты поддержки | enterprise | `/pricing` делает **301 на `/demo`** | **не подтверждено** | 8–16 недель платного внедрения | — |
| **Chatbase** | Self-serve агент на своём сайте | SMB self-serve | Free / Hobby **$40** / Standard **$150** / Pro **$500** в мес (кредиты 50/700/4 000/15 000). Доп.: $40 за 1 000 кредитов, $25/агент/мес, **$99/мес за снятие брендинга** | **Message credit** (за сообщение, не за решение) | Self-serve. Агенты free-тарифа удаляются после 14 дней простоя | [chatbase.co/pricing](https://www.chatbase.co/pricing) |
| **Botpress** | Конструктор ботов + Desk | SMB/mid | Free (100 разговоров) / Plus **$150/мес** (год, 250) / Team **$750/мес** (год, 1 500) / Enterprise | **Conversation** = ≥2 сообщения от пользователя за месяц; голос: 3 мин = 1 разговор. Каждый разговор включает **$0,10 LLM-расходов по себестоимости** | Self-serve | [botpress.com/pricing](https://botpress.com/pricing) |
| **Voiceflow** | Уход из SMB вверх | mid | **Публичную цену УБРАЛИ** | **не подтверждено** | — | — |

⚠️ **Botpress:** автопополнение на платных тарифах **обязательно и отключить нельзя** — на 95% квоты докупается пакет за $65 или $50.

**Fin: два скандала и честное признание сильных сторон.**

Дословно со страницы [fin.ai/pricing](https://fin.ai/pricing) (проверено автором отчёта лично): *«**Resolution**: No further help is requested after Fin's last answer. **Procedure handoff**: Fin completes a Procedure you've configured to hand off to a human. **Disqualification**… **Qualification**…»*. Пассивность определения Resolution: клиент, который плюнул и ушёл, тарифицируется так же, как тот, кому помогли.

**Скандал (первоисточник, не агрегатор):** тред [community.intercom.com](https://community.intercom.com/fin-product-feedback-member-group-49/fin-s-flawed-resolution-assumption-10516), 27.05.2025 — клиент проверил четыре недели: Fin коснулся 40 тикетов, 16 помечены «resolved by Fin» (**40% оплачено**), при проверке 9 из 16 решены не были → реальные **12,5% против 40% оплаченных**. CPO Paul Adams на «Built for You» 21.05.2025 заявил, что ответ сотрудника снимает списание; 04.06.2025 сотрудник Intercom **отозвал это** как «misstep»; 05.06 компания признала, что «didn't communicate the billing logic accurately». Под per-resolution-инвойсы **возникла ниша аудиторов счетов** (TareCount).

**Признать честно:** у Fin **ЕСТЬ** контроль бюджета (*«Control built in — Manage usage with configurable alerts, limits, and real time reporting»*, hard limits на Operator-кредиты $0,01/кредит) и **ЕСТЬ** Simulations, Regression Tests, Previews, Audience Testing. Тезис «ни у кого нет кэпов» для Fin **не работает**.

**Zendesk: PM официально подтвердил, что клиентов тарифицировали за нерешённое** — тред на 90 ответов ([community.zendesk.com](https://community.zendesk.com/product-updates/we-are-excited-to-launch-ai-agents-and-automated-resolutions-6337/index8.html)). Статья базы знаний с текстом «an agent must do this for you», клик «Yes, this answered my question» тарифицировался как automated resolution; PM Ryan McGrew 22.07.2025: это *«expected behavior today and aligns with how resolutions are measured»*. Цитаты: «It appears we were vastly overcharged»; «massive bait-and-switch»; 10 бесплатных решений/агент/мес — «insultingly low». **Zendesk это починил 18.05.2026, Fin — нет.**

**Sierra и Decagon: проверяемой критики не существует.** Поиск по HN дал **ноль настоящих клиентских жалоб**. Вся ходящая критика восходит к статьям конкурентов (прежде всего eesel AI, который сам раскрывает, что он конкурент Sierra). **Не подтверждено — не ставить в презентацию.** Настоящая защитимая слабость: **нет публичных цен, нет самообслуживания, нет триала, только продажи через менеджера.**

**Правовой прецедент:** *Moffatt v. Air Canada*, трибунал Британской Колумбии, февраль 2024 — компания заявила, что её чат-бот отдельная сущность; трибунал отверг это. **Ответственность несёт тот, кто развернул агента, а не вендор** ([ABA](https://www.americanbar.org/groups/business_law/resources/business-law-today/2024-february/bc-tribunal-confirms-companies-remain-liable-information-provided-ai-chatbot/)).

**Telegram, русский, узбекский (10 вендоров поддержки):**

| Вендор | Telegram | Русский | Узбекский | Инбокс оператора |
|---|---|---|---|---|
| Sierra | ❌ | вероятно, списка нет | не подтверждено | Частично — эскалация в ваш контакт-центр |
| Decagon | ❌ | не подтверждено | не подтверждено | Своего инбокса нет |
| **Fin** | ❌ | ✅ | ✅ **единственный на рынке** | ✅ нативный Inbox |
| Ada | ❌ | ✅ | ❌ (нет в списке 60 языков, хотя есть казахский и белорусский) | Своего инбокса нет |
| Zendesk | ⚠️ только через Sunshine Conversations, Suite Professional+ ($115/агент/мес) | ✅ | ❌ | ✅ |
| Agentforce | ❌ только кастомный «Bring Your Own Channel» | ❌ (только EN; FR/IT/DE/ES/PT в бете) | ❌ | ✅ |
| Chatbase | ❌ только через Zapier/Make | не подтверждено | не подтверждено | ✅ |
| Voiceflow | ❌ **имел и убрал** — `/integrations/telegram` делает 301 | не подтверждено | не подтверждено | Своего инбокса нет |
| **Botpress** | ✅ **нативный, поддерживается командой** | не подтверждено | не подтверждено | ✅ Botpress Desk, даже на Free |

**Четыре вывода отчёта:** нативный Telegram — **1 из 10**; Voiceflow Telegram имел и **снял** (это не пробел поиска); узбекский есть **ровно у одного вендора — Fin**; **локализованной админ-панели нет ни у кого** — Ada дословно: *«The Ada dashboard is only available in English»*.

**Финансирование:** Sierra $1,585 млрд привлечено, оценка **>$15 млрд**, ARR $150 млн (фев. 2026) / ~$200 млн (май 2026, по сообщениям). Fin $490 млн, **продан за $3,6 млрд**. Decagon ~$481 млн, **$4,5 млрд**, ARR ~$100 млн (июль 2026, по сообщениям). Parloa >$560 млн, **$3 млрд**, ARR >$50 млн. Ada ~$202 млн, **раундов с мая 2021 нет**. Botpress $45 млн, $120 млн, ~$10 млн ARR. Voiceflow $38,5 млн, ~$9,9 млн ARR, **раундов с 2023 нет**.

🎯 **Chatbase — самый важный ориентир во всём исследовании.** **$0 венчурных денег**, бутстрап, **18 человек (11 инженеров), >$10 млн ARR, 8 000+ платящих клиентов, self-serve от $40/мес** ([Supabase case study](https://supabase.com/customers/chatbase)). Ближайшее существующее доказательство, что self-serve модель достижима без корпоративных продаж.

> **Будут ли конкурировать за ташкентский SMB?** Sierra, Decagon, Ada — никогда: sales-led без публичных цен и триала. Fin — нет, биллит **только в USD** (дословно: *«Right now, we can't bill in any other currencies»*) и уходит в Salesforce. Реальные сопоставимые — **Chatbase и Botpress**: self-serve, публичные цены, у Botpress нативный Telegram. Но у обоих нет узбекского, нет UZS и нет CRM-действий.

### 4.4. Sales / SDR-агенты — девять вендоров, семь счётчиков

| Вендор | Позиционирование | Сегмент | Цена | Единица тарификации | Онбординг | Источник |
|---|---|---|---|---|---|---|
| **11x (Alice)** | «The AI Growth Company» / «digital workers» | mid/enterprise | ⚠️ **Страница противоречит сама себе:** карточка «Starting at **$3 750/mo**, billed annually» ($45 тыс/год) против FAQ там же — «11x starts at **$36,000 per year**» ($3 тыс/мес). **Расхождение $9 тыс/год** | **Новые prospects/мес** (2 000/5 000/10 000+). *«We charge per lead, not per send»* | 2–4 недели | [11x.ai](https://www.11x.ai/products/alice/pricing) |
| **Artisan** | AI SDR «Ava» | mid | **Ни одной цифры.** Team/Scale/Enterprise — «Pricing scoped on your plan» | Leads contacted/mo (~2 500/~6 000/custom) + диалер за место | — | [artisan.co/pricing](https://www.artisan.co/pricing) |
| **Regie.ai** | Sales-агенты | SMB/mid | Free $0 (250 кредитов) · Pro **$49/мес** (5 000) · Enterprise | Кредиты (research, drafting, enrichment, dialing); пустой enrichment бесплатен | Self-serve | [regie.ai/pricing](https://regie.ai/pricing) |
| **Clay** | GTM data + оркестрация | mid | Free · Launch **$167/мес** (год)/$185 · Growth **$446/мес** (год)/$495 · Enterprise | **Двойной:** Actions (от <$0,01) + Data Credits (от $0,05) | Self-serve | [clay.com/pricing](https://www.clay.com/pricing) |
| **Qualified** | Piper AI SDR (куплен Salesforce) | enterprise | Sales-gated. Vendr: медиана **$68 430/год**, разброс **$35 910–$120 259** (190 покупок) | Место, годовой, минимум 5–10 мест | Только менеджер | [vendr.com](https://www.vendr.com/marketplace/qualified) |
| **Unify** | «AI-augmented», не AI SDR | mid | Free · Base **$20/место/мес** (800 кред.) · Pro **$60/место/мес** (2 400) · Business | Место + кредиты. Email ≈1, телефон ≈4. **LLM списывается из кредитов** | Self-serve | [unifygtm.com/pricing](https://www.unifygtm.com/pricing) |
| **AiSDR** | AI SDR | SMB/mid | Solo **$250/мес** · Explore **$900** · Scale **$2 500** | AI-исследованные контакты/мес (200/800/2 500) | Self-serve | [aisdr.com/pricing](https://aisdr.com/pricing/) |
| **Lyzr** | «agentic OS» | mid | Cloud **$0,08 за запуск агента** · VPC/On-Prem **$0,03**. «No seats» | **Запуск агента**; LLM отдельно pass-through | Self-serve | [lyzr.ai/pricing](https://www.lyzr.ai/pricing/) |
| **Salesforge** | Outbound + Agent Frank | SMB/mid | Pro **$48/мес** ($40 год) · Growth **$96** ($80) · **Agent Frank $499/мес** (кварт.)/$416 (год) | **Пять счётчиков сразу:** активные контакты, письма/мес, валидация, персонализация, соц.действия. Frank: +$0,25/контакт свыше 2 000 | Self-serve | [salesforge.ai/pricing](https://www.salesforge.ai/pricing) |

**Ценовая яма 76-кратная:** Regie **$49/мес** против 11x **$3 750/мес** — середина рынка не обслужена никем.

⚠️ **Реальная цена Artisan — не подтверждено.** tomba.io: «низкие тысячи в месяц»; bestaiagents.app: «Intern $250/мес, Employee $600/мес». Обе — SEO-контент, **взаимно несовместимы**, ни одна не совпадает со структурой тарифов на сайте.

**Скандал 11x — подтверждён** ([TechCrunch, 24.03.2025](https://techcrunch.com/2025/03/24/a16z-and-benchmark-backed-11x-has-been-claiming-customers-it-doesnt-have/), ~24 источника): ZoomInfo — *«We did not give them permission to use our logo… we are not a customer»*, триал показал *«11x's product performed significantly worse than our SDR employees»*; юрист ZoomInfo написал о *«deceptive trade practices, trademark infringement, misappropriation of goodwill, and false advertising»*; годовые контракты с 3-месячным разрывом считались как полный год, заявляли **$14 млн ARR при реальных ~$3 млн**; сотрудник: «теряли 70–80% клиентов»; бывший инженер: *«The products barely work»*. Последствия: Sarah Tavel (Benchmark) перешла из GP в venture partner; **05.05.2025 CEO Hasan Sukkar ушёл**. На 27.08.2026 компания жива; увольнений, down-раунда или закрытия **не найдено — не подтверждено**.

**Здоровье категории.** Lusha (поставщик данных, **не конкурент**), 10.05.2026: *«The failure wasn't the AI… The failure was the assumption underneath: that data quality at scale was a solved problem. It isn't.»* и *«The category isn't dead — the label is.»* Бегство от ярлыка: 11x → «digital workers»; Lyzr → «agentic OS»; Unify → «AI-augmented»; Salesforce/Qualified → «agentic AI marketing»; **G2 переименовал категорию в «AI Sales Assistant»**.

**Механизм backlash — первоисточник Google:** с 01.02.2024 обязательны SPF/DKIM, PTR, TLS, **spam rate < 0,30%** (цель «ниже 0,10%»), для 5 000+/день SPF+DKIM+DMARC; прямо запрещено *«Don't purchase email addresses from other companies»* ([support.google.com](https://support.google.com/a/answer/81126)).

⚠️ **Не использовать:** пласт SEO-контента «AI SDR is dead / 47% collapse» (greenway.ai, pynghq.com, alleyoop.io) — **ИИ-генерированный, статистика непроверяема**.

**🔴 Покрытие данных по Центральной Азии — численное доказательство.** People Data Labs — **единственный, кто публикует разбивку по странам** ([docs.peopledatalabs.com](https://docs.peopledatalabs.com/docs/countries)), 227 стран, 777 485 725 записей:

| Страна | Записей | Место |
|---|---|---|
| США | 198 422 290 | 1 (**25,5% датасета**) |
| Индия | 86 687 712 | 2 |
| Украина | 1 801 979 | 52 |
| **Казахстан** | **512 434** | 89 |
| **Узбекистан** | **297 643** | 103 |
| Кыргызстан | 90 168 | — |
| **Россия / Беларусь** | **ОТСУТСТВУЮТ в таблице** | — |

**США : Узбекистан = 667 : 1.** Вся ЦА = 970 959 = **0,125% датасета**. Узбекистан ниже Ботсваны, Боснии, Руанды и Намибии. Оговорка PDL: набор *«has a rate of duplication»* — реальное число уникальных людей ещё ниже.

⚠️ **Две ловушки, проверенные и отброшенные:** Apollo `/companies/uzbekistan` отдаёт 410 — но `/companies/germany` тоже 410; ZoomInfo `/location-uzbekistan` отдаёт 403 — но и `location-germany` тоже. **Это не сигналы про Узбекистан.**

**Корректная формулировка для питча (из отчёта):** утверждать «у них нет данных по СНГ» — недоказуемо. Доказуемо: *«вся категория стоит на слое данных, чьи единственные опубликованные цифры дают Центральной Азии одну тысячную от покрытия США, а все остальные поставщики отказываются публиковать региональные показатели вообще»*.

**Telegram и русский:** Telegram — **0 из 9**. 11x явно перечисляет WhatsApp для LATAM/APAC и **не упоминает Telegram** — сознательный выбор карты каналов. AiSDR публикует 16 языков, включая **украинский**, **не включая русский**. 11x «105+ языков» только на Pro+ (custom pricing). **Узбекского нет ни у кого.**

> **Будут ли конкурировать за ташкентский SMB?** Нет, и это доказуемо численно. Категория стоит на слое B2B-данных, где Узбекистан — 0,04% выборки, ни один вендор не поддерживает Telegram, и середина рынка (между $49 и $3 750) не обслужена. **Для Nemo это не конкуренты, а источник аргументов.**

### 4.5. Большие платформы

| Вендор | Позиционирование | Сегмент | Цена | Единица тарификации | Онбординг | Источник |
|---|---|---|---|---|---|---|
| **OpenAI** | Workspace Agents в ChatGPT | SMB→enterprise | Free · **Go $5/мес** · Plus $20 · Pro от $100 · **Business Standard $20/юзер/мес** (год)/$25 · **Business Premium $100/юзер/мес** (год) · Enterprise custom | Место; Workspace-агенты включены в Business-место. AgentKit — «included with standard API model pricing» | Внутри ChatGPT | [chatgpt.com/pricing](https://chatgpt.com/pricing/) |
| **Anthropic** | Поставщик интеллекта, не конкурент | — | Team Standard **$20/место/мес** (год), Team Premium **$100**, Enterprise $20/место + usage. **Managed Agents $0,08 за час активной сессии** + токены. API: Haiku 4.5 **$1/$5** за MTok, Sonnet 5 $2/$10, Opus 5 $5/$25. Batch −50% | Место / час / токены | — | [claude.com/pricing](https://claude.com/pricing) |
| **Microsoft** | Copilot Studio | enterprise + SMB через M365 | M365 Copilot enterprise **$30,00/юзер/мес** (год); **M365 Copilot Business (SMB): было $21,00 → теперь от $18,00**; **Copilot Studio $200 за пакет/мес = 25 000 Copilot Credits** ⇒ **$0,008/кредит** | Кредит: классический ответ 1 · генеративный 2 ($0,016) · действие агента 5 ($0,04) · заземление на граф 10 ($0,08) · премиум/reasoning **10 кредитов за 1K токенов** · GenAI-голос **35 кредитов/мин ($0,28/мин)** | Внутри M365 | [microsoft.com](https://www.microsoft.com/en-us/microsoft-365-copilot/pricing/copilot-studio) · [learn.microsoft.com](https://learn.microsoft.com/en-us/microsoft-copilot-studio/requirements-messages-management) |
| **Google Gemini Enterprise** | *«For small businesses and teams. No IT setup needed»* | SMB→enterprise | **Business от $21/место/мес** (до 300 мест, no-code Agent Designer, триал 30 дней) · Standard/Plus **от $30/место/мес** · Pay-as-you-go **$0 за место** (от 20 мест, оплата по токенам; **ограниченный роллаут**) | Место / токены | Self-serve, no-code Agent Designer | [cloud.google.com/gemini-enterprise](https://cloud.google.com/gemini-enterprise) |
| **AWS** | Bedrock AgentCore / Amazon Q Business | enterprise | AgentCore: Runtime **$0,0895/vCPU-час + $0,00945/ГБ-час**, Memory $0,25–0,75 за 1 000, Gateway $0,005–0,025 за 1 000. Q Business: Lite **$3/юзер/мес**, Pro **$20**, **Enterprise Index $0,264/час за юнит** | Компьют / юзер | — | [aws.amazon.com](https://aws.amazon.com/bedrock/agentcore/pricing) · [aws.amazon.com/q/business/pricing](https://aws.amazon.com/q/business/pricing/) |

**🎯 Что реально заплатит малый бизнес — по собственному примеру Microsoft:** *«Customer support agent… 4 classic answers + 2 generative answers, 900 customers/day → 7,200 Copilot Credits/day»* → 216 000 кредитов/мес = 8,64 пакета ≈ **$1 728/мес за один сайтовый бот поддержки**, до всяких мест M365. Кредиты **не переносятся**; на **125% предоплаченной ёмкости Microsoft отключает кастомных агентов** («This agent is currently unavailable. It has reached its usage limit»).

**Самый дешёвый индекс AWS Q Business — ~$190/мес до единого пользователя.** Все примеры AWS начинаются с 500–5 000 сотрудников.

**🔴 Сигнал коммодитизации:** Google **Workspace Studio** («Automate your workday with intelligent AI agents») включён **во все четыре тарифа Workspace**, от Starter до Enterprise, **без доплаты** (~€7/место) ([workspace.google.com/pricing](https://workspace.google.com/pricing)).

**Валюты:** Salesforce — USD/AUD/GBP/EUR/JPY/SEK, **ни UZS, ни RUB**. Fin — *«Intercom is billed in United States Dollars (USD) only… Right now, we can't bill in any other currencies.»*

**Слабости больших платформ:**
- **OpenAI:** риск «выкатили и закрыли» доказан. Равнодушие разработчиков — URL анонса AgentKit подавали на HN 4+ раза, максимум **11, 6, 3 и 3 балла при 0–3 комментариях**. API-триггер искалечен: *«the API queues the agent run and returns `202 Accepted` with no response body. It does not return a run ID, and the agent's response cannot currently be retrieved through the API»*. **Нет Telegram.** Масштаб: *«Over 5 million business users worldwide»*.
- **Microsoft:** Telegram **не нативный** — только через Azure Bot Service, *«developer coding required»*. *«A user can't send or upload attachments to the chat… This limitation applies to all channels»* — агент **не может принять фото товара или чека**.
- **Google:** рамка «внутренняя продуктивность за место». Нет клиентского канала, нет Telegram, нет инбокса оператора, нет захвата лидов. Business-издание **не может** импортировать ADK или сторонних агентов. Вовлечённость на HN по анонсам Gemini Enterprise — **1–5 баллов, 0–2 комментария**. Масштаб в местах или выручке — **не подтверждено**.
- **Salesforce Agentforce:** *«Flex Credits and Conversations will not be supported in the same org»* — надо выбрать одно, смена SKU через менеджера; *«Unused Flex Credits do not roll over into subsequent subscription terms»*. ARR Agentforce **$1,2 млрд в Q1 FY27, +205% г/г**.
- **Anthropic — поставщик, а не конкурент.** Нет конструктора без кода, нет слоя каналов, нет CRM-интеграций, нет лид-форм, нет инбокса оператора. Ограничение: *«Unless previously approved, Anthropic does not allow third party developers to offer claude.ai login or rate limits for their products, including agents built on the Claude Agent SDK»* — нужны API-ключи. ✅ **Узбекистан в списке поддерживаемых стран** и для API, и для Claude.ai.

**LLM API — барьеров нет (проверено):** OpenAI API ✅ UZ/KZ, ChatGPT ✅, Anthropic API + Claude.ai ✅, Google Gemini API ✅. **Санкционных изъятий для UZ/KZ нет ни в одном списке** (в отличие от Украины).

> **Будут ли конкурировать за ташкентский SMB?** Google и OpenAI — **за внимание, не за нагрузку**: узбекский SMB может подключить ChatGPT Business ($20/место) или Gemini Enterprise Business ($21/место) сам, но у обоих **нет клиентского канала, Telegram и инбокса оператора**. Microsoft — только для тех, кто уже на M365. AWS — нерелевантен. **Главный эффект больших платформ: они задают ожидания покупателя о том, «сколько стоит агент»** — и эти якоря ($21/место, $1 728/мес за бота, $2,00 за разговор) работают в пользу Nemo, а не против.

**Провал корпоративных ИИ-проектов — что реально сказано.** «95% MIT» — отчёт *The GenAI Divide: State of AI in Business 2025*, издан **MIT Media Lab NANDA Initiative** (**не MIT Sloan, не рецензируемый**), метод: 150 интервью, 350 опросов, 300 проектов; утверждение — 95% пилотов не дали различимой финансовой отдачи. **Конфликт интересов отмечен Fortune** ([21.08.2025](https://fortune.com/2025/08/21/an-mit-report-that-95-of-ai-pilots-fail-spooked-investors-but-the-reason-why-those-pilots-failed-is-what-should-make-the-c-suite-anxious/)). Не выброс: Capgemini 2023 — 88%; S&P Global 2025 — 42% заброшены. 🎯 **Ключевое: причина — «learning gap», а не возможности моделей; купленные ИИ-инструменты давали успех в 67% случаев, внутренние разработки — ~22%.**

Gartner ([25.06.2025](https://www.gartner.com/en/newsroom/press-releases/2025-06-25-gartner-predicts-over-40-percent-of-agentic-ai-projects-will-be-canceled-by-end-of-2027)): **>40% агентских проектов будут отменены к концу 2027**; *«only about 130 of the thousands of agentic AI vendors are real»*. **Контр-факт** (Gartner, 26.08.2026): *«AI Spending by Customer Service Leaders Has Surged by 38%, Despite Overall Service and Support Function Budgets Rising by Just 2%»*.

---

## 5. Региональные конкуренты (СНГ и Узбекистан)

### 5.1. Российские / СНГ платформы

| Платформа | Цена | Сегмент / модель | Каналы | Узбекский | Источник |
|---|---|---|---|---|---|
| **Salebot** (salebot.pro) | ⚠️ **Три несовместимых набора цен в источниках.** Отчёт 2: Free (50 сообщ./день, 2 сотрудника); Standard **1 399 ₽**; Premium **1 799 ₽**; «по др. источникам: 1 299 / 2 999 / 5 999 ₽». Отчёт 1 (прямо с salebot.pro): Бесплатный 0 ₽; **Бизнес 2 999 ₽/мес** или 30 590 ₽/год (10 000 сообщ./день, **ИИ-ассистент включён**); **Инфобизнес 3 999 ₽/мес** или 40 790 ₽/год. Доп.: −15% при годовой оплате, +649 ₽ за доп. мессенджер, +599 ₽ за оператора | Конструктор + «ИИ-сотрудник уже в комплекте». Заявлено: **15 000+ компаний, 8 лет, 120 000 000+ клиентов, 60 000 000+ сообщений/день** | TG, WhatsApp, Instagram, Avito, VK | 🔴 **Нет.** Переключатель: ar, de, en, es, fr, **kk (Қазақша)**, lv, ms, pt, ru, tr, th, uk — **узбекского нет** | [docs.salebot.pro](https://docs.salebot.pro/nashi-uslugi/tarify), [salebot.pro](https://salebot.pro/) |
| **BotHelp** (bothelp.io) | START (14 дней) бесплатно, ∞ каналов, ≤3 000 подписчиков, 75 000 токенов · CREATOR **1 599 ₽/мес** (1 канал, только Instagram, ∞ подписчиков) · **PRO от 1 599 ₽/мес** (∞ каналов, от 1 000 подписчиков слайдером) · SCALE **от 29 990 ₽/мес**. Все — 150 000 токенов/мес. ⚠️ Др. источник в отчёте 2: **«от 500 ₽»**. Токен-пакеты: LIGHT 499 ₽ = 5M · BOOST 1 599 ₽ = 10M · ULTRA 7 999 ₽ = 40M | **ИИ-агенты и база знаний на каждом тарифе, включая триал.** PRO дословно: «1 599 ₽/мес / **0,25 ₽ за подписчика**… Вы платите только за активных подписчиков». Безлимит агентов, ботов, сценариев, сотрудников и сообщений на всех платных тарифах. **Казахстанское юрлицо: ТОО «BHKZ»** (футер: «© 2026 ООО "Ботхелп", ТОО "BHKZ"») | MAX, Telegram, Instagram, WhatsApp, ВКонтакте. Интеграции: GetCourse, amoCRM, Bitrix24, Tilda, Zapier | **Нет** | [bothelp.io/ru/pricing](https://bothelp.io/ru/pricing) (страница изменена 24.08.2026), [help.bothelp.io](https://help.bothelp.io/tarify-i-oplata/) |
| **TextBack** | от **2 990 ₽** (~$35,3) | Мессенджер-маркетинг, 14 дней триал, автоворонки, безлимитные рассылки | Мессенджеры | **Нет** | [toolfox.ru](https://toolfox.ru/services/s/textback) |
| **PuzzleBot** (puzzlebot.top) | ⚠️ **Расхождение между отчётами.** Отчёт 1: Креативный **891/990 ₽**, Расширенный **1 521/1 690 ₽**, Профессиональный **2 691/2 990 ₽**/мес. Отчёт 2: **300–1 000 ₽**. Free: 1 бот, 150 пользователей, с рекламой. **Лимит выручки на аккаунт:** Free 3 000 ₽/мес, Креативный 30 000 ₽, Расширенный 80 000 ₽ | ⚠️ **ИИ/LLM/агентских функций нет вообще** — детерминированный no-code конструктор ботов и Mini App. Заявлено: 67К разработчиков, 83К ботов ежедневно, «свыше 6М пользователей Telegram». **Конкурирует за бюджет, не за возможности** | Telegram, Max | **Нет.** Но 🔴 платёжные интеграции для юрлиц явно включают **Payme (business.payme.uz)** и **Click.uz**; магазин ботов поддерживает «Рублях Гривнах Тенге **Сум** Долларах Евро»; в кейсах — **Fanstore.uz** (t.me/Fanstorebot) | [puzzlebot.top](https://puzzlebot.top/) |
| **Leadtex** (leadteh.ru) | от **1 100 ₽** (~$13) | Конструктор | WhatsApp, TG, Viber, VK | **Нет** | [help.leadteh.ru](https://help.leadteh.ru/tarify) |
| **Aimylogic / Just AI** | Тарифы **не подтверждено** — `aimylogic.com/ru/price` отдал пустое тело дважды | Just AI: «Лидер GenAI-трансформации бизнеса в России», осн. 2011, **200+ специалистов**; продукты Just AI Agent Platform, **Caila** («300+ LLM под одним API», OpenAI-совместимый), Jay Guard (блокировка prompt-injection, маскирование данных), Jay Copilot. Клиенты: Альфа-Банк, Сбер, МТС, Мегафон, X5, Ozon, Билайн. **Публичных цен нет.** Aimylogic: **60 000+ клиентов**, 21+ канал | TG, WA, Viber, IG, Meta, JivoChat, Bitrix24, IFTTT, Zapier | 🔴 Языки чат-бота дословно: *«русский, казахский, английский, испанский, португальский»* — **узбекского нет** | [just-ai.com](https://just-ai.com), [help.cloud.just-ai.com](https://help.cloud.just-ai.com/en/aimylogic/) |
| **TWIN (Twin24)** | **Публичных цен нет** — CTA дословно «А сколько стоит внедрение? … Узнать цену». Forbes (со ссылкой с их пресс-страницы): привлекла **120 млн рублей** | ООО «Уралинновация», Сколково. 🔴 **Продаёт франшизу** («Продавайте продукты TWIN по договору франшизы в вашем городе») + White Label + реферальная программа + платный курс сертификации. *Вывод отчёта (не факт):* это ровно тот механизм, которым российский вендор оказывается в Ташкенте без открытия офиса | **Telegram**, MAX, WhatsApp, Avito; интеграции с Bitrix24. Клиенты: Tanuki, ПЭК, Совкомбанк | **не подтверждено** | [twin24.ai](https://twin24.ai) |
| **ManyChat** | от **$15** | Глобальная, лидер по Instagram | Instagram, FB Messenger | Нет | — |
| **Chatfuel** | от **$19** | Глобальная | IG, FB, WA | Нет | — |
| **autoFAQ** | — | **данные не найдены** — подтверждения актуального статуса не получено | — | — | — |
| **Sherlock / Craftalk** | — | **данные не найдены** | — | — | — |
| **Twin** (отдельной строкой в отчёте 2) | — | **данные не найдены** | — | — | — |
| **Fistashka** | — | **данные не найдены** | — | — | — |

🔴 **BotHelp — единственный вендор во всём исследовании, кто публикует стоимость диалога.** Дословно: *«1 диалог ≈ 500–6 000 токенов. 150 000 токенов ≈ 25–300 диалогов»*. Ни Kommo, ни amoCRM, ни Bitrix24 этого не делают.

**Выводы отчёта 2 по российским платформам:**
1. **Ни одна не заявляет поддержку узбекского** — ни в интерфейсе, ни в контенте.
2. Ценовой уровень **$3,5–35/мес** заметно ниже MoonAI ($50 + токены). Это ценовой якорь для узбекского МСБ, который уже знает эти сервисы.
3. Все — **классические конструкторы сценариев/автоворонок**, а не LLM-агенты (кроме частичных AI-надстроек: BotHelp даёт AI-токены в тарифе).
4. Расчёты в рублях + российская юрисдикция = фрикция для узбекского юрлица. Не блокер, но налог на конверсию.

**Живой сигнал трения (PuzzleBot, зарубежный рельс Prodamus):** *«Цена тарифа была автоматически изменена на минимальную сумму 11 долларов. К сожалению, это ограничение платёжной системы»*.

### 5.2. Провайдеры моделей в регионе — поставщики, не конкуренты

**Yandex AI Studio** (aistudio.yandex.ru), выделен из Yandex Cloud в отдельный бренд. **Agent Atelier** — работающая среда конструирования агентов: «Конструктор агентских сценариев — от простых ассистентов до end-to-end автоматизации бизнес-процессов». Масштаб с их сайта: **225+ млрд токенов в месяц, 40+ тыс. клиентов, 50+ компаний из РБК-500**. Грант новичку 4 000 ₽; «AI Studio Boost» — гранты **до 1 млн рублей**.

🔴 Публикует цены в тенге ([yandex.cloud](https://yandex.cloud/ru/docs/foundation-models/pricing)):

| Модель | ₽ / 1000 ток. (sync) | ₸ / 1000 ток. (sync) |
|---|---|---|
| YandexGPT Lite | 0,20 ₽ | 1,00 ₸ |
| YandexGPT Pro | 1,20 ₽ | 6,00 ₸ |
| Embeddings | 0,01 ₽ | 0,05 ₸ |

Комплаенс дословно: «Данные хранятся в соответствии с российским законодательством».

**Sber GigaChat** ([developers.sber.ru](https://developers.sber.ru/docs/ru/gigachat/tariffs/legal-tariffs), обновлено 15.07.2026, цены действуют с 01.02.2026, с НДС): PAYG за 1000 токенов — Lite **0,065 ₽**, Pro **0,5 ₽**, Max **0,65 ₽**, Embeddings 0,014 ₽. Минимальный месячный платёж 600 ₽. Пакеты: Lite 1 000M = 65 000 ₽ (⇒ **65 ₽ за 1 млн токенов** — *арифметика автора отчёта, вывод*); Max 1 000M = 650 000 ₽.

Физлицам — **365 000 000 бесплатных токенов на 12 месяцев**, 🔴 но дословно: *«Бесплатный доступ (Freemium-режим)… предоставляется исключительно для личного некоммерческого использования. Коммерческое использование… допускается только после приобретения платного пакета услуг.»* **Под SaaS их подложить нельзя.**

**Доступность и оплачиваемость GigaChat и Yandex AI Studio из Узбекистана — не подтверждено.** Оба требуют РФ/КЗ-контрактующих лиц в проверенных потоках; ни один не публикует цены в сумах.

### 5.3. amoCRM — AI-агент «Амма»

**Амоконф, 18.04.2026, Москва — крупнейшее обновление за историю продукта** ([gnzs.ru](https://gnzs.ru/blog/amoconf2026), опубл. 20.01.2026, изм. 20.04.2026):

- **«Амма»** — встроенный AI-агент: анализирует сделки и подсказывает проблемы, **сам формирует ответы клиентам**, помогает в переписке, **настраивает CRM «с нуля» через диалог**, строит отчёты
- **Онбординг через диалог:** создание аккаунта, добавление сотрудников, настройка воронки, подключение каналов, создание ботов — «за несколько минут, только через общение с AI»
- **Кастомные AI-агенты пользователя:** свой стиль общения, подключение баз знаний, автоматизация диалогов
- Аналитика на естественном языке («Продажи за вчера», «Кто из менеджеров проседает»), AI создаёт виджеты
- Официальная интеграция с мессенджером **Max**
- Enterprise-безопасность: SSO, 2FA, скрытие чувствительных данных с логированием, роль «владелец аккаунта»

**Что умеет агент в GA** (заперт за Профессиональным, [amocrm.ru/ai-agent](https://www.amocrm.ru/ai-agent/)): ответы на базе знаний, рекомендация по каталогу с ценой и остатком, квалификация лида, **действия в CRM** (*«создавать задачи, менять ответственного за сделку, переводить сделку на другой этап воронки, запускать нужный сценарий Salesbot… заполнять поля в карточке»*), настраиваемая передача оператору с авто-саммари диалога. **Telegram подключается вставкой токена BotFather — бесплатно, без шлюза, без платы за сообщение.**

**Партнёрские города в Узбекистане: Ташкент, Самарканд, Наманган, Нукус.**

#### ⚠️ Цены — два источника расходятся, оба сохранены

**Отчёт 1** ([amocrm.ru/buy](https://www.amocrm.ru/buy), **проверено автором отчёта лично 27.08.2026**; переключатель валют содержит **uzs**):

| Тариф | RUB | KZT | **UZS/юзер/мес** |
|---|---|---|---|
| Базовый | 599 ₽ | 5 199 ₸ | **79 000 soʻm** |
| Расширенный | **1 199 ₽ до 1 сентября** (далее 1 299 ₽) | 9 899 ₸ | **169 000 soʻm до 1 сентября** (далее **179 000**) |
| Профессиональный | **1 699 ₽ до 1 сентября** (далее 1 799 ₽) | 15 099 ₸ | **249 000 soʻm до 1 сентября** (далее **259 000**) |

⚠️ Нюанс, пойманный при личной проверке: цены на Расширенный и Профессиональный — **промо, истекают через 5 дней от даты отчёта** (то есть 01.09.2026).

**Отчёт 2** ([gnzs.ru](https://gnzs.ru/tarify-amocrm), [lakki-crm.ru](https://lakki-crm.ru/tseny-i-tarify-amocrm/)):

| Тариф | Цена | USD |
|---|---|---|
| Базовый | от **499 ₽**/польз./мес (через партнёра, 12 мес) | ~$5,9 |
| Расширенный | ~**832 ₽**/польз./мес (годовая) / 999 ₽ помесячно | ~$9,8 / $11,8 |
| AMOATS (для малого бизнеса) | **999 ₽ за аккаунт** | ~$11,8 |

**Токены:** включено **5 000 / 10 000 / 15 000** на юзера в месяц. Докупка **100 000 токенов = 999 ₽ / 9 899 ₸ / 139 000 soʻm**. **Минимум 6 месяцев, помесячной оплаты нет:** *«Стоимость тарифных планов установлена для подписки от полугода, помесячной оплаты в настоящее время нет.»* Пакет **«Микро-бизнес»: 2 юзера, 999 000 soʻm/год, 90 000 токенов**.

**Kommo** (международный близнец, только USD): **$15 / $25 / $45** за юзера/мес, минимум 6 мес. **Убрал агента из начального тарифа:** *«Starting June 1, 2026, new Base plan users won't have access to the AI agent»* ([support.kommo.com](https://support.kommo.com/docs/plans-limits.md), обновлено 14.08.2026). Агентов на воркспейс: Base — нет, Advanced 3, Pro 50. **Кредитов на разговор Kommo публиковать отказывается — не подтверждено**, то есть клиент не может спрогнозировать стоимость.

### 5.4. Bitrix24 — цены в сумах, за всю компанию

[bitrix24.uz/prices](https://www.bitrix24.uz/prices/):

| Тариф | Пользователей | **UZS/мес** | ⚠️ USD/мес — **два разных числа** | KZT/мес | RUB/мес | По акции (−35%, 3–31 авг. 2026) |
|---|---|---|---|---|---|---|
| Бесплатный | ∞ (UZ/KZ/RU), но **1–2 юзера международно** | 0 | 0 | 0 | 0 | — |
| Базовый | 5 | **288 000** | **$49** (собств. USD-прайс, год, отчёт 1) / **~$24,5** (пересчёт UZS по 11 778,52) | 13 000 ₸ | 2 490 ₽ | 187 200 UZS |
| Стандартный | 50 | **875 000** | **$99** / **~$74,3** | 38 000 ₸ | 6 990 ₽ | 568 750 UZS |
| Профессиональный | 100 | **1 750 000** | **$199** / **~$148,6** | 76 000 ₸ | 13 990 ₽ | 1 137 500 UZS |
| Энтерпрайз | 250 | **4 300 000** | ~$365 (пересчёт) | — | — | 2 795 000 UZS |
| Энтерпрайз | 10 000 | 127 000 000 | ~$10 782 (пересчёт) | — | — | 82 550 000 UZS |

⚠️ **Сохранённое расхождение:** отчёт 1 приводит собственную USD-колонку Bitrix24 ($49/$99/$199 при годовой оплате), консолидированная выжимка приводит пересчёт сумовых цен по курсу ЦБ ($24,5/$74,3/$148,6). **Разница ~2×.** Отчёты это не примирили; трактовка (разный период оплаты, региональное ценообразование или ошибка) — **не установлена**.

⚠️ Скидка −35% — **промо только 3–31 августа 2026** (УЗ+ТДж для зоны .UZ, КЗ+КГ+ТМ для .KZ). Постоянная годовая скидка по их же FAQ — **−20%**. Тарифы продаются **только на 1 или 12 месяцев**; принимается Visa/MasterCard **и** оплата по счёту от физлица, ИП или юрлица. **Возврат невозможен:** *«по законодательству РУз можно вернуть только товары или отказаться от услуг, вернуть переданное право нельзя»* — это прямо влияет на политику refund у Nemo.

**AI в Bitrix24 (2026):**
- **BitrixGPT** (бывш. CoPilot, переименован в апреле 2026) — на всех тарифах, **включая бесплатный**
- Бесплатный образовательный пакет: **100 / 100 / 100 / 200 / 400 ИИ-запросов в месяц на весь аккаунт** (Free/Базовый/Стандартный/Проф/Enterprise). Отчёт: **100 запросов/мес — это ~3 в день на всю компанию: демо, а не рабочая нагрузка**
- Бусты по 1 000 доп. запросов/мес — **цена буста в любой валюте: не подтверждено** (цифры 1 000/3 000/6 000 ₽ рядом на странице — это буст **хранилища**, проверено по окружающему тексту)
- 🔴 **AI-агенты — статус «скоро»** на матрицах **и bitrix24.uz, и bitrix24.kz**: системные AI-агенты, конструктор бизнес-процессов и AI-агентов, модифицирование агентов, **создание своих AI-агентов**, внешний AI-агент **Hermes**. Также «скоро» — **«BitrixGPT в Открытых линиях»** со строкой «AI-ответы клиентам в Открытых линиях». **Международная страница CoPilot содержит ноль упоминаний ИИ-агентов**
- **Уже отгружается:** транскрибация звонков, автозаполнение полей CRM, речевая аналитика, саммари встреч, генерация текста и картинок, **Битрикс24 MCP** (MCP Hub + MCP-сервер)
- Модельная стратегия дословно с bitrix24.uz: *«Мы разработали концепцию открытого BitrixGPT, чтобы вы могли использовать языковые модели разных компаний: YandexGPT, OpenAI и другие. Не платите дважды…»* — **bring-your-own-model снимает геоблокировку как барьер для UZ**

**Каналы Открытых линий:** Facebook, Instagram, WhatsApp, **Telegram**, VK, MAX, Viber, Apple Messages for Business, виртуальный WhatsApp. Telegram на всех зонах (Free 1 канал, Базовый 2, Стандартный 10, Проф ∞). **«Интернет-магазин внутри Telegram» — в бете**: каталог → заказ → оплата внутри чата. Отчёт: «это Bitrix24 инвестирует прямо в вашу канальную гипотезу».

**След в Узбекистане:** **45 сертифицированных партнёров** (против 2 880 в РФ, 221 в КЗ) ([bitrix24.uz/partners](https://www.bitrix24.uz/partners/)) — Первый Бит Узбекистан, MICROS, Simple Solutions, Vulpes Solutions, RED BUTTON, CORE DYNAMICS, UNIDREAM. Локализованные узбекские Telegram/Instagram/YouTube.

### 5.5. Установленная база

| Метрика | Значение | Год | Источник |
|---|---|---|---|
| Bitrix24, зарегистрированных компаний (глобально) | **>15 000 000** (зарегистрировано, **не платит**; число платящих **не подтверждено**) | 2026 | bitrix24.uz (собственное заявление, футер) |
| amoCRM, клиентов (глобально) | **>100 000** | — | [ITQlick](https://www.itqlick.com/compare/bitrix24/amocrm) |
| **Установленная база amoCRM и Bitrix24 в Узбекистане** | **данные не найдены** | — | — |

**Косвенные индикаторы** ([fera-tech.com, 16.02.2026](https://fera-tech.com/ru/blog/ai-and-business-automation-in-uzbekistan-2026-state-of-market/)): amoCRM лидирует по использованию в продажах в UZ; Bitrix24 и локальная разработка **IOTA.uz** также распространены; учёт — 1С и МойСклад; телефония — Sipuni и OnlinePBX. Партнёры-интеграторы в Ташкенте: **crmpro.uz (>1000 компаний)**, **icorp.uz (>250 клиентов)**, mcrm.uz, softeam.uz, upsoft.uz, getline.uz, amocrm-ozbekiston.uz. Лидер рейтинга Bitrix24 2025 по облаку — «Первый Бит Узбекистан».

### 5.6. Что реально платит узбекский SMB сегодня

Сценарий: 3 юзера, входящий Telegram, нужен ИИ-автоответ (таблица отчёта 1):

| Вариант | В месяц | Автономный агент? |
|---|---|---|
| Bitrix24 Базовый (5 мест включено) | **288 000 UZS за всё** | **Нет — «скоро»** |
| amoCRM Базовый ×3 | 237 000 UZS | Нет — агент требует Проф |
| **amoCRM Профессиональный ×3** | **747 000 UZS** (мин. 6 мес; с 1 сент. — 777 000) | **Да, GA** |
| amoCRM Проф ×3 + 100k токенов | 886 000 UZS | Да |
| BotHelp PRO | ~1 599 ₽ | Да |
| Kommo Advanced ×3 | $75 | Да |

**🎯 Ценовое окно — между 288 000 и 747 000 UZS/мес.**

**Наблюдение отчёта:** amoCRM берёт **в 3,15 раза больше за место** (79 000 → 249 000 сумов) исключительно за разблокировку агента.

### 5.7. Узбекистанские игроки

Базовый источник — карта рынка **Gorgona AI × ALPHA, июнь 2026**, 100+ участников в 14 сегментах ([gorgona.uz](https://gorgona.uz/ru/blog/ai-uzbekistan-map-2026)).

| Компания | Модель | Цены | Каналы | Узбекский | Источник |
|---|---|---|---|---|---|
| **Cybernet AI** (cyber-net.ai) | Голосовые AI-агенты, enterprise. Резидент IT Park | **не публичны** | Телефония (входящие/исходящие) | **Да, нативно** + свободный переход на русский, двуязычные диалоги | [gazeta.uz, 10.06.2025](https://www.gazeta.uz/ru/2025/06/10/cybernet-ai/) |
| **Lynx AI** (lynx-ai.uz) | AI-агенты + собств. UZ STT/TTS + AI-телефония | **не публичны** (страница /pricing есть) | Telegram, Instagram, сайт, IP-телефония, CRM | **Да**, UZ/RU/EN | [lynx-ai.uz](https://lynx-ai.uz/ru/solutions/ai-agents) |
| **Aisha AI** (aisha.group) | Голосовые агенты, TTS/STT, аналитика звонков, meeting AI | **не публичны** | Звонки, чат | **Да**, UZ/RU/EN | aisha.group |
| **aisolution.uz** | Интегратор + проекты под ключ, собств. UZ-STT | **$1 990 / $9 900 / от $27 900** (разово, без абонплаты) | TG, IG, WhatsApp, сайт, звонки, email | **Да**, UZ/RU/EN (с мая 2026) | [aisolution.uz](https://aisolution.uz/en) |
| **Innosoft** (innosoft.uz) | Кастомная разработка AI-агентов | **5–8 / 10–15 / 15–25 млн UZS** (~$425 / $850–1 275 / $1 275–2 122) | TG, Web, WhatsApp, CRM, 1С, Bitrix24, Payme, Click | **Да**, UZ/RU/EN | [innosoft.uz](https://innosoft.uz/blog/bizness-uchun-ai-agentlar) |
| **Repli AI** | SaaS-платформа автоматизации продаж и поддержки, NLP + RAG | **данные не найдены** | Instagram, Telegram, WhatsApp | **Да**, локализация для UZ и RU | [timesca.com, 05.08.2026](https://timesca.com/uzbekistan-ai-economy/) |
| **Gorgona AI** | AI-агенты **on-premise**, для чувствительных данных | **не публичны** | — | — | gorgona.uz |
| **Arkon AI** (arkonai.uz) | AI-агенты для клиентов/персонала/продаж (в т.ч. HoReCa) | **не публичны** | — | — | gorgona.uz |
| **KOTIB AI** (kotib.ai) | Из транскрибации → платформа автоматизации | **не публичны** | — | Да | gorgona.uz |
| **Fera Tech** (fera-tech.com) | Студия: TG-боты, AI-агенты, CRM-интеграции | Простой TG-бот **0,5–1,5 млн UZS**; бот+оплата **1,5–5 млн**; AI-агент с CRM **от 5 млн**; поддержка **от $50/мес** | Telegram (основной) | Да | fera-tech.com |
| **Tipa агентство** (tipa.uz) | Агентство: боты, CRM | FAQ-бот no-code **1,5–4 млн UZS**; кастомный **5–10 млн**; AI-бот на GPT-4 **12–40 млн UZS**; поддержка **0,5–5 млн UZS/мес** | TG, IG, WhatsApp, web | Да | [tipa.uz, 22.05.2026](https://tipa.uz/ru/news/chat-boty-biznes-uzbekistan-telegram-whatsapp/) |
| **Salom AI** (salom-ai.uz) | Потребительский AI на узбекском (латиница + кириллица) | Free; Premium **19 000 UZS/мес** (~$1,6) | Web, iOS, Android | **Да, нативно** | salom-ai.uz |
| **UzbekVoice Agents** (agents.uzbekvoice.ai) | Голосовые AI-агенты (обзвон) | **не публичны** | Звонки | **Да**, UZ/RU/EN | gorgona.uz |

**Cybernet AI — ориентир по масштабу возможного:** клиенты **Капиталбанк, SQB, Asakabank, Uzum Group, Alif**; **сотни тысяч звонков в день**; экономия клиентов **более $2 млн/мес только на операционных издержках**; направления — pre/soft-collection, продажи (холодные и тёплые базы, отработка возражений), клиентский сервис; **ISO 27001**; cloud или on-premise; соответствие ЗРУ о персданных ([lex.uz/docs/4396428](https://lex.uz/docs/4396428)); география — Узбекистан, Казахстан, Кыргызстан, Египет, Турция, США, Мексика.

**Соседние сегменты:**
- **Финтех:** Aiphoria × TBC — **40% звонков колл-центра уже обрабатывают AI-агенты**; TBC Uzbekistan — ассистент **Lola AI** на собственных LLM для узбекского; UZCARD × zyple.ai → **oneziyo.ai** (скоринг, антифрод, стресс-тесты, транзакционный мониторинг); **Click** — виртуальный помощник **Cleo** в приложении + внутренние AI-агенты по отделам
- **LegalTech:** Tuzuk AI, Lex AI, LexoraAI
- **HRTech:** Growy AI, OneDesk
- **Бухгалтерия:** Dobek AI (интеграция с 1С — НДС, отчёты, банковские выписки)
- **CV:** TASS Vision, Cradle Vision, TAD Industries
- **Инфраструктура:** CoreAI (GPU-облако, NVIDIA H200/H100/A100, локальное размещение данных в UZ), UzCloud, Yandex Cloud
- **Международные с узбекскими корнями:** **Twolabs AI (первый узбекский стартап в Y Combinator)**, Unitlab AI, Datatruck, Numeo AI
- **Интеграторы:** Cybernet AI, EPAM Uzbekistan, Jet Infosystems Uzbekistan

**🔴 Главный вывод по локальному рынку:** **в Узбекистане нет ни одного локального SaaS-конструктора AI-агентов с self-serve подпиской.** Всё локальное предложение делится на:
1. **Проектную модель** (интеграторы, студии): 5–40 млн UZS разово = **$425–3 400**, срок 10–45 дней / 2–12 недель
2. **Enterprise voice** (Cybernet, Aiphoria): банки и телеком, не МСБ
3. **Вертикальные продукты** (LegalTech, HRTech, бухгалтерия)
4. **Языковую инфраструктуру** (STT/TTS/LLM), которую продают как API, а не как продукт для бизнеса

**Единственный self-serve конструктор с присутствием в UZ — MoonAI, и он без узбекской локализации.**

### 5.8. Матрица угроз для SMB-платформы в Центральной Азии

| Уровень | Кто | Почему |
|---|---|---|
| 🔴 **Прямая, немедленная** | **amoCRM** | GA-агент, база знаний, действия в CRM, передача оператору, Telegram через бесплатный BotFather-токен, **цены в сумах**, партнёры в Ташкенте, Самарканде, Намангане, Нукусе. Каждый питч обязан отвечать на «почему не проапгрейдить amoCRM до Профессионального» |
| 🔴 **Прямая, отложенная — окно закрывается по известному расписанию** | **Bitrix24** | Самый глубокий локальный след (45 партнёров, цены в сумах, узбекские соцканалы, локальные промо) и **публично обещанные, но НЕ выпущенные** ИИ-агенты. Когда выпустит — выпустит в базу, до которой не дотянуться. Отчёт: «считайте, что месяцы» |
| 🔴 **Прямая** | **BotHelp** | Ближайший аналог продукта, ИИ-агенты на всех тарифах, **единственный публикует стоимость диалога**, от 1 599 ₽/мес, **уже имеет казахстанское ТОО**. Узбекского интерфейса нет |
| 🟠 **Реальная, косвенная** | **Salebot**, **TWIN** (франшизная модель) | Тот же бюджет, русскоязычный продукт, локальная цена. TWIN может появиться в Ташкенте по инициативе местного интегратора в любой момент |
| 🟠 **За внимание, не за нагрузку** | **ChatGPT Go $5/мес и Business $20/место**, **Google Gemini Enterprise Business $21/место** | Google — единственный из больших, кого узбекский SMB может подключить сам. Но у обоих нет клиентского канала, Telegram и инбокса оператора |
| 🟡 **Условная** | **MS 365 Copilot Business $18/юзер/мес** | Только для тех, кто уже на M365 |
| ⚪ **Не побеспокоятся никогда** | **Sierra, Decagon, Ada, Artisan, 11x, Clay, Qualified, AWS, Agentforce, Lindy, Dust, CrewAI, Beam AI** | Sales-led без публичных цен; Salesforce не имеет UZS; Fin биллит только в USD; Sales/SDR стоит на слое данных, где Узбекистан — 0,04% |
| 🟢 **Поставщики, не конкуренты** | **Anthropic** (Узбекистан в списке поддерживаемых стран, Haiku 4.5 $1/$5, программа «Powered by Claude»), **OpenAI API**, **Yandex AI Studio** (цены в тенге), **GigaChat** (65 ₽/млн токенов — самый дешёвый русскоязычный инференс, но **freemium запрещён для коммерции**) | Юнит-экономика не является ограничением |

---

## 6. Рынок Узбекистана в цифрах

### 6.1. МСБ

**Нацкомстат, на 1 января 2026**, через [uz.kursiv.media, 13.01.2026](https://uz.kursiv.media/2026-01-13/chislo-predpriyatij-v-uzbekistane-prevysilo-474-tys/):

| Показатель | Значение | Доля |
|---|---|---|
| **Всего предприятий** | **474 900** | 100% |
| **Малый бизнес** | **403 800** | **85%** |
| Торговля | **153 200** | 32,3% |
| ООО (юр. форма) | 170 400 | — |
| С иностранным капиталом | 18 100 (+22% г/г) | 3,8% |
| — Китай | 5 000 | — |
| — Россия | 3 200 | — |
| — Турция | 2 100 | — |

**Региональная концентрация** (тот же источник, 01.01.2026):

| Регион | Предприятий | Доля |
|---|---|---|
| **Ташкент** | **108 700** | **22,9%** |
| Ташкентская обл. | 46 500 | 9,8% |
| Самаркандская обл. | 41 200 | 8,7% |
| Ферганская обл. | 38 200 | 8,0% |
| **Топ-4 суммарно** | **234 600** | **49,4%** |

**На 26 июня 2026:** **476 750** действующих субъектов предпринимательства (без дехканских и фермерских хозяйств); промышленность — 12,5%, третье место — сельское/лесное хозяйство ([siat.stat.uz](https://siat.stat.uz/data/2065/?lang=ru), [stat.uz](https://stat.uz/ru/)).

**Независимое подтверждение из отчёта 1** по тем же открытым данным stat.uz (SDMX ЕГРПО, наборы 256 и 261): **474 899 действующих предприятий** и **403 767 действующих малых** (серия 2026, публикация янв. 2026). Расхождение с 474 900 / 403 800 — округление.

⚠️ **Детальная отраслевая разбивка** (услуги / HoReCa / медицина / образование / бьюти по отдельности) в публичных источниках **не найдена** — есть в базе SIAT, требует прямого запроса в Нацкомстат.

⚠️ **TAM/SAM отчёта 2 помечен автором как «не цитируемая статистика, а моя арифметика»:** 234 600 предприятий в топ-4 регионах × ~32% в торговле → **~75 000 компаний** первичного контура; при 5% проникновении и ARPU $50/мес — **$45 млн ARR**. Это **потолок, не прогноз**.

### 6.2. Демография и интернет

**Отчёт 1 — Digital 2026: Uzbekistan** (DataReportal/Kepios, опубл. 08.11.2025, данные окт. 2025, [datareportal.com](https://datareportal.com/reports/digital-2026-uzbekistan)):

| Показатель | Значение |
|---|---|
| Население (ООН) | **37,2 млн**, медианный возраст **27,0** |
| Интернет-пользователи | **33,1 млн (89,0%)** |
| Сотовые подключения | 33,9 млн (91,1%) |
| Соцсетевые аккаунты | 14,1 млн (37,9%) |
| Instagram (охват рекламы) | **14,1 млн** — доминирует |
| Медианная скорость мобильного | 55,51 Мбит/с (+53,4% г/г) |

**Отчёт 2** ([sostav.ru / Wunder Digital, 04.11.2025](https://www.sostav.ru/blogs/243630/70486)): население **>37 млн** (+2%/год, 2025); интернет-проникновение **87%** (2024); доля мобильного интернета **82%** пользователей (2025).

⚠️ Интернет-проникновение: **89,0% (окт. 2025, DataReportal)** против **87% (2024, Wunder Digital)** — разные годы, обе цифры сохранены.

**Казахстан для сравнения** (DataReportal, окт. 2025): население **20,9 млн**, интернет **19,5 млн (93,4%)**, соцсети **16,9 млн (80,8%)**. Astana Hub: **+1 800 компаний**, **₸864 млрд** выручки участников за 5 лет, **$630 млн** экспортной выручки за 4 года.

### 6.3. 🔴 Telegram — прямое противоречие между двумя отчётами, сохранено

**Позиция отчёта 1: жёсткого процента проникновения публично не существует.**

**DataReportal не публикует данные по Telegram для Узбекистана и Казахстана** — у Telegram нет рекламного планировщика, поэтому его нет в разделе платформ вообще. `uz.tgstat.com/analytics` отдаёт **HTTP 429** за логином. Дословная рекомендация: **«Жёсткий процент проникновения — не подтверждено. Не ставить его в презентацию без нового источника.»**

Косвенные улики из каталога **uz.tgstat.com**, которые отчёт 1 считает сильными:
- TGStat держит **отдельный узбекистанский сайт с полностью узбекским интерфейсом**, рядом с казахским и киргизским
- Каналы свыше 850 тыс. подписчиков: Caps Community **2 776 288** · ТЕЗКОР ЎЗБЕКИСТОН **1 135 845** · Kun.uz **1 109 445** · Tezkor Yangiliklar **1 091 562** · Telegram_Yulduzlari **1 004 729** · Shopirlar **997 908** · PATRUL UZ **954 947** · O'zbekiston 24 **939 053**
- **Торговля родная для канала:** «Sotish» (продажи) = **11 900 каналов**, Biznes va startaplar 4 000, Marketing/PR/reklama 1 900, Transport 3 300. Активные группы-маркетплейсы: 🌏YUK_markazi **100 263**, НАМАНГАН чат **174 530**
- **Государство и финтех живут в Telegram:** IT Park (t.me/itpark_uz), lex.uz, stat.uz, my.gov.uz (**261 994**), Click (t.me/clickuz), пресс-служба Президента (**240 800**)

⚠️ Мета-описание сайта «2 837 219 dan ortiq kanal va guruhlar» — **глобальный шаблонный счётчик TGStat, не цифра по Узбекистану. Не цитировать как таковую.**

**Позиция отчёта 2: конкретные цифры есть.**

| Показатель | Значение | Год | Источник |
|---|---|---|---|
| **Telegram, пользователей** | **25 млн** | 2025 | Wunder Digital / DataReportal через [sostav.ru](https://www.sostav.ru/blogs/243630/70486) |
| **Telegram, охват** | **76% интернет-аудитории** | 2025 | там же |
| Telegram (альтернативная оценка) | **~27 млн**, ~76% интернет-пользователей, охват **~95%** среди онлайн | 2026 | [fera-tech.com](https://fera-tech.com/ru/blog/ai-and-business-automation-in-uzbekistan-2026-state-of-market/) |
| Telegram, всего пользователей (др. источник) | **>25 млн** | 2024 | [vaib.uz](https://vaib.uz/2024/10/08/stalo-izvestno-skolko-chelovek-v-uzbekistane-polzuyutsya-telegram-issledovanie/) |
| WhatsApp | **~25% аудитории** активно | 2026 | [tipa.uz](https://tipa.uz/ru/news/chat-boty-biznes-uzbekistan-telegram-whatsapp/) |
| Instagram | **2/3 всех переходов** на внешние сайты из соцсетей | 2025 | sostav.ru / DataReportal |
| TikTok | 2-е место, аудитория **в 5 раз меньше** Instagram; **платформа заблокирована**, монетизации нет | 2025 | sostav.ru |
| YouTube | Лидер по охвату, **монетизация недоступна** | 2025 | sostav.ru |

**Как это разрешать: никак — обе позиции идут в документ вместе.** Отчёт 1 прямо запрещает ставить процент в презентацию без нового источника; отчёт 2 приводит 25 млн / 76% со ссылкой на sostav.ru/Wunder Digital. **Для инвесторской коммуникации нужен первичный источник (логин TGStat или заказное исследование), см. §10.**

**Telegram для бизнеса:** «В некоторых ташкентских сервисах доставки еды и интернет-магазинах Telegram-боты обеспечивают **40% и более месячного оборота**» (fera-tech.com, **с оговоркой самого автора «по имеющимся данным»**). Косвенное академическое подтверждение: авторы корпуса USC собирали 105 часов узбекской речи **через Telegram-бота**, объясняя, что «Telegram широко используется в Узбекистане» ([arXiv:2107.14419](https://arxiv.org/pdf/2107.14419)).

### 6.4. E-commerce и Uzum

| Показатель | Значение | Год | Источник |
|---|---|---|---|
| Оборот онлайн-торговли | **22,7 трлн UZS ≈ $1,93 млрд** (×1,5 г/г) | 2025 | [fintech-retail.com, 18.03.2026](https://fintech-retail.com/2026/03/18/torgovlya-6/) |
| Доля e-com в рознице | **4,6%** | 2025 | там же |
| Число электронных торговых площадок | **36 (2024) → 115 (2025)**, ×3,2 | 2025 | [caravan-info.uz](https://caravan-info.uz/ru/ekonomika/831678-onlayn-torgovlya-v-uzbekistane-uskoryaetsya-chislo-platform-vyroslo-vtroe.html) |
| Рост e-commerce за последние годы | **более чем в 2,5 раза** | — | ПРООН через [gorgona.uz](https://gorgona.uz/ru/blog/ai-uzbekistan-map-2026) |
| Прогноз рынка | **$2–3 млрд** при CAGR 41–47% | ближайшие годы | **первичный источник не подтверждён** |

⚠️ **Расхождение источников, сохранено:** один источник даёт «прогнозируемый объём e-commerce **$431,7 млн** к 2025 году», что противоречит официальным **22,7 трлн UZS (~$1,93 млрд)**. Вероятно, разные определения (только маркетплейсы vs вся онлайн-торговля). **Рекомендация отчёта — использовать 22,7 трлн UZS**, она ближе к официальной статистике.

**Uzum:**

| Метрика | Значение | Год | Источник |
|---|---|---|---|
| **Продавцов на Uzum Market** | **>18 000**, ~90% — МСБ | 2026 | [gazeta.uz, 09.07.2026](https://www.gazeta.uz/ru/2026/07/09/uzum-market/) |
| **GMV e-commerce-направления Uzum** | **>$500 млн** (×1,5 г/г) | 2025 | [gazeta.uz, 10.07.2026](https://www.gazeta.uz/ru/2026/07/10/uzum-market/) |
| Прогноз GMV | **~$1 млрд** | 2026 | gazeta.uz, 10.07.2026 |
| Заказов | **34 млн** | 2025 | gazeta.uz |
| Локальный ассортимент | **1,9 млн SKU** | 2026 | gazeta.uz |
| Рост оборота продавцов | **+60% г/г** | 2026 | gazeta.uz, 09.07.2026 |
| Продавцы с активными продажами | **+32%** с начала года | 2026 | gazeta.uz |
| Uzum Sellers Academy | **>9 000** выпускников с 2022; GMV после обучения растёт **в 3,5 раза** | 2026 | gazeta.uz |
| Инвестиции Uzum в инфраструктуру | **>$500 млн** накоплено | — | gazeta.uz |
| Логистика | 9 кросс-докинговых складов, **>2 100 ПВЗ в 626 населённых пунктах** | 2026 | gazeta.uz |
| Оценка холдинга Uzum | **$2,3 млрд** при раунде $130 млн | — | [tadviser](https://www.tadviser.ru/index.php/Компания:Uzum) |

**Инструменты для продавцов 2026:** **«Буст заказов»** — запуск 09.04.2026, автопродвижение в поиске, оплата процента от стоимости товара **только после получения заказа покупателем** ([seller.uzum.uz](https://seller.uzum.uz/news/157)); **UTM-метки в рекламных ссылках** — с 08.06.2026 ([uz24.uz](https://uz24.uz/ru/articles/uzum-market-26-5-22)).

🔴 **AI-ассистент для продавцов Uzum: данные не найдены.** В открытых источниках на август 2026 нет ни одного упоминания AI-ассистента, AI-агента или ИИ-инструмента для селлеров Uzum Market. Известно лишь общее: «Uzum как первый технологический единорог страны встраивает ИИ в персонализацию и операционные процессы» (gorgona.uz, июнь 2026) — то есть **внутрь своего продукта, не в кабинет продавца**.

### 6.5. IT Park Uzbekistan

| Показатель | Значение | Дата | Источник |
|---|---|---|---|
| **Резидентов** | **>3 700**, стартапов **>1 000** | май 2026 | [CNews, 21.05.2026](https://www.cnews.ru/articles/2026-05-21_uzbekistan_kak_operatsionnyj_hab) |
| Резидентов (альт. оценка) | **>2 000** | февр. 2026 | fera-tech.com |
| Резидентов (историч.) | 1 598, из них 411 с иностранным капиталом | ноябрь 2023 | [it-park.uz](https://www.it-park.uz/ru/itpark/news/obzor-kompaniy-rezidentov-it-park-ekonomicheskiy-vklad-i-ih-rol-v-sozdanii-rabochih-mest-i-uvelichenii-it-eksporta) |
| Компаний-экспортёров | **1 050**, из них 315 в регионах | 1П 2026 | it-park.uz |
| География экспорта | **102 страны** | 2026 | [the-tech.kz](https://the-tech.kz/geografiya-eksporta-rezidentov-it-park-uzbekistan-rasshirilas-do-102-stran) |
| Экспорт ИКТ-услуг | **$620 млн** (+40% г/г) | 2025 | [tadviser](https://www.tadviser.ru/index.php/Статья:ИКТ-рынок_Узбекистана) |
| Экспорт IT-услуг (альт.) | вырос **в 4,5 раза**, приблизился к **$1 млрд** | 2025 | fergana.agency через gorgona.uz |
| Занятость у резидентов | >24 125 специалистов | 2023 | it-park.uz |

⚠️ **Расхождение 2 000 / 3 700 резидентов** — разные даты (февраль vs май 2026) и, вероятно, разные критерии (активные vs всего выданных свидетельств). **Точное количество на август 2026 — не найдено.**

⚠️ **Экспорт: $620 млн (+40%, tadviser) против «в 4,5 раза, приблизился к $1 млрд» (fergana.agency)** — обе за 2025, взаимно несовместимы, обе сохранены.

**Налоговые льготы — ⚠️ два отчёта расходятся по сроку, оба сохранены:**

| Налог | Нерезидент | **Резидент IT Park** |
|---|---|---|
| Налог на прибыль | **4–12%** (отчёт 1) / **4–15%** (отчёт 2) | **0%** |
| Социальный налог | 12% | **0%** |
| Имущество и земля | 2% | **0%** |
| НДФЛ сотрудников | 12% | **7,5%** |
| НДС | 12% / стандартный | **0%** |
| Таможенные пошлины на серверное оборудование | стандартные | освобождение |

- **Отчёт 2:** льготы действуют **до 1 января 2028 года** ([buxgalter.uz](https://buxgalter.uz/publish/doc/text205205_nk-2025_prodleny_lgoty_rezidentam_it-parka), [outsource.gov.uz](https://www.outsource.gov.uz/ru/why-uzbekistan/government-support), [tax-legal.uz](https://tax-legal.uz/it-park/)).
- **Отчёт 1, дословно:** *«**Срок/окончание льгот: не подтверждено** — не утверждайте "до 2040 года", я не смог это подтвердить»* (источник — [outsource.gov.uz](https://www.outsource.gov.uz/en/why-uzbekistan/government-support), сверено с ПКМ № 589 от 15.07.2019).

🔴 **Ограничение с 1 апреля 2026:** льготы **не применяются** к резидентам, работающим как платёжная организация, оператор платёжной системы, **маркетплейс (электронная платёжная система)** и МФО ([it-park.uz](https://www.it-park.uz/ru/itpark/news/vvodyatsya-novye-pravila-dlya-rezidentov-it-park-uzbekistan)). Для SaaS не блокер, но **при агрегации платежей — риск потери льгот**.

**Программы:**
- **Zero Risk Program** — готовый офис с мебелью и техникой, покрытие части расходов на найм и обучение, **компенсация до 15% ФОТ** за граждан РУз (CNews, май 2026)
- **IT-виза на 3 года** — без разрешения на работу, распространяется на семью, доступ к медицине и образованию как у граждан, покупка недвижимости без ограничений по стоимости
- **IT Park Ventures** — фонд Минцифры; приоритеты ИИ, финтех, DeepTech, EdTech ([itparkventures.uz](https://itparkventures.uz/en/about-fund))
- **DSA Acceleration** — именно через неё MoonAI получил $50 000 SAFE и поддержку выхода на UZ-рынок
- **President AI Award (2026)** — акселерация + инвестиции, привязанные к измеримым бизнес-результатам; **$1 млн конкурс AI-стартапов, программа расширена до $5 млн**
- **AI Incubator** — 10-недельная программа в Ташкенте, старт июль 2026 ([gov.uz](https://gov.uz/en/digital/news/view/189894))

🔴 **Малоцитируемое и прямо релевантное:** **ПП-5234 от 26.08.2021** учредил **регуляторную песочницу («особый режим») для применения технологий искусственного интеллекта**; положение утверждено ПКМ № 717 от 29.11.2021.

### 6.6. Госконтекст по ИИ

| Показатель | Значение | Дата | Источник |
|---|---|---|---|
| Стратегия развития ИИ до 2030 | **ПП-358, 14.10.2024**; целевой объём ИИ-продуктов **$1,5 млрд** | 14.10.2024 | [lex.uz/ru/docs/7158606](https://lex.uz/ru/docs/7158606), [spot.uz](https://www.spot.uz/ru/2024/10/17/ai-strategy/) |
| Указ окт. 2025 (**УП-189, 22.10.2025**) | ≥**100 ИИ-проектов** к концу 2026; **>$1 млрд** иностранных инвестиций в ИИ-инфраструктуру к 2030; **$90 млн** беспроцентная кредитная линия на 7 лет; 15 университетских ИИ-лабораторий | 22.10.2025 | [lex.uz/ru/docs/7790236](https://lex.uz/ru/docs/7790236). ⚠️ Отчёт 2 ссылается на тот же указ по другому URL: [lex.uz/docs/-7789403](https://lex.uz/docs/-7789403?ONDATE=27.10.2025+00) |
| Инвестиции в ИИ-инфраструктуру | **>$50 млн** (в т.ч. 16 суперкомпьютеров) | 2025 | spot.uz / kapital.uz |
| Финансирование ИИ | **$100 млн** | 2026 | kapital.uz |
| GPU-кластер | **$24 млн** создан, до конца года ещё **$45 млн** оборудования | 01.05.2026 | [gazeta.uz](https://www.gazeta.uz/ru/2026/05/01/ai-infrastructure-uzb/) |
| ЦОД в стране | **~6 дата-центров** — узкое место | 2026 | Statista через gorgona.uz |
| Полнотекстовый поиск lex.uz | **166 актов** упоминают «искусственного интеллекта», 139 президентских; 61 в 2025, 35 в 2026 YTD | 27.08.2026 | отчёт 1 |
| **Проникновение генеративного ИИ** | **7,2%** трудоспособного населения (рост с 5,7% во 2П 2025); **мировое среднее 17,8%** | Q1 2026 | [Microsoft Global AI Diffusion Q1 2026](https://www.microsoft.com/en-us/corporate-responsibility/dmc/topics/ai-economy-institute/reports/global-ai-adoption-2026-q1/) |
| Использование ИИ работающими специалистами | **64%** уже используют хотя бы частично, ещё 20% планируют | 2026 | [hh.uz](https://tashkent.hh.uz/article/33747) |
| Government AI Readiness Index | 87-е (2023) → **62-е (2025)** | 2025 | [Oxford Insights](https://oxfordinsights.com/ai-readiness/government-ai-readiness-index-2025/) |
| StartupBlink GSEI 2026 | **79-е место**, **Country of the Year 2026**, самый быстрый в мире рост показателя экосистемы **+227%** | 2026 | [startupblink.com](https://www.startupblink.com/startup-ecosystem/uzbekistan) |
| Стоимость стартап-экосистемы | **>$3,9 млрд** (рост в 13 раз за 5 лет) | 2026 | uzdaily через gorgona.uz |
| Венчур | **$329 млн** всего, из них **$293 млн — иностранный капитал**; 92% — ранние стадии | 2025 | [fintech-retail.com](https://fintech-retail.com/2026/03/04/investicii-7/) |
| Программа «Пять миллионов лидеров ИИ» | ~5 млн человек до 2030 (совместно с ОАЭ), запуск ноябрь 2025 | 2025 | [gov.uz](https://gov.uz/ru/digital/news/view/125831) |
| Партнёрство с OpenAI | ChatGPT Edu в школах, курсы, поддержка узбекских AI-стартапов | 27.10.2025 | [daryo.uz](https://daryo.uz/en/2025/10/27/uzbekistan-and-openai-partner-to-bring-chatgpt-edu-to-schools/) |

⚠️ **Отчёт 1 дословно: «$1,5 млрд — это целевой показатель политики, а не измерение рынка. Никогда не цитировать как TAM.»**

**Барьеры (исследование ПРООН, февраль 2026):** высокая стоимость вычислений, ограниченный доступ к общим GPU-мощностям, пробелы в доступе к пригодным данным, скромное венчурное финансирование, и — **SAFE-соглашения и конвертируемые займы не признаны локальным законодательством** ([UNDP](https://www.undp.org/sites/g/files/zskgke326/files/2026-02/advancing-ai-in-the-private-sector-in-uzbekistan_eng-3.pdf)).

### 6.7. Платёжная инфраструктура

| Система | Позиция | Применение |
|---|---|---|
| **Payme** | Лидер, **>10 млн пользователей** | E-commerce, боты, **подписки** |
| **Click** | Уверенный №2, заявляет **20 000 000 пользователей**, PCI DSS, поддерживает **Telegram-бота как платёжный интерфейс** | E-commerce, услуги, коммуналка |
| **Uzum Bank** | Быстрорастущий | Приложения, молодая аудитория |
| **UzCard / Humo** | Национальные карточные системы | Карточные рельсы |
| Paynet / Kapitalbank | Ниша | Legacy, отдельные вертикали |

**Payme + Click + Uzum Bank вместе покрывают >90% локального платёжного оборота** ([fera-tech.com](https://fera-tech.com/ru/blog/ai-and-business-automation-in-uzbekistan-2026-state-of-market/)). Библиотека **PayTechUZ** объединяет шлюзы в одну интеграцию.

**Рекуррентные платежи:**

| Провайдер | Возможность | Детали | Источник |
|---|---|---|---|
| **Payme Business Subscribe API** | ✅ **Полноценный merchant-side рекуррент** | JSON-RPC 2.0 (checkout.paycom.uz/api, песочница checkout.test.paycom.uz). Привязка карты («в один клик»), оплата без редиректа, **рекуррентные платежи и автоплатежи**, выставление счетов. Запросы шлёт приложение мерчанта. **Обязательное требование: метка «Powered by Payme» в приложении.** Принимает **Uzcard и HUMO**; работает через приложение Payme, **ТГ ботов**, email, SMS; кассу могут держать **только юрлица** | [developer.help.paycom.uz](https://developer.help.paycom.uz/protokol-subscribe-api/) |
| **Click** | ⚠️ **Только клиентская сторона** | «Автоплатёж» в Click SuperApp — потребительское поручение, пользователь сам выбирает расписание. **Merchant-side документация рекуррентов в открытом доступе не найдена.** Продукт **«Click Подписка»** запущен (уведомления 07.05.2026 и 18.08.2026), но условия для мерчанта **не подтверждено** | [click.uz](https://click.uz/ru/auto-payment) |
| **Freedom Pay Uzbekistan** | ✅ Есть | Сервис регулярных платежей | [freedompay.uz](https://freedompay.uz/services/regular-payment-service) |
| **Payme (прецедент)** | ✅ Работает в проде | Запущены автоплатежи для «Яндекс Плюс» | [spot.uz, 29.08.2023](https://www.spot.uz/ru/2023/08/29/payme/) |

**🔴 Практические ограничения для SaaS:**
1. **Карточный рекуррент — рабочий инструмент только через Payme Subscribe API.** Единственный подтверждённый merchant-side механизм.
2. **B2B-практика — оплата по счёту от юрлица.** Bitrix24.uz: только 1 или 12 месяцев, **возврат невозможен**.
3. **amoCRM не имеет помесячной оплаты** — минимум 6 месяцев. Это ослабляет их в self-serve сегменте.
4. **Ценообразование обязано быть в сумах** (fera-tech.com).
5. **Валютные ограничения на трансграничные SaaS-подписки и репатриацию выручки — данные не найдены.** Требует консультации с локальным юристом/банком до запуска биллинга. Правовая рамка существует (Закон о валютном регулировании в редакции **ЗРУ-1138 от 21.04.2026**, [lex.uz/ru/docs/8153154](https://lex.uz/ru/docs/8153154)), но **конкретной цифры лимита нет — не цитировать никаких чисел**.
6. 🔴 **Stripe не поддерживает ни Узбекистан, ни Казахстан** ([stripe.com/global](https://stripe.com/global) — ни одной центральноазиатской страны в списке ~50). Самообслуживаемый международный биллинг требует иностранного юрлица или merchant-of-record. Онбордят ли **Paddle / Lemon Squeezy** узбекских продавцов — **не подтверждено**.

### 6.8. 🔴 Локализация данных — связывающее архитектурное ограничение

**Закон ЗРУ-547 «О персональных данных»**, локализация добавлена **15.01.2021**, в силе с **16.04.2021** ([DLA Piper](https://www.dlapiperdataprotection.com/index.html?t=law&c=UZ), обновлено 27.01.2025, сверено с первоисточником [lex.uz/docs/4396428](https://lex.uz/docs/4396428), ст. 20 ↔ ст. 27¹ ч. 2): персональные данные граждан Узбекистана, обрабатываемые через интернет, должны **собираться, систематизироваться и храниться на технических средствах, физически находящихся в Узбекистане**, в базах, внесённых в Госреестр.

**Принуждение:** уведомительная регистрация в **Агентстве персонализации** через pd.gov.uz (15 дней на рассмотрение); несоблюдение → внесение в **Реестр нарушителей** и **блокировка сайта оператора внутри Узбекистана**. Штрафы **7 БРВ** (граждане) / **50 БРВ** (должностные); повторно → уголовная ответственность **100–150 БРВ**. Трансграничная передача требует «адекватной защиты» — **список адекватности никогда не принимался**, поэтому на практике полагаются на исключение по явному согласию.

⚠️ **Статья 20 сейчас действует в редакции Закона № ЗРУ-1125 от 26 марта 2026** ([lex.uz/docs/8104580](https://lex.uz/docs/8104580)) — **что именно изменилось, не подтверждено. Прочитать до заморозки схемы данных.**

*Вывод отчёта (не факт):* Telegram-first платформа, хранящая переписку узбекских конечных клиентов, попадает прямо в этот режим. У Supabase нет узбекского региона, а отправка содержимого диалогов в OpenAI/Anthropic/Google — трансграничная передача. Рабочий путь: хранилище персданных на узбекской инфраструктуре с регистрацией в pd.gov.uz, явное согласие на трансграничную LLM-обработку, псевдонимизация до выхода за периметр.

---

## 7. Бенчмарк замещения — главный вход в ценообразование

### 7.1. Что стоит человек

| Показатель | UZS/мес | USD/мес | Дата | Источник |
|---|---|---|---|---|
| Средняя зарплата по стране | **6 825 000** (+17,4% г/г) | **$579** | Q1 2026 | [kun.uz, 28.04.2026](https://kun.uz/ru/news/2026/04/28/srednyaya-zarplata-v-uzbekistane-dostigla-68-mln-sumov), Нацкомстат |
| Средняя зарплата по стране | **7 090 000** (+18,4% г/г) | **$602** | янв–июнь 2026 | [uz.kursiv.media](https://uz.kursiv.media/2026-04-28/zarplaty-v-uzbekistane-vyrosli-na-17-za-god-srednij-dohod-prevysil-68-mln-sumov/) |
| **Ташкент** | **11 684 000** | **$992** | Q1 2026 | kun.uz, Нацкомстат |
| Навоийская обл. | 8 453 000 | $718 | Q1 2026 | там же |
| Кашкадарьинская обл. | 4 665 000 | $396 | Q1 2026 | там же |
| **Медиана: менеджер по продажам / по работе с клиентами** | **10 563 025** | **$897** | февраль 2026 | [hh.uz](https://hh.uz/article/34255) |
| Менеджер по продажам (диапазон, др. оценка) | **1 500 000 – 5 000 000** | **$127–425** | 2026 | [1ccrm.com](https://1ccrm.com/zarplata-menedzhera-po-prodazham-v-uzbekistane-prakticheskie-rekomendaczii-i-realnye-czifry/) |
| Вакансия менеджера по продажам, Ташкент | **4 000 000** | **$340** | 2026 | [ish.uz](https://ish.uz/ru/jobs-insurance/4478) |
| **Практический кейс: 2 менеджера в клинике, Ташкент** | ~7 000 000 суммарно → **3 500 000 на человека** | **$297** | май 2026 | [tipa.uz](https://tipa.uz/ru/news/chat-boty-biznes-uzbekistan-telegram-whatsapp/) |

⚠️ **Разброс огромный и его нельзя усреднять.** Медиана hh.uz (**$897**) отражает вакансии на портале — более квалифицированные и столичные позиции. Практическая оценка агентства (**$297**) — реальную зарплату линейного менеджера в Ташкенте. **Рекомендация обоих отчётов: для ценообразования брать нижнюю границу $297–340.**

**Отдельно отмечено:** отчёты **не нашли** прямых бенчмарков по оператору поддержки и агенту колл-центра как отдельным ролям — все приведённые цифры относятся к менеджеру по продажам / по работе с клиентами и к средним зарплатам по стране и регионам. **Данных по колл-центру как отдельной позиции нет.**

### 7.2. Расчёт замещения

⚠️ Таблица помечена автором отчёта 2 как **«моя арифметика на основе вышеприведённых цифр»**, а не как измерение.

| Сценарий | Стоимость/мес | Доля от 1 менеджера ($297) | Доля от медианы ($897) |
|---|---|---|---|
| **MoonAI** ($50 + ~$13 токены при 1000 диалогов) | **$63** | **21%** | 7% |
| Bitrix24 Базовый (5 польз.) | $24,5 | 8% | 3% |
| Salebot Standard | $16,5 | 6% | 2% |
| amoCRM Базовый (3 польз.) | ~$18 | 6% | 2% |
| Поддержка бота у местной студии | от $50 (fera-tech) / 0,5–5 млн UZS (tipa.uz) | 17–140% | 6–47% |
| Проект под ключ (Innosoft, средний) | 10–15 млн UZS разово | = **2,9–4,3 месяца** зарплаты менеджера | 0,9–1,4 мес |
| Проект под ключ (aisolution Старт) | $1 990 разово | = **6,7 месяца** зарплаты | 2,2 мес |

### 7.3. Что из этого следует для цены Nemo

**Выводы отчёта по willingness to pay (сформулированы автором как выводы, не как измерение):**

- **Потолок для комфортной self-serve покупки МСБ — $30–100/мес.** Выше начинает требоваться sales-цикл и обоснование ROI.
- **$50/мес (уровень MoonAI) = 17% зарплаты одного менеджера** по нижней границе — легко продаваемая экономика, **но она уже занята**.
- **Ниже $25/мес** — зона Bitrix24 (с бесплатным BitrixGPT) и Salebot. Дословно: **«туда идти опасно»**.
- **Реалистичный ROI-нарратив: окупаемость 1–4 месяца** за счёт экономии на менеджерах. tipa.uz приводит кейс с окупаемостью **2,5 месяца** и годовой экономией + ростом выручки на **~80 млн UZS ≈ $6 800**.

**Проверка через глобальные якоря (отчёт 1):** собственный документированный пример Microsoft для бота поддержки — **~$1 728/мес**; Salesforce — **$2,00 за разговор**; Google — **$21/место/мес** за конструктор, работающий только внутрь компании. Дословный вывод отчёта: *«всё, что вы поставите ниже ~$100–300/мес за полноценного клиентского агента в Telegram с передачей оператору, защитимо по опубликованным числам»*.

⚠️ **Два эти вывода не совпадают и оба сохранены.** Отчёт 2 (локальная экономика замещения) даёт коридор **$30–100/мес**; отчёт 1 (глобальные опубликованные якоря) — **до ~$100–300/мес**. Разница в том, чем аргументировать цену: зарплатой линейного менеджера в Ташкенте или прайс-листами Microsoft и Salesforce. **Для узбекского SMB решающей является первая рамка**, вторая работает как аргумент против возражения «дорого» в сравнении с международными вендорами.

**Прямое ограничение для ценового позиционирования:** узбекский SMB, которому агент нужен сегодня, уже видит на рынке цены **288 000–747 000 UZS/мес** (Bitrix24 Базовый — amoCRM Профессиональный ×3, §5.6). В долларах по курсу 11 778,52 это **~$24,5–63,4/мес**. **MoonAI со своими $63 стоит ровно на верхней границе этого коридора.**

---

## 8. Состояние узбекского ASR / TTS

### 8.1. Опубликованные WER (ASR / STT)

| Модель / система | Датасет | WER | CER | Год | Источник |
|---|---|---|---|---|---|
| **E2E-Conformer** (LM + speed pert. + spec. aug.) | USC test | **17,4%** | 5,8% | 2021 | [arXiv:2107.14419](https://arxiv.org/pdf/2107.14419) |
| E2E-Conformer | USC valid | 18,1% | 7,8% | 2021 | там же |
| E2E-Transformer | USC test | 21,0% | 7,6% | 2021 | там же |
| DNN-HMM (Kaldi TDNN-F, LF-MMI) | USC test | 23,5% | 7,5% | 2021 | там же |
| E2E-LSTM | USC test | 27,0% | 12,0% | 2021 | там же |
| E2E-Conformer **без LM** | USC test | 35,1% | 10,7% | 2021 | там же |
| Conformer (внутренний бенчмарк) | ASR-Clean, Latn/Cyrl, 15 ч | **9,8%** | 4,1% | 2025 | [Avezov, Bukhara State Univ.](https://americanjournal.org/index.php/ajrhss/article/download/3095/2948/3212) |
| Conformer (внутренний бенчмарк) | ASR-Noisy, SNR 0–15 dB, 15 ч | **16,7%** | 7,8% | 2025 | там же |
| **ElevenLabs Scribe v1** | FLEURS uz | **15,9%** | — | 2026 | [elevenlabs.io](https://elevenlabs.io/speech-to-text/uzbek) (таблица) |
| **Gemini Flash 2** | FLEURS uz | **32,0%** | — | 2026 | там же |
| **🔴 Whisper Large v3** | FLEURS uz | **96,7%** | — | 2026 | там же |
| **Deepgram Nova 2** | FLEURS uz | **100,0%** | — | 2026 | там же |
| RubaiSTT (open-source, С. Исломов) | обучена на **475 ч** аудио | **не опубликован** | — | 2026 | [uz-speech.web.app](https://uz-speech.web.app/) через gorgona.uz |

⚠️ **Противоречие внутри одного источника, сохранено:** на той же странице ElevenLabs в **текстовом описании** заявлено *«word error rate of just **3,1%** на FLEURS и **5,5%** на Common Voice»*, тогда как **таблица там же** даёт Scribe v1 = **15,9% WER на FLEURS**. Разные версии модели или условия замера — **не раскрыто**. Рекомендация отчётов: **использовать 15,9% как консервативную оценку**, а 3,1%/5,5% — как маркетинговое заявление вендора.

### 8.2. 🔴 Whisper на узбекском — вердикт

**Whisper Large v3 = 96,7% WER на FLEURS uz.** Модель из коробки **неприменима вообще** — практически каждое слово ошибочно. Узбекский не входит в языки, на которых Whisper обучен в достаточном объёме. **Whisper без дообучения исключён.**

Варианты, зафиксированные отчётами:
1. **ElevenLabs Scribe** (15,9% FLEURS) — лучший коммерческий из проверенных
2. **Локальные провайдеры:** **Muxlisa** (UZINFOCOM), **Lynx AI STT**, **Aisha AI**, **собственный UZ-STT aisolution** (дообучен на реальных звонках клиентов), **Mohir.ai / Mohirdev AI Lab**, **UzbekVoice.ai** — **у всех WER не опубликован**
3. **Дообучение Conformer на USC** → достижимо **17,4% WER**, но на **читаемой речи, не на телефонных звонках**

**Про корпус USC:** 105 часов, **958 дикторов, 108 387 высказываний, 618,6 тыс. слов**, лицензия **CC-BY 4.0**, сделан TUIT (Ташкент) совместно с ISSAI (Nazarbayev University), [github.com/IS2AI/Uzbek_ASR](https://github.com/IS2AI/Uzbek_ASR). Масштаб для сравнения: крупнейшие открытые узбекские речевые датасеты — **сотни часов**; для английского доступны **десятки тысяч часов** (gorgona.uz со ссылкой на NVIDIA / Mozilla Common Voice).

### 8.3. TTS

| Провайдер | Тип | Заявленное качество | Источник |
|---|---|---|---|
| **Lynx AI TTS** | Собственная узбекская модель синтеза, разработана в Узбекистане | **не опубликовано** | [lynx-ai.uz](https://lynx-ai.uz/ru/articles/lynx-tts-uzbek-voice-model) |
| **Muxlisa** (UZINFOCOM, госоператор) | «Первая AI-платформа Узбекистана для STT, TTS и NLP», включая диалекты | **не опубликовано** | [muxlisa.uz](https://muxlisa.uz/en) |
| **Aisha AI** | TTS + STT + голосовые агенты | **не опубликовано** | [aisha.group](https://aisha.group/en) |
| **UzbekVoice.ai** | STT/TTS/NLP через API, краудсорсинговый корпус | **не опубликовано** | [uzbekvoice.ai](https://uzbekvoice.ai/en-US) |
| **Yandex SpeechKit** | Узбекский в Алисе, **режим «узбекский-русский»** | **не опубликовано** | gorgona.uz |
| ElevenLabs / Narakeet / SpeechGen / Voiser | Коммерческие, узбекский в каталоге. SpeechGen: **26 мужских и 21 женский** узбекских голоса | **не опубликовано** | [speechgen.io](https://speechgen.io/en/tts-uzbek/), [narakeet.com](https://www.narakeet.com/languages/uzbek-text-to-speech/) |
| Академический бенчмарк (Tacotron-style, адаптирован к узбекской фонологии) | **MOS 4,12 ± 0,08** (5-балльная), ASR-CER proxy **6,1%** | 2025 | [Avezov, 2025](https://americanjournal.org/index.php/ajrhss/article/download/3095/2948/3212) |

Канальный шум снижает MOS в среднем на **~0,12** и повышает ASR-CER на **0,9 п.п.** (Avezov, 2025).

**🔴 Ключевой пробел: ни один локальный TTS/STT-провайдер не публикует цифр качества.** Все заявляют качество, никто не публикует WER или MOS. Это прямо ограничивает возможность выбрать поставщика по данным — потребуется собственный замер.

### 8.4. Узбекско-русский code-switching

Узбекский официально классифицируется как язык с **четырьмя одновременными сложностями** (Avezov, 2025):
1. **Два активных скрипта** — латиница и кириллица
2. **Агглютинативная морфология** с продуктивной деривацией
3. **Повсеместный русский code-switching**
4. **Сильная диалектная вариативность** по регионам и медиа

**Опубликованные результаты по code-switched данным:**

| Задача | Метрика | Значение | Условия |
|---|---|---|---|
| MT UZ→RU | BLEU / chrF / COMET | **29,3 / 57,8 / 0,56** | смешанные домены, **25% code-switch спанов** в тестовом наборе |
| MT RU→UZ | BLEU / chrF / COMET | **24,7 / 53,2 / 0,49** | там же |
| ST UZ→RU (речь→текст) | BLEU / Average Lagging | **21,5 / 3,2 с** | разговорный |

Источник: [Avezov, «Evaluation suite for Uzbek speech and bilingual translation at scale», American Journal of Research in Humanities and Social Sciences, Vol. 40, Sept. 2025](https://americanjournal.org/index.php/ajrhss/article/download/3095/2948/3212).

**Топ ошибок ASR на шумных данных:**

| Категория ошибки | Доля |
|---|---|
| **Пропуск диакритики** (oʻ→o, gʻ→g) | **27%** |
| **Кросс-скриптовые путаницы в именованных сущностях** | **19%** |
| Ошибки границ клитик в вопросительных конструкциях | **14%** |

RU→UZ деградации в основном связаны с деривационной морфологией (неверное складывание аффиксов) и сохранением скрипта для цитируемых русских фрагментов.

**Лингвистическая база:** **интрасентенциальное переключение — самый частый тип**, особенно у молодых и более свободно владеющих билингвов ([World Bulletin of Social Sciences](https://scholarexpress.net/index.php/wbss/article/view/5317)); смешанный дискурс включает арабские, русские и английские элементы ([ziyonuri.uz](https://ziyonuri.uz/index.php/YJIFI/article/view/25)); end-to-end UZ→RU речевой перевод в низкоресурсных и code-switching условиях — [Web of Teachers](https://webofjournals.com/index.php/1/article/view/5127).

**Продукты, явно заявляющие поддержку смешанных UZ-RU диалогов:** **Muxlisa** (*«live speech and mixed Uzbek–Russian conversations for call centers»*), **Cybernet AI** («естественно говорят на узбекском, свободно переходят на русский, работают с двуязычными диалогами»), **Lynx AI** (UZ/RU/EN), **Aisha AI**, **Yandex Алиса** (режим «узбекский-русский»).

### 8.5. Узбекский в LLM

**TUMLU** — нативный (не переводной) MMLU для тюркских языков, **ACL 2025 Main**. 11 академических предметов, вопросы средней и старшей школы, **разработаны носителями**, а не переведены машинно. Языки: азербайджанский, крымско-татарский, каракалпакский, казахский, татарский, турецкий, уйгурский, **узбекский**.

| Модель | Балл на узбекском |
|---|---|
| **Claude 3.5 Sonnet** | **69,1** |
| GPT-4o | 65,4 |
| Gemini 1.5 Pro | 65,1 |
| Gemini 1.5 Flash | 52,1 |

Источник: [arXiv:2502.11020](https://arxiv.org/abs/2502.11020), Isbarov et al., ACL 2025; [github.com/ceferisbarov/TUMLU](https://github.com/ceferisbarov/TUMLU).

**Перевод:** UZ→EN — лучшая **Gemini-2.0-Flash, 32,81 BLEU / 58,80 chrF++**; UZ→UZ (качество) — **Claude-Sonnet-4, 83,63 chrF++**.

**Малые open-source модели практически неприменимы.** Тестировались 7 моделей 0,6–2 млрд параметров (DeepSeek-R1-Distill-Qwen-1.5B, Falcon3-1B-Instruct, Gemma2-2B-it, GLM-Edge-1.5B-Chat, Kimi-K2-Instruct, Llama-3.2-1B-Instruct, Qwen3-0.6B) на 180 образцах (формальные, новостные, технические, разговорные тексты и жаргон), zero-shot: *«Только Kimi-K2-Instruct достигает практической применимости»*, средний **BLEU 0,54**; остальные «часто выдают бессвязный вывод или смешивают языки» ([Yusupkhujaev K., Ministry of Digital Technologies of Uzbekistan, Zenodo 10.5281/zenodo.17223973](https://zenodo.org/records/17223973), сентябрь 2025).

**Морфологические сбои у топовых моделей** (GPT-5, Gemini 2.0 Pro, LLaMA 4): поверхностная беглость при систематических ошибках в **порядке аффиксов, гармонии гласных, согласовании, уровнях вежливости**; **морфологические ошибки составляют более трети всех нецелевых форм** ([Taylor & Francis, Cogent Arts & Humanities, 2025, DOI 10.1080/23311983.2025.2600519](https://www.tandfonline.com/doi/full/10.1080/23311983.2025.2600519)).

**Локальные языковые инициативы:** **Национальная LLM на узбекском** — разрабатывается на государственном уровне ([gazeta.uz, 05.08.2025](https://www.gazeta.uz/ru/2025/08/05/artificial-intelligence/)); **UzLiB** — открытый бенчмарк и датасет от Tahrirchi ([github.com/tahrirchi/uzlib](https://github.com/tahrirchi/uzlib)); **Tahrirchi / Tilmoch** ([tilmoch.ai](https://tilmoch.ai/ru/translator)); **TBC Lola AI** ([tbcbankgroup.com](https://www.tbcbankgroup.com/news-media/press-releases/2defc6b2-dbc3-4c27-b3c5-0bb20330f18c)); **BERTbek** ([ACL SIGUL 2024](https://aclanthology.org/2024.sigul-1.5/)); **mGPT-1.3B-uzbek** от AI Forever ([huggingface.co](https://huggingface.co/ai-forever/mGPT-1.3B-uzbek)).

### 8.6. Практические выводы отчётов по языку

1. **Для узбекского использовать только топовые проприетарные LLM.** Claude 3.5 Sonnet — лучший на TUMLU-узбекском (69,1). **Малые open-source модели (<3B) не использовать вообще.**
2. **Нужен собственный слой пост-проверки морфологии и скрипта.** >1/3 ошибок топовых моделей — морфология. Лечится валидатором и few-shot примерами, **но не «просто хорошим промптом»**.
3. **Обязательно поддержать оба скрипта** — латиницу и кириллицу — на входе и выходе, с транслитерационным слоем (19% ошибок ASR — кросс-скриптовые путаницы в именах).
4. **Диакритика oʻ / gʻ критична** (27% ошибок ASR). Нормализация должна **сохранять** диакритику, не схлопывать её.
5. **Голос: Whisper исключён.** Только ElevenLabs Scribe или локальный провайдер.
6. **Собственный UZ-eval обязателен.** Стандартные метрики (BLEU) переоценивают качество на узбекском — **character-level метрики (chrF) коррелируют с человеческой оценкой заметно лучше**. Нужен свой evaluation set с UZ-RU code-switching, тегами переключений и обоими скриптами.

### 8.7. Что здесь неизвестно — явно

- **WER не опубликован ни у одного локального провайдера:** RubaiSTT, Muxlisa, Lynx AI STT, Mohir.ai, Aisha AI, UzbekVoice.ai, aisolution UZ-STT.
- **MOS не опубликован ни у одного TTS-провайдера**, кроме академического бенчмарка Avezov (не продукт).
- **Нет опубликованных цифр по телефонному аудио** — все известные WER относятся к читаемой или студийной речи; отчёт прямо оговаривает, что 17,4% на USC достижимы «на читаемой речи, не на телефонных звонках».
- **Нет опубликованного бенчмарка code-switching для ASR как отдельной задачи** — есть только MT/ST метрики Avezov с 25% code-switch спанов.
- **Цены локальных языковых API (Muxlisa, Lynx AI, Aisha, UzbekVoice, Mohir.ai) — не публичны.**

---

## 9. Где белое пространство

Проверка шести гипотез Nemo по ~35 вендорам (отчёт 1). Ранжировано по величине незанятого пространства.

### Место 1 — 🟢🟢 Узбекский язык на всех слоях продукта

**Свидетельство:**
- **Узбекский интерфейс: 0 из ~35 глобальных вендоров.**
- Узбекский как язык агента есть **ровно у одного вендора — Fin**, который биллит только в USD и уходит в Salesforce.
- **Локализованной админ-панели нет ни у кого** — Ada дословно: *«The Ada dashboard is only available in English»*. Отчёт: «агент, отвечающий по-русски, и консоль оператора по-русски — разные продукты, и второй не делает никто».
- Российские платформы локализовались в **казахский и пропустили узбекский**: Salebot (ar, de, en, es, fr, **kk**, lv, ms, pt, ru, tr, th, uk), Aimylogic («русский, казахский, английский, испанский, португальский»).
- MoonAI — только `/ru` и `/en`.
- Обоснование спроса: **>90% потребительской коммуникации идёт на узбекском** (оценка Cybernet AI, [gazeta.uz, 10.06.2025](https://www.gazeta.uz/ru/2025/06/10/cybernet-ai/)).

**Риск, который закрывает позицию:** **MoonAI, вероятно, добавит узбекский** — у него дочка в UZ и деньги IT Park. Отчёт даёт **окно 12–18 месяцев**. Локальные игроки (Cybernet AI, Lynx AI, Aisha AI, aisolution, Innosoft, Repli AI, Salom AI) уже нативно узбекские — но **ни один не self-serve SaaS-конструктор**. Позиция закроется в тот момент, когда либо MoonAI локализуется, либо кто-то из локальных перейдёт из проектной модели в подписочную.

**Оговорка отчёта, которую надо принять:** одного языка недостаточно — за 12–18 месяцев надо построить что-то более защитимое (данные, качество на узбекском, дистрибуция).

### Место 2 — 🟢 Жёсткий бюджет-кэп на уровне одного прогона + предварительная оценка стоимости

**Свидетельство:**
- Кэпы на уровне **аккаунта/места** есть у Dust (лучший: личный + воркспейсный + программный, 0 = блок всего API/Zapier/n8n), Relevance AI (org+project на всех тарифах), Lindy (пауза), Gumloop (потолок $5 000), Fin (limits + alerts, hard limits на Operator-кредиты).
- **На уровне ОДНОГО ПРОГОНА — ни у кого.** Ближайшие аналоги: Zapier Agents — потолок действий на прогон (10/40); Gumloop — пауза с запросом одобрения при превышении. **Оба — действия, а не деньги.**
- **Предварительной оценки стоимости до запуска нет ни у кого вообще.** Make (09.12.2025) и Gumloop (30.01.2025) **официально признали**, что это невозможно в их архитектуре.
- Это бьёт по слабости №1 у каждого инкумбента: худшие отзывы каждого конкурента — про счета («3000 кредитов за день», «$550 за 44 000 кредитов, я не разрешал овераж», «в пять раз дороже ожидаемого в проде»).
- Единственный, кто хотя бы публикует диапазон стоимости диалога, — **BotHelp** («1 диалог ≈ 500–6 000 токенов»).

**Риск, который закрывает позицию:** технически это не защищено патентом и воспроизводимо. **Но воспроизведение требует детерминированной архитектуры** — Make и Gumloop признали, что при недетерминированном выборе инструментов оценка невозможна в принципе. Инкумбенту придётся перетарифицировать всю книгу. Ближайшая реальная угроза — **Fin** (у него уже есть hard limits и симуляции) и **Dust** (лучшие кэпы), но ни один не приходит в Узбекистан.

### Место 3 — 🟡 Shadow / dry-run без сайд-эффектов, в русско/узбекоязычном SMB-сегменте

**Свидетельство:**
- **Занято тремя и хорошо:** **Beam AI** — лучший (*«integrations are sandboxed, so test runs do not create, update, or delete live records»*); **Relevance AI** — Tool simulations + evals, блокирующие публикацию; **Fin** — Simulations, Regression Tests, Previews, Audience Testing.
- У остальных — фикция: n8n data pinning только в разработке; **`crewai test` выполняет по-настоящему**; Zapier прямо пишет, что тесты дают реальные сайд-эффекты; **Make списывает кредиты за тесты**; Stack AI HITL ломается на API и Form.
- **В русскоязычном и SMB-сегменте — свободно.** Ни у одной из СНГ-платформ (Salebot, BotHelp, TextBack, PuzzleBot, Leadtex, Aimylogic, TWIN) dry-run не задокументирован.

**Риск, который закрывает позицию:** Beam AI и Relevance AI уже умеют это технически — вопрос только выхода в регион, а он маловероятен (Beam при PitchBook $1,35 млн, Relevance в развороте в sales-led). Более реальный риск — **Bitrix24 или amoCRM добавят песочницу** вместе с выпуском своих конструкторов агентов.

### Место 4 — 🟡 Детерминированные DAG-пайплайны (Nemo Forge) в SMB-сегменте

**Свидетельство:**
- **Тренд подтверждён деньгами:** **Poetic** (ex-Forge) — $50 млн Series A при оценке $500M, 12.06.2026, Kleiner Perkins **с участием OpenAI**; прямо анти-агентная компания, компилирует регламенты в *«deterministic, near-tokenless execution»*; клиенты SoFi, AIG, Chime.
- **Но это корпоративный сегмент США. В SMB — свободно.**
- Косвенное подтверждение спроса: CrewAI-практик, 02.06.2026 — *«Non-optimized token consumption… A CrewAI workflow that "works" in dev might cost five times more than expected in production»*; **PuzzleBot вообще не имеет LLM-функций** и живёт на детерминированном no-code, что показывает, что рынок принимает детерминизм.

**Риск, который закрывает позицию:** Poetic может пойти вниз по рынку; но также существенно, что **детерминизм сам по себе не продаётся SMB** — он продаётся через свои следствия (предсказуемая цена, dry-run, трассы). **Позиция ценна как архитектурная основа для мест 2 и 3, а не как отдельное сообщение.**

### Место 5 — 🟡 Messaging-first (Telegram) — тонкий ров, но обязательная гигиена

**Свидетельство:**
- **Sales/SDR: 0 из 9. Поддержка: 1 из 10** (только Botpress; Voiceflow **имел и удалил**). **Большие платформы: 0 из 6** (Microsoft — только через Azure Bot Service с написанием кода).
- **Но:** нативный Telegram есть у n8n, Make, Activepieces, Botpress, Relevance AI (без BotFather-токенов), amoCRM/Kommo, Bitrix24, BotHelp, Salebot, PuzzleBot, TWIN, Aimylogic — **у российских платформ у всех**.
- **amoCRM подключает Telegram токеном BotFather бесплатно, без шлюза, без платы за сообщение.**
- **Bitrix24 катает «Интернет-магазин внутри Telegram» в бете** (каталог → заказ → оплата внутри чата).
- **PuzzleBot уже принимает сумы через Payme и Click**, имеет узбекского мерчанта в кейсах (Fanstore.uz).

**Прямая формулировка отчёта:** **«Telegram сам по себе — тонкий ров. Настоящий ров — узбекский язык.»**

**Риск, который закрывает позицию:** уже закрыта для СНГ-конкурентов. Telegram нужен как обязательное условие, а не как дифференциатор.

### Место 6 — 🔴 Объяснимые трассы — гигиена, не дифференциатор глобально; свободно в СНГ

**Свидетельство:** плотно занято — CrewAI (лучший OTel, 17 интеграций), Dust (аудит-логи + SIEM, различает человека и ИИ), n8n (LLM generated / LLM error / Tool called события), Beam (трасса + токены), Gumloop (лучшая декомпозиция стоимости по прогону), Relevance AI (стоимость на задачу, OTEL). **Но в СНГ-сегменте — ни у кого нет.**

**Риск:** это ожидание рынка, а не преимущество. Отсутствие трасс — минус; наличие — не плюс в глобальном разговоре.

### Место 7 — 🔴 HITL-одобрения — плотно занято, и есть чему учиться

**Свидетельство:** **Dust «stake levels»** — лучшая модель (High = одобрение каждый раз, Medium = раз на пару агент+получатель, Low, Never ask; `send_mail` выключен по умолчанию); **Gumloop App Rules с CEL-выражениями** по аргументам вызова инструмента, написанными агентом на естественном языке с утверждением человеком; **n8n sendAndWait включая Telegram**; Beam AI «Consent required» на узел + API approve/reject; Relevance AI по-рёберно (Auto / Approval required / Let agent decide).

**Провалы конкурентов, которые можно атаковать:** **Zapier Agents не имеет принудительного узла одобрения** (официальная рекомендация — написать «ask for my confirmation» в инструкции агента, то есть на уровне промпта); **Make HITL — Enterprise + закрытая бета по приглашению**; **Stack AI HITL ломается на API и Form**; **Lindy HITL только в общих Slack-тредах** — веб-чат, Slack DM и SMS без защиты.

**Риск:** позиция занята. Ценность — в том, чтобы не отстать, и в возможности указать на провалы конкурентов.

### 🎯 Итоговая формулировка белого пятна (дословно из отчёта 1)

> **Детерминированный пайплайн + предварительная оценка стоимости + жёсткий кэп на прогон + песочница без сайд-эффектов + узбекско-русская консоль оператора + нативный Telegram + оплата в сумах.**

**Ни один вендор не имеет больше трёх из семи.** Лучшие комбинации в мире:
- **Beam AI** — песочница + генерация из SOP + HITL, но **нет Telegram, нет цен, нет локализации**
- **Relevance AI** — симуляция + кэпы + Telegram, но **нет RU/UZ, нет BotFather, sales-led**
- **Dust** — кэпы + stake levels + аудит, но **нет Telegram вообще**

**Дополнительные незанятые позиции, зафиксированные отчётом 2:**
- **18 000+ продавцов Uzum Market без AI-инструментов** (оборот +60% г/г, ~90% МСБ) — готовый вертикальный сегмент. **AI-ассистент для селлеров: данные не найдены.**
- **Цены в сумах + Payme Subscribe API** — операционное преимущество, которое MoonAI (Delaware + Kaspi + $50) **структурно не может быстро повторить**.
- **Статус резидента IT Park** (0% налога на прибыль/НДС/соцналог, НДФЛ 7,5%) даёт структурное ценовое преимущество перед российскими платформами и MoonAI на этом рынке. ⚠️ Срок действия льгот — **расхождение источников** (см. §6.5).

### Красные флаги, зафиксированные обоими отчётами

- **Bitrix24 уже раздаёт AI бесплатно и готовит конструктор AI-агентов.** Если Nemo — «просто агент с базой знаний», это будет коммодитизировано **за 6–12 месяцев**.
- **MoonAI, вероятно, добавит узбекский** — окно **12–18 месяцев**.
- **SAFE и конвертируемые займы не признаны законодательством РУз** (ПРООН, февр. 2026) — влияет на структурирование раундов.
- **С 01.04.2026 льготы IT Park не действуют для маркетплейсов и платёжных организаций** — при агрегации платежей риск переквалификации.
- **Только ~6 дата-центров в стране**, высокая стоимость вычислений, ограниченный доступ к GPU — **локальный inference на узбекском будет дорогим**; полагаться на облачные LLM-API.
- **Проникновение генеративного ИИ — 7,2%** против 17,8% мирового. Рынок ранний: продавать придётся не «лучший агент», а «замена менеджера» с посчитанным ROI.
- **Лицензия n8n** (Sustainable Use License, fair-code, не OSI) прямо запрещает white-labelling, хостинг за плату и **сбор учётных данных конечных пользователей для питания фичи вашего приложения**. Если n8n где-то в стеке — **эскалировать до архитектурных решений**.

---

## 10. Чего мы не знаем

Консолидированный список всего, что исследования пометили как непроверенное или ненайденное. Это список задач для первичного research, а не для цитирования.

### 10.1. Методологические провалы исследования — читать первым

- **Reddit был полностью недоступен во всех потоках** (403 / блок-лист). **Ни одной reddit-цитаты в отчётах нет.** r/AI_Agents, r/automation, r/n8n **не проверены** — стоит отдельного ручного прохода.
- **Бюджет WebSearch (200 вызовов) исчерпан к середине работы.** Следствие: **проверка известных компаний сильная, обнаружение неизвестных слабое.**
- 🔴 **«Узбекские и казахские локальные ИИ-вендоры, которых я не мог назвать заранее, не найдены. Это самая большая дыра»** — дословно из отчёта 1. (Отчёт 2 частично закрыл её через карту Gorgona AI × ALPHA, но полнота не гарантирована.)
- **G2 / Capterra / Trustpilot частично блокировали ботов.** Где рейтинги помечены «по сообщениям» — они не прочитаны напрямую.

### 10.2. Регион — самое критичное

| Вопрос | Статус | Почему важно |
|---|---|---|
| **Что изменил Закон ЗРУ-1125 от 26.03.2026 в статье 20 Закона о персданных** ([lex.uz/docs/8104580](https://lex.uz/docs/8104580)) | **не подтверждено** | 🔴 **Прочитать до заморозки схемы данных** |
| **Клирят ли Uzcard/Humo/сумовые Visa зарубежных онлайн-мерчантов; валютные лимиты ЦБ РУз** | **не подтверждено** — правовая рамка ЗРУ-1138 от 21.04.2026 существует, но **конкретной цифры лимита нет; не цитировать никаких чисел** | Определяет, может ли узбекский SMB вообще заплатить за западный SaaS |
| **Валютные ограничения на трансграничные SaaS-подписки и репатриацию выручки из РУз** | **данные не найдены** | Требует консультации с локальным юристом/банком **до запуска биллинга** |
| **Процент проникновения Telegram в УЗ и КЗ** | 🔴 **не подтверждено** (отчёт 1: нужен логин TGStat, «не ставить цифру»). Отчёт 2 даёт 25 млн / 76% через sostav.ru — **противоречие сохранено, см. §6.3** | Ключевой слайд инвесторской презентации |
| **Условия «Click Подписка» для мерчанта** | **не подтверждено** | Второй по величине платёжный рельс |
| **Merchant-side документация рекуррентных платежей Click** | **данные не найдены** | — |
| **Онбордят ли Paddle / Lemon Squeezy узбекских продавцов** | **не подтверждено** | Единственный обходной путь при отсутствии Stripe |
| **Merchant-initiated recurring у Kaspi** | **не подтверждено** | Определяет, насколько прочен платёжный рельс MoonAI |
| **Доступность и оплачиваемость Yandex AI Studio и GigaChat из Узбекистана** | **не подтверждено** | Альтернативный (дешёвый) инференс-рельс |
| **Срок действия льгот IT Park** | ⚠️ **Расхождение:** отчёт 2 — «до 1 января 2028»; отчёт 1 — **«не подтверждено, не утверждайте до 2040 года»** | Влияет на финмодель |
| **Точное количество резидентов IT Park на август 2026** | **не найдено** — расхождение **2 000 (февр. 2026) vs 3 700 (май 2026)** | — |
| **Есть ли уже активный франчайзи TWIN или реселлер ИИ-агентов Bitrix24/amoCRM в Узбекистане** | **не подтверждено** | Определяет скорость входа российских вендоров |
| **Установленная база amoCRM и Bitrix24 конкретно в Узбекистане** | **данные не найдены** | Размер контура, из которого придётся отбивать клиентов |
| **Детальная отраслевая разбивка 474,9 тыс. предприятий** (услуги / HoReCa / медицина / образование / бьюти) | **не найдена** в публичных источниках — есть в базе SIAT, **требует прямого запроса в Нацкомстат** | Сегментация ICP |
| **AI-инструменты для продавцов Uzum Market** | 🔴 **данные не найдены** — ни одного упоминания на август 2026 | Основание для вертикальной гипотезы |
| **Публичные цены Cybernet AI, Lynx AI, Aisha AI, Repli AI, Gorgona AI, Arkon AI, KOTIB AI, UzbekVoice Agents** | **не публичны** | Невозможно позиционироваться по цене против локальных |
| **Актуальный статус и цены autoFAQ, Sherlock/Craftalk, Twin, Fistashka** | **данные не найдены** | — |
| **Узбекский язык у TWIN** | **не подтверждено** | — |

### 10.3. Язык и речь

- **Опубликованные WER для RubaiSTT, Muxlisa, Lynx AI STT, Mohir.ai, Aisha AI, UzbekVoice.ai, aisolution UZ-STT** — **все заявляют качество, никто не публикует цифры.**
- **MOS для всех локальных TTS-провайдеров** — не опубликовано.
- ⚠️ **Внутреннее противоречие ElevenLabs:** 15,9% WER в таблице против 3,1%/5,5% в тексте на той же странице — **условия замера не раскрыты**.
- **Нет опубликованных WER на телефонном аудио** — все известные цифры на читаемой/студийной речи.

### 10.4. Финансы и масштаб конкурентов

- **ARR раскрыт ровно одной компанией из семи конструкторов** — Dust (>$20 млн). ARR для Lindy, Relevance, Beam, CrewAI, Stack AI, 11x, Artisan, Regie, Unify, AiSDR — **третьесторонние модельные оценки, не цифры компаний.**
- **Оценка не раскрыта ни одним из восьми конструкторов.** Relevance AI явно отказалась (*«The company did not provide its valuation»*).
- **Не подтверждено:** финансирование / оценка / ARR Zapier; суммы раундов Beam AI (PitchBook $1,35 млн противоречит 8 инвесторам и заявленной стадии Series A); сумма Activepieces; сумма и оценка Gumloop; суммы сделок Zendesk–Forethought, Salesforce–Qualified, Celonis–Make.
- **Реальная цена Artisan** — tomba.io «низкие тысячи в месяц» против bestaiagents.app «Intern $250/мес, Employee $600/мес»; **взаимно несовместимы, обе SEO-контент**.
- **n8n ARR** «$40 млн+ и 230 000+ активных пользователей» — вторичные источники (sacra, getlatka); **«$100M+ ARR» — только блог startupriders, не подтверждено**.
- **11x на 27.08.2026:** компания жива; увольнений, down-раунда или закрытия **не найдено — не подтверждено**.

### 10.5. Продуктовые пробелы у конкурентов

- Рейт-карта кредитов workspace-агентов **OpenAI** (анонс апреля 2026 обещал бесплатность до 06.05.2026 «with credit-based pricing starting on that date» — **текущая ставка не найдена**).
- PAYG-ставка за кредит **Copilot Studio**; цены **Google Workspace** в USD; масштаб **Gemini Enterprise** в местах или выручке.
- Цены и региональная доступность **Coze**.
- **Цена буста CoPilot/BitrixGPT в любой валюте** (видна только внутри портала).
- Жив ли **«AI-ответы в Открытых линиях» Bitrix24** несмотря на тег «скоро».
- **Тарифы Aimylogic / Just AI** (страница отдала пустое тело дважды); **Repli AI** — цены не найдены.
- Долларовые цены тарифов **Botpress**; цены пакетов **Kommo** и **кредитов на разговор Kommo** (публиковать отказывается).
- Поддержка русского у **Artisan, Clay, Regie, Salesforge, Lyzr, Decagon, Forethought, Chatbase, Voiceflow, Botpress**.
- **Входящий Telegram-триггер у Lindy**; локализация приложения **Beam AI**; закрылся ли разрыв производительности **Activepieces против n8n**; цены **Lovable** (не отрендерились серверно).
- **Sierra и Decagon:** проверяемой критики **не существует** — вся ходящая критика восходит к статьям конкурентов (eesel AI). **Не ставить в презентацию.**

### 10.6. Предупреждения о качестве данных — нести дальше

- **Lindy: всегда цитировать обе оценки** — G2 4,9 и Trustpilot 1,7.
- **~45% отзывов Relevance AI на G2 — за подарочные карты.**
- **Свежие отзывы Stack AI — по приглашению продавца («Incentivized / Seller invite»).**
- **aifunding.me недостоверен** — выдумал итоговые суммы для Poetic.
- **G2 `/products/beam-ai/` — совершенно другая компания** (Attentive AI, ПО для строительных обмеров). Не цитировать.
- **Zapier противоречит сам себе:** «2 млн бизнесов» на /about против «3 млн+» на главной.
- **Огромный пласт SEO-контента «AI SDR is dead / 47% collapse»** (greenway.ai, pynghq.com, alleyoop.io) — **ИИ-генерированный, не использовать**.
- **Apollo 410 и ZoomInfo 403 по Узбекистану — не сигналы про Узбекистан** (Германия отдаёт то же самое).
- **«$1,5 млрд» из Стратегии ИИ до 2030 — целевой показатель политики, не измерение рынка. Никогда не цитировать как TAM.**
- **TAM/SAM $45 млн ARR (§6.1) — арифметика автора отчёта, а не статистика.** Потолок, не прогноз.
- **Метрики MoonAI (98,8% точности, 8 сек, 80% воронки) — маркетинг, не аудит.** Методика не раскрыта; на сайте 98,8%, в интервью 98%.

### 10.7. Чего нет в этом документе вообще

- **Себестоимость обслуживания одного клиента Nemo** — в исследованиях не считалась.
- **Данные по оператору поддержки и агенту колл-центра как отдельным зарплатным позициям в Узбекистане** — не найдены; §7 опирается только на менеджера по продажам и средние зарплаты.
- **Отток и retention у любого из региональных конкурентов** — не найдено ни у одного, кроме Dust («нулевой отток в 2025», собственное заявление).
- **Реальное количество платящих клиентов Bitrix24** — «>15 000 000 зарегистрировано» это регистрации; **число платящих не подтверждено**.
- **Собственные данные Nemo** (клиенты, выручка, retention) — по `yc/fall-2026/application-draft.md` репозиторий их **не устанавливает**; все соответствующие поля помечены как требующие ввода основателя.
