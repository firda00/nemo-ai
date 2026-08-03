# Внешние источники: решение по проверке

Дата проверки: 27 июля 2026.

Исходники GitHub-проектов сохранены только для read-only проверки в `C:\Users\firda\Documents\nemo-external-review`. Ничего из них не запускалось, не устанавливалось в Nemo и не получало доступ к секретам проекта.

| Источник | Решение | Причина |
| --- | --- | --- |
| `google/magika` | Рассмотреть позже | Локальный анализ типа файла. Подходит как изолированная серверная capability после version pinning, лимитов размера файла и тестов. Не использовать curl или PowerShell pipe installer. |
| `stackblitz/bolt-slides` | Рассмотреть позже | Может помочь с генерацией презентаций. Не является core-функцией Nemo; внешние данные на слайдах должны быть opt-in. |
| `thewh1teagle/vibe` | Только локальный пилот | Транскрибация аудио. Нужны отдельные разрешения на микрофон, файлы, загрузки и обновления. |
| `severity1/claude-code-prompt-improver` | Только sandbox | Hook видит prompts и tool metadata. Не включать глобально и не давать доступ к чувствительным данным. |
| `ayghri/i-have-adhd` | Opt-in личный skill | Низкий технический риск, но это настройка стиля ответов, а не продуктовая интеграция. |
| `Termix-SSH/Termix` | Не ставить на Nemo host | Управляет SSH, RDP, VNC, туннелями и удалёнными командами. Не меняем SSH-конфигурацию, ключи или доступы. |
| `builtbybel/FluentTweaker` | Отклонить | Системные изменения Windows, registry, UAC, задачи, удаление компонентов и remote bootstrap. |
| `Osmantic/ODS` | Не ставить на production | Docker, модели, GPU, persistent agents, optional Tailscale и host-network changes. Возможен только на отдельной VM после отдельного review. |
| `clucraft/PriceGhost` | Не интегрировать по умолчанию | Скрапинг сайтов, LLM/API-ключи, уведомления и отдельная база данных. Это отдельный сервис, не capability Nemo. |
| `spel987/PolyUploader` | Отклонить | Загружает файлы на множество сторонних хостингов, хранит API-ключи, поднимает local proxy. |
| `breferrari/obsidian-mind` | Не использовать как есть | Может индексировать заметки, подключать MCP и сохранять контекст сессий. Высокий риск утечки рабочих данных. |
| `smixs/pohuy` | Не использовать в Nemo | Стиль с нецензурной лексикой не подходит для клиента, команды или операционных журналов. |
| `paranoiaprivacy.wiki` | Только справочник | Это сайт с материалами по privacy, не устанавливаемый репозиторий. |
| `pliny-the-prompter/obliteratus` | Не использовать | Hosted prompt-bypass/jailbreak инструмент противоречит безопасной модели Nemo. |
| `OpenMOSS-Team/MOSS-SoundEffect-v2.0` | Отдельный ML-пилот позже | Модель, а не готовая интеграция. Нужны licence review, GPU/cost benchmark, abuse policy и изолированный executor. |

## Правило подключения внешнего инструмента

Инструмент не показывается пользователю как работающий, пока не выполнены все пункты:

1. Есть server-side executor.
2. Есть tenant authorization и конкретные permission boundaries.
3. Есть лимиты: размер входа, время выполнения, retries, стоимость и quota.
4. Секреты не попадают во frontend или логи.
5. Есть audit record и human approval для consequential action.
6. Есть production smoke test.
