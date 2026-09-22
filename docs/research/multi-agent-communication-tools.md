# Multi-Agent CLI Orchestrators with Inter-Agent Communication

> Research date: 2026-03-25
> Focus: tools where Agent A (Claude) can send a message to Agent B (Codex/Gemini), NOT just "fan-out same task to multiple agents"

## TL;DR

Ни один инструмент не является зрелым "фундаментом" для замены нашего стека. Все проекты в этом пространстве молоды (< 6 месяцев), быстро меняют API, и ни один не имеет production-grade inter-agent communication для РАЗНЫХ провайдеров CLI-агентов уровня, который мы уже реализовали для Claude Code Agent Teams.

**Лидеры по inter-agent communication:**

| Tool | Stars | Inter-Agent Msg | Multi-Provider | Kanban | Наша оценка |
|------|-------|----------------|----------------|--------|------------|
| Ruflo | 25,709 | SQLite + JSON | Claude + Codex | Нет | Hype-driven, раздутые цифры |
| Composio AO | 5,390 | CI feedback routing | Claude, Codex, Aider | Нет | Planner-executor, не P2P |
| Claude Octopus | 2,069 | Consensus gate 75% | 8 providers | Нет | Plugin, не orchestrator |
| mcp_agent_mail | 1,842 | MCP + SQLite inbox | Any MCP client | Нет | Протокол, не UI |
| claude_code_bridge | 1,855 | Real-time collab | Claude, Codex, Gemini | Нет | Terminal split-pane |
| Overstory | 1,123 | SQLite mail (WAL) | 11 runtimes | Нет | Closest to real P2P |
| agtx | 693 | Session switching | Claude, Codex, Gemini, OpenCode, Cursor | Kanban-like | Autonomous, но молодой |
| AI Maestro | 556 | AMP protocol | Claude, Codex, any | Kanban! | Multi-machine, но TypeScript mesh |
| parallel-code | 407 | Нет (изоляция) | Claude, Codex, Gemini | Diff viewer | Параллельное, не collaborative |
| CAO (AWS) | 344 | SQLite inbox + MCP | Q CLI, Claude, Codex | Нет | AWS-backed, но ранняя стадия |
| MCO | 249 | Fan-out, не P2P | 5 CLIs | Нет | Dispatch layer, не messaging |
| hcom | 164 | File-based hooks | Claude, Codex, Gemini, OpenCode | Нет | Lightweight, hooks-only |
| MetaSwarm | 148 | Skills-based | Claude, Gemini, Codex | Нет | Self-improving framework |
| CAS | 69 | Через MCP server | Claude Code only | Нет | Claude-only, раннее |
| kodo | 46 | Verification cycle | Claude, Codex, Gemini | Нет | SWE-bench verified |

---

## 1. CAS (Coding Agent System)

- **Repo:** https://github.com/codingagentsystem/cas
- **Stars:** 69
- **Language:** Rust
- **License:** MIT
- **Created:** 2026-01-05

### Что это
Supervisor + Workers модель для Claude Code. Factory mode оркестрирует несколько Claude Code инстансов в параллельных git worktree. MCP server дает агентам persistent memory, task tracking, rules, skills через SQLite + FTS.

### Inter-Agent Communication
- Нет прямого inter-agent messaging между агентами
- Communication идет через supervisor (hub-and-spoke)
- Workers не общаются друг с другом напрямую
- Coordinator раздает задачи, workers возвращают результаты

### Multi-Provider Support
- **ТОЛЬКО Claude Code** — нет поддержки Codex, Gemini, Goose и др.

### Вердикт
Не подходит как фундамент. Claude-only, маленькое коммьюнити (69 stars), нет inter-agent messaging, нет multi-provider. Persistent memory через MCP server — интересная идея, но не уникальная.

---

## 2. AWS CLI Agent Orchestrator (CAO)

- **Repo:** https://github.com/awslabs/cli-agent-orchestrator
- **Stars:** 344
- **Language:** Python
- **License:** Apache 2.0 (AWS)
- **Created:** 2025-07-29

### Что это
Иерархическая система оркестрации CLI AI агентов от AWS Labs. Три паттерна: Handoff (синхронный transfer), Assign (async spawn), Send Message (прямая коммуникация).

### Inter-Agent Communication
- **Send Message** — прямые сообщения между существующими агентами
- **SQLite inbox system** — асинхронная доставка сообщений с FIFO ordering
- **File-watching** — определяет когда terminal idle и доставляет pending messages
- **MCP tools** — `handoff`, `assign`, `send_message` для координации
- **REST API** — cao-server на `localhost:9889`

### Multi-Provider Support
- Amazon Q CLI, Claude Code, Codex CLI (через провайдер с API key)
- Каждый агент в изолированной tmux сессии

### Что хорошо
- AWS-backed = стабильная поддержка
- Реальный inter-agent messaging через SQLite inbox
- Profile-based agent isolation
- Cron-like scheduled runs

### Что плохо
- 344 stars — ранняя стадия
- Зависимость на tmux
- Python-based (не наш стек)
- Нет UI/dashboard

### Вердикт
Наиболее продуманный подход к inter-agent messaging через SQLite inbox. Но ранняя стадия, нет UI, Python-only. Send Message паттерн — это то, что нам нужно, но реализация привязана к tmux sessions.

---

## 3. Overstory

- **Repo:** https://github.com/jayminwest/overstory
- **Stars:** 1,123
- **Language:** TypeScript (Bun)
- **License:** MIT
- **Created:** 2026-02-12

### Что это
Превращает coding session в multi-agent team. Workers в git worktree через tmux. SQLite mail system для координации. FIFO merge queue с 4-tier conflict resolution.

### Inter-Agent Communication
- **SQLite mail system** (WAL mode, ~1-5ms/query) — ключевая фича
- **8 typed protocol messages:** `worker_done`, `merge_ready`, `merged`, `merge_failed`, `escalation`, `health_check`, `dispatch`, `assign`
- **Type-safe API:** `sendProtocol<T>()` и `parsePayload<T>()`
- **Broadcast:** группы `@all`, `@builders` и др.
- **`overstory mail`** CLI: send/check/list/read/reply

### Multi-Provider Support
- **11 runtime adapters:** Claude Code, Pi, Gemini CLI, Aider, Goose, Amp и др.
- Pluggable `AgentRuntime` interface

### Что хорошо
- Самый развитый SQLite mail system среди всех инструментов
- Type-safe protocol messages — близко к нашему подходу с inbox files
- 11 runtime adapters — реальная мультипровайдерность
- TypeScript/Bun — совместимый стек

### Что плохо
- Зависимость на tmux + Bun (не Node/Electron)
- "Compounding error rates, cost amplification, debugging complexity" — сами предупреждают
- Нет UI — всё CLI
- 1,123 stars за 1.5 месяца — быстрый рост, но незрелый

### Вердикт
Ближайший по архитектуре к нашему подходу (SQLite mail ~ наш inbox system). Протокольные сообщения с типами, broadcast — всё это у нас уже есть. Мог бы быть полезен как reference для protocol design, но не как фундамент.

---

## 4. Composio Agent Orchestrator

- **Repo:** https://github.com/ComposioHQ/agent-orchestrator
- **Stars:** 5,390
- **Language:** TypeScript
- **License:** MIT
- **Created:** 2026-02-13

### Что это
Planner-Executor модель для fleet of parallel coding agents. Orchestrator — сам AI agent который читает codebase, decompose features, мониторит progress. Plugin system с 8 swappable slots.

### Inter-Agent Communication
- **НЕ peer-to-peer messaging** — orchestrator agent роутит feedback
- CI failures → injection back в agent session
- Review comments → routing в правильный agent с контекстом
- Self-improvement loop: logs → retrospectives → adjustments

### Multi-Provider Support
- Claude Code, Codex, Aider
- Runtime-agnostic: tmux, Docker
- Tracker-agnostic: GitHub, Linear

### Что хорошо
- 5,390 stars — самый популярный в категории
- TypeScript — наш стек
- Self-improvement system — уникальная фича
- Plugin architecture — гибко

### Что плохо
- Нет P2P inter-agent messaging — всё через orchestrator
- Agent A не может напрямую послать сообщение Agent B
- Orchestrator = single point of failure
- 1.5 месяца от creation — очень молодой

### Вердикт
Самый popular, но inter-agent communication = feedback routing через orchestrator, а не direct messaging. Это принципиально другой паттерн, чем наш. Полезен как reference для planner-executor, но не для P2P communication.

---

## 5. hcom (Hook-Comms)

- **Repo:** https://github.com/aannoo/hcom
- **Stars:** 164
- **Language:** Rust
- **Created:** 2025-07-21

### Что это
Lightweight CLI для inter-agent messaging через hooks. Agents могут message, watch, spawn друг друга across terminals.

### Inter-Agent Communication
- **`send`** — отправка сообщений между agents
- **`listen`** — блокирующее ожидание с фильтрами (agent, type, status, sender, intent)
- **`events`** — event stream с подписками
- **`bundle`** — structured context packages для handoffs
- **`transcript`** — чтение conversation другого агента
- **TUI dashboard** для мониторинга

### Multi-Provider Support
- Claude Code, Gemini CLI, Codex, OpenCode
- Hooks integration для Gemini CLI

### Что хорошо
- Минимальный, специализированный tool для inter-agent messaging
- Работает с любым CLI agent через hooks
- `listen` с фильтрами — мощный примитив

### Что плохо
- 164 stars — маленькое коммьюнити
- Rust — другой стек
- Нет task management, нет orchestration — только messaging
- Зависимость на hooks mechanism

### Вердикт
Интересный lightweight подход к messaging, но это only messaging layer без orchestration. Можно изучить как reference для protocol design, но не как фундамент.

---

## 6. AI Maestro

- **Repo:** https://github.com/23blocks-OS/ai-maestro
- **Stars:** 556
- **Language:** TypeScript
- **License:** MIT
- **Created:** 2025-10-10

### Что это
Dashboard для управления агентами across multiple machines. Agent Messaging Protocol (AMP). Skills system. Code Graph. Memory.

### Inter-Agent Communication
- **Agent Messaging Protocol (AMP)** — email-like communication
  - Priority levels, message types, cryptographic signatures, push notifications
  - Отдельный open-source протокол: https://github.com/agentmessaging/protocol
- **Peer mesh network** — multi-machine без central server
- **External gateways:** Slack, Discord, Email, WhatsApp

### Multi-Provider Support
- Claude Code, Aider, Cursor, Copilot, OpenCode, Codex CLI, Gemini CLI
- 30+ compatible agents через Skills

### Kanban Board
- **ДА!** Полный Kanban с drag-and-drop, dependencies, 5 status columns
- Teams + War Rooms

### Что хорошо
- **Kanban board** — единственный конкурент с Kanban!
- AMP protocol — formalized inter-agent messaging
- Multi-machine support — уникально
- TypeScript — наш стек
- External messaging gateways

### Что плохо
- 556 stars — умеренная популярность
- AMP protocol ещё развивается
- tmux dependency
- "80+ agents across multiple computers" — выглядит как over-engineering

### Вердикт
**Самый близкий конкурент** по feature set: Kanban + inter-agent messaging + multi-provider + TypeScript. AMP protocol — интересный formalized подход. Стоит внимательно изучить. Однако peer mesh network и multi-machine — это другой масштаб, чем наш local-first подход.

---

## 7. ORCH

- **Website:** https://www.orch.one/
- **Stars:** N/A (repo не найден / приватный на момент исследования)
- **License:** MIT

### Что это
CLI runtime для управления Claude Code, Codex, Cursor как typed agent teams. State machine, event bus, TUI.

### Inter-Agent Communication
- **Typed event bus** — 31 event type, agents emit events, orchestrator reacts
- **Inter-agent messaging** — direct messages, broadcasts, injected в prompts
- **Agent Teams** — group agents under lead, broadcast context
- **State machine:** todo -> in_progress -> review -> done

### Multi-Provider Support
- 5 adapters: Claude, OpenCode (Gemini, DeepSeek via OpenRouter), Codex, Cursor, Shell

### Что хорошо
- Event bus architecture — decoupled communication
- State machine — production-quality
- 5 adapters из коробки
- Headless daemon mode (`orch serve`)

### Что плохо
- GitHub repo не найден или приватный — нельзя оценить реальный код
- Event bus = centralized, не P2P
- Нет UI кроме TUI

### Вердикт
Архитектурно интересный (event bus + state machine), но невозможно оценить зрелость кода без доступа к repo. Event bus — это скорее pub/sub, чем direct messaging.

---

## 8. Ruflo

- **Repo:** https://github.com/ruvnet/ruflo
- **Stars:** 25,709
- **Language:** TypeScript
- **License:** MIT
- **Created:** 2025-06-02

### Что это
"The leading agent orchestration platform for Claude." Multi-agent swarms, autonomous workflows, RAG integration. Ранее Claude-Flow.

### Inter-Agent Communication
- SQLite для memory persistence
- JSON-based coordination protocols для inter-agent messaging
- Compaction lifecycle → archive context to SQLite

### Multi-Provider Support
- Claude Code + Codex integration

### Что хорошо
- 25K stars — самый популярный в нише
- Comprehensive feature set

### Что плохо
- 25K stars за < 10 месяцев — подозрительно (возможен бот-boost)
- "v3 introduces self-learning neural capabilities" — marketing buzzwords
- Сравнения с конкурентами в README — red flag
- Claude-centric, minimal real multi-provider

### Вердикт
Hype-driven проект с подозрительно высокими stars. Inter-agent communication через SQLite + JSON — базовый уровень. Не стоит использовать как фундамент из-за quality concerns.

---

## 9. MCO (Multi-CLI Orchestrator)

- **Repo:** https://github.com/mco-org/mco
- **Stars:** 249
- **Language:** Python
- **Created:** 2026-02-26

### Что это
Neutral dispatch layer. Отправляет prompts на несколько CLI agents параллельно, агрегирует результаты.

### Inter-Agent Communication
- **НЕТ real inter-agent messaging**
- Fan-out same prompt → collect results → aggregate
- Structured code review с findings schema

### Multi-Provider Support
- Claude Code, Codex CLI, Gemini CLI, OpenCode, Qwen Code

### Вердикт
Dispatch/aggregation, не collaboration. Agent A не знает о Agent B. Полезен для multi-perspective review, но это не inter-agent communication.

---

## 10. mcp_agent_mail

- **Repo:** https://github.com/Dicklesworthstone/mcp_agent_mail
- **Stars:** 1,842
- **Language:** Python
- **Created:** 2025-10-23

### Что это
Mail-like coordination layer для coding agents. FastMCP server + Git + SQLite.

### Inter-Agent Communication
- **Inbox/outbox** per agent
- **Searchable message history**
- **File lease system** — voluntary file reservation
- **Memorable identities** для agents
- HTTP-only FastMCP server

### Multi-Provider Support
- Any MCP-compatible client

### Что хорошо
- 1,842 stars — солидное коммьюнити
- Clean abstraction: mail metaphor для agent communication
- File leases — unique feature для conflict prevention

### Что плохо
- Python + FastMCP — другой стек
- Только communication layer, не orchestrator
- Нет task management, нет UI

### Вердикт
Лучший standalone inter-agent communication protocol. File leases — интересная идея для нас. Но это protocol library, не ready-to-use tool.

---

## 11. agtx

- **Repo:** https://github.com/fynnfluegge/agtx
- **Stars:** 693
- **Language:** Rust
- **Created:** 2026-02-08

### Что это
Multi-session AI coding terminal manager. Autonomous orchestration с spec-driven workflow.

### Inter-Agent Communication
- Session switching с context awareness
- Gemini -> research | Claude -> implement | Codex -> review
- Kanban board в TUI

### Multi-Provider Support
- Claude, Codex, Gemini, OpenCode, Cursor

### Вердикт
Autonomous orchestration с role-based agent dispatch. Kanban-like TUI. Но Rust стек и нет rich inter-agent messaging.

---

## 12. claude_code_bridge (ccb)

- **Repo:** https://github.com/bfly123/claude_code_bridge
- **Stars:** 1,855
- **Language:** Python
- **Created:** 2025-10-25

### Что это
Real-time multi-AI collaboration. Split-pane terminal. Persistent context.

### Inter-Agent Communication
- Real-time collaboration между Claude, Codex, Gemini
- Persistent context sharing
- WYSIWYG split-pane terminal

### Вердикт
Terminal-based collaboration, не programmatic API. Интересен как UX reference, но не как foundation.

---

## 13. Claude Octopus

- **Repo:** https://github.com/nyldn/claude-octopus
- **Stars:** 2,069
- **Language:** Shell
- **Created:** 2026-01-15

### Что это
Multi-LLM orchestration plugin для Claude Code. 8 providers, consensus gates.

### Inter-Agent Communication
- 75% consensus gate — providers должны согласиться
- Parallel (research), sequential (problem scoping), adversarial (review) modes

### Multi-Provider Support
- Codex, Gemini, Claude, Perplexity, OpenRouter, Copilot, Qwen, Ollama

### Вердикт
Plugin для Claude Code, не standalone orchestrator. Consensus mechanism — интересно, но это не direct messaging.

---

## Сравнительная таблица: типы Inter-Agent Communication

| Pattern | Tools | Описание |
|---------|-------|----------|
| **SQLite Inbox/Mail** | CAO, Overstory, mcp_agent_mail | Асинхронная доставка через SQLite, FIFO, typed messages |
| **Event Bus** | ORCH | Typed events, pub/sub, decoupled |
| **AMP Protocol** | AI Maestro | Email-like, priorities, crypto signatures, mesh network |
| **Hooks/File-based** | hcom | File watches + hooks для inter-terminal messaging |
| **Orchestrator Routing** | Composio AO | Central agent роутит feedback, не P2P |
| **Fan-out/Aggregate** | MCO, Claude Octopus | Dispatch same task, collect results — не communication |
| **Session Switching** | agtx, ccb | Context handoff между sessions — implicit communication |

---

## Ключевые выводы

### 1. Kanban есть ТОЛЬКО у AI Maestro
Из всех исследованных инструментов, только AI Maestro (556 stars) имеет полноценный Kanban board с drag-and-drop. Это подтверждает нашу уникальность. Также agtx имеет kanban-like TUI, но без GUI.

### 2. Реальный P2P inter-agent messaging — редкость
Большинство инструментов используют hub-and-spoke (orchestrator в центре). Реальный P2P:
- **Overstory** — SQLite mail с typed protocol
- **CAO** — SQLite inbox + Send Message
- **AI Maestro** — AMP protocol + mesh
- **hcom** — hooks-based messaging
- **mcp_agent_mail** — MCP inbox/outbox

### 3. Ни один инструмент не является зрелым фундаментом
- Все проекты < 6 месяцев (кроме Ruflo и CAO)
- API быстро меняются
- Большинство зависят на tmux
- Нет production-grade error handling

### 4. Наш подход (Claude Code Agent Teams + Electron UI) остается уникальным
- **Inbox-based messaging** через файлы — мы уже реализовали
- **Kanban board** — мы единственные с полноценным GUI
- **Electron app** — никто больше не делает desktop app для agent orchestration (кроме parallel-code)
- **Team lifecycle management** — наш уровень detail (config.json, session management, DM) не имеет аналогов

### 5. Что стоит изучить/заимствовать

| Идея | Источник | Применимость для нас |
|------|----------|---------------------|
| SQLite mail protocol messages (8 types) | Overstory | Можно формализовать наши inbox message types |
| File leases для conflict prevention | mcp_agent_mail | Полезно для multi-agent file editing |
| AMP protocol (priorities, signatures) | AI Maestro | Можно добавить priorities в наш inbox |
| Event bus architecture | ORCH | Для decoupled communication в Electron |
| Self-improvement loop | Composio AO | Agent learning from past sessions |
| Consensus gates | Claude Octopus | Multi-provider code review |
| Pluggable AgentRuntime interface | Overstory | Для будущей multi-provider поддержки |

---

## Рекомендация

**НЕ использовать ни один из этих инструментов как фундамент.** Причины:

1. **Наш стек уникален** (Electron + React + TypeScript + Zustand) — ни один tool не совместим
2. **Наша архитектура inbox messaging уже работает** и протестирована
3. **Kanban board** — наше ключевое преимущество, которого нет у конкурентов
4. **Зрелость кода** у всех инструментов низкая (< 6 месяцев)
5. **Dependency risk** — tmux, Bun, Python, Rust — чужой стек

**Что имеет смысл:**
- Изучить **Overstory** как reference для typed protocol messages
- Изучить **mcp_agent_mail** для file lease механизма
- Изучить **AI Maestro** как ближайшего конкурента (Kanban + AMP)
- Следить за **CAO (AWS)** — AWS backing значит долгосрочную поддержку
- Рассмотреть **AgentRuntime interface** из Overstory для будущей multi-provider поддержки

---

## Источники

- [CAS - codingagentsystem/cas](https://github.com/codingagentsystem/cas)
- [CAS Website](https://cas.dev/)
- [AWS CLI Agent Orchestrator](https://github.com/awslabs/cli-agent-orchestrator)
- [AWS Blog - Introducing CAO](https://aws.amazon.com/blogs/opensource/introducing-cli-agent-orchestrator-transforming-developer-cli-tools-into-a-multi-agent-powerhouse/)
- [CAO Message Queueing - DeepWiki](https://deepwiki.com/awslabs/cli-agent-orchestrator/3.4-message-queueing-and-inbox-system)
- [Overstory](https://github.com/jayminwest/overstory)
- [Composio Agent Orchestrator](https://github.com/ComposioHQ/agent-orchestrator)
- [hcom](https://github.com/aannoo/hcom)
- [AI Maestro](https://github.com/23blocks-OS/ai-maestro)
- [AMP Protocol](https://github.com/agentmessaging/protocol)
- [ORCH](https://www.orch.one/)
- [MCO](https://github.com/mco-org/mco)
- [Ruflo](https://github.com/ruvnet/ruflo)
- [mcp_agent_mail](https://github.com/Dicklesworthstone/mcp_agent_mail)
- [agtx](https://github.com/fynnfluegge/agtx)
- [claude_code_bridge](https://github.com/bfly123/claude_code_bridge)
- [Claude Octopus](https://github.com/nyldn/claude-octopus)
- [parallel-code](https://github.com/johannesjo/parallel-code)
- [MetaSwarm](https://github.com/dsifry/metaswarm)
- [kodo](https://github.com/ikamensh/kodo)
- [Awesome Agent Orchestrators](https://github.com/andyrewlee/awesome-agent-orchestrators)
- [Zed Editor - External Agents / ACP](https://zed.dev/docs/ai/external-agents)
