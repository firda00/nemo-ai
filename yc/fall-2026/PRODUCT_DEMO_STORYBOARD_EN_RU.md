# Nemo AI Product Demo: Storyboard

Format: screen recording, 16:9, 1440x900 or 1920x1080, 1 minute 50 seconds to 2 minutes 20 seconds.

Goal: show one real workflow from plain-language task to supervised result. Do not show unverified integrations, customer data, secrets, billing, image generation, or sending to Telegram.

## Preparation

- Use `https://nemo.185.8.213.144.sslip.io/app/autonomous`.
- Sign in with the dedicated investor demo account.
- Set the interface language to English.
- Use the synthetic knowledge file `yc/fall-2026/demo-assets/nemo-demo-academy-faq.txt`.
- Close unrelated browser tabs and notifications.
- Run the exact workflow three times before recording.
- Record a backup take.

## Frame 1: Product Context

| Time | Screen action | English narration | Russian meaning |
| --- | --- | --- | --- |
| 0:00-0:08 | Open the **AI Team** page. Keep the page still for two seconds. | `Nemo helps a business turn one recurring responsibility into a supervised AI workflow.` | Nemo помогает бизнесу превратить одну повторяющуюся обязанность в управляемый AI-процесс. |
| 0:08-0:15 | Click the task field. | `Instead of configuring a complex automation graph, I describe the responsibility in plain language.` | Вместо настройки сложной схемы автоматизации я описываю обязанность обычным языком. |

## Frame 2: Define the Workflow

| Time | Screen action | English narration | Russian meaning |
| --- | --- | --- | --- |
| 0:15-0:30 | Paste the workflow below. Do not type it slowly. | `This team will handle incoming inquiries for an online school. The important part is the boundary: it can prepare work, but it must not invent facts or make consequential decisions.` | Эта команда будет обрабатывать входящие заявки онлайн-школы. Важна граница: она готовит работу, но не выдумывает факты и не принимает важные решения. |
| 0:30-0:38 | Click the paperclip, attach `nemo-demo-academy-faq.txt`, and wait until its name appears. | `I attach a small synthetic knowledge file. The agents can use these facts, but they must ask a person to confirm anything the file does not contain.` | Я прикрепляю небольшой синтетический файл знаний. Агенты могут использовать эти факты, но должны просить человека подтвердить всё, чего в файле нет. |
| 0:38-0:41 | Click the violet arrow button. | `Now Nemo designs a lead agent and specialists for this specific task.` | Теперь Nemo проектирует руководителя и специалистов под эту конкретную задачу. |

### Workflow to paste

```text
Create an AI team for handling incoming inquiries for an online school.

The team must:
- answer only from the uploaded knowledge base;
- ask for the person's name, phone number, course of interest, and preferred start date;
- never invent prices, discounts, schedules, or guarantees;
- state clearly when information is missing;
- prepare a concise next step for a human manager;
- keep customer-facing messages as drafts until a person approves them;
- show the team workflow and review status.

Deliverable: a ready-to-use response draft, a structured lead summary, missing information, and the next human action.
```

## Frame 3: Team Formation

| Time | Screen action | English narration | Russian meaning |
| --- | --- | --- | --- |
| 0:41-0:58 | Let the team appear. Slowly point at the lead and two specialist cards with the cursor. | `Nemo creates a team around the task. The lead coordinates the work, specialists contribute distinct parts, and the configuration stays editable.` | Nemo создаёт команду вокруг задачи. Руководитель координирует работу, специалисты выполняют разные части, а конфигурация остаётся редактируемой. |
| 0:58-1:08 | Let specialist statuses update. Do not cut while a run is still pending. | `The system does not treat a fluent answer as proof. It runs the task through specialist work and review before presenting the result.` | Система не считает красивый ответ доказательством. Она проводит задачу через работу специалистов и проверку перед показом результата. |

## Frame 4: Result and Human Boundary

| Time | Screen action | English narration | Russian meaning |
| --- | --- | --- | --- |
| 1:00-1:25 | Scroll to the final result. Point to the response, lead summary, missing information, and next action. | `The output is not just chat text. It includes a response draft, structured information for the business, missing facts, and a next action for a human manager.` | Результат - не просто текст чата. В нём есть черновик ответа, структурированная информация для бизнеса, недостающие факты и следующее действие менеджера. |
| 1:25-1:40 | If the run shows review or trace, open one completed item. If it does not, leave it closed. | `We can inspect how the work was handled. If information is missing or an action matters, the workflow stops and asks a person to decide.` | Можно проверить, как была обработана работа. Если информации не хватает или действие важно, процесс останавливается и просит человека принять решение. |

## Frame 5: Close

| Time | Screen action | English narration | Russian meaning |
| --- | --- | --- | --- |
| 1:40-1:55 | Return focus to final result or team overview. | `Nemo is not trying to replace a business with one model. We help businesses introduce AI into one bounded workflow, measure quality, and expand only as trust is earned.` | Nemo не пытается заменить бизнес одной моделью. Мы помогаем внедрить AI в один ограниченный процесс, измерить качество и расширяться только по мере доверия. |
| 1:55-2:00 | Hold the final product view. End recording. | `That is Nemo AI.` | Это Nemo AI. |

## Stop Rules

Stop and record again if any of these happen:

- The UI says `Demo mode`, `local simulation`, `coming soon`, or shows an error.
- The workflow fails, escalates unexpectedly, or produces invented facts.
- A real customer name, email, phone number, key, token, or internal document appears.
- A tool claims it sent a message, edited external data, or completed an action that you cannot verify.
- The workflow has not completed before the two-minute limit.

## Do Not Say

- `Fully autonomous AI workforce`
- `Agents can do anything`
- `We replace departments`
- `This prevents all mistakes`
- `We have customers, pilots, revenue, or measured savings` unless independently true and documented
