# OpenCode Deep Dive — Comprehensive Analysis (March 2026)

## Executive Summary

OpenCode — open-source AI coding agent от Anomaly (ex-SST), ~126K GitHub stars, 800+ контрибьюторов, 5M MAU. Написан на TypeScript (Bun) + Go (TUI), MIT license. Поддерживает 75+ LLM-провайдеров через Models.dev. Архитектура client/server с persistent sessions. Agent Teams — community-implemented (не core), file-based JSONL inbox, peer-to-peer messaging, multi-provider teams (Claude+Codex+Gemini доказано). Главный конкурент Claude Code в terminal-agent пространстве.

**Claim verification:**
- "95K+ stars" — **занижено**, на март 2026 ~126-129K stars
- "75+ providers" — **подтверждено**, через Models.dev + AI SDK
- "Multi-agent team support" — **частично**: agent teams реализованы community (opencode-ensemble plugin + PR #12730-12732), НЕ core feature, но доказали работу Claude+Codex+Gemini вместе

---

## 1. What IS OpenCode?

### Основные факты

| Параметр | Значение |
|----------|----------|
| **Название** | OpenCode |
| **Организация** | Anomaly (ex-SST / Serverless Stack) |
| **GitHub** | [anomalyco/opencode](https://github.com/anomalyco/opencode) |
| **Сайт** | [opencode.ai](https://opencode.ai/) |
| **Stars** | ~126-129K (март 2026) |
| **Contributors** | 800+ |
| **Commits** | 10,000+ |
| **MAU** | 5M+ developers |
| **License** | MIT |
| **Языки** | TypeScript (Bun) — backend, Go — TUI, Zig — OpenTUI core |
| **Дата запуска** | 19 июня 2025 |
| **Версии** | Terminal CLI, Desktop App (beta), IDE extensions |

### Кто создал

**Founders:**
1. **Jay V (CEO)** — задает стратегию, enterprise sales. Университет Waterloo.
2. **Frank Wang (CTO)** — техническая архитектура. Model-agnostic дизайн с нуля. Университет Waterloo.
3. **Dax Raad** — public face, подкасты, Twitter. Ex-Amazon, ex-Ironbay. Присоединился к SST в 2021.
4. **Adam Elmore** — AWS Hero, indie hacker, AWS FM podcast host.

**Происхождение:** Jay и Frank создали Anomaly, затем Serverless Stack (SST) — прошли Y Combinator, привлекли инвестиции от основателей PayPal, LinkedIn, Yelp, YouTube. SST набрал 25K stars, стал прибыльным в 2025. Во время SST команда строила terminal-first UIs и даже запустила Terminal — подписку на кофе через терминал ($100K продаж в первый год).

### Скандальная история: Fork и Split (2025)

- Оригинальный OpenCode создал **Kujtim Hoxha** на Go с Bubble Tea TUI
- **Charm** (компания, создатель Bubble Tea) приобрела проект, наняла Kujtim
- Dax Raad и Adam Doty (из SST) были major contributors, им не понравился ход
- Обвинения: Charm переписал git history, удалил контрибуции, забанил критиков
- **Результат:** Charm переименовал свою версию в **Crush**, а Dax/Adam сохранили бренд OpenCode под SST (anomalyco)
- Fork полностью переписан с Go на **TypeScript + Bun** для использования Vercel AI SDK

### Скандал с Anthropic (январь 2026)

- Ранние версии OpenCode подделывали HTTP-заголовок `claude-code-20250219`, выдавая себя за Claude Code
- 9 января 2026 Anthropic заблокировал сторонние tools от использования Claude OAuth
- 19 февраля 2026 Anthropic обновил Terms of Service, запретив OAuth токены Free/Pro/Max в third-party tools
- OpenCode удалил весь Claude OAuth код в тот же день
- Запустили **OpenCode Zen** (pay-as-you-go gateway) и **OpenCode Black** ($200/мес, enterprise)
- **18,000 новых stars за 2 недели** — controversy привлекла внимание

---

## 2. Поддержка 75+ провайдеров

**Подтверждено.** OpenCode использует [Models.dev](https://models.dev) + Vercel AI SDK для поддержки 75+ LLM-провайдеров.

### Ключевые провайдеры

| Провайдер | Детали |
|-----------|--------|
| OpenAI (GPT, Codex) | API key |
| Anthropic (Claude) | API key (после блокировки OAuth) |
| Google Gemini | API key + Vertex AI |
| AWS Bedrock | IAM credentials |
| Groq | API key |
| Azure OpenAI | Enterprise endpoint |
| OpenRouter | Pre-loaded models |
| Ollama (local) | `opencode --model ollama/qwen2.5-coder:32b` |
| GitHub Copilot | Copilot subscription (Pro+ для некоторых моделей) |
| ChatGPT Plus/Pro | OAuth login |
| Cloudflare AI Gateway | Unified billing, no per-provider keys |
| SAP AI Core | 40+ models, enterprise platform |
| GitLab | Agent Platform (18.8+) |
| Deepseek | API key |
| Local models | Any OpenAI-compatible endpoint |

### Как это работает

```
User → OpenCode → AI SDK → Models.dev → Provider API → LLM Response
```

- Models.dev — реестр моделей с метаданными
- AI SDK (от Vercel) — универсальный SDK для вызова разных провайдеров
- `/connect` команда — добавление credentials
- `/models` команда — список доступных моделей
- Config: можно назначить разные модели для разных agent-ролей (plan vs build)

### Монетизация через провайдеров

| Tier | Цена | Описание |
|------|-------|----------|
| Free | $0 | BYO API key или local models (Ollama) |
| OpenCode Zen | Pay-per-token | Curated gateway, pass-through pricing |
| OpenCode Black | $200/мес | Enterprise, multi-provider (sold out) |

---

## 3. Agent Teams: Multi-Agent Support

### Статус: Community-Implemented, NOT Core Feature

Важное уточнение: Agent Teams в OpenCode — это **community contribution**, а не встроенная core-фича (в отличие от Claude Code).

- **GitHub Issue [#12661](https://github.com/anomalyco/opencode/issues/12661)** — Feature request для native agent teams
- **PRs #12730-12732** (dev branch) — community implementation (core, tools & routes, TUI)
- **[opencode-ensemble](https://github.com/hueyexe/opencode-ensemble)** — SDK plugin для agent teams
- **[opencode-workspace](https://github.com/kdcokenny/opencode-workspace)** — multi-agent orchestration harness

### Архитектура Agent Teams (community implementation)

#### Messaging: Two-Layer System

```
Layer 1: Inbox (Source of Truth)
  team_inbox/<projectId>/<teamName>/<agentName>.jsonl
  Каждая строка: { id, from, text, timestamp, read }

Layer 2: Session Injection (Delivery)
  Message → injected as synthetic user message → LLM видит и обрабатывает
```

**Ключевые отличия от Claude Code:**

| Аспект | Claude Code | OpenCode |
|--------|-------------|----------|
| Storage | JSON array (O(N) writes) | JSONL append-only (O(1)) |
| Messaging | Polling JSON files | Event-driven auto-wake |
| Communication | Leader-centric routing | Full mesh peer-to-peer |
| Multi-model | Single provider only | Multiple providers per team |
| Process model | 3 backends (in-process, tmux, iTerm2) | Single process |
| State tracking | Implicit | Two-level state machines |

#### State Machines (Dual)

**Member Status (5 states):** `ready` → `busy` → `shutdown_requested` → `shutdown` (terminal), `error`
- Guards: `guard: true` (prevents race conditions), `force: true` (crash recovery)

**Execution Status (10 states):** Fine-grained prompt loop position tracking

#### Peer-to-Peer Messaging

Любой teammate может отправить сообщение любому другому по имени — не только через lead. Lead фокусируется на orchestration, а не routing.

#### Sub-Agent Isolation

Team tools (`team_create`, `team_spawn`, `team_message`) запрещены для sub-agents через deny rules + tool visibility hiding. Sub-agents — одноразовые workers, их output не должен попадать в coordination channel.

### Доказано: Claude + Codex + Gemini в одной команде

**Тест 1: Architecture Drama (3 провайдера)**
- GPT-5.3 Codex + Gemini 2.5 Pro + Claude Sonnet 4
- Координация через один message bus
- Claiming tasks из shared list
- "Arguing about architecture" через peer-to-peer messaging

**Тест 2: Super Bowl Prediction (4 Claude Opus)**
- Stats analyst + Betting analyst + Matchup analyst + Injury scout
- Full-mesh topology
- Atomic task claiming под concurrent access

**Тест 3: NFL Research (2 Gemini)**
- Обнаружена проблема: Gemini генерировал ~50 одинаковых "task complete" сообщений в цикле

### Ограничения

- Agent teams пока на dev branch, не в stable release
- Нет multi-caller support в core — субагент не знает, кто с ним говорит (кроме Parent)
- Gemini имеет проблемы с message loop
- Recovery при crash: нет auto-restart, user должен re-engage teammates

---

## 4. Architecture Deep Dive

### Двухъязычная система

```
┌──────────────────────────────────────────────┐
│              User runs `opencode`             │
│         (single Bun-compiled binary)          │
└──────────────────┬───────────────────────────┘
                   │
          ┌────────▼─────────┐
          │   Bun Process     │
          │   (TypeScript)    │──── HTTP Server (API + SSE events)
          │   - LLM calls     │              ▲
          │   - Tool exec     │              │ OpenAPI SDK
          │   - Sessions      │              │ (auto-generated by Stainless)
          │   - LSP client    │         ┌────┴──────┐
          │   - Plugin system │         │  Go TUI    │
          │   - MCP client    │         │  (Client)  │
          └──────────────────┘         └────────────┘
                                            │
                                    (Migrating to OpenTUI:
                                     Zig core + React/Solid/Vue)
```

### Backend (TypeScript + Bun)

- **Runtime:** Bun (fast JavaScript runtime)
- **Build:** `bun build .. --compile` — single executable
- **HTTP Server:** API + SSE events для real-time updates
- **Storage:** SQLite для persistent data
- **LLM Communication:** Через Vercel AI SDK
- **Tool Execution:** LLM решает когда вызвать tool, SDK вызывает `execute` функцию
- **LSP Integration:** Отправляет `textDocument/didChange`, получает diagnostics, кормит LLM
- **40+ event types:** Через GlobalBus, доставка через SSE

### Frontend (Go TUI → OpenTUI)

- **Текущий:** Go с Bubble Tea framework
- **Мигрирует на:** [OpenTUI](https://github.com/anomalyco/opentui) — Zig core + TypeScript bindings
- **OpenTUI:** React/SolidJS/Vue reconcilers, Bun exclusive (Node/Deno в процессе)
- **Persistent sessions:** Сервер в background, TUI реконнектится после disconnect/sleep

### Client-Server Protocol

- **OpenAPI spec** → auto-generated SDK через Stainless
- **3 official SDKs:** TypeScript, Go, Python
- **SSE** для real-time events (40+ event types)
- **Zero dependencies** в SDK

### Desktop App

- Beta на macOS, Windows, Linux
- Также есть community [OpenGUI](https://dev.to/akemmanuel/i-built-a-native-desktop-gui-for-opencode-in-4-days-with-ai-p44) — Electron + React

### IDE Extensions

VS Code, Cursor, Zed, Windsurf, VSCodium + GitHub и GitLab integrations.

---

## 5. Built-in Tools

| Tool | Описание |
|------|----------|
| Shell | Выполнение bash команд |
| Edit | Exact string replacement в файлах |
| Write | Создание/перезапись файлов |
| Read | Чтение файлов |
| Grep | Regex поиск по codebase |
| LSP | Code intelligence: definitions, references, hover, call hierarchy |

### Agents

| Agent | Доступ | Назначение |
|-------|--------|------------|
| **Build** (default) | Full access | Development work |
| **Plan** | Read-only | Analysis, planning |
| **Review** | Read-only + docs | Code review |
| **Debug** | Bash + Read | Investigation |
| **Docs** | File ops, no shell | Documentation |
| **@general** | Subagent | Complex search/multistep |

---

## 6. MCP Support

**Полная поддержка MCP как client.** Feature request для MCP server mode ([#3306](https://github.com/sst/opencode/issues/3306)).

### Типы MCP серверов

1. **Local MCP Servers** — stdio-based communication, запускаются как local processes
2. **Remote MCP Servers** — HTTP + OAuth 2.0 (Dynamic Client Registration RFC 7591)

### Конфигурация

```json
// opencode.json
{
  "mcp": {
    "sentry": {
      "command": "npx",
      "args": ["@sentry/mcp-server"],
      "env": { "SENTRY_AUTH_TOKEN": "{env:SENTRY_TOKEN}" }
    }
  }
}
```

- Поддержка `{env:VAR}` и `{file:path}` для секретов
- `enabled: false` для временного отключения
- Auto-OAuth flow для remote servers
- Tools автоматически доступны LLM наряду с built-in tools

### Предупреждение о Context

MCP tools добавляют контекст. GitHub MCP server, например, может быстро превысить context limit. Рекомендуется осторожность при выборе MCP серверов.

---

## 7. Plugin System & Extensibility

### Plugin Sources

1. **Directory plugins:** `.opencode/plugins/` (project) или `~/.config/opencode/plugins/` (global)
2. **NPM packages:** в opencode.json, auto-install через Bun

### Hook Types

| Hook | Описание |
|------|----------|
| `tool.execute.before/after` | Перехват tool calls |
| `session.created/updated` | Session lifecycle |
| `message.*` | Message events |
| `event` | System events (`session.idle`, `session.created`, etc.) |
| `experimental.session.compacting` | Inject context before compaction |
| `chat.message` | Modify messages before LLM |

### Custom Tools

Plugin tools можно определить — они доступны LLM наряду с built-in tools. Если имя совпадает с built-in, plugin tool имеет приоритет.

### Notable Community Plugins

- **EnvSitter** — блокирует чтение `.env*` файлов
- **Agent Ensemble** — agent teams orchestration
- **Persistent Memory** — self-editable memory blocks (как Letta)
- **Annotation UI** — перехватывает plan mode, открывает browser UI
- **Worktree Isolation** — git worktree per agent

---

## 8. What Can We Learn From It?

### Архитектурные идеи для Claude Agent Teams UI

1. **Client/Server разделение** — persistent sessions, reconnect после disconnect. Наш Electron-подход можно дополнить server mode для remote access.

2. **JSONL append-only inbox** — O(1) writes vs O(N) JSON array. **Мы уже используем JSONL для session files**, но team inbox в Claude Code — JSON array. Можно предложить Anthropic JSONL формат.

3. **Event-driven vs Polling** — OpenCode использует SSE + event bus вместо file polling. Мы используем file watching с debounce (100ms). Event-driven подход быстрее и чище.

4. **Peer-to-Peer messaging** — в Claude Code все идет через lead. OpenCode показывает, что full-mesh topology работает. **Мы уже отключили relay для teammate DMs** (см. CLAUDE.md), что близко к peer-to-peer.

5. **Two-level state machines** — member status (coarse) + execution status (fine). Может улучшить наш UI для отображения состояния agents.

6. **Plugin system** — hooks для tool.execute, session events, compaction. Потенциал для нашего MCP integration.

7. **Multi-provider teams** — самая уникальная фича. Claude Code не может этого. Для нашего UI это не актуально (мы визуализируем Claude Code teams), но показывает направление рынка.

8. **Auto-wake** — когда teammate отправляет сообщение idle agent'у, он автоматически "просыпается". В Claude Code нужен manual re-engage.

---

## 9. Competitor or Integration Partner?

### Как конкурент нашему продукту

| Аспект | OpenCode | Claude Agent Teams UI (мы) |
|--------|----------|---------------------------|
| **Что это** | Coding agent | UI для управления agent teams |
| **Kanban** | Нет (только community: opencode-kanban, VibeKanban) | Встроенный kanban board |
| **Code Review** | Нет diff view в TUI | Diff view per task |
| **Team Management** | CLI-based, нет visual management | Visual kanban + real-time status |
| **Notifications** | Нет | Встроенные уведомления |
| **Session Analysis** | Базовый | Deep analysis (bash, reasoning, subagents) |
| **Context Monitoring** | Нет | Token usage по категориям |
| **Direct Messaging** | Через CLI | Visual DM interface |

**Вывод: OpenCode — НЕ прямой конкурент.** Они coding agent, мы — UI для управления agent teams. OpenCode больше конкурирует с Claude Code CLI, а не с нашим UI.

### Как потенциальный integration partner

OpenCode имеет **полноценный SDK** (TypeScript, Go, Python) и **SSE events**. Теоретически мы могли бы:

1. **Добавить OpenCode backend** — управлять OpenCode sessions через их SDK вместо/параллельно Claude Code
2. **Визуализировать OpenCode teams** — их agent teams используют JSONL inbox, мы могли бы парсить
3. **Multi-agent kanban** — один kanban для Claude Code + OpenCode agents
4. **Cross-provider orchestration** — использовать наш UI для управления mixed teams (Claude через Claude Code, GPT/Gemini через OpenCode)

**Риски интеграции:**
- OpenCode agent teams — community feature, не stable API
- Совершенно другая архитектура (HTTP SDK vs CLI process management)
- Потребуется значительная работа по адаптации

---

## 10. Unique Features vs Claude Code

| Feature | OpenCode | Claude Code |
|---------|----------|-------------|
| **Model freedom** | 75+ providers, local models | Only Anthropic |
| **Open source** | MIT license, full source | Closed source |
| **Desktop app** | Beta (macOS/Win/Linux) | Нет |
| **IDE extensions** | VS Code, Cursor, Zed, Windsurf | Нет (только CLI) |
| **Plugin system** | Hooks, custom tools, npm plugins | Hooks (bash-based) |
| **Persistent sessions** | Client/server, reconnect | Нет |
| **Agent types** | Build/Plan/Review/Debug/Docs + custom | One agent + subagents |
| **SDK** | TypeScript/Go/Python, OpenAPI spec | Нет public SDK |
| **LSP integration** | Built-in, feeds diagnostics to LLM | Нет |
| **Agent Teams** | Community (multi-provider!) | Native (single provider) |
| **Context compaction** | Supports plugin hook | Automatic |
| **Pricing** | Free + BYO API key | $20/mo Claude Pro minimum |
| **Accuracy** | Varies by model | SWE-bench Pro 57.5% |
| **Adoption** | 5M MAU, 126K stars | 4% of GitHub commits, 135K/day |

### Что уникально у OpenCode

1. **Model agnosticism** — designed from day one, не afterthought
2. **Client/server architecture** — sessions persist, remote control possible
3. **Multi-provider agent teams** — Claude+Codex+Gemini в одной команде
4. **Plugin ecosystem** — rich hook system, npm packages, custom tools
5. **3 official SDKs** — TypeScript, Go, Python
6. **OpenTUI** — собственный TUI framework на Zig

### Что уникально у Claude Code (и у нас)

1. **Native agent teams** — core feature, не community plugin
2. **SWE-bench accuracy** — лучшие результаты на бенчмарках
3. **4% GitHub commits** — доминирует в реальном использовании
4. **Stream-json protocol** — надежный IPC для agent coordination
5. **Kanban board** (наш UI) — НИКТО не имеет визуального kanban для agent teams

---

## Summary & Key Takeaways

### Факты (verified)

- OpenCode — реальный и крупный проект: ~126-129K stars, 800+ contributors, 5M MAU
- 75+ providers — подтверждено через Models.dev + AI SDK
- MIT license — подтверждено
- Agent teams с multi-provider — доказано (community implementation)
- TypeScript (Bun) + Go + Zig architecture — подтверждено
- MCP client support — полноценный
- Desktop app + IDE extensions — beta, но работает
- Plugin system — rich, с hooks и custom tools

### Риски и concerns

- Agent teams — community feature, не stable, на dev branch
- Скандал с Anthropic OAuth — показывает этические вопросы
- Fork controversy — community split может повлиять на долгосрочную стабильность
- Gemini message loop bug — multi-provider teams нестабильны
- OpenCode Black ($200/мес) sold out — бизнес-модель не ясна

### Relevance для нашего продукта

- **Прямая конкуренция: НЕТ** — мы UI для team management, они coding agent
- **Косвенная конкуренция: ДА** — community tools (opencode-kanban, VibeKanban) пытаются решить ту же проблему
- **Потенциал интеграции: СРЕДНИЙ** — SDK доступен, но архитектура сильно отличается
- **Наше преимущество сохраняется:** Kanban board для agent teams нет НИ У КОГО, включая OpenCode

---

## Sources

- [anomalyco/opencode (GitHub)](https://github.com/anomalyco/opencode)
- [opencode.ai](https://opencode.ai/)
- [OpenCode Docs](https://opencode.ai/docs/)
- [Building Agent Teams in OpenCode (DEV Community)](https://dev.to/uenyioha/porting-claude-codes-agent-teams-to-opencode-4hol)
- [How OpenCode went from zero to titan (Dev Genius)](https://blog.devgenius.io/how-opencode-went-from-zero-to-titan-in-eight-months-dcdcd8ff5572)
- [OpenCode background story (TFN)](https://techfundingnews.com/opencode-the-background-story-on-the-most-popular-open-source-coding-agent-in-the-world/)
- [How Coding Agents Actually Work: Inside OpenCode](https://cefboud.com/posts/coding-agents-internals-opencode-deepdive/)
- [OpenCode vs Claude Code (MorphLLM)](https://www.morphllm.com/comparisons/opencode-vs-claude-code)
- [OpenCode vs Claude Code (DataCamp)](https://www.datacamp.com/blog/opencode-vs-claude-code)
- [OpenCode vs Anthropic Legal Controversy](https://www.shareuhack.com/en/posts/opencode-anthropic-legal-controversy-2026)
- [OpenCode MCP Servers docs](https://opencode.ai/docs/mcp-servers/)
- [OpenCode Plugins docs](https://opencode.ai/docs/plugins/)
- [OpenCode Agents docs](https://opencode.ai/docs/agents/)
- [OpenCode Models docs](https://opencode.ai/docs/models/)
- [OpenCode Providers docs](https://opencode.ai/docs/providers/)
- [OpenTUI (GitHub)](https://github.com/anomalyco/opentui)
- [opencode-ensemble (GitHub)](https://github.com/hueyexe/opencode-ensemble)
- [opencode-kanban (GitHub)](https://github.com/qrafty-ai/opencode-kanban)
- [Vibe Kanban](https://vibekanban.com/)
- [awesome-opencode (GitHub)](https://github.com/awesome-opencode/awesome-opencode)
