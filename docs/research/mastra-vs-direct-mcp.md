# @mastra/mcp vs Direct MCP: нужна ли нам Mastra как универсальный интеграционный слой?

**Дата:** 2026-03-24
**Контекст:** Вопрос пользователя — "Maybe we should use @mastra/mcp since it has many agents built-in?"
**Связанные документы:**
- `docs/research/mastra-integration-analysis.md` — полный технический анализ интеграции Mastra
- `docs/research/best-integration-approach.md` — сравнение всех подходов к мультипровайдерности
- `docs/research/ai-agent-protocols-and-routing.md` — обзор протоколов и фреймворков

---

## Краткий ответ

**Mastra НЕ даёт нам "many agents built-in" в том смысле, как это звучит.** Mastra — это SDK для создания СВОИХ агентов через API-вызовы к LLM-провайдерам. Она не умеет запускать/управлять CLI-агентами (Claude Code, Codex, Gemini CLI и т.д.) как процессами. Для нашего продукта — Electron-приложения, управляющего CLI-процессами через kanban-доску — прямой MCP остаётся правильным выбором.

**Итоговая рекомендация: Прямой MCP (Вариант A)**
- Надёжность: 9/10
- Уверенность: 9/10

---

## 1. Что такое @mastra/mcp на самом деле

### Что Mastra НЕ является

Mastra — это **НЕ** библиотека, которая подключает готовых агентов (Claude Code, Codex, Gemini CLI). Это SDK для создания собственных агентов через API-вызовы. Когда Mastra говорит про "40+ providers" — речь о 40+ LLM-провайдерах (OpenAI, Anthropic, Google и т.д.), к которым можно делать API-запросы, а не о CLI-агентах, которые работают как процессы.

### Что Mastra ЯВЛЯЕТСЯ

| Компонент | Описание |
|-----------|----------|
| `@mastra/core` | Agent runtime: создание агентов через `new Agent({model, instructions, tools})` |
| `@mastra/mcp` | MCPClient (подключение к MCP-серверам) + MCPServer (экспорт инструментов) |
| Agent | TS-объект, который вызывает LLM API + tools в цикле |
| Supervisor | Паттерн multi-agent: один агент координирует других |
| Memory | Observational Memory для long-term context |
| Workflows | DAG-based workflow engine |
| ToolSearchProcessor | Динамическая подгрузка инструментов (экономия токенов) |

### Ключевой момент

Mastra-агент — это `agent.generate("prompt")` или `agent.stream("prompt")`. Это **HTTP-вызов к LLM API** (OpenAI, Anthropic и т.д.). Это **НЕ** запуск CLI-процесса `claude --input-format stream-json`.

Наш продукт — менеджер CLI-процессов с kanban-доской. Mastra работает на другом уровне абстракции.

---

## 2. Поддержка MCP у CLI-агентов (март 2026)

**Ключевой вопрос: если агенты уже поддерживают MCP нативно, зачем нам Mastra как прослойка?**

| CLI-агент | MCP поддержка | Как настраивается | Источник |
|-----------|---------------|-------------------|----------|
| **Claude Code** | Нативная | `--mcp-config path.json`, `.mcp.json`, `~/.claude.json` | [code.claude.com/docs/en/mcp](https://code.claude.com/docs/en/mcp) |
| **OpenAI Codex** | Нативная | `~/.codex/config.toml`, `codex mcp add` | [developers.openai.com/codex/mcp](https://developers.openai.com/codex/mcp) |
| **Gemini CLI** | Нативная | `~/.gemini/settings.json` | [geminicli.com/docs/tools/mcp-server](https://geminicli.com/docs/tools/mcp-server/) |
| **Goose** | Нативная (MCP — основа расширений) | Built-in, Remote/Stdio/Command | [github.com/block/goose](https://github.com/block/goose) |
| **OpenCode** | Нативная | `opencode.json`, `opencode mcp add` | [opencode.ai/docs/mcp-servers](https://opencode.ai/docs/mcp-servers/) |
| **Kilo Code** | Нативная | `mcp_settings.json`, `.kilocode/mcp.json` | [kilo.ai/docs/automate/mcp/using-in-kilo-code](https://kilo.ai/docs/automate/mcp/using-in-kilo-code) |
| **Aider** | Через адаптеры (mcpm-aider) | MCP-клиент пакеты | [pulsemcp.com/servers/disler-aider](https://www.pulsemcp.com/servers/disler-aider) |

**Вывод: 6 из 7 основных CLI-агентов уже поддерживают MCP нативно.** Им не нужна Mastra как прослойка — они могут подключиться к нашему MCP-серверу напрямую.

---

## 3. Что Mastra добавляет поверх "сырого" MCP

### Реальные преимущества Mastra (и почему они нам НЕ нужны)

| Фича Mastra | Что это | Нужно ли нам? | Почему |
|-------------|---------|---------------|--------|
| **MCPClient** — подключение к нескольким MCP-серверам | Единый клиент для N серверов | Нет | Наш продукт ПРЕДОСТАВЛЯЕТ MCP-сервер, а не потребляет их |
| **MCPServer** — экспорт агентов/инструментов | Expose agents as MCP tools | Нет | У нас уже есть FastMCP сервер с 30+ инструментами |
| **ToolSearchProcessor** — динамический поиск инструментов | Агент ищет нужный инструмент по запросу | Нет | У нас ~30 инструментов, а не сотни. Контекст не проблема |
| **Agent Runtime** — цикл reason-act с memory | Полноценный runtime для API-агентов | Нет | Наши агенты — CLI-процессы (Claude Code, Codex), у них свой runtime |
| **Observability** — MCP_TOOL_CALL spans, Studio UI | Трейсинг MCP-вызовов | Нет | У нас свой UI с timeline, chunks, context tracking |
| **Serverless adapters** — Express/Hono/Koa | Запуск MCP в serverless | Нет | Мы Electron-приложение, не serverless |
| **Multi-registry** — Composio, Smithery | Поиск MCP-серверов в реестрах | Нет | Мы предоставляем один конкретный MCP-сервер |
| **Supervisor pattern** — multi-agent orchestration | Один агент управляет другими | Частично | Но Claude Code Agent Teams УЖЕ делает это нативно через `TeamCreate` + `Agent tool` |
| **600+ моделей** через 40+ провайдеров | Model routing | Нет | CLI-агенты сами решают, какую модель использовать |

### Что Mastra НЕ может

| Задача | Может ли Mastra? | Как мы решаем |
|--------|-------------------|---------------|
| Запустить `claude` CLI как процесс | Нет | `spawnCli()` + stream-json |
| Управлять `codex` CLI как subprocess | Нет | Нужен свой ProvisioningService |
| Парсить stream-json stdout | Нет | `handleStreamJsonMessage()` — наш код |
| Использовать Agent Teams built-in tools | Нет | Claude Code нативно |
| Работать с `~/.claude/teams/` файловой системой | Нет | `agent-teams-controller` |
| Показывать kanban-доску | Нет | Наш Electron UI |

---

## 4. Три подхода: сравнение

### Вариант A: Прямой MCP (наш текущий/рекомендуемый подход)

**Надёжность: 9/10 | Уверенность: 9/10**

```
┌─────────────────────────────┐
│    Electron App (UI)        │
│  ┌───────┐ ┌──────────┐    │
│  │Kanban │ │ Timeline  │    │
│  │Board  │ │ Messages  │    │
│  └───┬───┘ └────┬─────┘    │
│      └──────────┘           │
│           │ IPC             │
├───────────┼─────────────────┤
│    Main Process             │
│  ┌────────────────────┐     │
│  │ TeamProvisioning   │     │
│  │ Service             │     │
│  └─────────┬──────────┘     │
│            │                │
│  ┌─────────┴──────────┐     │
│  │  MCP Server         │ ←── Любой агент подключается сюда
│  │  (agent-teams-mcp)  │     через --mcp-config
│  │  30+ tools          │
│  └─────────────────────┘     │
└─────────────────────────────┘
         │              │
    ┌────┴────┐    ┌────┴────┐
    │ Claude  │    │ Codex / │
    │ Code    │    │ Gemini  │
    │ CLI     │    │ CLI     │
    │ (native)│    │ (via    │
    │         │    │  MCP)   │
    └─────────┘    └─────────┘
```

**Как работает:**
1. Claude Code — нативная интеграция (процесс + stream-json + Agent Teams)
2. Другие агенты (Codex, Gemini, Goose, OpenCode, Kilo) — подключаются к нашему MCP-серверу через свой нативный MCP-клиент
3. Все агенты видят одну kanban-доску, создают задачи, обновляют статусы через MCP tools

**Трудозатраты:** 0 доп. работы для MCP-части (уже работает). 2-3 недели для новых MCP-инструментов (`team_join`, `task_poll_assigned` и др.) + UI для внешних агентов.

**Что даёт:**
- Любой MCP-совместимый агент подключается из коробки
- Zero dependency overhead (никаких `@mastra/*` пакетов)
- Наш MCP-сервер — единственная точка интеграции
- Полная совместимость с Claude Code Agent Teams

**Чего не даёт:**
- Нет встроенного agent-to-agent (A2A) протокола (но он нам и не нужен — у нас inbox-файлы)
- Нет автоматического model routing (но CLI-агенты делают это сами)
- Нет встроенного observability для внешних агентов (но мы видим их действия через MCP-tool calls)

### Вариант B: @mastra/mcp как обёртка нашего MCP-сервера

**Надёжность: 5/10 | Уверенность: 4/10**

```
┌────────────────────────────────┐
│    Electron App (UI)           │
├────────────────────────────────┤
│    Main Process                │
│  ┌────────────────────┐        │
│  │ TeamProvisioning   │        │
│  └─────────┬──────────┘        │
│            │                   │
│  ┌─────────┴────────────────┐  │
│  │ @mastra/mcp MCPServer    │  │ ← Mastra обёртка
│  │  wraps our FastMCP tools │  │
│  └─────────┬────────────────┘  │
│            │                   │
│  ┌─────────┴────────────────┐  │
│  │ @mastra/mcp MCPClient    │  │ ← Mastra клиент
│  │  connects to external    │  │    для внешних серверов
│  │  MCP servers             │  │
│  └──────────────────────────┘  │
└────────────────────────────────┘
```

**Трудозатраты:** 1-2 недели на обёртку + зависимость от `@mastra/core` (~150KB+)

**Что даёт:**
- Typed MCPClient с auto-detect transport (stdio/HTTP/SSE)
- ToolSearchProcessor для динамического tool loading (если у нас будет 100+ инструментов)
- Tracing integration с Langfuse/LangSmith

**Чего не даёт:**
- Ничего, что нельзя получить с прямым MCP
- CLI-агенты всё равно подключаются через свой нативный MCP-клиент, а не через Mastra

**Проблемы:**
- Лишний слой абстракции (FastMCP -> Mastra MCPServer -> MCP protocol -> agent)
- Зависимость от быстро меняющегося фреймворка (Mastra уже менял API agent networks -> supervisors)
- Bundle size increase в Electron (~150KB+ от @mastra/core)
- Нет реальной выгоды: CLI-агенты не используют @mastra/mcp — они используют свои нативные MCP-клиенты

### Вариант C: Mastra как оркестратор (создаёт/управляет агентами программно)

**Надёжность: 3/10 | Уверенность: 3/10**

```
┌────────────────────────────────┐
│    Electron App (UI)           │
├────────────────────────────────┤
│    Main Process                │
│  ┌──────────────────────────┐  │
│  │ Mastra Supervisor Agent  │  │ ← Mastra управляет всем
│  │  model: anthropic/...    │  │
│  │  agents: { worker1, ... }│  │
│  │  tools: { task_create }  │  │
│  └──────────┬───────────────┘  │
│             │                  │
│  ┌──────────┴───────────────┐  │
│  │ Mastra Sub-Agents        │  │ ← API-based, не CLI
│  │  openai/gpt-4o           │  │
│  │  anthropic/claude-sonnet │  │
│  │  google/gemini-2.5-pro   │  │
│  └──────────────────────────┘  │
└────────────────────────────────┘
```

**Трудозатраты:** 8-12 недель

**Что даёт:**
- Полная мультимодельность через API (40+ провайдеров)
- Mastra memory, workflows, evals

**Чего не даёт:**
- Claude Code Agent Teams (нативные инструменты CLI: file editing, terminal, git, session persistence)
- Управление CLI-процессами
- Парсинг JSONL-сессий
- Всё, что делает наш продукт уникальным

**Проблемы:**
- **Полностью ломает наш продукт.** Мы перестаём быть "Claude Agent Teams UI" и становимся "ещё один Mastra-based agent manager"
- Нужно заново реализовать file editing, bash, git tools (тысячи строк battle-tested кода в Claude Code)
- Теряем CLAUDE.md, hooks, settings.json, extended thinking — весь экосистемный Claude Code
- Mastra-агенты — API-based. Они НЕ запускаются как CLI-процессы с своим terminal и git integration

---

## 5. Что насчёт "Skills" — 40+ AI агентов в Mastra?

Это отдельная тема, которая может ввести в заблуждение.

**"Skills" в Mastra — это НЕ готовые агенты.** Это markdown-файлы с инструкциями (CLAUDE.md, AGENTS.md), которые учат внешних AI coding agents (Claude Code, Cursor, Windsurf, Copilot и т.д.) использовать Mastra API. То есть Mastra генерирует `.cursor/rules` или `CLAUDE.md` с документацией по своему SDK.

Список из 40+ "агентов" (AdaL, Amp, Antigravity, Augment, CodeBuddy, Crush, Droid, Goose, Kilo, Kimi CLI, Kiro CLI, Kode и т.д.) — это список IDE/CLI tools, для которых Mastra может сгенерировать instruction files. Это **НЕ** то, что Mastra может программно запускать или управлять.

---

## 6. Экосистема: инструменты для оркестрации CLI-агентов

Для полноты картины — вот что существует в марте 2026 для управления CLI-агентами как процессами (наша задача):

| Инструмент | Что делает | GitHub | Подходит нам? |
|------------|-----------|--------|---------------|
| **CCManager** | Session manager для Claude/Codex/Gemini/OpenCode/Kilo CLI | [kbwo/ccmanager](https://github.com/kbwo/ccmanager) | Нет — TUI, не Electron; нет kanban |
| **MCO** | Neutral orchestration layer для CLI-агентов | [mco-org/mco](https://github.com/mco-org/mco) | Частично — dispatch layer, но без UI |
| **Mozzie** | Desktop tool для параллельной оркестрации | [ProductHunt](https://www.producthunt.com/products/mozzie) | Конкурент |
| **Nexus MCP** | MCP-сервер для вызова CLI-агентов как tools | [glama.ai](https://glama.ai/mcp/servers/j7an/nexus-mcp) | Интересно — позволяет одному агенту вызывать другой через MCP |
| **claude-code-teams-mcp** | Reimplementation Agent Teams как standalone MCP server | [cs50victor/claude-code-teams-mcp](https://github.com/cs50victor/claude-code-teams-mcp) | Валидирует наш подход — MCP как universal integration layer |

**Вывод:** Индустрия движется к MCP как универсальному протоколу, а не к Mastra как универсальному фреймворку. Mastra — для создания API-based агентов. MCP — для интеграции любых агентов с инструментами.

---

## 7. Сводная таблица

| Критерий | Вариант A: Прямой MCP | Вариант B: @mastra/mcp обёртка | Вариант C: Mastra оркестратор |
|----------|----------------------|-------------------------------|------------------------------|
| **Трудозатраты** | 2-3 недели (новые MCP tools) | 3-4 недели | 8-12 недель |
| **Что ломается** | Ничего | Ничего (additive) | Всё |
| **Code reuse** | 100% | 100% | ~20% |
| **Мультипровайдерность** | Любой MCP-совместимый агент | Любой MCP-совместимый агент | 40+ API провайдеров |
| **CLI-агенты** | Нативная поддержка | Нативная поддержка | Не поддерживаются |
| **Bundle size** | +0 KB | +150 KB+ (@mastra/core) | +150 KB+ |
| **Зависимость от Mastra** | Нет | Слабая | Полная |
| **Риск** | Очень низкий | Низкий | Очень высокий |
| **Наш продукт остаётся?** | Да | Да | Нет — становится другим продуктом |
| **Уникальность** | Kanban + Claude Code Teams + MCP | Kanban + Claude Code Teams + MCP | Ещё один Mastra-based agent manager |
| **Надёжность** | 9/10 | 5/10 | 3/10 |
| **Уверенность** | 9/10 | 4/10 | 3/10 |

---

## 8. Финальная рекомендация

### Не используем @mastra/mcp. Используем прямой MCP.

**Причины:**

1. **Mastra решает не нашу проблему.** Mastra — SDK для создания API-based агентов. Наш продукт — менеджер CLI-процессов. Разные домены.

2. **CLI-агенты уже поддерживают MCP нативно.** Claude Code, Codex, Gemini CLI, Goose, OpenCode, Kilo — все могут подключиться к нашему MCP-серверу без Mastra.

3. **@mastra/mcp — лишний слой.** CLI-агенты не используют Mastra MCPClient. Они используют свои нативные MCP-клиенты. Mastra MCPServer просто обернёт наш FastMCP-сервер без добавления ценности.

4. **Наш MCP-сервер уже работает.** 30+ инструментов, battle-tested с Claude Code Agent Teams. Нужно добавить 5-8 новых инструментов для external agents — и готово.

5. **Zero dependency = zero risk.** Mastra меняет API быстро (agent networks -> supervisors за месяцы). Прямой MCP — стабильный стандарт (v1.0+, AAIF/Linux Foundation).

6. **Наше конкурентное преимущество — kanban + Claude Code Agent Teams.** Mastra не усиливает это. Mastra превращает нас в generic agent manager, которых уже десятки.

### Что делать вместо Mastra

Следовать плану из `docs/research/best-integration-approach.md` — **Option 7: Hybrid**:

1. **Phase 1 (неделя 1-2):** Добавить MCP-инструменты для external agents: `team_join`, `team_leave`, `task_poll_assigned`, `task_claim`, `member_register`, `member_heartbeat`
2. **Phase 2 (неделя 2-3):** UI-поддержка внешних агентов: provider badge, external member type
3. **Phase 3 (неделя 3-4):** Notification mechanism (polling, SSE)
4. **Phase 4 (по запросу):** Нативная поддержка второго CLI-агента (Codex) через `AgentRuntime` abstraction

### Когда Mastra МОЖЕТ понадобиться

- Если мы решим создавать **API-based агентов** для задач, не требующих CLI (code review, planning, triage) — Mastra Agent + наш MCP server
- Если мы решим добавить **ToolSearchProcessor** для discovery среди сотен инструментов (сейчас у нас 30+, не актуально)
- Если мы решим экспортировать наши агенты/workflow как **standalone MCP server** для внешних систем (Mastra MCPServer может быть удобнее FastMCP)
- Если Claude Code CLI будет **deprecated** (никаких признаков этого)

Но это всё сценарии "если" на далёкое будущее. Сейчас прямой MCP — правильный и достаточный выбор.

---

## Источники

- [Mastra GitHub Repository (22K+ stars)](https://github.com/mastra-ai/mastra)
- [Mastra MCP Overview](https://mastra.ai/docs/mcp/overview)
- [Mastra Agents Overview](https://mastra.ai/docs/agents/overview)
- [Mastra Agent Networks](https://mastra.ai/docs/agents/networks)
- [@mastra/mcp npm](https://www.npmjs.com/package/@mastra/mcp)
- [Why We're All-In on MCP (Mastra Blog)](https://mastra.ai/blog/mastra-mcp)
- [Mastra 1.0 Announcement (300K+ weekly downloads, 19.4K stars)](https://mastra.ai/blog/announcing-mastra-1)
- [Mastra Changelog 2026-03-12](https://mastra.ai/blog/changelog-2026-03-12)
- [Claude Code MCP Docs](https://code.claude.com/docs/en/mcp)
- [OpenAI Codex MCP](https://developers.openai.com/codex/mcp)
- [Gemini CLI MCP](https://geminicli.com/docs/tools/mcp-server/)
- [Goose — open source AI agent by Block](https://github.com/block/goose)
- [OpenCode MCP](https://opencode.ai/docs/mcp-servers/)
- [Kilo Code MCP](https://kilo.ai/docs/automate/mcp/using-in-kilo-code)
- [Aider MCP Server](https://www.pulsemcp.com/servers/disler-aider)
- [claude-code-teams-mcp (standalone reimplementation)](https://github.com/cs50victor/claude-code-teams-mcp)
- [CCManager (session manager)](https://github.com/kbwo/ccmanager)
- [MCO (multi-agent orchestrator)](https://github.com/mco-org/mco)
- [Nexus MCP (CLI agents as MCP tools)](https://glama.ai/mcp/servers/j7an/nexus-mcp)
- [Mastra ToolSearchProcessor (Feb 2026)](https://mastra.ai/blog/changelog-2026-02-04)
- [Google Official MCP Support Announcement](https://cloud.google.com/blog/products/ai-machine-learning/announcing-official-mcp-support-for-google-services)
- [Agentic AI Foundation (AAIF) — Linux Foundation](https://www.linuxfoundation.org/press/linux-foundation-announces-the-formation-of-the-agentic-ai-foundation)
