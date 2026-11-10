# AI Maestro — Deep Dive Research

**Дата исследования:** 2026-03-25
**Репозиторий:** [23blocks-OS/ai-maestro](https://github.com/23blocks-OS/ai-maestro)
**Сайт:** [ai-maestro.23blocks.com](https://ai-maestro.23blocks.com/)
**Автор:** Juan Pelaez / 23blocks
**Лицензия:** MIT

---

## Общая информация

AI Maestro — open-source оркестратор AI-агентов с системой навыков (Skills System), дашбордом для управления агентами, собственным протоколом обмена сообщениями (AMP) и поддержкой мультимашинных mesh-сетей. Позиционирует себя как "The Future of Work: Humans + AI Agents".

### Метрики репозитория (на 25 марта 2026)

| Метрика | Значение |
|---------|----------|
| Stars | **557** |
| Forks | 77 |
| Open issues | 8 |
| Коммитов | 890+ |
| Контрибьюторов | ~5 (249 от jpelaez-23blocks, далее 9, 7, 4, 2) |
| Создан | 10 октября 2025 |
| Последний коммит | 25 марта 2026 (сегодня!) |
| Последний релиз | v0.26.4 (25 марта 2026) |
| Языки | TypeScript 89%, Shell 6.7%, JS 3.4%, CSS 0.5% |
| Размер репо | ~312 MB |

**Вывод:** Проект активно развивается, коммиты ежедневные. Но по факту это проект одного человека (Juan Pelaez — 249 из ~270 коммитов от людей). 4 коммита от аккаунта `claude` — что ироничным образом подтверждает AI-происхождение кода.

---

## Origin Story

Цитата из описания проекта:
> "I had 35 terminals and couldn't tell which was which."

Автор запускал 35+ AI-агентов одновременно и стал "human mailman" между ними — копировал контекст из одного терминала в другой. Сейчас утверждает, что запускает **80+ агентов** на нескольких компьютерах.

---

## Поддерживаемые агенты

### Заявленная совместимость:
- **Claude Code** (основной)
- **Aider**
- **Cursor**
- **GitHub Copilot CLI**
- **OpenCode** (через Skills)
- **Любой терминальный AI-агент**

### Как это работает:
AI Maestro не является "мультипровайдерным" в том смысле, что он сам вызывает API разных LLM. Он работает на уровне **терминалов** — оборачивает tmux-сессии и предоставляет dashboard для управления ими. Любой инструмент, который работает в терминале, может быть "агентом" в AI Maestro.

**Важное уточнение:** AI Maestro НЕ абстрагирует LLM-провайдеров (как например LiteLLM). Он оркестрирует **процессы в терминале**. Claude Code внутри себя использует Anthropic API, Aider может использовать OpenAI/Anthropic/etc — но AI Maestro этого не контролирует.

---

## Архитектура

### Tech Stack

| Компонент | Технология | Роль |
|-----------|-----------|------|
| Frontend | **Next.js** | Web-дашборд |
| Terminal | **xterm.js** | Эмуляция терминала в браузере |
| Database | **CozoDB** | Граф-реляционная БД для памяти и Code Graph |
| Code Analysis | **ts-morph** | Парсинг AST для Code Graph |
| Process Mgmt | **tmux** | Мультиплексор терминалов |
| Networking | **Peer Mesh** | P2P сеть между машинами |

### CozoDB — выбор базы данных

CozoDB (3 926 stars) — необычный выбор. Это транзакционная реляционно-графовая-векторная БД, использующая **Datalog** для запросов. Ключевые фичи:
- Реляционная модель + графовые алгоритмы
- Векторный поиск через HNSW-индексы
- Встраиваемая (embedded)
- Time-travel запросы

Это позволяет хранить и код-граф (структура кодобазы), и память агентов (conversation history), и выполнять векторный поиск — в одной БД.

### Три уровня "интеллекта"

1. **Memory** — Персистентная память через CozoDB. Агенты помнят прошлые решения и разговоры.
2. **Code Graph** — Визуализация структуры кодобазы. ts-morph парсит AST, извлекает классы/функции/импорты, строит граф зависимостей. Delta-индексация (переиндексируются только изменённые файлы).
3. **Documentation** — Автогенерируемая документация из кода, доступная агентам для поиска.

### Мультимашинная mesh-сеть

- Peer-to-peer топология: каждая машина — равноправный узел
- Нет центрального сервера
- Новая машина автоматически присоединяется к mesh
- Все агенты со всех машин видны в одном дашборде
- Поддержка remote access через Tailscale VPN

### Структура репозитория

```
/app          — Application logic
/components   — UI-компоненты
/services     — Backend-сервисы
/plugin       — Система плагинов для Claude Code
/agent-container — Контейнеризированные агенты
/infrastructure/terraform/aws-agent — AWS deployment
/docs         — Документация
```

---

## Agent Messaging Protocol (AMP)

AMP — это **собственный протокол** 23blocks для межагентной коммуникации. Отдельный репозиторий: [agentmessaging/protocol](https://github.com/agentmessaging/protocol) (20 stars, Apache 2.0).

### Ключевые характеристики

| Параметр | Значение |
|----------|----------|
| Версия | 0.1.3-draft |
| Лицензия | Apache 2.0 |
| Безопасность | Ed25519 криптографические подписи |
| Адресация | Email-подобная: `agent-name@tenant.provider` |
| Спецификации | 11 документов |

### Формат сообщений

Конверт содержит:
- `from` / `to` — адреса отправителя/получателя
- `subject` — тема
- `priority` — приоритет
- `in_reply_to` — для тредов
- `payload` — произвольный JSON
- `signature` — Ed25519 подпись

Каноническая подпись: `from|to|subject|priority|in_reply_to|SHA256(payload)`

### Доставка сообщений

4 способа:
1. **WebSocket** — реалтайм для подключённых агентов
2. **REST API** — polling
3. **Webhook** — HTTP POST push
4. **Relay queue** — очередь для офлайн-агентов (TTL 7 дней по умолчанию)
5. **Mesh** — локальная маршрутизация без интернета

### Провайдеры (федеративная модель)

- **AI Maestro** (self-hosted): `http://localhost:23000/api/v1` — работает
- **crabmail.ai** — "coming soon"
- **lolainbox.com** — "coming soon"

### Безопасность

- Ed25519 подписи предотвращают подмену отправителя
- Trust-level аннотации для внешних сообщений
- Key revocation с федеративным распространением
- Защита от prompt injection (34 паттерна)
- SSRF-превенция для webhook

### Критическая оценка AMP

**Плюсы:**
- Формально специфицированный протокол (11 документов)
- Криптографическая безопасность по умолчанию
- Федеративная модель
- Поддержка офлайн-агентов

**Минусы:**
- Всего 20 stars на GitHub
- Единственная реализация — сам AI Maestro
- Федерация заявлена, но 2 из 3 провайдеров "coming soon"
- По факту проприетарный протокол одного проекта, несмотря на Apache 2.0 лицензию
- Не совместим с ACP (Agent Communication Protocol), MCP или другими стандартами

---

## Kanban Board

AI Maestro включает kanban-доску с:
- **5 колонок** (статусы задач)
- **Drag-and-drop** перемещение карточек
- **Зависимости** между задачами
- **Шаренные задачи** между агентами
- Часть "War Room" — split-pane интерфейс для командных встреч

**Детали реализации Kanban ограничены** — в документации и на сайте нет скриншотов или подробного описания UX. Описание сводится к маркетинговым фразам: "full Kanban board with drag-and-drop, dependencies, and 5 status columns."

---

## Gateways — внешние интеграции

AI Maestro поддерживает "Gateways" для подключения к внешним сервисам:
- **Slack**
- **Discord**
- **Email**
- **WhatsApp**

Маршрутизация через синтаксис `@AIM:agent-name`. Заявлена защита от 34 паттернов prompt injection.

---

## Skills System

Система плагинов, устанавливаемых через `npx skills add`. Навыки автоматически триггерят:
- Поиск по памяти
- Запросы к Code Graph
- Поиск документации

Совместим с 30+ агентами через "Agent Skills Standard".

### Agent Identity (AID)

Новая фича (v0.26.0, 24 марта 2026): агенты могут аутентифицироваться на OAuth 2.0 серверах используя Ed25519 identity. Без паролей, без API-ключей.

---

## Релизная активность

Последние 5 релизов (за 2 дня!):

| Версия | Дата | Описание |
|--------|------|----------|
| v0.26.4 | 25.03.2026 | AMP mesh routing fix |
| v0.26.3 | 24.03.2026 | AID v0.2.0: независим от AMP |
| v0.26.2 | 24.03.2026 | Dynamic discovery для verification |
| v0.26.1 | 24.03.2026 | Переименование installer, auto-discover skills |
| v0.26.0 | 24.03.2026 | Agent Identity (AID) интеграция |

5 релизов за 2 дня — это очень высокий темп. Может свидетельствовать как об активной разработке, так и о незрелости (частые фиксы только что выпущенных фич).

---

## Сравнение с нашим продуктом (Claude Agent Teams UI)

### Фундаментальные различия

| Аспект | AI Maestro | Claude Agent Teams UI |
|--------|-----------|----------------------|
| **Подход** | Терминальный оркестратор (tmux wrapper) | Нативная UI-надстройка над Claude Code Agent Teams |
| **Агенты** | Любой терминальный AI | Claude Code (нативный Agent Teams API) |
| **Мультипровайдер** | Да (на уровне терминалов) | Нет (Claude-only, но с multi-model: Opus/Sonnet/Haiku) |
| **Kanban** | Есть (5 колонок, drag-drop, dependencies) | Есть (5 колонок, drag-drop, real-time) |
| **Межагентная связь** | AMP protocol (собственный) | Нативный Claude Code inbox/task system |
| **Code Review** | Не указан | Diff view с approve/reject/comment |
| **Deep Analytics** | Memory + Code Graph + Docs | Session analysis, context tracking, token usage |
| **Мультимашинность** | Peer mesh network | Нет (локальный) |
| **UI** | Web (Next.js, браузер) | Desktop (Electron) |
| **Процесс** | tmux sessions | stream-json CLI processes |

### Где AI Maestro сильнее

1. **Мультимашинность** — peer mesh сеть, агенты на разных компьютерах. У нас этого нет вообще.
2. **Мультиагентность** — поддерживает Claude, Aider, Cursor, Copilot и любой терминальный инструмент. Мы только Claude Code.
3. **Memory System** — CozoDB с графовыми запросами, векторным поиском, персистентной памятью. У нас аналитика сессий, но не полноценная "память" агентов.
4. **Code Graph** — визуализация кодобазы через ts-morph + CozoDB. У нас такого нет.
5. **External Gateways** — Slack, Discord, Email, WhatsApp. У нас встроенный MCP-сервер, но не gateway к мессенджерам.
6. **Scale** — заявляет 80+ агентов. Наш продукт ориентирован на команды 3-8 агентов.

### Где наш продукт сильнее

1. **Нативная интеграция с Claude Code** — мы работаем с официальным Agent Teams API, а не просто оборачиваем терминалы. Наши агенты нативно общаются через inbox, шарят задачи, имеют structured task references.
2. **Code Review** — полноценный diff view с accept/reject/comment, как в Cursor. У AI Maestro это не заявлено.
3. **Kanban UX** — у нас real-time обновления, direct messaging на карточках, quick actions, structured task references с кросс-ссылками. AI Maestro заявляет Kanban, но без деталей UX.
4. **Deep Session Analysis** — bash commands, reasoning, subprocesses breakdown, chunk timeline. AI Maestro показывает терминал, но не анализирует сессии.
5. **Context Monitoring** — 6 категорий контекста (CLAUDE.md, tool outputs, thinking, team coordination), token usage by category. Уникальная фича.
6. **Desktop App** — нативный Electron, не браузерная вкладка.
7. **DM to agents** — прямые сообщения конкретному агенту с карточки задачи.
8. **Zero-setup** — встроенная установка Claude Code и аутентификация. AI Maestro требует Node.js + tmux + установку.
9. **Built-in Code Editor** — редактор файлов с Git support.
10. **Post-compact context recovery** — восстановление инструкций после context compaction.

### Фундаментальная разница в философии

**AI Maestro** = "Terminal multiplexer on steroids" — оборачивает tmux, добавляет UI и межагентную коммуникацию. Агенты — это просто терминальные сессии. Протокол AMP — собственный, не стандартный.

**Claude Agent Teams UI** = "CTO dashboard for Claude teams" — нативная надстройка над Claude Code Agent Teams, с глубоким пониманием внутренних протоколов Claude (stream-json, inbox, tasks). Агенты — это структурированные сущности с ролями, задачами и коммуникацией.

---

## Рыночное позиционирование

AI Maestro позиционирован в [awesome-agent-orchestrators](https://github.com/andyrewlee/awesome-agent-orchestrators) в категории **"Parallel Agent Runners"** наряду с 38 другими инструментами.

### Конкуренты AI Maestro (не наши)

| Инструмент | Фокус | Stars |
|-----------|-------|-------|
| **Maestro** (RunMaestro) | Desktop orchestrator, Claude/Codex/OpenCode | 2000+ |
| **Vibe Kanban** (BloopAI) | Kanban + Git worktree + MCP | N/A |
| **Claw-Kanban** | Kanban + role-based auto-assignment | N/A |
| **Agent Orchestrator** (ComposioHQ) | Plugin-based, tracker-agnostic | N/A |

RunMaestro (отдельный проект) — самый серьёзный конкурент для AI Maestro: 2000+ stars, desktop app, Group Chat, Auto Run, Mobile Remote Control.

---

## Оценки

### Надёжность решения: 6/10

- Проект одного разработчика (249 из ~270 коммитов)
- Зависимость от CozoDB (нишевая БД)
- 5 релизов за 2 дня — признак незрелости
- AMP протокол — 20 stars, единственная реализация
- Нет community reviews (Reddit/HN)
- Нет automated tests (не видно в описании)

### Уровень угрозы для нашего продукта: 4/10

- Другая ниша: мультиагентный терминальный оркестратор vs нативный Claude Teams UI
- Наша аудитория — пользователи Claude Code Agent Teams
- Их аудитория — пользователи 3+ разных AI-инструментов
- Пересечение небольшое: только если пользователь Claude Code решит добавить другие инструменты

### Что стоит позаимствовать

1. **Memory System** — персистентная память агентов между сессиями. Наши агенты теряют контекст при рестарте. CozoDB — overengineered для нас, но концепция ценная.
2. **Code Graph** — визуализация кодобазы. Можно реализовать через tree-sitter или ts-morph + простое хранение.
3. **Multi-machine** — даже не P2P mesh, но хотя бы возможность подключаться к remote Claude Code сессиям.
4. **External integrations** — Slack/Discord уведомления о прогрессе задач.

---

## Источники

- [GitHub: 23blocks-OS/ai-maestro](https://github.com/23blocks-OS/ai-maestro)
- [AI Maestro Website](https://ai-maestro.23blocks.com/)
- [AMP Protocol: agentmessaging/protocol](https://github.com/agentmessaging/protocol)
- [Agent Messaging Protocol Website](https://agentmessaging.org/)
- [CozoDB](https://github.com/cozodb/cozo)
- [Medium: "Your AI Agent Has Amnesia"](https://medium.com/23blocks/your-ai-agent-has-amnesia-heres-how-we-fixed-it-49980712f2e4) (paywall)
- [Medium: "From 47 Terminal Windows to One Dashboard"](https://medium.com/23blocks/building-ai-maestro-from-47-terminal-windows-to-one-beautiful-dashboard-64cd25ff3b43) (paywall)
- [awesome-agent-orchestrators](https://github.com/andyrewlee/awesome-agent-orchestrators)
- [Maestro vs Superpowers vs ECC comparison gist](https://gist.github.com/jeffscottward/de77a769d9e25a8ccdc92b65291b1c34)
